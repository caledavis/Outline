// Draws the outline as a grid and turns clicks, keys and drags into changes
// to the document (via the functions in model.ts).

import type { Editor } from "@tiptap/core";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { createEditor, editorHtml, type EditorKind } from "./editor";
import {
  BookOpen, CalendarDays, ChevronDown, ChevronRight, FileText, Globe, GripVertical, Hash, List,
  Paperclip, Pencil, Plus, RotateCcw, SquareCheck, Tag, Trash2, Type, X, icon,
} from "./icons";
import { toggleMenu, type MenuEntry } from "./menu";
import * as model from "./model";
import { TOPIC, type Column, type ColumnType, type Link, type OutlineDoc, type Row, type Style } from "./model";
import { promptText } from "./prompt";
import { plainText, sanitize } from "./sanitize";
import { fetchZoteroNotes } from "./zotero";

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

/** What the outline is narrowed down to; rows must match all of it. */
export interface Filter {
  /** Words that must all appear somewhere in the row. */
  text: string;
  /** Tags the row must have. */
  tags: string[];
  /** Column id → the value its cells must hold ("true" or "" for checkboxes). */
  columns: Record<string, string>;
}

const NO_FILTER: Filter = { text: "", tags: [], columns: {} };

const COLUMN_TYPES: [ColumnType, string, Parameters<typeof icon>[0]][] = [
  ["text", "Text", Type],
  ["checkbox", "Checkbox", SquareCheck],
  ["number", "Number", Hash],
  ["date", "Date", CalendarDays],
  ["select", "Pop-up list", List],
  // These are made automatically when a row first gets tags or links, not chosen from the menu.
  ["tags", "Tags", Tag],
  ["links", "Links", Paperclip],
  ["zotero", "Zotero links", BookOpen],
];

const GUTTER_PX = 28;
const DEFAULT_COLUMN_PX = 160;
const MIN_COLUMN_PX = 60;

export class OutlineView {
  doc: OutlineDoc = model.newDoc();
  /** The row with the keyboard focus; always one of the selected rows. */
  selectedId: string | null = null;
  /** All selected rows (several can be selected with Shift- or ⌘-click). */
  selection = new Set<string>();
  /** Where a Shift-click selection range starts. */
  private anchorId: string | null = null;

  /** Called whenever the document changes (including while typing). */
  onChange = () => {};
  /** Called when the formatting toolbar should refresh. */
  onEditorChange: (editor: Editor | null) => void = () => {};
  /** Called when the user presses the link shortcut. */
  onLinkRequest = () => {};
  /** Called when the selected rows change. */
  onSelectionChange = () => {};
  /** Called when the search or filters change. */
  onFilterChange = () => {};
  /** Called when the user clicks an empty part of a Zotero cell. */
  onCiteRequest = () => {};
  /** Called when the user clicks an empty part of a Tags cell, with the cell to show a menu by. */
  onTagRequest: (cell: HTMLElement) => void = () => {};
  /** Called when the user clicks an empty part of a Links cell, with the cell to show a menu by. */
  onAttachRequest: (cell: HTMLElement) => void = () => {};

  filter: Filter = NO_FILTER;
  /** Rows kept on screen while filtering although they don't match (new or edited rows). */
  private pinned = new Set<string>();

  private editing: Editing | null = null;
  /** A row whose (still empty) note is open for editing. */
  private openNoteId: string | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private drag: Drag | null = null;
  /** The column being dragged to a new position. */
  private columnDrag: string | null = null;
  private dropLine = el("div", "drop-line");
  private styleSheet = document.head.appendChild(el("style"));

  constructor(private root: HTMLElement) {
    root.addEventListener("click", (e) => this.handleClick(e));
    root.addEventListener("mousedown", (e) => {
      // Shift- and ⌘-clicks select rows; stop them selecting text as well.
      const inEditor = (e.target as HTMLElement).closest(".ProseMirror");
      if ((e.shiftKey || (isMac ? e.metaKey : e.ctrlKey)) && !inEditor) e.preventDefault();
    });
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
    doc.styles ??= [];
    doc.tags ??= [];
    doc.defaultStyle = { ...doc.defaultStyle, id: model.DEFAULT_STYLE, name: "Default" };
    model.addMissingRowDataColumns(doc);
    this.filter = NO_FILTER;
    this.pinned.clear();
    this.root.classList.remove("filtering");
    this.undoStack = [];
    this.redoStack = [];
    if (doc.rows.length === 0) doc.rows.push(model.newRow());
    this.selectOnly(doc.rows[0].id);
    this.render();
    this.onSelectionChange();
    this.onFilterChange();
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  render() {
    this.updateColumnWidths();
    this.updateStyleSheet();
    const rows = el("div", "rows");
    const visible = this.visible();
    for (const { row, depth, context } of visible) rows.append(this.renderRow(row, depth, context));
    if (!visible.length) rows.append(text("no-matches", "No rows match."));
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
      cell.dataset.col = column.id;
      cell.draggable = true; // drag a header to move its column
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
      const type = model.columnType(column);
      if (type !== "text") {
        const typeIcon = icon(COLUMN_TYPES.find(([t]) => t === type)![2], 13);
        typeIcon.classList.add("column-type");
        cell.append(typeIcon);
      }
      cell.append(name);

      if (column.id !== TOPIC) {
        const menu = el("button", "column-menu");
        menu.append(icon(ChevronDown, 14));
        menu.title = "Column type and options";
        menu.setAttribute("aria-label", "Column options");
        menu.addEventListener("click", () => toggleMenu(menu, () => this.columnMenu(column)));
        cell.append(menu);
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
    add.addEventListener("click", () => toggleMenu(add, () => this.addColumnMenu()));
    header.append(add);
    return header;
  }

  private renderRow(row: Row, depth: number, context = false): HTMLElement {
    const rowEl = el("div", "row");
    rowEl.dataset.id = row.id;
    rowEl.classList.toggle("selected", this.selection.has(row.id));
    // Shown only because a row inside it matches the filter.
    rowEl.classList.toggle("context", context);
    if (row.style) rowEl.dataset.style = row.style;

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
        cell.append(toggle, content(row.cells[TOPIC] ?? ""), this.renderBadges(row));
      } else {
        cell.classList.add(model.columnType(column));
        cell.append(this.renderValue(row, column));
      }
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

  /** A cell in one of the extra columns, drawn to suit the column's type. */
  private renderValue(row: Row, column: Column): HTMLElement {
    const value = row.cells[column.id] ?? "";
    switch (model.columnType(column)) {
      case "checkbox": {
        const box = el("input", "checkbox");
        box.type = "checkbox";
        box.checked = value === "true";
        box.addEventListener("change", () => this.setCell(row.id, column.id, box.checked ? "true" : ""));
        return box;
      }
      case "select": {
        const select = el("select", "choice");
        const choices = column.options ?? [];
        // Keep a value that's no longer one of the choices, so it isn't lost silently.
        const extra = value && !choices.includes(value) ? [value] : [];
        for (const choice of ["", ...choices, ...extra]) select.append(new Option(choice || "—", choice));
        select.value = value;
        select.classList.toggle("empty", !value);
        select.addEventListener("change", () => this.setCell(row.id, column.id, select.value));
        return select;
      }
      case "number":
        return text("content", model.formatNumber(value));
      case "date":
        return text("content", model.formatDate(value));
      case "tags": {
        const tags = el("div", "content badge-list");
        for (const tag of row.tags ?? []) tags.append(tagBadge(tag));
        return tags;
      }
      case "links": {
        const links = el("div", "content badge-list");
        row.links?.forEach((link, index) => {
          if (link.kind !== "zotero") links.append(linkBadge(link, index));
        });
        return links;
      }
      case "zotero": {
        const links = el("div", "content badge-list");
        links.classList.toggle("with-notes", !!column.showNotes);
        row.links?.forEach((link, index) => {
          if (link.kind !== "zotero") return;
          if (!column.showNotes) {
            links.append(linkBadge(link, index));
            return;
          }
          const item = el("div", "zotero-link");
          item.append(linkBadge(link, index));
          for (const note of link.notes ?? []) {
            const noteEl = text("zotero-note", note);
            noteEl.title = "Click to copy";
            item.append(noteEl);
          }
          links.append(item);
        });
        return links;
      }
      default:
        return content(value);
    }
  }

  /** The row's tags and links, shown after its Topic when they don't have a column of their own. */
  private renderBadges(row: Row): HTMLElement | string {
    const tags = model.rowDataColumn(this.doc, "tags") ? [] : (row.tags ?? []);
    const links = (row.links ?? [])
      .map((link, index) => ({ link, index }))
      .filter(({ link }) => !model.rowDataColumn(this.doc, model.linkColumnType(link)));
    if (!tags.length && !links.length) return "";
    const badges = el("div", "badges");
    for (const tag of tags) badges.append(tagBadge(tag));
    for (const { link, index } of links) badges.append(linkBadge(link, index));
    return badges;
  }

  private rowElement(id: string): HTMLElement | null {
    return this.root.querySelector(`.row[data-id="${id}"]`);
  }

  /**
   * Styles are drawn with a generated style sheet: rows (and the sidebar's
   * previews) carry a `data-style` attribute, so changing a style only means
   * rewriting this sheet, not redrawing the outline.
   */
  updateStyleSheet() {
    const rule = (selector: string, style: Style) => {
      const rules: string[] = [];
      // Sizes are relative to the normal 14px, so styled rows grow and shrink with the outline's text size.
      if (Number.isFinite(style.size)) rules.push(`--style-size: ${Math.min(96, Math.max(6, style.size!)) / 14}em`);
      if (model.isColor(style.color)) rules.push(`--style-color: ${style.color}`);
      if (style.bold) rules.push("--style-weight: 650");
      if (style.italic) rules.push("--style-slant: italic");
      if (model.isColor(style.background)) rules.push(`--style-background: ${style.background}`, "--style-pad: 4px");
      if (style.font === "serif" || style.font === "sans" || style.font === "mono") rules.push(`--style-font: var(--${style.font})`);
      return `${selector} { ${rules.join("; ")} }`;
    };
    // Default applies only to rows without a style; styled rows don't inherit any of it.
    const defaultRule = rule(
      `#outline .row:not([data-style]), [data-style="${model.DEFAULT_STYLE}"]`,
      this.doc.defaultStyle ?? { id: "", name: "" },
    );
    const styleRules = this.doc.styles
      .filter((style) => /^[a-z][a-z0-9_-]*$/i.test(style.id))
      .map((style) => rule(`[data-style="${style.id}"]`, style));
    this.styleSheet.textContent = [defaultRule, ...styleRules].join("\n");
  }

  /** The plain text of a row's Topic, including any edits still being typed. */
  topicText(row: Row): string {
    if (this.editing?.rowId === row.id && this.editing.field === TOPIC) return this.editing.editor.getText();
    return plainText(row.cells[TOPIC] ?? "");
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  /** Selects just this row. */
  select(id: string | null) {
    this.selectOnly(id);
    this.updateSelection(true);
  }

  /** Selects a row and scrolls it to the top of the outline. */
  reveal(id: string) {
    this.stopEditing();
    this.select(id);
    this.rowElement(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  /** Changes the selection without updating the screen (for use before a redraw). */
  private selectOnly(id: string | null) {
    this.selectedId = id;
    this.anchorId = id;
    this.selection = new Set(id ? [id] : []);
  }

  /** Selects every visible row from the anchor row to this one. */
  private extendSelection(id: string) {
    const ids = this.visible().map((v) => v.row.id);
    const to = ids.indexOf(id);
    const from = ids.indexOf(this.anchorId ?? id);
    if (to < 0) return;
    const [first, last] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
    this.selection = new Set(ids.slice(first, last + 1));
    this.selectedId = id;
    this.updateSelection(true);
  }

  private extendSelectionBy(delta: -1 | 1) {
    const ids = this.visible().map((v) => v.row.id);
    const next = ids[ids.indexOf(this.selectedId!) + delta];
    if (next) this.extendSelection(next);
  }

  /** Adds a row to the selection, or removes it if it's already selected. */
  private toggleSelected(id: string) {
    if (this.selection.has(id) && this.selection.size > 1) {
      this.selection.delete(id);
      if (this.selectedId === id) this.selectedId = [...this.selection][0];
    } else {
      this.selection.add(id);
      this.selectedId = id;
    }
    this.anchorId = id;
    this.updateSelection();
  }

  /** Brings the screen up to date with the selection, dropping rows that no longer exist. */
  private updateSelection(scroll = false) {
    for (const id of this.selection) if (!model.locate(this.doc, id)) this.selection.delete(id);
    if (!this.selectedId || !this.selection.has(this.selectedId)) {
      this.selectedId = [...this.selection][0] ?? null;
    }
    for (const rowEl of this.root.querySelectorAll<HTMLElement>(".row")) {
      rowEl.classList.toggle("selected", this.selection.has(rowEl.dataset.id!));
    }
    if (scroll && this.selectedId) this.rowElement(this.selectedId)?.scrollIntoView({ block: "nearest" });
    this.onSelectionChange();
  }

  /** The styles used by the selected rows (null meaning "no style"). */
  selectedStyles(): Set<string | null> {
    const styles = new Set<string | null>();
    for (const id of this.selection) {
      const row = model.locate(this.doc, id)?.row;
      if (row) styles.add(row.style ?? null);
    }
    return styles;
  }

  // -------------------------------------------------------------------------
  // Editing text
  // -------------------------------------------------------------------------

  edit(rowId: string, field: string, cursor: CursorPosition = "end") {
    this.stopEditing();
    const row = model.locate(this.doc, rowId)?.row;
    if (!row) return;
    if (this.filtering) this.pinned.add(rowId); // don't let it vanish while being edited

    const column = this.doc.columns.find((c) => c.id === field);
    if (column && model.columnType(column) !== "text") {
      this.select(rowId);
      if (column.type === "number" || column.type === "date") this.editValue(row, column);
      if (column.type === "zotero") this.onCiteRequest();
      const cell = this.rowElement(rowId)?.querySelector<HTMLElement>(`[data-field="${field}"]`);
      if (cell && column.type === "tags") this.onTagRequest(cell);
      if (cell && column.type === "links") this.onAttachRequest(cell);
      return;
    }
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

  /** Edits a number or date cell with a plain input box. */
  private editValue(row: Row, column: Column) {
    const target = this.rowElement(row.id)?.querySelector<HTMLElement>(`[data-field="${column.id}"] .content`);
    if (!target) return;
    const input = el("input", "value-input");
    input.type = column.type === "date" ? "date" : "number";
    input.step = "any";
    input.value = row.cells[column.id] ?? "";
    target.replaceChildren(input);
    input.focus();

    let finished = false;
    const finish = (save: boolean) => {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      if (save && value !== (row.cells[column.id] ?? "")) this.setCell(row.id, column.id, value);
      else target.replaceWith(this.renderValue(row, column));
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        finish(e.key === "Enter");
      }
    });
    input.addEventListener("blur", () => finish(true));
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
      case "Shift-ArrowUp":
      case "Shift-ArrowDown":
        this.extendSelectionBy(key === "Shift-ArrowUp" ? -1 : 1);
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
    }
    const digit = key.match(/^Mod-(\d)$/);
    if (digit) {
      this.applyStyleNumber(Number(digit[1]));
      return true;
    }
    return false;
  }

  private handleClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const rowId = target.closest<HTMLElement>(".row")?.dataset.id;

    // Checkboxes and pop-up lists handle their own clicks.
    if (target.closest("input, select")) return;

    const note = target.closest<HTMLElement>(".zotero-note");
    if (note) {
      copyText(note.textContent ?? "", note);
      return;
    }

    const badge = target.closest<HTMLElement>(".badge");
    if (badge && rowId) {
      const remove = !!target.closest(".badge-remove");
      if (badge.dataset.tag !== undefined) {
        if (remove) this.removeTag(rowId, badge.dataset.tag);
        else this.toggleTagFilter(badge.dataset.tag);
      } else {
        const index = Number(badge.dataset.link);
        if (remove) this.removeLink(rowId, index);
        else {
          const link = model.locate(this.doc, rowId)?.row.links?.[index];
          if (link) openLink(link);
        }
      }
      return;
    }

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
    const modifier = e.shiftKey || (isMac ? e.metaKey : e.ctrlKey);
    if (rowId && modifier && !target.closest(".ProseMirror")) {
      this.stopEditing();
      if (e.shiftKey) this.extendSelection(rowId);
      else this.toggleSelected(rowId);
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
    const visible = this.visible();
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
  change(operation: () => boolean, then?: { rowId: string; field: string; cursor?: CursorPosition }) {
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
    else this.updateSelection(true);
  }

  /** The document's current state, to pass to commit() after changing it directly. */
  snapshot(): string {
    this.flush();
    return JSON.stringify(this.doc);
  }

  /** Records direct changes made since snapshot() so they can be undone. */
  commit(snapshot: string) {
    if (JSON.stringify(this.doc) === snapshot) return;
    this.pushUndo(snapshot);
    this.onChange();
  }

  /** Applies a style to the selected rows, or removes it if they all have it already. */
  applyStyle(styleId: string | null) {
    const rows = [...this.selection].map((id) => model.locate(this.doc, id)?.row).filter((r) => !!r);
    const style = styleId && rows.some((r) => r.style !== styleId) ? styleId : null;
    this.change(() => {
      if (rows.every((r) => (r.style ?? null) === style)) return false;
      for (const row of rows) row.style = style;
      return true;
    });
  }

  /** Mod+1 to Mod+9 apply the styles in order; Mod+0 removes the style. */
  applyStyleNumber(n: number) {
    if (n === 0) this.applyStyle(null);
    else if (this.doc.styles[n - 1]) this.applyStyle(this.doc.styles[n - 1].id);
  }

  addRow() {
    const row = model.newRow();
    this.pinned.add(row.id);
    this.change(() => (model.insertAfter(this.doc, this.selectedId, row), true), { rowId: row.id, field: TOPIC });
  }

  /** The selected rows to act on, leaving out any inside another selected row. */
  private selectedRows(): string[] {
    return model.topmost(this.doc, this.selection);
  }

  indent() {
    const ids = this.selectedRows();
    this.change(() => model.indentRows(this.doc, ids));
  }

  outdent() {
    const ids = this.selectedRows();
    this.change(() => model.outdentRows(this.doc, ids));
  }

  moveRow(delta: -1 | 1) {
    const ids = this.selectedRows();
    this.change(() => model.moveRowsBy(this.doc, ids, delta));
  }

  toggleCollapse(id = this.selectedId) {
    const row = id ? model.locate(this.doc, id)?.row : null;
    if (!row?.children.length) return;
    if (!row.collapsed && this.editing && this.editing.rowId !== row.id) {
      this.stopEditing(); // the row being edited might be about to disappear
      this.selectOnly(row.id);
    }
    this.change(() => {
      row.collapsed = !row.collapsed;
      return true;
    });
  }

  /** Deletes the selected rows (and their children). */
  deleteRow() {
    const ids = this.selectedRows();
    if (!ids.length) return;
    // Afterwards, select the row just above the first one deleted.
    const visible = this.visible();
    const index = visible.findIndex((v) => this.selection.has(v.row.id));
    const wasEditing = this.editing;
    this.stopEditing();
    this.change(() => {
      for (const id of ids) model.removeRow(this.doc, id);
      if (this.doc.rows.length === 0) this.doc.rows.push(model.newRow());
      const remaining = this.visible();
      this.selectOnly((remaining[index - 1] ?? remaining[0]).row.id);
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

  /** The kinds of column that can be added (only one Tags, Links or Zotero column each). */
  private addColumnMenu(): MenuEntry[] {
    const types = COLUMN_TYPES.filter(([type]) => !model.isRowDataType(type) || !model.rowDataColumn(this.doc, type));
    return [
      { heading: "Add a column" },
      ...types.map(([type, label, typeIcon]): MenuEntry => ({ label, icon: typeIcon, action: () => this.addColumn(type) })),
    ];
  }

  addColumn(type: ColumnType = "text") {
    this.stopEditing();
    if (model.isRowDataType(type)) {
      this.change(() => model.ensureRowDataColumn(this.doc, type));
      return;
    }
    this.change(() => {
      const column = model.addColumn(this.doc);
      if (type !== "text") column.type = type;
      return true;
    });
    const added = this.doc.columns[this.doc.columns.length - 1];
    if (type === "select") {
      this.editChoices(added.id);
      return;
    }
    // Put the cursor in the new column's name so it can be typed straight away.
    const name = this.root.querySelector<HTMLElement>(`.hcell[data-col="${added.id}"] .name`);
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

  private columnMenu(column: Column): MenuEntry[] {
    const type = model.columnType(column);
    const remove: MenuEntry = { label: "Delete column", icon: Trash2, danger: true, action: () => this.deleteColumn(column.id) };
    if (type === "zotero") {
      return [
        { label: "Show notes", checked: !!column.showNotes, action: () => this.toggleShowNotes(column.id) },
        { label: "Update notes from Zotero", icon: RotateCcw, action: () => this.updateZoteroNotes() },
        "separator",
        remove,
      ];
    }
    if (model.isRowDataType(type)) return [remove];
    const entries: MenuEntry[] = [{ heading: "Type" }];
    for (const [value, label, typeIcon] of COLUMN_TYPES.filter(([t]) => !model.isRowDataType(t))) {
      entries.push({ label, icon: typeIcon, checked: type === value, action: () => this.setColumnType(column.id, value) });
    }
    if (type === "select") {
      entries.push("separator", { label: "Edit choices…", icon: Pencil, action: () => this.editChoices(column.id) });
    }
    entries.push("separator", remove);
    return entries;
  }

  private setColumnType(id: string, type: ColumnType) {
    this.dropColumnFilter(id);
    this.change(() => model.setColumnType(this.doc, id, type));
    const column = this.doc.columns.find((c) => c.id === id);
    if (type === "select" && column && !column.options?.length) this.editChoices(id);
  }

  private async editChoices(id: string) {
    const column = this.doc.columns.find((c) => c.id === id);
    if (!column) return;
    const choices = await promptText(`Choices for “${column.name}”, one per line`, (column.options ?? []).join("\n"), {
      multiline: true,
    });
    if (choices !== null) this.change(() => model.setColumnOptions(this.doc, id, choices.split("\n")));
  }

  private toggleShowNotes(id: string) {
    const column = this.doc.columns.find((c) => c.id === id);
    if (!column) return;
    this.change(() => {
      column.showNotes = !column.showNotes;
      return true;
    });
  }

  /** Fetches every linked Zotero item's notes again (after they've been edited in Zotero). */
  private async updateZoteroNotes() {
    const uris = new Set<string>();
    model.walk(this.doc.rows, (row) => {
      for (const link of row.links ?? []) if (link.kind === "zotero") uris.add(link.target);
    });
    const fetched = new Map<string, string[]>();
    try {
      for (const uri of uris) fetched.set(uri, await fetchZoteroNotes(uri));
    } catch (error) {
      await message(String(error), { title: "Could not update notes", kind: "error" });
      return;
    }
    this.change(() => {
      let changed = false;
      model.walk(this.doc.rows, (row) => {
        for (const link of row.links ?? []) {
          const notes = fetched.get(link.target);
          if (link.kind === "zotero" && notes && JSON.stringify(notes) !== JSON.stringify(link.notes ?? [])) {
            link.notes = notes;
            changed = true;
          }
        }
      });
      return changed;
    });
  }

  /** Sets a cell in one of the extra columns. */
  setCell(rowId: string, columnId: string, value: string) {
    const row = model.locate(this.doc, rowId)?.row;
    if (!row) return;
    this.change(() => {
      if ((row.cells[columnId] ?? "") === value) return false;
      if (value) row.cells[columnId] = value;
      else delete row.cells[columnId];
      return true;
    });
  }

  private async deleteColumn(id: string) {
    const column = this.doc.columns.find((c) => c.id === id);
    if (!column) return;
    const shown = { tags: "tags", links: "links", zotero: "Zotero links" } as Record<string, string>;
    const type = model.columnType(column);
    const question =
      type in shown
        ? `Remove the “${column.name}” column? The ${shown[type]} will be shown next to each row's topic instead.`
        : `Delete the column “${column.name}” and everything in it?`;
    const confirmed = await ask(question, {
      title: "Delete column",
      kind: "warning",
      okLabel: "Delete",
    });
    if (!confirmed) return;
    this.dropColumnFilter(id);
    this.change(() => (model.removeColumn(this.doc, id), true));
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
    const header = handle.closest<HTMLElement>(".hcell");
    if (header) {
      // Not while resizing a column or renaming one.
      if (document.body.classList.contains("resizing") || header.contains(document.activeElement)) {
        e.preventDefault();
        return;
      }
      this.stopEditing();
      this.columnDrag = header.dataset.col!;
      e.dataTransfer!.effectAllowed = "move";
      e.dataTransfer!.setData("text/plain", "");
      header.classList.add("dragging");
      return;
    }
    if (this.filtering) {
      // With rows hidden, where a row would land is unclear.
      e.preventDefault();
      return;
    }
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
    const visible = this.visible().filter((v) => v.row !== dragged && !model.contains(dragged, v.row.id));
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

  /** The column a dragged column would be dropped next to, from the pointer's position across the outline. */
  private columnDropTarget(e: DragEvent): { target: HTMLElement; after: boolean } | null {
    for (const target of this.root.querySelectorAll<HTMLElement>(".hcell")) {
      const rect = target.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX < rect.right) {
        return target.dataset.col === this.columnDrag ? null : { target, after: e.clientX > rect.left + rect.width / 2 };
      }
    }
    return null;
  }

  private handleDragOver(e: DragEvent) {
    if (this.columnDrag) {
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      this.root.querySelector(".hcell.drop-before, .hcell.drop-after")?.classList.remove("drop-before", "drop-after");
      const drop = this.columnDropTarget(e);
      drop?.target.classList.add(drop.after ? "drop-after" : "drop-before");
      return;
    }
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
    if (this.columnDrag) {
      e.preventDefault();
      const drop = this.columnDropTarget(e);
      const id = this.columnDrag;
      this.clearDrag();
      if (drop) this.change(() => model.moveColumn(this.doc, id, drop.target.dataset.col!, drop.after));
      return;
    }
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
    this.root.querySelector(".hcell.drop-before, .hcell.drop-after")?.classList.remove("drop-before", "drop-after");
    this.drag = null;
    this.columnDrag = null;
  }

  // -------------------------------------------------------------------------
  // Tags and links
  // -------------------------------------------------------------------------

  /** The selected rows themselves. */
  selectedRowObjects(): Row[] {
    return [...this.selection].map((id) => model.locate(this.doc, id)?.row).filter((r) => !!r);
  }

  /** Replaces one row's tags. */
  setTags(rowId: string, tags: string[]) {
    const row = model.locate(this.doc, rowId)?.row;
    if (!row) return;
    const cleaned = model.cleanTags(tags);
    this.change(() => {
      if (JSON.stringify(row.tags ?? []) === JSON.stringify(cleaned)) return false;
      row.tags = cleaned;
      if (cleaned.length) model.ensureRowDataColumn(this.doc, "tags");
      return true;
    });
  }

  /** Adds a tag to the selected rows, or removes it if they all have it already. */
  applyTag(tag: string) {
    const rows = this.selectedRowObjects();
    if (!rows.length) return;
    const remove = rows.every((row) => row.tags?.includes(tag));
    this.change(() => {
      for (const row of rows) {
        row.tags = remove ? (row.tags ?? []).filter((t) => t !== tag) : model.cleanTags([...(row.tags ?? []), tag]);
      }
      if (!remove) {
        model.defineTag(this.doc, tag);
        model.ensureRowDataColumn(this.doc, "tags");
      }
      return true;
    });
  }

  /** Tags that every selected row has. */
  selectedTags(): Set<string> {
    const [first, ...rest] = this.selectedRowObjects();
    return new Set((first?.tags ?? []).filter((tag) => rest.every((row) => row.tags?.includes(tag))));
  }

  createTag(name: string): boolean {
    let created = false;
    this.change(() => (created = model.defineTag(this.doc, name)));
    return created;
  }

  renameTag(from: string, to: string) {
    const [tag] = model.cleanTags([to]);
    this.change(() => model.renameTag(this.doc, from, to));
    if (tag && this.filter.tags.includes(from)) {
      this.setFilter({ ...this.filter, tags: model.cleanTags(this.filter.tags.map((t) => (t === from ? tag : t))) });
    }
  }

  deleteTag(name: string) {
    this.change(() => (model.deleteTag(this.doc, name), true));
    if (this.filter.tags.includes(name)) this.toggleTagFilter(name);
  }

  /** Where to show a menu for the selected row's tags: its Tags cell, or the row itself. */
  tagMenuAnchor(): HTMLElement | null {
    const rowEl = this.selectedId ? this.rowElement(this.selectedId) : null;
    return rowEl?.querySelector<HTMLElement>(".cell.tags") ?? rowEl?.querySelector<HTMLElement>(".cell.topic") ?? null;
  }

  private removeTag(rowId: string, tag: string) {
    const row = model.locate(this.doc, rowId)?.row;
    if (row) this.setTags(rowId, (row.tags ?? []).filter((t) => t !== tag));
  }

  /** Adds links to every selected row (skipping ones a row already has). */
  addLinks(links: Link[]) {
    const rows = this.selectedRowObjects();
    this.change(() => {
      let changed = false;
      for (const type of new Set(links.map(model.linkColumnType))) {
        if (model.ensureRowDataColumn(this.doc, type)) changed = true;
      }
      for (const row of rows) {
        const fresh = links.filter((l) => !row.links?.some((existing) => existing.target === l.target));
        if (fresh.length) {
          row.links = [...(row.links ?? []), ...fresh];
          changed = true;
        }
      }
      return changed;
    });
  }

  private removeLink(rowId: string, index: number) {
    const row = model.locate(this.doc, rowId)?.row;
    if (!row?.links?.[index]) return;
    this.change(() => {
      row.links = row.links!.filter((_, i) => i !== index);
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Search and filters
  // -------------------------------------------------------------------------

  get filtering(): boolean {
    const { text, tags, columns } = this.filter;
    return !!text.trim() || tags.length > 0 || Object.keys(columns).length > 0;
  }

  setFilter(filter: Filter) {
    this.stopEditing();
    this.filter = filter;
    this.pinned.clear();
    this.root.classList.toggle("filtering", this.filtering);
    this.render();
    this.updateSelection();
    this.onFilterChange();
  }

  toggleTagFilter(tag: string) {
    const tags = this.filter.tags.includes(tag) ? this.filter.tags.filter((t) => t !== tag) : [...this.filter.tags, tag];
    this.setFilter({ ...this.filter, tags });
  }

  private dropColumnFilter(id: string) {
    if (!(id in this.filter.columns)) return;
    const columns = { ...this.filter.columns };
    delete columns[id];
    this.setFilter({ ...this.filter, columns });
  }

  /** The rows on screen, in order: all of them, or just those matching the filter. */
  private visible(): { row: Row; depth: number; context?: boolean }[] {
    if (!this.filtering) return model.visibleRows(this.doc);
    return model.filteredRows(this.doc, (row) => this.pinned.has(row.id) || this.matches(row));
  }

  private matches(row: Row): boolean {
    const { text, tags, columns } = this.filter;
    if (tags.some((tag) => !row.tags?.includes(tag))) return false;
    for (const [id, value] of Object.entries(columns)) {
      if ((row.cells[id] ?? "") !== value) return false;
    }
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const haystack = this.searchText(row);
    return words.every((word) => haystack.includes(word));
  }

  /** Everything in a row that search looks at, in lower case. */
  private searchText(row: Row): string {
    const parts = this.doc.columns.map((c) => model.cellText(c, row.cells[c.id]));
    parts.push(plainText(row.note), ...(row.tags ?? []));
    for (const link of row.links ?? []) parts.push(link.title, link.detail ?? "", ...(link.notes ?? []));
    return parts.join(" ").toLowerCase();
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
    if (!this.selectedId || !model.locate(this.doc, this.selectedId)) this.selectOnly(this.doc.rows[0]?.id ?? null);
    this.onChange();
    this.render();
    this.updateSelection(true);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function text(className: string, value: string): HTMLElement {
  const element = el("div", className);
  element.textContent = value;
  return element;
}

function removeButton(label: string): HTMLElement {
  const button = el("span", "badge-remove");
  button.append(icon(X, 10));
  button.title = label;
  return button;
}

function tagBadge(tag: string): HTMLElement {
  const badge = el("span", "badge tag");
  badge.dataset.tag = tag;
  badge.title = `Show rows tagged “${tag}”`;
  badge.append(text("badge-label", tag), removeButton("Remove tag"));
  return badge;
}

function linkBadge(link: Link, index: number): HTMLElement {
  const badge = el("span", `badge link ${link.kind}`);
  badge.dataset.link = String(index);
  badge.title = [link.detail, link.kind === "zotero" ? "Click to show in Zotero" : link.target].filter(Boolean).join("\n");
  const kindIcon = link.kind === "zotero" ? BookOpen : link.kind === "file" ? FileText : Globe;
  badge.append(icon(kindIcon, 12), text("badge-label", link.title), removeButton("Remove link"));
  return badge;
}

/** Copies text to the clipboard, briefly marking the element it came from as copied. */
async function copyText(value: string, from: HTMLElement) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Older webviews: copy via a hidden text box instead.
    const area = el("textarea");
    area.value = value;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  from.classList.add("copied");
  window.setTimeout(() => from.classList.remove("copied"), 1200);
}

/** Opens a link's file, web page or Zotero item with the system. */
export async function openLink(link: Link) {
  try {
    if (link.kind === "file") await openPath(link.target);
    else if (/^(https?:|mailto:|zotero:)/i.test(link.target)) await openUrl(link.target);
  } catch (error) {
    await message(String(error), { title: "Could not open link", kind: "error" });
  }
}

function content(html: string): HTMLElement {
  const div = el("div", "content");
  div.innerHTML = sanitize(html);
  return div;
}
