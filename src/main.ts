// Wires the outline view to the window: toolbar, file handling, shortcuts.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import type { Editor } from "@tiptap/core";
import { Filters } from "./filters";
import { FileText, Globe, Plus, insertIcons } from "./icons";
import { toggleMenu, type MenuEntry } from "./menu";
import { allTags, assignIds, cleanTags, newDoc, type Link, type OutlineDoc } from "./model";
import { promptText } from "./prompt";
import { Sidebar } from "./sidebar";
import { OutlineView, isMac } from "./view";
import { chooseZoteroItems } from "./zotero";

const FILTERS = [{ name: "Outline (OPML)", extensions: ["opml"] }];

const view = new OutlineView(document.getElementById("outline")!);
const sidebar = new Sidebar(document.getElementById("sidebar")!, view);
const filters = new Filters(view);
let path: string | null = null;
let dirty = false;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function fileName(p: string | null): string {
  return p ? p.split(/[\\/]/).pop()!.replace(/\.opml$/i, "") : "Untitled";
}

function setDirty(value: boolean) {
  dirty = value;
  getCurrentWindow().setTitle(`${dirty ? "• " : ""}${fileName(path)} — Outline`);
}

view.onChange = () => {
  if (!dirty) setDirty(true);
  sidebar.refresh();
};
view.onSelectionChange = () => sidebar.updateSelection();
view.onFilterChange = () => {
  filters.update();
  sidebar.refresh();
};

/** Asks before throwing away unsaved changes. Returns true if it's OK to continue. */
async function confirmDiscard(): Promise<boolean> {
  view.flush();
  if (!dirty) return true;
  return ask(`Do you want to discard your changes to “${fileName(path)}”?`, {
    title: "Unsaved changes",
    kind: "warning",
    okLabel: "Discard",
    cancelLabel: "Cancel",
  });
}

async function newFile() {
  if (!(await confirmDiscard())) return;
  path = null;
  view.load(newDoc());
  sidebar.refresh();
  setDirty(false);
}

async function openFile() {
  if (!(await confirmDiscard())) return;
  const chosen = await open({ multiple: false, directory: false, filters: FILTERS });
  if (!chosen) return;
  try {
    const doc = await invoke<OutlineDoc>("open_outline", { path: chosen });
    assignIds(doc.rows);
    path = chosen;
    view.load(doc);
    sidebar.refresh();
    setDirty(false);
  } catch (error) {
    await message(String(error), { title: "Could not open file", kind: "error" });
  }
}

async function saveFile(saveAs = false) {
  view.flush();
  let target = path;
  if (!target || saveAs) {
    target = await save({ filters: FILTERS, defaultPath: `${fileName(path)}.opml` });
    if (!target) return;
    if (!/\.opml$/i.test(target)) target += ".opml";
  }
  try {
    view.doc.title = fileName(target);
    await invoke("save_outline", { path: target, doc: view.doc });
    path = target;
    setDirty(false);
  } catch (error) {
    await message(String(error), { title: "Could not save file", kind: "error" });
  }
}

getCurrentWindow().onCloseRequested(async (event) => {
  if (!(await confirmDiscard())) event.preventDefault();
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

async function editLink() {
  const editor = view.editor;
  if (!editor) return;
  const current: string = editor.getAttributes("link").href ?? "";
  const url = await promptText("Link address (leave empty to remove the link)", current);
  if (url === null) {
    editor.commands.focus();
    return;
  }
  const chain = editor.chain().focus().extendMarkRange("link");
  if (!url) chain.unsetLink().run();
  else chain.setLink({ href: /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}` }).run();
}

view.onLinkRequest = editLink;
view.onCiteRequest = () => cite();
view.onTagRequest = (cell) => toggleMenu(cell, tagMenu);
view.onAttachRequest = (cell) => toggleMenu(cell, attachMenu);

// ---------------------------------------------------------------------------
// Tags, attachments and Zotero
// ---------------------------------------------------------------------------

/** A checklist of tags for the selected rows, plus a way to make a new one. */
function tagMenu(): MenuEntry[] {
  const has = view.selectedTags();
  const entries: MenuEntry[] = allTags(view.doc).map(({ tag }) => ({
    label: tag,
    checked: has.has(tag),
    action: () => view.applyTag(tag),
  }));
  if (entries.length) entries.push("separator");
  entries.push({ label: "New tag…", icon: Plus, action: newTagForRows });
  return entries;
}

async function newTagForRows() {
  const name = await promptText("New tag", "");
  const [tag] = cleanTags([name ?? ""]);
  if (tag) view.applyTag(tag);
}

function showTagMenu() {
  const anchor = view.tagMenuAnchor();
  if (anchor) toggleMenu(anchor, tagMenu);
}

async function attachFiles() {
  const paths = await open({ multiple: true, directory: false, title: "Attach files" });
  if (!paths?.length) return;
  view.addLinks(paths.map((path): Link => ({ kind: "file", target: path, title: path.split(/[\\/]/).pop()! })));
}

async function attachWebLink() {
  const address = await promptText("Web address", "");
  if (!address) return;
  const href = /^[a-z][a-z0-9+.-]*:/i.test(address) ? address : `https://${address}`;
  let title = href;
  try {
    const url = new URL(href);
    title = url.hostname.replace(/^www\./, "") + (url.pathname.length > 1 ? url.pathname : "");
  } catch {
    // Not a valid address; show it as typed.
  }
  view.addLinks([{ kind: "url", target: href, title: title.length > 40 ? `${title.slice(0, 39)}…` : title }]);
}

function attachMenu() {
  return [
    { label: "File…", icon: FileText, action: attachFiles },
    { label: "Web link…", icon: Globe, action: attachWebLink },
  ];
}

async function cite() {
  if (!view.selection.size) return;
  const links = await chooseZoteroItems();
  if (links.length) view.addLinks(links);
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

const SIDEBAR_KEY = "sidebarHidden";

function setSidebarHidden(hidden: boolean) {
  document.body.classList.toggle("sidebar-hidden", hidden);
  document.querySelector('[data-action="sidebar"]')?.classList.toggle("active", !hidden);
  try {
    localStorage.setItem(SIDEBAR_KEY, String(hidden));
  } catch {
    // Remembering this is only a convenience.
  }
}

function toggleSidebar() {
  setSidebarHidden(!document.body.classList.contains("sidebar-hidden"));
}

// ---------------------------------------------------------------------------
// Text size
// ---------------------------------------------------------------------------

// A preference for this computer, not part of the outline file.
const FONT_SIZE_KEY = "outlineFontSize";
const DEFAULT_FONT_SIZE = 14;
/** The sizes − and + step through, each about 15% bigger than the last. */
const FONT_SIZES = [10, 12, 14, 16, 18, 21, 24, 28, 32];
let fontSize = DEFAULT_FONT_SIZE;

/** Steps to the next size up (+1) or down (−1) in FONT_SIZES. */
function stepFontSize(direction: 1 | -1) {
  const next = direction > 0 ? FONT_SIZES.find((s) => s > fontSize) : [...FONT_SIZES].reverse().find((s) => s < fontSize);
  if (next) setFontSize(next);
}

function setFontSize(size: number) {
  fontSize = Math.min(FONT_SIZES[FONT_SIZES.length - 1], Math.max(FONT_SIZES[0], size));
  document.getElementById("outline")!.style.setProperty("--outline-size", `${fontSize}px`);
  (document.querySelector('[data-action="reset-size"]') as HTMLButtonElement).disabled = fontSize === DEFAULT_FONT_SIZE;
  try {
    localStorage.setItem(FONT_SIZE_KEY, String(fontSize));
  } catch {
    // Remembering this is only a convenience.
  }
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

const actions: Record<string, (button: HTMLButtonElement) => void> = {
  sidebar: toggleSidebar,
  new: newFile,
  open: openFile,
  save: () => saveFile(),
  bold: () => view.editor?.chain().focus().toggleBold().run(),
  italic: () => view.editor?.chain().focus().toggleItalic().run(),
  underline: () => view.editor?.chain().focus().toggleUnderline().run(),
  strike: () => view.editor?.chain().focus().toggleStrike().run(),
  link: editLink,
  note: () => view.toggleNote(),
  attach: (button) => toggleMenu(button, attachMenu),
  cite,
  smaller: () => stepFontSize(-1),
  larger: () => stepFontSize(1),
  "reset-size": () => setFontSize(DEFAULT_FONT_SIZE),
  // The filter button handles its own clicks (see filters.ts).
};

const toolbar = document.querySelector<HTMLElement>(".toolbar")!;
insertIcons(toolbar);
const markButtons = [...toolbar.querySelectorAll<HTMLButtonElement>("[data-mark]")];

for (const button of toolbar.querySelectorAll<HTMLButtonElement>("button")) {
  button.title = button.title.replace(/Mod\+/g, isMac ? "⌘" : "Ctrl+");
  // Stop the button taking focus away from the text being edited.
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", () => actions[button.dataset.action!]?.(button));
}

view.onEditorChange = (editor: Editor | null) => {
  for (const button of markButtons) {
    button.disabled = !editor;
    button.classList.toggle("active", !!editor?.isActive(button.dataset.mark!));
  }
};
view.onEditorChange(null);

let sidebarHidden = false;
try {
  sidebarHidden = localStorage.getItem(SIDEBAR_KEY) === "true";
} catch {
  // Use the default.
}
setSidebarHidden(sidebarHidden);

let savedFontSize = DEFAULT_FONT_SIZE;
try {
  savedFontSize = Number(localStorage.getItem(FONT_SIZE_KEY)) || DEFAULT_FONT_SIZE;
} catch {
  // Use the default.
}
setFontSize(savedFontSize);

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

window.addEventListener(
  "keydown",
  (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && ["n", "o", "s"].includes(key)) {
      // File shortcuts work everywhere, so stop the editor seeing them.
      e.preventDefault();
      e.stopPropagation();
      if (key === "n") newFile();
      else if (key === "o") openFile();
      else saveFile(e.shiftKey);
      return;
    }
    if (mod && ["=", "+", "-", "_"].includes(e.key)) {
      // ⌘+ (often typed as ⌘=) and ⌘− change the outline's text size.
      e.preventDefault();
      e.stopPropagation();
      stepFontSize(e.key === "=" || e.key === "+" ? 1 : -1);
      return;
    }
    if (mod && e.key === "\\") {
      e.preventDefault();
      toggleSidebar();
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    if (mod && key === "f") {
      e.preventDefault();
      e.stopPropagation();
      filters.focusSearch();
      return;
    }
    if (mod && e.shiftKey && key === "t") {
      e.preventDefault();
      e.stopPropagation();
      showTagMenu();
      return;
    }
    const target = e.target as HTMLElement;
    if (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
    if (view.handleKey(e)) e.preventDefault();
  },
  true,
);

setDirty(false);
view.edit(view.selectedId!, "topic");
