// Wires the outline view to the window: toolbar, file handling, shortcuts.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import type { Editor } from "@tiptap/core";
import { insertIcons } from "./icons";
import { assignIds, newDoc, type OutlineDoc } from "./model";
import { OutlineView, isMac } from "./view";

const FILTERS = [{ name: "Outline (OPML)", extensions: ["opml"] }];

const view = new OutlineView(document.getElementById("outline")!);
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

const promptDialog = document.getElementById("prompt") as HTMLDialogElement;
const promptInput = document.getElementById("prompt-input") as HTMLInputElement;

/** A small text-entry dialog. Resolves to null if cancelled. */
function promptText(label: string, value: string): Promise<string | null> {
  document.getElementById("prompt-label")!.textContent = label;
  promptInput.value = value;
  promptDialog.returnValue = "";
  promptDialog.showModal();
  promptInput.select();
  return new Promise((resolve) => {
    promptDialog.addEventListener(
      "close",
      () => resolve(promptDialog.returnValue === "ok" ? promptInput.value.trim() : null),
      { once: true },
    );
  });
}

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

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

const actions: Record<string, () => void> = {
  new: newFile,
  open: openFile,
  save: () => saveFile(),
  bold: () => view.editor?.chain().focus().toggleBold().run(),
  italic: () => view.editor?.chain().focus().toggleItalic().run(),
  underline: () => view.editor?.chain().focus().toggleUnderline().run(),
  strike: () => view.editor?.chain().focus().toggleStrike().run(),
  link: editLink,
  note: () => view.toggleNote(),
};

const toolbar = document.querySelector<HTMLElement>(".toolbar")!;
insertIcons(toolbar);
const markButtons = [...toolbar.querySelectorAll<HTMLButtonElement>("[data-mark]")];

for (const button of toolbar.querySelectorAll<HTMLButtonElement>("button")) {
  button.title = button.title.replace(/Mod\+/g, isMac ? "⌘" : "Ctrl+");
  // Stop the button taking focus away from the text being edited.
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", () => actions[button.dataset.action!]?.());
}

view.onEditorChange = (editor: Editor | null) => {
  for (const button of markButtons) {
    button.disabled = !editor;
    button.classList.toggle("active", !!editor?.isActive(button.dataset.mark!));
  }
};
view.onEditorChange(null);

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
    const target = e.target as HTMLElement;
    if (promptDialog.open || target.isContentEditable || target.tagName === "INPUT") return;
    if (view.handleKey(e)) e.preventDefault();
  },
  true,
);

setDirty(false);
view.edit(view.selectedId!, "topic");
