//! Reading and writing outlines as OPML 2.0 (http://opml.org/spec2.opml).
//!
//! OPML is a plain-text XML format where each row is an `<outline>` element and
//! nesting is expressed by putting elements inside each other. The standard
//! attributes we use are:
//!
//! - `text`  — the row's main ("Topic") column, as inline HTML (allowed by the spec)
//! - `_note` — the row's note, a widely used convention (OmniOutliner, Workflowy…)
//!
//! - `category` — the row's tags, comma-separated (from the OPML 2.0 spec)
//!
//! Anything OPML has no standard place for (extra columns, styles, links,
//! collapsed rows) is stored in elements and attributes under our own `ol:`
//! namespace. Other apps ignore
//! those, so files stay readable everywhere.

use std::collections::BTreeMap;

use quick_xml::escape::{escape, unescape};
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use serde::{Deserialize, Serialize};

/// Namespace URI identifying our extension attributes.
const NAMESPACE: &str = "urn:outline-app:opml:1";

/// The id of the main column, which maps to OPML's standard `text` attribute.
pub const TOPIC: &str = "topic";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub title: String,
    pub columns: Vec<Column>,
    #[serde(default)]
    pub styles: Vec<Style>,
    /// Tags created in the Tags pane, including ones no row uses yet.
    #[serde(default)]
    pub tags: Vec<String>,
    pub rows: Vec<Row>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Column {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub width: Option<u32>,
    /// One of `COLUMN_TYPES`.
    #[serde(rename = "type", default = "text_type")]
    pub kind: String,
    /// The choices for a pop-up list ("select") column.
    #[serde(default)]
    pub options: Vec<String>,
    /// Whether a Zotero column shows each item's notes.
    #[serde(rename = "showNotes", default)]
    pub show_notes: bool,
}

/// "tags", "links" and "zotero" columns show the row's tags, file and web links,
/// and Zotero links (which are stored on the row, not in the column's cells).
pub const COLUMN_TYPES: [&str; 8] = ["text", "checkbox", "number", "date", "select", "tags", "links", "zotero"];

fn text_type() -> String {
    "text".into()
}

/// Something a row links to: a file, a web page, or an item in Zotero.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Link {
    /// One of `LINK_KINDS`.
    pub kind: String,
    /// A file path, or a URL (`zotero://select/…` for Zotero items).
    pub target: String,
    /// The short label shown on the row.
    pub title: String,
    /// More detail, e.g. a Zotero item's full title.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub detail: String,
    /// A Zotero item's notes, as plain text (copied from Zotero when linked).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

pub const LINK_KINDS: [&str; 3] = ["file", "url", "zotero"];

/// A named look (text size, colour, weight…) that can be applied to rows.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Style {
    pub id: String,
    pub name: String,
    /// Text size in pixels; `None` keeps the normal size.
    #[serde(default)]
    pub size: Option<u32>,
    /// Text colour as `#rrggbb`; `None` keeps the normal colour.
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    /// Highlight colour behind the text as `#rrggbb`, if any.
    #[serde(default)]
    pub background: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Row {
    /// Cell contents (inline HTML), keyed by column id.
    #[serde(default)]
    pub cells: BTreeMap<String, String>,
    /// The row's note (HTML paragraphs), or empty.
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub collapsed: bool,
    /// The id of the style applied to this row, if any.
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub links: Vec<Link>,
    #[serde(default)]
    pub children: Vec<Row>,
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

pub fn parse(xml: &str) -> Result<Document, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut doc = Document { title: String::new(), columns: Vec::new(), styles: Vec::new(), tags: Vec::new(), rows: Vec::new() };
    // Rows whose closing `</outline>` we haven't reached yet, outermost first.
    let mut open: Vec<Row> = Vec::new();
    let mut is_opml = false;

    loop {
        let event = reader
            .read_event()
            .map_err(|e| format!("Invalid XML near byte {}: {e}", reader.error_position()))?;
        match event {
            Event::Start(e) => match e.name().as_ref() {
                "opml" => is_opml = true,
                "title" => {
                    let raw = reader.read_text(e.name()).map_err(|e| e.to_string())?;
                    doc.title = unescape(&raw).map_err(|e| e.to_string())?.trim().to_string();
                }
                "outline" => open.push(row_from(&e)?),
                _ => {}
            },
            Event::Empty(e) => match e.name().as_ref() {
                "outline" => {
                    let row = row_from(&e)?;
                    attach(&mut open, &mut doc.rows, row);
                }
                "ol:column" => doc.columns.push(column_from(&e)?),
                "ol:style" => doc.styles.push(style_from(&e)?),
                "ol:tag" => {
                    let name = attributes(&e)?.into_iter().find(|(key, _)| key == "name").map(|(_, v)| v);
                    if let Some(name) = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
                        doc.tags.push(name);
                    }
                }
                _ => {}
            },
            Event::End(e) if e.name().as_ref() == "outline" => {
                let row = open.pop().ok_or("Unexpected </outline> in file")?;
                attach(&mut open, &mut doc.rows, row);
            }
            Event::Eof => break,
            _ => {}
        }
    }

    if !is_opml {
        return Err("This file is not an OPML outline.".into());
    }
    // OPML files from other apps only have the one standard column.
    if !doc.columns.iter().any(|c| c.id == TOPIC) {
        doc.columns.insert(0, Column { id: TOPIC.into(), name: "Topic".into(), width: None, kind: text_type(), options: Vec::new(), show_notes: false });
    }
    Ok(doc)
}

/// Adds a finished row to its parent, or to the top level if it has none.
fn attach(open: &mut [Row], top_level: &mut Vec<Row>, row: Row) {
    match open.last_mut() {
        Some(parent) => parent.children.push(row),
        None => top_level.push(row),
    }
}

fn attributes(e: &BytesStart) -> Result<Vec<(String, String)>, String> {
    e.attributes()
        .map(|attr| {
            let attr = attr.map_err(|e| e.to_string())?;
            let key = attr.key.as_ref().to_string();
            let value = attr.normalized_value(XmlVersion::Implicit1_0).map_err(|e| e.to_string())?.into_owned();
            Ok((key, value))
        })
        .collect()
}

fn row_from(e: &BytesStart) -> Result<Row, String> {
    let mut row = Row::default();
    for (key, value) in attributes(e)? {
        match key.as_str() {
            "text" => {
                row.cells.insert(TOPIC.into(), value);
            }
            "_note" => row.note = note_to_html(&value),
            "ol:collapsed" => row.collapsed = value == "true",
            "ol:style" if is_valid_id(&value) => row.style = Some(value),
            "category" => {
                row.tags = value.split(',').map(str::trim).filter(|t| !t.is_empty()).map(String::from).collect();
            }
            "ol:links" => {
                // Links are stored as JSON; anything unreadable is skipped.
                let links: Vec<Link> = serde_json::from_str(&value).unwrap_or_default();
                row.links = links.into_iter().filter(|l| LINK_KINDS.contains(&l.kind.as_str())).collect();
            }
            _ => {
                if let Some(column) = key.strip_prefix("ol:col-") {
                    row.cells.insert(column.into(), value);
                }
            }
        }
    }
    Ok(row)
}

fn column_from(e: &BytesStart) -> Result<Column, String> {
    let mut column = Column { id: String::new(), name: String::new(), width: None, kind: text_type(), options: Vec::new(), show_notes: false };
    for (key, value) in attributes(e)? {
        match key.as_str() {
            "id" => column.id = value,
            "name" => column.name = value,
            "width" => column.width = value.parse().ok(),
            "type" if COLUMN_TYPES.contains(&value.as_str()) => column.kind = value,
            "options" => {
                column.options = value.lines().map(str::trim).filter(|o| !o.is_empty()).map(String::from).collect();
            }
            "show-notes" => column.show_notes = value == "true",
            _ => {}
        }
    }
    if !is_valid_id(&column.id) {
        return Err(format!("Invalid column id {:?} in file", column.id));
    }
    Ok(column)
}

fn style_from(e: &BytesStart) -> Result<Style, String> {
    let mut style = Style::default();
    for (key, value) in attributes(e)? {
        match key.as_str() {
            "id" => style.id = value,
            "name" => style.name = value,
            "size" => style.size = value.parse().ok().map(|size: u32| size.clamp(MIN_SIZE, MAX_SIZE)),
            "color" => style.color = Some(value).filter(|c| is_valid_color(c)),
            "bold" => style.bold = value == "true",
            "italic" => style.italic = value == "true",
            "background" => style.background = Some(value).filter(|c| is_valid_color(c)),
            _ => {}
        }
    }
    if !is_valid_id(&style.id) {
        return Err(format!("Invalid style id {:?} in file", style.id));
    }
    Ok(style)
}

/// Notes written by other apps are plain text; turn each line into a paragraph.
fn note_to_html(note: &str) -> String {
    if note.trim_start().starts_with('<') {
        return note.to_string();
    }
    note.lines()
        .map(|line| format!("<p>{}</p>", escape(line)))
        .collect()
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

pub fn write(doc: &Document) -> Result<String, String> {
    if let Some(bad) = doc.columns.iter().find(|c| !is_valid_id(&c.id)) {
        return Err(format!("Invalid column id {:?}", bad.id));
    }
    if let Some(bad) = doc.styles.iter().find(|s| !is_valid_id(&s.id)) {
        return Err(format!("Invalid style id {:?}", bad.id));
    }

    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out += &format!("<opml version=\"2.0\" xmlns:ol=\"{NAMESPACE}\">\n");
    out += "  <head>\n";
    out += &format!("    <title>{}</title>\n", attr(&doc.title));
    for column in &doc.columns {
        out += &format!("    <ol:column id=\"{}\" name=\"{}\"", column.id, attr(&column.name));
        if let Some(width) = column.width {
            out += &format!(" width=\"{width}\"");
        }
        if column.kind != "text" && COLUMN_TYPES.contains(&column.kind.as_str()) {
            out += &format!(" type=\"{}\"", column.kind);
        }
        if !column.options.is_empty() {
            out += &format!(" options=\"{}\"", attr(&column.options.join("\n")));
        }
        if column.show_notes {
            out += " show-notes=\"true\"";
        }
        out += "/>\n";
    }
    for style in &doc.styles {
        out += &format!("    <ol:style id=\"{}\" name=\"{}\"", style.id, attr(&style.name));
        if let Some(size) = style.size {
            out += &format!(" size=\"{}\"", size.clamp(MIN_SIZE, MAX_SIZE));
        }
        if let Some(color) = style.color.as_ref().filter(|c| is_valid_color(c)) {
            out += &format!(" color=\"{color}\"");
        }
        if style.bold {
            out += " bold=\"true\"";
        }
        if style.italic {
            out += " italic=\"true\"";
        }
        if let Some(background) = style.background.as_ref().filter(|c| is_valid_color(c)) {
            out += &format!(" background=\"{background}\"");
        }
        out += "/>\n";
    }
    for tag in &doc.tags {
        out += &format!("    <ol:tag name=\"{}\"/>\n", attr(tag));
    }
    out += "  </head>\n  <body>\n";
    for row in &doc.rows {
        write_row(&mut out, row, &doc.columns, 2);
    }
    out += "  </body>\n</opml>\n";
    Ok(out)
}

fn write_row(out: &mut String, row: &Row, columns: &[Column], depth: usize) {
    let indent = "  ".repeat(depth);
    let topic = row.cells.get(TOPIC).map(String::as_str).unwrap_or("");
    *out += &format!("{indent}<outline text=\"{}\"", attr(topic));
    for column in columns.iter().filter(|c| c.id != TOPIC) {
        if let Some(value) = row.cells.get(&column.id).filter(|v| !v.is_empty()) {
            *out += &format!(" ol:col-{}=\"{}\"", column.id, attr(value));
        }
    }
    if !row.note.is_empty() {
        *out += &format!(" _note=\"{}\"", attr(&row.note));
    }
    if row.collapsed {
        *out += " ol:collapsed=\"true\"";
    }
    if let Some(style) = row.style.as_ref().filter(|s| is_valid_id(s)) {
        *out += &format!(" ol:style=\"{style}\"");
    }
    if !row.tags.is_empty() {
        let tags: Vec<String> = row.tags.iter().map(|t| t.replace(',', " ")).collect();
        *out += &format!(" category=\"{}\"", attr(&tags.join(",")));
    }
    if !row.links.is_empty() {
        let json = serde_json::to_string(&row.links).unwrap_or_default();
        *out += &format!(" ol:links=\"{}\"", attr(&json));
    }

    if row.children.is_empty() {
        *out += "/>\n";
    } else {
        *out += ">\n";
        for child in &row.children {
            write_row(out, child, columns, depth + 1);
        }
        *out += &format!("{indent}</outline>\n");
    }
}

/// Escapes text for use inside an XML attribute. Line breaks and tabs must be
/// written as character references, or XML readers turn them into spaces.
fn attr(text: &str) -> String {
    escape(text).replace('\n', "&#10;").replace('\r', "&#13;").replace('\t', "&#9;")
}

const MIN_SIZE: u32 = 6;
const MAX_SIZE: u32 = 96;

fn is_valid_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Column and style ids become part of attribute names, so keep them simple.
fn is_valid_id(id: &str) -> bool {
    id.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Document {
        let mut child = Row::default();
        child.cells.insert(TOPIC.into(), "Child with <em>emphasis</em> & \"quotes\"".into());
        child.cells.insert("c2".into(), "Smith 2021".into());
        child.note = "<p>Line one</p><p>Line\ttwo\nthree</p>".into();
        child.tags = vec!["to-read".into(), "method & theory".into()];
        child.links = vec![
            Link { kind: "file".into(), target: "/Users/me/Papers/smith \"2021\".pdf".into(), title: "smith.pdf".into(), ..Link::default() },
            Link {
                kind: "zotero".into(),
                target: "zotero://select/library/items/ABCD1234".into(),
                title: "Smith 2021".into(),
                detail: "A <long> & winding title".into(),
                notes: vec!["\\cite{smith2021}".into(), "Line one\nline \"two\"".into()],
            },
        ];

        let mut parent = Row::default();
        parent.cells.insert(TOPIC.into(), "<strong>Chapter 1</strong>".into());
        parent.collapsed = true;
        parent.style = Some("s1".into());
        parent.children.push(child);

        let mut empty = Row::default();
        empty.cells.insert(TOPIC.into(), String::new());

        Document {
            title: "Thesis".into(),
            columns: vec![
                Column { id: TOPIC.into(), name: "Topic".into(), width: None, kind: text_type(), options: Vec::new(), show_notes: false },
                Column {
                    id: "c2".into(),
                    name: "Source & page".into(),
                    width: Some(180),
                    kind: "select".into(),
                    options: vec!["Smith 2021".into(), "Jones & Lee".into()],
                    show_notes: true,
                },
            ],
            styles: vec![
                Style { id: "s1".into(), name: "Heading".into(), size: Some(18), bold: true, ..Style::default() },
                Style {
                    id: "s2".into(),
                    name: "Red & highlighted".into(),
                    color: Some("#c2410c".into()),
                    italic: true,
                    background: Some("#fff3bf".into()),
                    ..Style::default()
                },
            ],
            tags: vec!["to-read".into(), "unused & spare".into()],
            rows: vec![parent, empty],
        }
    }

    #[test]
    fn round_trip_preserves_everything() {
        let doc = sample();
        let xml = write(&doc).unwrap();
        assert_eq!(parse(&xml).unwrap(), doc);
    }

    #[test]
    fn reads_opml_from_other_apps() {
        let xml = r#"<?xml version="1.0"?>
            <opml version="2.0"><head><title>Notes &amp; ideas</title></head><body>
              <outline text="One" _note="first line&#10;second &lt;line&gt;">
                <outline text="Two" type="link" url="https://example.com"/>
              </outline>
            </body></opml>"#;
        let doc = parse(xml).unwrap();
        assert_eq!(doc.title, "Notes & ideas");
        assert_eq!(doc.columns.len(), 1);
        assert_eq!(doc.rows[0].note, "<p>first line</p><p>second &lt;line&gt;</p>");
        assert_eq!(doc.rows[0].children[0].cells[TOPIC], "Two");
    }

    #[test]
    fn reads_example_file() {
        let doc = parse(include_str!("../../examples/Sample research plan.opml")).unwrap();
        assert_eq!(doc.columns.len(), 7);
        assert_eq!(doc.columns[5].kind, "tags");
        assert_eq!(doc.columns[2].kind, "select");
        assert_eq!(doc.columns[2].options, ["Not started", "Reading", "Drafting", "Done"]);
        assert_eq!(doc.rows[1].children[0].tags, ["to-read", "history"]);
        assert_eq!(doc.rows[1].children[0].links[0].kind, "url");
        assert_eq!(doc.rows.len(), 3);
        assert!(doc.rows[1].children[1].collapsed);
        assert_eq!(doc.rows[0].children[1].cells["c2"], "Smith 2021, p. 12");
    }

    #[test]
    fn reads_tags_and_skips_bad_links() {
        let xml = r#"<opml version="2.0"><head/><body>
              <outline text="x" category=" a, b ,," ol:links='[{"kind":"evil","target":"x","title":"x"},{"kind":"url","target":"https://e.com","title":"e"}]'/>
              <outline text="y" ol:links="not json"/>
            </body></opml>"#;
        let doc = parse(xml).unwrap();
        assert_eq!(doc.rows[0].tags, ["a", "b"]);
        assert_eq!(doc.rows[0].links.len(), 1);
        assert!(doc.rows[1].links.is_empty());
    }

    #[test]
    fn rejects_non_opml() {
        assert!(parse("<html><body/></html>").is_err());
        assert!(parse("<opml><body><outline text='x'></body></opml>").is_err());
    }

    #[test]
    fn ignores_unsafe_style_values() {
        let xml = r##"<opml version="2.0"><head>
              <ol:style id="s1" name="Odd" size="500" color="red;background:url(x)" background="#12345z"/>
            </head><body><outline text="x" ol:style="s1 evil"/></body></opml>"##;
        let doc = parse(xml).unwrap();
        assert_eq!(doc.styles[0].size, Some(MAX_SIZE));
        assert_eq!(doc.styles[0].color, None);
        assert_eq!(doc.styles[0].background, None);
        assert_eq!(doc.rows[0].style, None);
    }

    #[test]
    fn rejects_unsafe_column_ids() {
        let mut doc = sample();
        doc.columns[1].id = "c2=\"x\" evil".into();
        assert!(write(&doc).is_err());
    }
}
