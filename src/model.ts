// The outline's data and the operations that reshape it. Nothing in here
// touches the screen; the view calls these functions and then redraws.

/** The id of the main column (stored as OPML's standard `text` attribute). */
export const TOPIC = "topic";

export interface Column {
  id: string;
  name: string;
  width?: number | null;
}

export interface Row {
  /** Only used while the app is running; ids aren't saved to the file. */
  id: string;
  /** Cell contents as inline HTML, keyed by column id. */
  cells: Record<string, string>;
  /** Note contents as HTML paragraphs, or "" for no note. */
  note: string;
  collapsed: boolean;
  children: Row[];
}

export interface OutlineDoc {
  title: string;
  columns: Column[];
  rows: Row[];
}

export function newRow(): Row {
  return { id: crypto.randomUUID(), cells: {}, note: "", collapsed: false, children: [] };
}

export function newDoc(): OutlineDoc {
  return { title: "", columns: [{ id: TOPIC, name: "Topic" }], rows: [newRow()] };
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
