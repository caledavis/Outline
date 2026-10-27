# Outline

A lightweight outliner for planning and organising research, for Windows, macOS and Linux.
Built with [Tauri](https://tauri.app) (Rust) and TypeScript, with text editing by [TipTap](https://tiptap.dev).

Outlines are saved as **OPML 2.0**, an open, plain-text outline format that OmniOutliner
and many other apps can also open.

## Running it

```sh
npm install          # once, to download the JavaScript libraries
npm run tauri dev    # run the app in development mode
npm run tauri build  # build an installer for this computer's OS
cd src-tauri && cargo test   # run the Rust tests
```

## Keyboard shortcuts

(⌘ on macOS, Ctrl on Windows and Linux)

| Action | Keys |
| --- | --- |
| New row below | Enter |
| Line break within a cell | Shift+Enter |
| Indent / outdent | Tab / Shift+Tab |
| Move row up / down | ⌘+Shift+↑ / ⌘+Shift+↓ |
| Collapse / expand | ⌘+. |
| Add or edit note | ⌘+' |
| Delete row | ⌘+Backspace (or Backspace when not editing) |
| Stop editing | Esc (then ↑/↓ select rows, Enter edits) |
| Bold / italic / underline | ⌘+B / ⌘+I / ⌘+U |
| Link | ⌘+K (⌘+click a link to open it) |
| Apply style 1–9 to selected rows | ⌘+1 … ⌘+9 (press again to remove) |
| Remove style | ⌘+0 |
| Select several rows | Shift+click, ⌘+click, or Shift+↑/↓ when not editing (indent, move, delete and styles then act on all of them) |
| Show / hide sidebar | ⌘+\\ |
| Search | ⌘+F (Esc clears) |
| Tags for the selected rows | ⌘+Shift+T |
| Undo / redo | ⌘+Z / ⌘+Shift+Z |
| New / open / save / save as | ⌘+N / ⌘+O / ⌘+S / ⌘+Shift+S |

Rows can also be dragged by the grip handle that appears to the left of a row. A blue line shows where the row will land; while
dragging, move the pointer right to nest it under the row above, or left to move it up levels.
The row that will become its parent is marked with a blue bar.

Drag the edge of any column header to resize that column; double-click the edge to reset it.

## Columns

The **+** at the right of the headers adds a column of any type, including a Tags, Links
or Zotero column. Drag a column's header to move it. Use the ⌄ menu on a column's header to choose its type — **Text**, **Checkbox**, **Number**,
**Date** or **Pop-up list** — to edit a pop-up list's choices, or to delete the column. When
the type changes, existing values are converted where possible.

## Tags, attachments and Zotero

- **Tags** are created and managed in the sidebar's Tags pane, shown as chips (+ New tag adds
  one). Click a chip to add that tag to the selected rows, or again to remove it; its ⌄ menu
  shows only rows with that tag, renames it or deletes it. Tags appear as pills in a Tags column. Click an
  empty part of a Tags cell (or press ⌘+Shift+T) for a checklist of tags for that row; click a
  pill to filter by it, or hover for × to remove it.
- **Attach** (paperclip) links a row to files or web pages, shown in a Links column; click a
  link to open it, or an empty part of a Links cell to add one.
- **Zotero** (book) links a row to items in your Zotero library. The links go in a Zotero
  column, which is added the first time; click an empty part of a Zotero cell to link that
  row, or a link to show the item in Zotero. The column's ⌄ menu has **Show notes**, which shows
  each item's Zotero notes under it (click a note to copy it, e.g. a LaTeX citation), and
  **Update notes from Zotero** to fetch them again after editing them in Zotero. This needs Zotero 7 or later to be open, with *Allow other applications on
  this computer to communicate with Zotero* ticked in Zotero → Settings → Advanced.

These all act on every selected row. If you delete the Tags, Links or Zotero column, its
contents are shown next to each row's topic instead.

## Search and filter

Type in the search box to show only rows containing all the words (in any column, note, tag
or link), along with the rows they sit inside. The filter button narrows the outline by tags
and by the values of checkbox and pop-up list columns; active filters are listed under the
toolbar.

## Sidebar

- **Overview** lists the top-level rows; click one to jump to it.
- **Styles** set the text size, colour, bold/italic and a highlight colour for whole rows. Click a style to apply it to the
  selected rows, or use its shortcut. The pencil button opens a style's settings (name, size,
  bold, italic, colour, highlight, order and delete). The order decides the shortcut number, up to nine styles.
- **Tags** lists every tag and how many rows have it; see above.

## Spelling

Outline uses the operating system's own spell checker. Misspelt words are underlined;
right-click one for suggestions.

- **macOS:** spell checking is always on. Autocorrect follows *Correct spelling automatically* in
  System Settings → Keyboard → Text Input → Edit.
- **Windows:** uses the Windows spell checker and its languages. Windows doesn't offer
  autocorrect in apps like this one.
- **Linux:** uses the system dictionaries (Hunspell via Enchant) for your locale's language.
  WebKitGTK doesn't offer autocorrect.

## How the code is organised

```
src-tauri/src/
  lib.rs      Rust commands the interface calls: open_outline, save_outline
  opml.rs     Reads and writes OPML files (with tests)
  zotero.rs   Searches the Zotero library through Zotero's local API
src/
  main.ts     Toolbar, file open/save, window title, global shortcuts
  sidebar.ts  The sidebar: overview of top-level rows, styles and tags
  filters.ts  The search box, filter menu and filter bar
  zotero.ts   The dialog for linking rows to Zotero items
  menu.ts     Pop-up menus
  prompt.ts   The small text-entry dialog
  view.ts     Draws the outline grid; editing, keys, drag and drop, columns, undo
  model.ts    The outline data and operations (indent, move, delete…)
  editor.ts   Sets up the TipTap text editor used inside a cell
  icons.ts    The Lucide icons used in the toolbar and outline
  sanitize.ts Strips unsafe HTML from files before showing it
  styles.css  Appearance (follows the system's light/dark mode)
index.html    The window's layout
```

## App icon

The icons in `src-tauri/icons` are made from the images in `icon-sources/`:

```sh
npx tauri icon icon-sources/app_icon.png        # Windows and Linux icons
# macOS: first shrink the artwork to Apple's icon grid (824px with a 100px margin)
swift scripts/pad-mac-icon.swift icon-sources/mac_icon.png /tmp/mac_icon_padded.png
npx tauri icon /tmp/mac_icon_padded.png -o /tmp/mac-icons && cp /tmp/mac-icons/icon.icns src-tauri/icons/
rm -rf src-tauri/icons/android src-tauri/icons/ios   # not needed for a desktop app
```

## File format

Each row is an `<outline>` element; nesting rows nests elements. The main column is the
standard `text` attribute (inline HTML for formatting) and notes use the common `_note`
attribute. Tags use OPML's standard `category` attribute. Extra columns, styles, links and
collapsed rows use the `ol:` namespace, which other apps simply ignore:

```xml
<opml version="2.0" xmlns:ol="urn:outline-app:opml:1">
  <head>
    <title>Thesis</title>
    <ol:column id="topic" name="Topic"/>
    <ol:column id="c2" name="Source" width="180"/>
    <ol:style id="s1" name="Heading 1" color="#de394b" bold="true"/>
  </head>
  <body>
    <outline text="Chapter 1" ol:style="s1" ol:collapsed="true">
      <outline text="Background" ol:col-c2="Smith 2021" _note="&lt;p&gt;Check page 12&lt;/p&gt;"/>
    </outline>
  </body>
</opml>
```
