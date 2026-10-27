<p align="center">
  <img src="outlineicon.png" alt="Outline" width="160">
</p>

# Outline: A lightweight outliner for planning research

**Download the latest version:**

- [macOS — Apple Silicon](https://github.com/caledavis/Outline/releases/latest/download/Outline-mac-arm64.dmg)
- [macOS — Intel](https://github.com/caledavis/Outline/releases/latest/download/Outline-mac-x64.dmg)
- [Windows — Installer](https://github.com/caledavis/Outline/releases/latest/download/Outline-win-x64-setup.exe) (or as an [.msi](https://github.com/caledavis/Outline/releases/latest/download/Outline-win-x64.msi))
- [Windows — Portable](https://github.com/caledavis/Outline/releases/latest/download/Outline-win-portable-x64.exe) (no installation or admin rights needed — ideal for managed or work computers)
- [Linux — AppImage](https://github.com/caledavis/Outline/releases/latest/download/Outline-linux-x86_64.AppImage)
- [Linux — .deb](https://github.com/caledavis/Outline/releases/latest/download/Outline-linux-amd64.deb) (Debian/Ubuntu)
- [Linux — .rpm](https://github.com/caledavis/Outline/releases/latest/download/Outline-linux-x86_64.rpm) (Fedora/openSUSE/RHEL)

Outline is a free and open-source outliner for planning and organising research, for Windows,
macOS and Linux, released under the European Union Public Licence (EUPL). Built with
[Tauri](https://tauri.app) (Rust) and TypeScript, with text editing by [TipTap](https://tiptap.dev).

Outlines are saved as **OPML 2.0**, an open, plain-text outline format that OmniOutliner
and many other apps can also open.

## Licence

Outline is free and released under the European Union Public Licence (EUPL v1.2; see
[LICENSE](LICENSE)). This means that everyone is free to use Outline, reproduce it, change it,
and make their changes available to others (among other things). Importantly, if Outline or a
derivative of it is distributed, it must also be done under the EUPL licence and the source code
must be made freely available.

This ensures that Outline remains free for everyone, and disincentivises companies from
profiting off it.

Outline bundles open-source libraries under their own licences, listed with their full text in
[THIRD-PARTY-LICENSES.txt](THIRD-PARTY-LICENSES.txt). Regenerate it with `npm run licenses` after
adding or updating dependencies.

## Troubleshooting

Outline isn't yet signed with Apple or Microsoft developer certificates, so the first time you
open it your computer may warn you:

- **macOS:** if it says Outline "can't be opened" or is from an unidentified developer, open
  **System Settings → Privacy & Security**, scroll down and click **Open Anyway** (once).
- **Windows:** if SmartScreen says it "protected your PC", click **More info → Run anyway**.
- **Windows (portable):** needs Microsoft Edge WebView2, which Windows 10 and 11 normally include.
- **Linux (AppImage):** make it executable first (`chmod +x Outline-linux-x86_64.AppImage`). If
  it still won't start, install `libfuse2` (e.g. `sudo apt install libfuse2`).

## Building it

```sh
npm install           # once, to download the JavaScript libraries
npm run tauri build   # builds the app and installers for this computer
```

The installers end up in `src-tauri/target/release/bundle/`. Each operating system can only
build its own installers, so the releases are built by GitHub Actions
(`.github/workflows/release.yml`) on GitHub's macOS, Windows and Linux machines:

1. Update the version number in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml`, and commit.
2. Tag the commit and push the tag, e.g. `git tag v0.2.0 && git push origin v0.2.0`.
3. GitHub builds every installer and publishes them as a release; the download links above then
   point to it.

To try the builds without publishing, run the workflow by hand (Actions → Release → Run
workflow); the installers are attached to the run.

## Running it

```sh
npm install          # once, to download the JavaScript libraries
npm run tauri dev    # run the app in development mode
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
| Back to Default style | ⌘+0 |
| Select several rows | Shift+click, ⌘+click, or Shift+↑/↓ when not editing (indent, move, delete and styles then act on all of them) |
| Show / hide sidebar | ⌘+\\ |
| Search | ⌘+F (Esc clears) |
| Larger / smaller text | ⌘+plus / ⌘+minus (or − and + in the toolbar, with ↺ to reset) |
| Tags for the selected rows | ⌘+Shift+T |
| Undo / redo | ⌘+Z / ⌘+Shift+Z |
| New / open / save / save as | ⌘+N / ⌘+O / ⌘+S / ⌘+Shift+S |
| New tab / close tab | ⌘+N or ⌘+T / ⌘+W |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab, or ⌘+Shift+] / ⌘+Shift+[ |

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
  font (serif, sans or mono), bold, italic, colour, highlight, order and delete). The order decides the shortcut number, up to nine styles.
  **Default** (⌘+0) sets how rows without a style look. Each style stands on its own: Default
  doesn't affect styled rows.
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
  main.ts     Toolbar, tabs, file open/save, window title, global shortcuts
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
