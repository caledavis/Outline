// The outline's data and the operations that reshape it. Nothing in here
// touches the screen; the view calls these functions and then redraws.

import { plainText } from "./sanitize";

/** The id of the main column (stored as OPML's standard `text` attribute). */
export const TOPIC = "topic";

/**
 * "tags", "links" and "zotero" columns show the row's tags, its file and web
 * links, and its Zotero links. These live on the row (`Row.tags`, `Row.links`),
 * not in the column's cells, so deleting the column loses nothing.
 */
export type ColumnType = "text" | "checkbox" | "number" | "date" | "select" | "tags" | "links" | "zotero";

/** Columns that show something kept on the row; there's at most one of each. */
export type RowDataType = "tags" | "links" | "zotero";

export function isRowDataType(type: ColumnType): type is RowDataType {
  return type === "tags" || type === "links" || type === "zotero";
}

export interface Column {
  id: string;
  name: string;
  width?: number | null;
  /** How the column's cells are edited and shown (the Topic column is always text). */
  type?: ColumnType;
  /** The choices for a pop-up list ("select") column. */
  options?: string[];
  /** Whether a Zotero column shows each item's notes. */
  showNotes?: boolean;
}

/** Something a row links to. */
export interface Link {
  kind: "file" | "url" | "zotero";
  /** A file path, or a URL (zotero://select/… for Zotero items). */
  target: string;
  /** The short label shown on the row. */
  title: string;
  /** More detail, e.g. a Zotero item's full title. */
  detail?: string;
  /** A Zotero item's notes, as plain text (copied from Zotero when linked). */
  notes?: string[];
}

/**
 * The outline's normal text size, in pixels. Style sizes are measured against
 * it, so a style keeps its proportions when the text is made larger or smaller.
 */
export const NORMAL_TEXT_SIZE = 14;

/** A named look (text size, colour, weight…) that can be applied to rows. */
export interface Style {
  id: string;
  name: string;
  /** Text size in pixels, or null for the normal size. */
  size?: number | null;
  /** Text colour as "#rrggbb", or null for the normal colour. */
  color?: string | null;
  bold?: boolean;
  italic?: boolean;
  /** Highlight colour behind the text as "#rrggbb", or null for none. */
  background?: string | null;
  /** The style's font, or null for the normal sans. */
  font?: "serif" | "sans" | "mono" | null;
}

/** The id of the Default style, which sets how rows without a style look. */
export const DEFAULT_STYLE = "default";

/** Styles get the shortcuts Mod+1 to Mod+9, so that's the most there can be. */
export const MAX_STYLES = 9;

export interface Row {
  /** Only used while the app is running; ids aren't saved to the file. */
  id: string;
  /** Cell contents as inline HTML, keyed by column id. */
  cells: Record<string, string>;
  /** Note contents as HTML paragraphs, or "" for no note. */
  note: string;
  collapsed: boolean;
  /** The id of the style applied to this row, if any. */
  style?: string | null;
  tags?: string[];
  links?: Link[];
  children: Row[];
}

export interface OutlineDoc {
  title: string;
  columns: Column[];
  styles: Style[];
  /** How rows without a style look (it has no effect on styled rows). */
  defaultStyle?: Style;
  /** Tags created in the Tags pane, including ones no row uses yet. */
  tags?: string[];
  rows: Row[];
}

export function newRow(): Row {
  return { id: crypto.randomUUID(), cells: {}, note: "", collapsed: false, children: [] };
}

export function newDoc(): OutlineDoc {
  return { title: "", columns: [{ id: TOPIC, name: "Topic" }], styles: starterStyles(), rows: [newRow()] };
}

/**
 * The styles a new outline starts with, all at the normal text size. The
 * colours share one perceived lightness (about OKLCH L = 0.60), so they read
 * at about 4:1 contrast on both the light and dark backgrounds. Headings step
 * from crimson towards ochre and grow less saturated at each level, so the
 * more important a heading, the more vivid it is. Quotes are teal: opposite
 * the warm headings, and unlike the blue used for links.
 */
function starterStyles(): Style[] {
  return [
    { id: "s1", name: "Heading 1", color: "#de394b", bold: true },
    { id: "s2", name: "Heading 2", color: "#cf5334", bold: true },
    { id: "s3", name: "Heading 3", color: "#bd6526", bold: true },
    { id: "s4", name: "Heading 4", color: "#a8742a", bold: true },
    { id: "s5", name: "Quote", color: "#0a898f" },
  ];
}

/** Gives every row a fresh id, e.g. after loading a file. */
export function assignIds(rows: Row[]) {
  for (const row of rows) {
    row.id = crypto.randomUUID();
    assignIds(row.children);
  }
}

export function walk(rows: Row[], fn: (row: Row) => void) {
  for (const row of rows) {
    fn(row);
    walk(row.children, fn);
  }
}

export interface Location {
  row: Row;
  parent: Row | null;
  /** The array that holds the row (its parent's children, or the top level). */
  siblings: Row[];
  index: number;
}

export function locate(doc: OutlineDoc, id: string): Location | null {
  const search = (siblings: Row[], parent: Row | null): Location | null => {
    for (let index = 0; index < siblings.length; index++) {
      const row = siblings[index];
      if (row.id === id) return { row, parent, siblings, index };
      const found = search(row.children, row);
      if (found) return found;
    }
    return null;
  };
  return search(doc.rows, null);
}

/**
 * The rows that match, in display order, with their ancestors (marked as
 * `context`) so they're shown in place. Collapsed rows are opened up.
 */
export function filteredRows(
  doc: OutlineDoc,
  matches: (row: Row) => boolean,
): { row: Row; depth: number; context: boolean }[] {
  const visit = (rows: Row[], depth: number): { row: Row; depth: number; context: boolean }[] =>
    rows.flatMap((row) => {
      const below = visit(row.children, depth + 1);
      const self = matches(row);
      return self || below.length ? [{ row, depth, context: !self }, ...below] : [];
    });
  return visit(doc.rows, 0);
}

/** Rows in display order, skipping the children of collapsed rows. */
export function visibleRows(doc: OutlineDoc): { row: Row; depth: number }[] {
  const result: { row: Row; depth: number }[] = [];
  const add = (rows: Row[], depth: number) => {
    for (const row of rows) {
      result.push({ row, depth });
      if (!row.collapsed) add(row.children, depth + 1);
    }
  };
  add(doc.rows, 0);
  return result;
}

/** Whether `id` is somewhere among the descendants of `ancestor`. */
export function contains(ancestor: Row, id: string): boolean {
  return ancestor.children.some((child) => child.id === id || contains(child, id));
}

/**
 * The given rows in document order, leaving out any whose ancestor is also
 * given (it moves along with that ancestor anyway).
 */
export function topmost(doc: OutlineDoc, ids: Set<string>): string[] {
  const result: string[] = [];
  const visit = (rows: Row[]) => {
    for (const row of rows) {
      if (ids.has(row.id)) result.push(row.id);
      else visit(row.children);
    }
  };
  visit(doc.rows);
  return result;
}

/** Inserts a row (a new empty one by default) after `id`, or at the end. */
export function insertAfter(doc: OutlineDoc, id: string | null, row = newRow()): Row {
  const loc = id ? locate(doc, id) : null;
  if (loc) loc.siblings.splice(loc.index + 1, 0, row);
  else doc.rows.push(row);
  return row;
}

/** Makes a row the last child of the row above it. */
export function indent(doc: OutlineDoc, id: string): boolean {
  const loc = locate(doc, id);
  if (!loc || loc.index === 0) return false;
  const newParent = loc.siblings[loc.index - 1];
  loc.siblings.splice(loc.index, 1);
  newParent.children.push(loc.row);
  newParent.collapsed = false;
  return true;
}

/**
 * Indents several rows (from topmost()). A row isn't indented into another
 * selected row, so a group of siblings moves in together.
 */
export function indentRows(doc: OutlineDoc, ids: string[]): boolean {
  const selected = new Set(ids);
  let changed = false;
  for (const id of ids) {
    const loc = locate(doc, id);
    if (!loc || loc.index === 0 || selected.has(loc.siblings[loc.index - 1].id)) continue;
    changed = indent(doc, id) || changed;
  }
  return changed;
}

/** Outdents several rows (from topmost()), keeping their order. */
export function outdentRows(doc: OutlineDoc, ids: string[]): boolean {
  let changed = false;
  // Last first: each lands just after its old parent, so this keeps the order.
  for (const id of [...ids].reverse()) changed = outdent(doc, id) || changed;
  return changed;
}

/** Moves a row out of its parent, to just after the parent. */
export function outdent(doc: OutlineDoc, id: string): boolean {
  const loc = locate(doc, id);
  if (!loc?.parent) return false;
  const parentLoc = locate(doc, loc.parent.id)!;
  loc.siblings.splice(loc.index, 1);
  parentLoc.siblings.splice(parentLoc.index + 1, 0, loc.row);
  return true;
}

/** Swaps a row with the sibling above (-1) or below (+1) it. */
export function moveBy(doc: OutlineDoc, id: string, delta: -1 | 1): boolean {
  const loc = locate(doc, id);
  if (!loc) return false;
  const target = loc.index + delta;
  if (target < 0 || target >= loc.siblings.length) return false;
  [loc.siblings[loc.index], loc.siblings[target]] = [loc.siblings[target], loc.siblings[loc.index]];
  return true;
}

/** Moves several rows (from topmost()) up or down past their neighbours, as a group. */
export function moveRowsBy(doc: OutlineDoc, ids: string[], delta: -1 | 1): boolean {
  const selected = new Set(ids);
  let changed = false;
  // Rows nearest the direction of travel go first, so the others can follow.
  for (const id of delta < 0 ? ids : [...ids].reverse()) {
    const loc = locate(doc, id);
    const neighbour = loc?.siblings[loc.index + delta];
    if (!neighbour || selected.has(neighbour.id)) continue;
    changed = moveBy(doc, id, delta) || changed;
  }
  return changed;
}

/**
 * Moves a row (with its children) to position `index` among the children of
 * `parentId` (or the top level when null). `index` counts the row's current
 * position, as if it hadn't been removed yet.
 */
export function moveRow(doc: OutlineDoc, id: string, parentId: string | null, index: number): boolean {
  const loc = locate(doc, id);
  if (!loc) return false;
  const parent = parentId ? locate(doc, parentId)?.row : null;
  if (parentId && (!parent || parent === loc.row || contains(loc.row, parentId))) return false;

  const siblings = parent ? parent.children : doc.rows;
  if (siblings === loc.siblings && loc.index < index) index--;
  if (siblings === loc.siblings && loc.index === index) return false; // it wouldn't move

  loc.siblings.splice(loc.index, 1);
  siblings.splice(index, 0, loc.row);
  if (parent) parent.collapsed = false;
  return true;
}

/** The row and its ancestors, outermost first; `path(…)[d]` is the ancestor at depth d. */
export function path(doc: OutlineDoc, id: string): Row[] {
  const result: Row[] = [];
  for (let loc = locate(doc, id); loc; loc = loc.parent ? locate(doc, loc.parent.id) : null) {
    result.unshift(loc.row);
  }
  return result;
}

export function removeRow(doc: OutlineDoc, id: string): boolean {
  const loc = locate(doc, id);
  if (!loc) return false;
  loc.siblings.splice(loc.index, 1);
  return true;
}

export function addColumn(doc: OutlineDoc): Column {
  let n = doc.columns.length + 1;
  while (doc.columns.some((c) => c.id === `c${n}`)) n++;
  const column = { id: `c${n}`, name: `Column ${n}`, width: 160 };
  doc.columns.push(column);
  return column;
}

export function removeColumn(doc: OutlineDoc, id: string) {
  doc.columns = doc.columns.filter((c) => c.id !== id);
  walk(doc.rows, (row) => delete row.cells[id]);
}

export function isColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function addStyle(doc: OutlineDoc): Style | null {
  if (doc.styles.length >= MAX_STYLES) return null;
  let n = doc.styles.length + 1;
  while (doc.styles.some((s) => s.id === `s${n}`)) n++;
  const style: Style = { id: `s${n}`, name: `Style ${doc.styles.length + 1}` };
  doc.styles.push(style);
  return style;
}

export function removeStyle(doc: OutlineDoc, id: string) {
  doc.styles = doc.styles.filter((s) => s.id !== id);
  walk(doc.rows, (row) => {
    if (row.style === id) row.style = null;
  });
}

/** Moves a style up or down the list, which changes its shortcut number. */
export function moveStyle(doc: OutlineDoc, id: string, delta: -1 | 1): boolean {
  const index = doc.styles.findIndex((s) => s.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= doc.styles.length) return false;
  [doc.styles[index], doc.styles[target]] = [doc.styles[target], doc.styles[index]];
  return true;
}

// ---------------------------------------------------------------------------
// Column types
// ---------------------------------------------------------------------------

export function columnType(column: Column): ColumnType {
  return column.type ?? "text";
}

/** A cell's value as plain text, whatever the column's type. */
export function cellText(column: Column, value: string | undefined): string {
  if (!value) return "";
  switch (columnType(column)) {
    case "text": return plainText(value);
    case "checkbox": return value === "true" ? "Yes" : "";
    case "date": return formatDate(value);
    case "number": return formatNumber(value);
    case "tags":
    case "links":
    case "zotero":
      return "";
    default: return value;
  }
}

export function formatNumber(value: string): string {
  const n = Number(value);
  return value !== "" && Number.isFinite(n) ? n.toLocaleString() : value;
}

export function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Changes a column's type, converting its cells where possible (values that
 * can't be converted are cleared). Switching to a pop-up list makes a choice
 * from each different value already in the column.
 */
export function setColumnType(doc: OutlineDoc, id: string, type: ColumnType): boolean {
  const column = doc.columns.find((c) => c.id === id);
  if (!column || column.id === TOPIC || columnType(column) === type) return false;
  // Tags, links and Zotero columns have no values of their own to convert.
  if (isRowDataType(type) || isRowDataType(columnType(column))) return false;
  const options = new Set(column.options ?? []);
  const from = columnType(column);

  walk(doc.rows, (row) => {
    const old = row.cells[id];
    if (!old) return;
    const text = (from === "text" ? plainText(old) : from === "checkbox" ? "Yes" : old).trim();
    let value = "";
    switch (type) {
      case "text":
        value = escapeHtml(text);
        break;
      case "checkbox":
        value = /^(true|yes|y|x|1|✓|✔|done)$/i.test(text) ? "true" : "";
        break;
      case "number": {
        const n = parseFloat(text.replace(/,/g, ""));
        value = Number.isFinite(n) ? String(n) : "";
        break;
      }
      case "date": {
        const time = Date.parse(text);
        value = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : isNaN(time) ? "" : toIsoDate(new Date(time));
        break;
      }
      case "select":
        value = text.replace(/\s+/g, " ");
        if (value) options.add(value);
        break;
    }
    if (value) row.cells[id] = value;
    else delete row.cells[id];
  });

  column.type = type;
  column.options = type === "select" ? [...options] : [];
  return true;
}

function toIsoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Sets a pop-up list's choices. Cells holding a removed choice are cleared. */
export function setColumnOptions(doc: OutlineDoc, id: string, options: string[]): boolean {
  const column = doc.columns.find((c) => c.id === id);
  if (!column) return false;
  const cleaned = [...new Set(options.map((o) => o.trim().replace(/\s+/g, " ")).filter(Boolean))];
  if (JSON.stringify(cleaned) === JSON.stringify(column.options ?? [])) return false;
  column.options = cleaned;
  walk(doc.rows, (row) => {
    if (row.cells[id] && !cleaned.includes(row.cells[id])) delete row.cells[id];
  });
  return true;
}

// ---------------------------------------------------------------------------
// Tags and links
// ---------------------------------------------------------------------------

/** The column showing the rows' tags, links or Zotero links, if there is one. */
export function rowDataColumn(doc: OutlineDoc, type: RowDataType): Column | undefined {
  return doc.columns.find((c) => columnType(c) === type);
}

const ROW_DATA_COLUMNS: Record<RowDataType, Partial<Column>> = {
  tags: { name: "Tags", width: 180 },
  links: { name: "Links", width: 200 },
  zotero: { name: "Zotero", width: 240, showNotes: true },
};

/** Adds the column for tags, links or Zotero links if there isn't one yet. Returns true if it was added. */
export function ensureRowDataColumn(doc: OutlineDoc, type: RowDataType): boolean {
  if (rowDataColumn(doc, type)) return false;
  Object.assign(addColumn(doc), ROW_DATA_COLUMNS[type], { type });
  return true;
}

/**
 * Adds a Tags, Links or Zotero column for any rows' tags or links that don't
 * have one (e.g. in outlines made before these columns existed).
 */
export function addMissingRowDataColumns(doc: OutlineDoc) {
  const needed = new Set<RowDataType>();
  walk(doc.rows, (row) => {
    if (row.tags?.length) needed.add("tags");
    for (const link of row.links ?? []) needed.add(linkColumnType(link));
  });
  for (const type of needed) ensureRowDataColumn(doc, type);
}

/** Moves a column to just before or after another one. */
export function moveColumn(doc: OutlineDoc, id: string, targetId: string, after: boolean): boolean {
  const order = doc.columns.map((c) => c.id).join();
  const from = doc.columns.findIndex((c) => c.id === id);
  if (from < 0 || id === targetId || !doc.columns.some((c) => c.id === targetId)) return false;
  const [column] = doc.columns.splice(from, 1);
  const to = doc.columns.findIndex((c) => c.id === targetId) + (after ? 1 : 0);
  doc.columns.splice(to, 0, column);
  return doc.columns.map((c) => c.id).join() !== order;
}

/** Which column a link is shown in. */
export function linkColumnType(link: Link): RowDataType {
  return link.kind === "zotero" ? "zotero" : "links";
}

/** Tidies tags typed by the user: no commas (they separate tags in the file), no repeats. */
export function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.replace(/[,\s]+/g, " ").trim()).filter(Boolean))];
}

/** Every tag (created or used), with how many rows have it, alphabetically. */
export function allTags(doc: OutlineDoc): { tag: string; count: number }[] {
  const counts = new Map<string, number>((doc.tags ?? []).map((tag) => [tag, 0]));
  walk(doc.rows, (row) => {
    for (const tag of row.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  });
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }));
}

/** Creates a tag. Returns false if the name is empty or the tag already exists. */
export function defineTag(doc: OutlineDoc, name: string): boolean {
  const [tag] = cleanTags([name]);
  if (!tag || allTags(doc).some((t) => t.tag === tag)) return false;
  doc.tags = [...(doc.tags ?? []), tag];
  return true;
}

/** Renames a tag everywhere. Renaming it to an existing tag merges the two. */
export function renameTag(doc: OutlineDoc, from: string, to: string): boolean {
  const [tag] = cleanTags([to]);
  if (!tag || tag === from) return false;
  const rename = (tags: string[]) => cleanTags(tags.map((t) => (t === from ? tag : t)));
  doc.tags = rename([...(doc.tags ?? []), from]);
  walk(doc.rows, (row) => {
    if (row.tags?.includes(from)) row.tags = rename(row.tags);
  });
  return true;
}

/** Deletes a tag, removing it from every row. */
export function deleteTag(doc: OutlineDoc, name: string) {
  doc.tags = (doc.tags ?? []).filter((t) => t !== name);
  walk(doc.rows, (row) => {
    if (row.tags?.includes(name)) row.tags = row.tags.filter((t) => t !== name);
  });
}
