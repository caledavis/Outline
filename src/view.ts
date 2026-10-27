// Draws the outline as a grid and turns clicks, keys and drags into changes
// to the document (via the functions in model.ts).

import type { Editor } from "@tiptap/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createEditor, editorHtml, type EditorKind } from "./editor";
import { ChevronDown, ChevronRight, GripVertical, Plus, X, icon } from "./icons";
import * as model from "./model";
import { TOPIC, type Column, type OutlineDoc, type Row } from "./model";
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

interface Drag {
  rowId: string;
  /** The dragged row's depth and the pointer's x position when the drag began. */
  depth: number;
  startX: number;
}

/** Where a dragged row would land if dropped now. */
interface DropPlacement {
  parentId: string | null;
  index: number;
  depth: number;
  /** Vertical position of the gap, in the outline's scrolling coordinates. */
  y: number;
}

const GUTTER_PX = 28;
const DEFAULT_COLUMN_PX = 160;
const MIN_COLUMN_PX = 60;

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
  private drag: Drag | null = null;
  private dropLine = el("div", "drop-line");

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
    this.updateColumnWidths();
    const rows = el("div", "rows");
    for (const { row, depth } of model.visibleRows(this.doc)) rows.append(this.renderRow(row, depth));
    this.root.replaceChildren(this.renderHeader(), rows);
  }

  /**
   * Sets the grid's column sizes. The Topic column fills the spare width until
   * it's resized by hand; every other column has a fixed width. Once nothing
   * else is stretching, the last track (holding the + button) takes up the
   * spare width, so the button always sits at the far right.
   */
  private updateColumnWidths() {
    const widths = this.doc.columns.map((c) =>
      c.width ? `${c.width}px` : c.id === TOPIC ? "minmax(240px, 1fr)" : `${DEFAULT_COLUMN_PX}px`,
    );
    const topicStretches = widths[this.doc.columns.findIndex((c) => c.id === TOPIC)]?.includes("fr");
    const last = topicStretches ? "36px" : "minmax(36px, 1fr)";
    this.root.style.setProperty("--grid", [`${GUTTER_PX}px`, ...widths, last].join(" "));
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
        remove.append(icon(X, 14));
        remove.title = "Delete column";
        remove.setAttribute("aria-label", "Delete column");
        remove.addEventListener("click", () => this.deleteColumn(column.id));
        cell.append(remove);
      }
      const resizer = el("div", "resizer");
      resizer.title = "Drag to resize; double-click to reset";
      resizer.addEventListener("pointerdown", (e) => this.startResize(e, column, cell));
      resizer.addEventListener("dblclick", () => this.resetWidth(column));
      cell.append(resizer);
      header.append(cell);
    }

    const add = el("button", "add-column");
    add.append(icon(Plus));
    add.title = "Add column";
    add.setAttribute("aria-label", "Add column");
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
    handle.append(icon(GripVertical, 14));
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
          toggle.append(icon(row.collapsed ? ChevronRight : ChevronDown, 14));
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

  private startResize(e: PointerEvent, column: Column, headerCell: HTMLElement) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.target as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");

    const before = JSON.stringify(this.doc);
    const originalWidth = column.width;
    const startX = e.clientX;
    // Measure the column as drawn, since the Topic column may be stretching to fill.
    const startWidth = headerCell.getBoundingClientRect().width;

    const move = (ev: PointerEvent) => {
      column.width = Math.max(MIN_COLUMN_PX, Math.round(startWidth + ev.clientX - startX));
      this.updateColumnWidths();
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing");
      if (column.width !== originalWidth) {
        this.pushUndo(before);
        this.onChange();
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  private resetWidth(column: Column) {
    if (column.width == null) return;
    this.pushUndo();
    column.width = null;
    this.updateColumnWidths();
    this.onChange();
  }

  // -------------------------------------------------------------------------
  // Drag and drop
  // -------------------------------------------------------------------------

  private handleDragStart(e: DragEvent) {
    const handle = e.target as HTMLElement;
    const rowEl = handle.closest<HTMLElement>(".row");
    if (!rowEl || !handle.classList.contains("handle")) return;
    this.stopEditing();
    const rowId = rowEl.dataset.id!;
    const depth = model.path(this.doc, rowId).length - 1;
    this.drag = { rowId, depth, startX: e.clientX };
    this.select(rowId);
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", "");
    e.dataTransfer!.setDragImage(rowEl, 12, 12);
    rowEl.classList.add("dragging");
  }

  /**
   * Works out where the dragged row would land. The pointer's height picks the
   * gap between two rows; how far it has moved sideways since the drag began
   * picks the level: right to nest under the row above, left to move up levels.
   */
  private dropPlacement(e: DragEvent): DropPlacement {
    const drag = this.drag!;
    const dragged = model.locate(this.doc, drag.rowId)!.row;
    // The dragged row and its children can't be drop targets.
    const visible = model
      .visibleRows(this.doc)
      .filter((v) => v.row !== dragged && !model.contains(dragged, v.row.id));
    const rects = visible.map((v) => this.rowElement(v.row.id)!.getBoundingClientRect());

    // The gap is just after the last row whose middle is above the pointer.
    let gap = 0;
    while (gap < rects.length && e.clientY > rects[gap].top + rects[gap].height / 2) gap++;
    const above = visible[gap - 1];
    const below = visible[gap];

    // Deepest: a child of the row above. Shallowest: level with the row below
    // (going any shallower would put the row after the one below instead).
    const deepest = above ? above.depth + 1 : 0;
    const shallowest = below ? below.depth : 0;
    const wanted = drag.depth + Math.round((e.clientX - drag.startX) / INDENT_PX);
    const depth = Math.max(shallowest, Math.min(deepest, wanted));

    let parentId: string | null = null;
    let index = 0;
    if (above && depth === above.depth + 1) {
      parentId = above.row.id; // first child of the row above
    } else if (above) {
      // Just after whichever of the above row's ancestors sits at this depth.
      const anchor = model.locate(this.doc, model.path(this.doc, above.row.id)[depth].id)!;
      parentId = anchor.parent?.id ?? null;
      index = anchor.index + 1;
    }

    const rootTop = this.root.getBoundingClientRect().top - this.root.scrollTop;
    const gapY = above ? rects[gap - 1].bottom : (rects[0]?.top ?? rootTop);
    return { parentId, index, depth, y: gapY - rootTop };
  }

  private handleDragOver(e: DragEvent) {
    if (!this.drag) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    const placement = this.dropPlacement(e);

    this.dropLine.style.top = `${placement.y - 1}px`;
    this.dropLine.style.left = `${GUTTER_PX + placement.depth * INDENT_PX + 22}px`;
    if (!this.dropLine.isConnected) this.root.append(this.dropLine);

    this.root.querySelector(".drop-parent")?.classList.remove("drop-parent");
    if (placement.parentId) this.rowElement(placement.parentId)?.classList.add("drop-parent");
  }

  private handleDrop(e: DragEvent) {
    if (!this.drag) return;
    e.preventDefault();
    const { parentId, index } = this.dropPlacement(e);
    const rowId = this.drag.rowId;
    this.clearDrag();
    this.change(() => model.moveRow(this.doc, rowId, parentId, index));
  }

  private clearDrag() {
    this.dropLine.remove();
    this.root.querySelector(".drop-parent")?.classList.remove("drop-parent");
    this.root.querySelector(".dragging")?.classList.remove("dragging");
    this.drag = null;
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
