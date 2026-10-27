//! Reading and writing outlines as OPML 2.0 (http://opml.org/spec2.opml).
//!
//! OPML is a plain-text XML format where each row is an `<outline>` element and
//! nesting is expressed by putting elements inside each other. The standard
//! attributes we use are:
//!
//! - `text`  — the row's main ("Topic") column, as inline HTML (allowed by the spec)
//! - `_note` — the row's note, a widely used convention (OmniOutliner, Workflowy…)
//!
//! Anything OPML has no standard place for (extra columns, collapsed rows) is
//! stored in attributes under our own `ol:` XML namespace. Other apps ignore
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
    pub rows: Vec<Row>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Column {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub width: Option<u32>,
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
    #[serde(default)]
    pub children: Vec<Row>,
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

pub fn parse(xml: &str) -> Result<Document, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut doc = Document { title: String::new(), columns: Vec::new(), rows: Vec::new() };
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
        doc.columns.insert(0, Column { id: TOPIC.into(), name: "Topic".into(), width: None });
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
    let mut column = Column { id: String::new(), name: String::new(), width: None };
    for (key, value) in attributes(e)? {
        match key.as_str() {
            "id" => column.id = value,
            "name" => column.name = value,
            "width" => column.width = value.parse().ok(),
            _ => {}
        }
    }
    if !is_valid_id(&column.id) {
        return Err(format!("Invalid column id {:?} in file", column.id));
    }
    Ok(column)
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

    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out += &format!("<opml version=\"2.0\" xmlns:ol=\"{NAMESPACE}\">\n");
    out += "  <head>\n";
    out += &format!("    <title>{}</title>\n", attr(&doc.title));
    for column in &doc.columns {
        out += &format!("    <ol:column id=\"{}\" name=\"{}\"", column.id, attr(&column.name));
        if let Some(width) = column.width {
            out += &format!(" width=\"{width}\"");
        }
        out += "/>\n";
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

/// Column ids become part of attribute names, so keep them simple.
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

        let mut parent = Row::default();
        parent.cells.insert(TOPIC.into(), "<strong>Chapter 1</strong>".into());
        parent.collapsed = true;
        parent.children.push(child);

        let mut empty = Row::default();
        empty.cells.insert(TOPIC.into(), String::new());

        Document {
            title: "Thesis".into(),
            columns: vec![
                Column { id: TOPIC.into(), name: "Topic".into(), width: None },
                Column { id: "c2".into(), name: "Source & page".into(), width: Some(180) },
            ],
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
        assert_eq!(doc.columns.len(), 3);
        assert_eq!(doc.rows.len(), 3);
        assert!(doc.rows[1].children[1].collapsed);
        assert_eq!(doc.rows[0].children[1].cells["c2"], "Smith 2021, p. 12");
    }

    #[test]
    fn rejects_non_opml() {
        assert!(parse("<html><body/></html>").is_err());
        assert!(parse("<opml><body><outline text='x'></body></opml>").is_err());
    }

    #[test]
    fn rejects_unsafe_column_ids() {
        let mut doc = sample();
        doc.columns[1].id = "c2=\"x\" evil".into();
        assert!(write(&doc).is_err());
    }
}
