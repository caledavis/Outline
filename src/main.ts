// Wires the outline view to the window: toolbar, file handling, shortcuts.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import type { Editor } from "@tiptap/core";
import { Filters } from "./filters";
import { FileText, Globe, Plus, X, icon, insertIcons } from "./icons";
import { toggleMenu, type MenuEntry } from "./menu";
import { NORMAL_TEXT_SIZE, allTags, assignIds, cleanTags, newDoc, type Link, type OutlineDoc } from "./model";
import { promptText } from "./prompt";
import { Sidebar } from "./sidebar";
import { OutlineView, isMac, type ViewState } from "./view";
import { chooseZoteroItems } from "./zotero";

const FILTERS = [{ name: "Outline (OPML)", extensions: ["opml"] }];

const view = new OutlineView(document.getElementById("outline")!);
const sidebar = new Sidebar(document.getElementById("sidebar")!, view);
const filters = new Filters(view);

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/**
 * An open outline. One view shows the active tab; the others keep their
 * document, selection, filter and undo history in `state` until they're
 * shown again.
 */
interface Tab {
  path: string | null;
  dirty: boolean;
  state: ViewState | null;
}

const tabBar = document.getElementById("tabs")!;
const documentName = document.getElementById("document-name")!;

// Lets the stylesheet leave room for the Mac's window buttons in the toolbar.
document.documentElement.dataset.platform = isMac ? "mac" : "other";
const tabs: Tab[] = [];
let active: Tab;

function fileName(p: string | null): string {
  return p ? p.split(/[\\/]/).pop()!.replace(/\.opml$/i, "") : "Untitled";
}

/** Opens a document in a new tab and shows it. */
function addTab(doc: OutlineDoc, path: string | null) {
  // New tabs open next to the one showing.
  const index = active ? tabs.indexOf(active) + 1 : tabs.length;
  if (active) active.state = view.saveState();
  active = { path, dirty: false, state: null };
  tabs.splice(index, 0, active);
  view.load(doc);
  showActive();
}

function switchTo(tab: Tab) {
  if (tab === active) return;
  active.state = view.saveState();
  active = tab;
  view.restoreState(tab.state!);
  tab.state = null;
  showActive();
}

/** Switches to the tab `offset` places along, wrapping round. */
function switchBy(offset: number) {
  switchTo(tabs[(tabs.indexOf(active) + offset + tabs.length) % tabs.length]);
}

/** Brings everything outside the outline up to date after the active tab changes. */
function showActive() {
  sidebar.refresh();
  renderTabs();
  updateTitle();
}

async function closeTab(tab: Tab) {
  if (tab.dirty) switchTo(tab); // so it's clear which outline the question is about
  if (!(await confirmDiscard(tab))) return;
  const index = tabs.indexOf(tab);
  tabs.splice(index, 1);
  if (tab !== active) {
    renderTabs();
  } else if (tabs.length) {
    active = tabs[Math.min(index, tabs.length - 1)];
    view.restoreState(active.state!);
    active.state = null;
    showActive();
  } else {
    active = undefined!;
    addTab(newDoc(), null);
  }
}

function renderTabs() {
  const items = tabs.map((tab) => {
    const item = document.createElement("div");
    item.className = "tab";
    item.classList.toggle("active", tab === active);
    item.classList.toggle("dirty", tab.dirty);
    item.title = (tab.path ?? "Untitled") + (tab.dirty ? " (unsaved)" : "");
    item.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault(); // no autoscroll on middle-click
    });
    item.addEventListener("click", () => switchTo(tab));
    item.draggable = true;
    item.addEventListener("dragstart", (e) => {
      draggedTab = tab;
      e.dataTransfer!.setData("application/x-outline-tab", "");
      e.dataTransfer!.effectAllowed = "move";
    });
    item.addEventListener("dragend", () => {
      draggedTab = null;
      showTabDrop(null);
    });
    item.addEventListener("auxclick", (e) => {
      if (e.button === 1) closeTab(tab);
    });

    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = fileName(tab.path);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.title = `Close (${isMac ? "⌘" : "Ctrl+"}W)`;
    close.setAttribute("aria-label", `Close ${fileName(tab.path)}`);
    close.append(icon(X, 13));
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab);
    });

    item.append(icon(FileText, 14), name, close);
    return item;
  });

  const add = document.createElement("button");
  add.className = "tab-new";
  add.title = `New outline (${isMac ? "⌘" : "Ctrl+"}N)`;
  add.setAttribute("aria-label", "New outline");
  add.append(icon(Plus, 15));
  add.addEventListener("click", newFile);

  tabBar.replaceChildren(...items, add);
  tabBar.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// Dragging a tab along the bar moves it.

let draggedTab: Tab | null = null;

/** Where a dragged tab would land: the index of the tab it would go before (or tabs.length, for the end). */
function tabDropIndex(e: DragEvent): number {
  const items = [...tabBar.querySelectorAll<HTMLElement>(".tab")];
  const index = items.findIndex((item) => {
    const box = item.getBoundingClientRect();
    return e.clientX < box.left + box.width / 2;
  });
  return index < 0 ? items.length : index;
}

/** Shows a line where a dragged tab would land, or hides it (null). */
function showTabDrop(index: number | null) {
  for (const item of tabBar.querySelectorAll(".drop-before, .drop-after")) item.classList.remove("drop-before", "drop-after");
  if (index === null) return;
  const items = tabBar.querySelectorAll(".tab");
  if (index < items.length) items[index].classList.add("drop-before");
  else items[items.length - 1]?.classList.add("drop-after");
}

tabBar.addEventListener("dragover", (e) => {
  if (!draggedTab) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
  showTabDrop(tabDropIndex(e));
});

tabBar.addEventListener("dragleave", (e) => {
  if (!tabBar.contains(e.relatedTarget as Node | null)) showTabDrop(null);
});

tabBar.addEventListener("drop", (e) => {
  if (!draggedTab) return;
  e.preventDefault();
  const from = tabs.indexOf(draggedTab);
  const to = tabDropIndex(e);
  tabs.splice(from, 1);
  tabs.splice(to > from ? to - 1 : to, 0, draggedTab);
  draggedTab = null;
  renderTabs();
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Names the active outline in the window's title and, as macOS hides that, the toolbar. */
function updateTitle() {
  getCurrentWindow().setTitle(`${active.dirty ? "• " : ""}${fileName(active.path)} — Outline`);
  documentName.textContent = fileName(active.path);
  documentName.title = active.path ?? "";
}

function setDirty(value: boolean) {
  active.dirty = value;
  updateTitle();
  renderTabs();
}

view.onChange = () => {
  if (!active.dirty) setDirty(true);
  sidebar.refresh();
};
view.onSelectionChange = () => sidebar.updateSelection();
view.onFilterChange = () => {
  filters.update();
  sidebar.refresh();
};

/** Asks before throwing away a tab's unsaved changes. Returns true if it's OK to continue. */
async function confirmDiscard(tab: Tab): Promise<boolean> {
  if (tab === active) view.flush();
  if (!tab.dirty) return true;
  return ask(`Do you want to discard your changes to “${fileName(tab.path)}”?`, {
    title: "Unsaved changes",
    kind: "warning",
    okLabel: "Discard",
    cancelLabel: "Cancel",
  });
}

/** Whether the active tab is a new outline nobody has typed in, which opening a file can replace. */
function activeIsBlank(): boolean {
  view.flush();
  return !active.path && !active.dirty;
}

function newFile() {
  addTab(newDoc(), null);
  view.edit(view.selectedId!, "topic");
}

async function openFile() {
  const chosen = await open({ multiple: true, directory: false, filters: FILTERS });
  if (chosen?.length) await openPaths(chosen);
}

/** Opens outlines in tabs, or switches to them if they're already open. */
async function openPaths(paths: string[]) {
  for (const path of paths) {
    const already = tabs.find((tab) => tab.path === path);
    if (already) {
      switchTo(already);
      continue;
    }
    try {
      const doc = await invoke<OutlineDoc>("open_outline", { path });
      assignIds(doc.rows);
      if (activeIsBlank()) {
        active.path = path;
        view.load(doc);
        showActive();
      } else {
        addTab(doc, path);
      }
    } catch (error) {
      await message(`${fileName(path)}: ${error}`, { title: "Could not open file", kind: "error" });
    }
  }
}

async function saveFile(saveAs = false) {
  view.flush();
  const tab = active;
  let target = tab.path;
  if (!target || saveAs) {
    target = await save({ filters: FILTERS, defaultPath: `${fileName(tab.path)}.opml` });
    if (!target) return;
    if (!/\.opml$/i.test(target)) target += ".opml";
  }
  try {
    view.doc.title = fileName(target);
    await invoke("save_outline", { path: target, doc: view.doc });
    tab.path = target;
    setDirty(false);
  } catch (error) {
    await message(String(error), { title: "Could not save file", kind: "error" });
  }
}

getCurrentWindow().onCloseRequested(async (event) => {
  view.flush();
  const unsaved = tabs.filter((tab) => tab.dirty);
  if (!unsaved.length) return;
  const names = unsaved.map((tab) => `“${fileName(tab.path)}”`).join(", ");
  const discard = await ask(
    unsaved.length === 1
      ? `Do you want to discard your changes to ${names}?`
      : `${unsaved.length} outlines have unsaved changes: ${names}. Do you want to discard them?`,
    { title: "Unsaved changes", kind: "warning", okLabel: "Discard", cancelLabel: "Cancel" },
  );
  if (!discard) event.preventDefault();
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

// A preference for this computer, not part of the outline file. Only a size
// the user picked is saved, so a change to the default reaches everyone else.
// (The key was renamed when this began, since the old one stored the default
// too.)
const FONT_SIZE_KEY = "outlineTextSize";
const DEFAULT_FONT_SIZE = NORMAL_TEXT_SIZE;
/** The sizes − and + step through, each about 10–20% bigger than the last. */
const FONT_SIZES = [8, 10, 12, 14, 16, 18, 21, 24, 28, 32];
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
    if (fontSize === DEFAULT_FONT_SIZE) localStorage.removeItem(FONT_SIZE_KEY);
    else localStorage.setItem(FONT_SIZE_KEY, String(fontSize));
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
    if (mod && !e.shiftKey && ["n", "t", "o", "w"].includes(key) || mod && key === "s") {
      // File shortcuts work everywhere, so stop the editor seeing them.
      e.preventDefault();
      e.stopPropagation();
      if (key === "n" || key === "t") newFile();
      else if (key === "o") openFile();
      else if (key === "w") closeTab(active);
      else saveFile(e.shiftKey);
      return;
    }
    // Next and previous tab: Ctrl+Tab and Ctrl+Shift+Tab, or ⌘⇧] and ⌘⇧[ on a Mac.
    if (e.ctrlKey && e.key === "Tab" || mod && e.shiftKey && ["[", "]", "{", "}"].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      switchBy(e.key === "Tab" ? (e.shiftKey ? -1 : 1) : ["[", "{"].includes(e.key) ? -1 : 1);
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

addTab(view.doc, null);
view.edit(view.selectedId!, "topic");

// Outlines opened from outside the app, e.g. by double-clicking one in the
// Finder. Rust holds on to them until they're taken, so none are missed
// while the page is still loading.
async function openSystemFiles() {
  const paths = await invoke<string[]>("take_opened_files");
  if (paths.length) await openPaths(paths);
}
listen("files-opened", openSystemFiles).then(openSystemFiles);
