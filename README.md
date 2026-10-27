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
| Undo / redo | ⌘+Z / ⌘+Shift+Z |
| New / open / save / save as | ⌘+N / ⌘+O / ⌘+S / ⌘+Shift+S |

Rows can also be dragged by the grip handle that appears to the left of a row. A blue line shows where the row will land; while
dragging, move the pointer right to nest it under the row above, or left to move it up levels.
The row that will become its parent is marked with a blue bar.

Drag the edge of any column header to resize that column; double-click the edge to reset it.

## How the code is organised

```
src-tauri/src/
  lib.rs      Rust commands the interface calls: open_outline, save_outline
  opml.rs     Reads and writes OPML files (with tests)
src/
  main.ts     Toolbar, file open/save, window title, global shortcuts
  view.ts     Draws the outline grid; editing, keys, drag and drop, columns, undo
  model.ts    The outline data and operations (indent, move, delete…)
  editor.ts   Sets up the TipTap text editor used inside a cell
  icons.ts    The Lucide icons used in the toolbar and outline
  sanitize.ts Strips unsafe HTML from files before showing it
  styles.css  Appearance (follows the system's light/dark mode)
index.html    The window's layout
```

## File format

Each row is an `<outline>` element; nesting rows nests elements. The main column is the
standard `text` attribute (inline HTML for formatting) and notes use the common `_note`
attribute. Extra columns and collapsed rows use attributes in the `ol:` namespace, which
other apps simply ignore:

```xml
<opml version="2.0" xmlns:ol="urn:outline-app:opml:1">
  <head>
    <title>Thesis</title>
    <ol:column id="topic" name="Topic"/>
    <ol:column id="c2" name="Source" width="180"/>
  </head>
  <body>
    <outline text="&lt;strong&gt;Chapter 1&lt;/strong&gt;" ol:collapsed="true">
      <outline text="Background" ol:col-c2="Smith 2021" _note="&lt;p&gt;Check page 12&lt;/p&gt;"/>
    </outline>
  </body>
</opml>
```
