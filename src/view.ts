// Draws the outline as a grid and turns clicks, keys and drags into changes
// to the document (via the functions in model.ts).

import type { Editor } from "@tiptap/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createEditor, editorHtml, type EditorKind } from "./editor";
import * as model from "./model";
import { TOPIC, type DropPosition, type OutlineDoc, type Row } from "./model";
import { sanitize } from "./sanitize";

/** Field name used for a row's note (every other field is a column id). */
const NOTE = "note";
const INDENT_PX = 20;
const MAX_UNDO = 200;

export const isMac = /Mac/.test(navigator.userAgent);

interface Editing {
  rowId: string;
  field: string;
  editor: Editor;
  /** The contents last written to the document, to detect changes. */
  saved: string;
}

type CursorPosition = "start" | "end" | number;

export class OutlineView {
  doc: OutlineDoc = model.newDoc();
  selectedId: string | null = null;

  /** Called whenever the document changes (including while typing). */
  onChange = () => {};
  /** Called when the formatting toolbar should refresh. */
  onEditorChange: (editor: Editor | null) => void = () => {};
  /** Called when the user presses the link shortcut. */
  onLinkRequest = () => {};

  private editing: Editing | null = null;
  /** A row whose (still empty) note is open for editing. */
  private openNoteId: string | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private dragId: string | null = null;

  constructor(private root: HTMLElement) {
    root.addEventListener("click", (e) => this.handleClick(e));
    root.addEventListener("dragstart", (e) => this.handleDragStart(e));
    root.addEventListener("dragover", (e) => this.handleDragOver(e));
    root.addEventListener("drop", (e) => this.handleDrop(e));
    root.addEventListener("dragend", () => this.clearDrag());
    this.load(this.doc);
  }

  get editor(): Editor | null {
    return this.editing?.editor ?? null;
  }

  load(doc: OutlineDoc) {
    this.stopEditing(false);
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    if (doc.rows.length === 0) doc.rows.push(model.newRow());
    this.selectedId = doc.rows[0].id;
    this.render();
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  render() {
    const columns = this.doc.columns;
    const widths = columns.map((c) => (c.id === TOPIC ? "minmax(240px, 1fr)" : `${c.width ?? 160}px`));
    this.root.style.setProperty("--grid", ["28px", ...widths, "32px"].join(" "));

    const rows = el("div", "rows");
    for (const { row, depth } of model.visibleRows(this.doc)) rows.append(this.renderRow(row, depth));
    this.root.replaceChildren(this.renderHeader(), rows);
  }

  private renderHeader(): HTMLElement {
    const header = el("div", "header");
    header.append(el("div", "gutter"));

    for (const column of this.doc.columns) {
      const cell = el("div", "hcell");
      const name = el("span", "name");
      name.textContent = column.name;
      name.contentEditable = "plaintext-only";
      name.spellcheck = false;
      name.title = "Click to rename";
      name.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "Escape") {
          if (e.key === "Escape") name.textContent = column.name;
          e.preventDefault();
          name.blur();
        }
      });
      name.addEventListener("blur", () => this.renameColumn(column.id, name.textContent ?? ""));
      cell.append(name);

      if (column.id !== TOPIC) {
        const remove = el("button", "delete-column");
        remove.textContent = "×";
        remove.title = "Delete column";
        remove.addEventListener("click", () => this.deleteColumn(column.id));
        const resizer = el("div", "resizer");
        resizer.addEventListener("pointerdown", (e) => this.startResize(e, column.id));
        cell.append(remove, resizer);
      }
      header.append(cell);
    }

    const add = el("button", "add-column");
    add.textContent = "+";
    add.title = "Add column";
    add.addEventListener("click", () => this.addColumn());
    header.append(add);
    return header;
  }

  private renderRow(row: Row, depth: number): HTMLElement {
    const rowEl = el("div", "row");
    rowEl.dataset.id = row.id;
    rowEl.classList.toggle("selected", row.id === this.selectedId);

    const gutter = el("div", "gutter");
    const handle = el("span", "handle");
    handle.textContent = "⠿";
    handle.draggable = true;
    handle.title = "Drag to move";
    gutter.append(handle);
    rowEl.append(gutter);

    for (const column of this.doc.columns) {
      const cell = el("div", "cell");
      cell.dataset.field = column.id;
      if (column.id === TOPIC) {
        cell.classList.add("topic");
        cell.style.paddingLeft = `${depth * INDENT_PX + 4}px`;
        const toggle = el("button", "toggle");
        toggle.tabIndex = -1;
        if (row.children.length) {
          toggle.textContent = row.collapsed ? "▸" : "▾";
          toggle.title = row.collapsed ? "Expand" : "Collapse";
        } else {
          toggle.classList.add("leaf");
        }
        cell.append(toggle);
      }
      cell.append(content(row.cells[column.id] ?? ""));
      rowEl.append(cell);
    }
    rowEl.append(el("div"));

    if (row.note || row.id === this.openNoteId) {
      const note = el("div", "note");
      note.dataset.field = NOTE;
      note.style.paddingLeft = `${depth * INDENT_PX + 26}px`;
      note.append(content(row.note));
      rowEl.append(note);
    }
    return rowEl;
  }

  private rowElement(id: string): HTMLElement | null {
    return this.root.querySelector(`.row[data-id="${id}"]`);
  }

  select(id: string | null) {
    this.selectedId = id;
    this.root.querySelector(".row.selected")?.classList.remove("selected");
    if (!id) return;
    const rowEl = this.rowElement(id);
    rowEl?.classList.add("selected");
    rowEl?.scrollIntoView({ block: "nearest" });
  }

  // -------------------------------------------------------------------------
  // Editing text
  // -------------------------------------------------------------------------

  edit(rowId: string, field: string, cursor: CursorPosition = "end") {
    this.stopEditing();
    const row = model.locate(this.doc, rowId)?.row;
    if (!row) return;
    if (field === NOTE && !row.note && this.openNoteId !== rowId) {
      this.openNoteId = rowId;
      this.render();
    }
    this.select(rowId);

    const target = this.rowElement(rowId)?.querySelector<HTMLElement>(`[data-field="${field}"] .content`);
    if (!target) return;
    const kind: EditorKind = field === NOTE ? "note" : "cell";
    const html = sanitize(field === NOTE ? row.note : (row.cells[field] ?? ""));
    target.replaceChildren();

    const editor = createEditor(target, html, {
      onKey: (key, ed) => this.handleEditorKey(key, ed),
      onChange: () => this.onChange(),
      onSelectionChange: (ed) => this.onEditorChange(ed),
    });
    this.editing = { rowId, field, editor, saved: editorHtml(editor, kind) };
    editor.commands.focus(cursor);
    this.onEditorChange(editor);
  }

  /** Copies the text being edited into the document, without leaving the cell. */
  flush() {
    const editing = this.editing;
    if (!editing) return;
    const html = editorHtml(editing.editor, editing.field === NOTE ? "note" : "cell");
    if (html === editing.saved) return;
    const row = model.locate(this.doc, editing.rowId)?.row;
    if (!row) return;
    this.pushUndo();
    if (editing.field === NOTE) row.note = html;
    else row.cells[editing.field] = html;
    editing.saved = html;
    this.onChange();
  }

  stopEditing(save = true) {
    const editing = this.editing;
    if (!editing) return;
    if (save) this.flush();
    this.editing = null;
    editing.editor.destroy();

    const rowEl = this.rowElement(editing.rowId);
    const target = rowEl?.querySelector(`[data-field="${editing.field}"]`);
    if (editing.field === NOTE && !editing.saved) {
      this.openNoteId = null;
      target?.remove();
    } else {
      target?.querySelector(".content")?.replaceWith(content(editing.saved));
    }
    this.onEditorChange(null);
  }

  private handleEditorKey(key: string, editor: Editor): boolean {
    const { rowId, field } = this.editing!;
    switch (key) {
      case "Enter":
        if (field === NOTE) return false;
        this.addRow();
        return true;
      case "Escape":
        this.stopEditing();
        return true;
      case "ArrowUp":
      case "ArrowDown":
        // Move between rows only from the first/last line of a cell.
        if (field === NOTE || !editor.view.endOfTextblock(key === "ArrowUp" ? "up" : "down")) return false;
        this.moveSelection(key === "ArrowUp" ? -1 : 1);
        return true;
      case "Mod-z":
        if (editor.can().undo()) return false;
        this.undo();
        return true;
      case "Mod-Shift-z":
      case "Mod-y":
        if (editor.can().redo()) return false;
        this.redo();
        return true;
      case "Mod-k":
        this.onLinkRequest();
        return true;
      case "Mod-'":
        if (field === NOTE) this.edit(rowId, TOPIC);
        else this.toggleNote();
        return true;
      default:
        return this.shortcut(key);
    }
  }

  // -------------------------------------------------------------------------
  // Keyboard and mouse
  // -------------------------------------------------------------------------

  /** Keys pressed while a row is selected but no text is being edited. */
  handleKey(e: KeyboardEvent): boolean {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = (mod ? "Mod-" : "") + (e.shiftKey ? "Shift-" : "") + (e.key.length === 1 ? e.key.toLowerCase() : e.key);
    switch (key) {
      case "Enter":
        if (this.selectedId) this.edit(this.selectedId, TOPIC);
        return !!this.selectedId;
      case "ArrowUp":
      case "ArrowDown":
        this.moveSelection(key === "ArrowUp" ? -1 : 1);
        return true;
      case "Backspace":
      case "Delete":
        this.deleteRow();
        return true;
      case "Mod-z":
        this.undo();
        return true;
      case "Mod-Shift-z":
      case "Mod-y":
        this.redo();
        return true;
      case "Mod-'":
        this.toggleNote();
        return true;
      default:
        return this.shortcut(key);
    }
  }

  /** Shortcuts that work the same whether or not you're editing text. */
  private shortcut(key: string): boolean {
    switch (key) {
      case "Tab": this.indent(); return true;
      case "Shift-Tab": this.outdent(); return true;
      case "Mod-.": this.toggleCollapse(); return true;
      case "Mod-Backspace": this.deleteRow(); return true;
      case "Mod-Shift-ArrowUp": this.moveRow(-1); return true;
      case "Mod-Shift-ArrowDown": this.moveRow(1); return true;
      default: return false;
    }
  }

  private handleClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const rowId = target.closest<HTMLElement>(".row")?.dataset.id;

    const link = target.closest("a");
    if (link) {
      e.preventDefault(); // never navigate the app window away
      if (isMac ? e.metaKey : e.ctrlKey) {
        openUrl(link.href);
        return;
      }
    }
    if (target.closest(".toggle")) {
      if (rowId) this.toggleCollapse(rowId);
      return;
    }
    const field = target.closest<HTMLElement>("[data-field]")?.dataset.field;
    if (rowId && field) {
      if (this.editing?.rowId !== rowId || this.editing.field !== field) this.edit(rowId, field);
    } else if (rowId) {
      this.stopEditing();
      this.select(rowId);
    } else if (target === this.root || target.classList.contains("rows")) {
      this.stopEditing();
    }
  }

  private moveSelection(delta: -1 | 1) {
    const visible = model.visibleRows(this.doc);
    const index = visible.findIndex((v) => v.row.id === this.selectedId);
    const next = visible[index + delta] ?? (index === -1 ? visible[0] : null);
    if (!next) return;
    if (this.editing && this.editing.field !== NOTE) {
      this.edit(next.row.id, this.editing.field, delta < 0 ? "end" : "start");
    } else {
      this.stopEditing();
      this.select(next.row.id);
    }
  }

  // -------------------------------------------------------------------------
  // Changing the outline's structure
  // -------------------------------------------------------------------------

  /**
   * Runs an operation that changes the outline's structure, records it for
   * undo and redraws. `then` says which cell to edit afterwards; by default
   * the cell being edited (if any) carries on being edited.
   */
  private change(operation: () => boolean, then?: { rowId: string; field: string; cursor?: CursorPosition }) {
    const editing = this.editing;
    const cursor = editing?.editor.state.selection.from;
    this.stopEditing();

    const before = JSON.stringify(this.doc);
    if (!operation()) {
      if (editing) this.edit(editing.rowId, editing.field, cursor);
      return;
    }
    this.pushUndo(before);
    this.onChange();
    this.render();

    const next = then ?? (editing && { rowId: editing.rowId, field: editing.field, cursor });
    if (next && this.rowElement(next.rowId)) this.edit(next.rowId, next.field, next.cursor ?? "end");
    else this.select(this.selectedId);
  }

  addRow() {
    const row = model.newRow();
    this.change(() => (model.insertAfter(this.doc, this.selectedId, row), true), { rowId: row.id, field: TOPIC });
  }

  indent() {
    const id = this.selectedId;
    if (id) this.change(() => model.indent(this.doc, id));
  }

  outdent() {
    const id = this.selectedId;
    if (id) this.change(() => model.outdent(this.doc, id));
  }

  moveRow(delta: -1 | 1) {
    const id = this.selectedId;
    if (id) this.change(() => model.moveBy(this.doc, id, delta));
  }

  toggleCollapse(id = this.selectedId) {
    const row = id ? model.locate(this.doc, id)?.row : null;
    if (!row?.children.length) return;
    if (!row.collapsed && this.editing && this.editing.rowId !== row.id) {
      this.stopEditing(); // the row being edited might be about to disappear
      this.selectedId = row.id;
    }
    this.change(() => {
      row.collapsed = !row.collapsed;
      return true;
    });
  }

  deleteRow() {
    const id = this.selectedId;
    if (!id) return;
    const visible = model.visibleRows(this.doc);
    const index = visible.findIndex((v) => v.row.id === id);
    const wasEditing = this.editing;
    this.stopEditing();
    this.change(() => {
      model.removeRow(this.doc, id);
      if (this.doc.rows.length === 0) this.doc.rows.push(model.newRow());
      const remaining = model.visibleRows(this.doc);
      this.selectedId = (remaining[index - 1] ?? remaining[0]).row.id;
      return true;
    });
    if (wasEditing && this.selectedId) this.edit(this.selectedId, TOPIC);
  }

  toggleNote() {
    const id = this.selectedId;
    if (!id) return;
    if (this.editing?.field === NOTE && this.editing.rowId === id) this.edit(id, TOPIC);
    else this.edit(id, NOTE);
  }

  // -------------------------------------------------------------------------
  // Columns
  // -------------------------------------------------------------------------

  addColumn() {
    this.stopEditing();
    this.change(() => (model.addColumn(this.doc), true));
    // Put the cursor in the new column's name so it can be typed straight away.
    const name = this.root.querySelector<HTMLElement>(`.hcell:nth-child(${this.doc.columns.length + 1}) .name`);
    if (name) {
      name.focus();
      getSelection()?.selectAllChildren(name);
    }
  }

  private renameColumn(id: string, name: string) {
    const column = this.doc.columns.find((c) => c.id === id);
    name = name.trim();
    if (!column || !name || name === column.name) {
      if (column && !name) this.render(); // put the old name back
      return;
    }
    this.pushUndo();
    column.name = name;
    this.onChange();
  }

  private async deleteColumn(id: string) {
    const column = this.doc.columns.find((c) => c.id === id);
    if (!column) return;
    const confirmed = await ask(`Delete the column “${column.name}” and everything in it?`, {
      title: "Delete column",
      kind: "warning",
      okLabel: "Delete",
    });
    if (confirmed) this.change(() => (model.removeColumn(this.doc, id), true));
  }

  private startResize(e: PointerEvent, id: string) {
    const column = this.doc.columns.find((c) => c.id === id);
    if (!column) return;
    e.preventDefault();
    const handle = e.target as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const before = JSON.stringify(this.doc);
    const startX = e.clientX;
    const startWidth = column.width ?? 160;

    const move = (ev: PointerEvent) => {
      column.width = Math.max(60, Math.round(startWidth + ev.clientX - startX));
      const widths = this.doc.columns.map((c) => (c.id === TOPIC ? "minmax(240px, 1fr)" : `${c.width ?? 160}px`));
      this.root.style.setProperty("--grid", ["28px", ...widths, "32px"].join(" "));
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      if (column.width !== startWidth) {
        this.pushUndo(before);
        this.onChange();
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }

  // -------------------------------------------------------------------------
  // Drag and drop
  // -------------------------------------------------------------------------

  private handleDragStart(e: DragEvent) {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".row");
    if (!rowEl || !(e.target as HTMLElement).classList.contains("handle")) return;
    this.stopEditing();
    this.dragId = rowEl.dataset.id!;
    this.select(this.dragId);
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", "");
    e.dataTransfer!.setDragImage(rowEl, 12, 12);
    rowEl.classList.add("dragging");
  }

  private dropTarget(e: DragEvent): { rowEl: HTMLElement; position: DropPosition } | null {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".row");
    if (!this.dragId || !rowEl) return null;
    const target = model.locate(this.doc, rowEl.dataset.id!)!.row;
    const dragged = model.locate(this.doc, this.dragId)!.row;
    if (target === dragged || this.isInside(dragged, target.id)) return null;

    const rect = rowEl.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    let position: DropPosition = y < 0.3 ? "before" : y > 0.7 ? "after" : "inside";
    // "After" an expanded parent would land below all its children, far from
    // the pointer; becoming its first child is what the indicator suggests.
    if (position === "after" && target.children.length && !target.collapsed) position = "inside";
    return { rowEl, position };
  }

  private isInside(ancestor: Row, id: string): boolean {
    return ancestor.children.some((c) => c.id === id || this.isInside(c, id));
  }

  private handleDragOver(e: DragEvent) {
    const drop = this.dropTarget(e);
    this.clearDropIndicator();
    if (!drop) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    drop.rowEl.classList.add(`drop-${drop.position}`);
  }

  private handleDrop(e: DragEvent) {
    const drop = this.dropTarget(e);
    const id = this.dragId;
    this.clearDrag();
    if (!drop || !id) return;
    e.preventDefault();
    this.change(() => model.moveTo(this.doc, id, drop.rowEl.dataset.id!, drop.position));
  }

  private clearDropIndicator() {
    this.root
      .querySelectorAll(".drop-before, .drop-after, .drop-inside")
      .forEach((r) => r.classList.remove("drop-before", "drop-after", "drop-inside"));
  }

  private clearDrag() {
    this.clearDropIndicator();
    this.root.querySelector(".dragging")?.classList.remove("dragging");
    this.dragId = null;
  }

  // -------------------------------------------------------------------------
  // Undo
  // -------------------------------------------------------------------------

  private pushUndo(snapshot = JSON.stringify(this.doc)) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    this.stopEditing();
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(JSON.stringify(this.doc));
    this.restore(previous);
  }

  redo() {
    this.stopEditing();
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.doc));
    this.restore(next);
  }

  private restore(snapshot: string) {
    this.doc = JSON.parse(snapshot);
    if (!this.selectedId || !model.locate(this.doc, this.selectedId)) this.selectedId = this.doc.rows[0]?.id ?? null;
    this.onChange();
    this.render();
    this.select(this.selectedId);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function content(html: string): HTMLElement {
  const div = el("div", "content");
  div.innerHTML = sanitize(html);
  return div;
}
