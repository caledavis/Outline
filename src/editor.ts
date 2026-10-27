// Text editing uses TipTap. To stay lightweight, only one editor exists at a
// time: it's created inside whichever cell (or note) you click, and removed
// again when you move elsewhere. Every other cell is plain, static HTML.

import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

export type EditorKind = "cell" | "note";

/** Keys the outline handles itself (adding rows, indenting, moving…). */
const OUTLINE_KEYS = [
  "Enter", "Tab", "Shift-Tab", "Escape", "ArrowUp", "ArrowDown",
  "Mod-'", "Mod-.", "Mod-Backspace", "Mod-Shift-ArrowUp", "Mod-Shift-ArrowDown",
  "Mod-z", "Mod-Shift-z", "Mod-y", "Mod-k",
  // Apply styles 1–9, or remove the style with 0.
  "Mod-0", "Mod-1", "Mod-2", "Mod-3", "Mod-4", "Mod-5", "Mod-6", "Mod-7", "Mod-8", "Mod-9",
];

export interface EditorHooks {
  /** Return true if the key was handled, false to let the editor handle it. */
  onKey: (key: string, editor: Editor) => boolean;
  onChange: () => void;
  onSelectionChange: (editor: Editor) => void;
}

export function createEditor(element: HTMLElement, html: string, hooks: EditorHooks): Editor {
  const outlineKeys = Extension.create({
    name: "outlineKeys",
    priority: 1000, // run before the editor's own shortcuts
    addKeyboardShortcuts() {
      return Object.fromEntries(OUTLINE_KEYS.map((key) => [key, () => hooks.onKey(key, this.editor)]));
    },
  });

  return new Editor({
    element,
    content: html,
    extensions: [
      StarterKit.configure({
        // Rows are the outline's structure, so block-level features are off for now.
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        trailingNode: false,
        dropcursor: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
      }),
      outlineKeys,
    ],
    // Ask the webview for the system's spell checker and autocorrect.
    editorProps: { attributes: { spellcheck: "true", autocorrect: "on" } },
    onUpdate: hooks.onChange,
    onTransaction: ({ editor }) => hooks.onSelectionChange(editor),
  });
}

/** The editor's contents in the form we store in the outline. */
export function editorHtml(editor: Editor, kind: EditorKind): string {
  if (editor.isEmpty) return "";
  const html = editor.getHTML();
  if (kind === "cell") {
    // A cell is normally one paragraph; store just its contents so the file
    // reads `text="Chapter 1"` rather than `text="<p>Chapter 1</p>"`.
    const single = html.match(/^<p>(.*)<\/p>$/s);
    if (single && !single[1].includes("</p>")) return single[1];
  }
  return html;
}
