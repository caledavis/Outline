// The outline's data and the operations that reshape it. Nothing in here
// touches the screen; the view calls these functions and then redraws.

/** The id of the main column (stored as OPML's standard `text` attribute). */
export const TOPIC = "topic";

export interface Column {
  id: string;
  name: string;
  width?: number | null;
}

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
}

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
  children: Row[];
}

export interface OutlineDoc {
  title: string;
  columns: Column[];
  styles: Style[];
  rows: Row[];
}

export function newRow(): Row {
  return { id: crypto.randomUUID(), cells: {}, note: "", collapsed: false, children: [] };
}

export function newDoc(): OutlineDoc {
  return { title: "", columns: [{ id: TOPIC, name: "Topic" }], styles: starterStyles(), rows: [newRow()] };
}

/** A few examples to start a new outline with. */
function starterStyles(): Style[] {
  return [
    { id: "s1", name: "Heading", size: 18, bold: true },
    { id: "s2", name: "Important", color: "#c2410c", bold: true },
    { id: "s3", name: "Highlight", background: "#fff3bf" },
    { id: "s4", name: "Muted", size: 12, color: "#8a8a8e", italic: true },
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
