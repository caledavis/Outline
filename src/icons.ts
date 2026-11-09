// Icons from the Lucide set (https://lucide.dev). Importing each icon by name
// means only the ones we use end up in the app.

import {
  AArrowDown, AArrowUp, Bold, BookOpen, Bug, CalendarDays, Check, ChevronDown, ChevronRight, ChevronUp, ChevronsLeft,
  ChevronsRight, CircleArrowDown, FilePenLine, FilePlus, FileText, FolderOpen, Globe, GripVertical, Hash, Italic, Link,
  List, ListFilter, PanelLeft, Paperclip, Pencil, Plus, RotateCcw, Save, Scale, Search, SquareCheck, StickyNote,
  Strikethrough, Tag, Tags, Trash2, Type, Underline, X, createElement,
} from "lucide";

type IconNode = Parameters<typeof createElement>[0];

/** Icons that can be named in HTML with a `data-icon` attribute. */
const BY_NAME: Record<string, IconNode> = {
  search: Search,
  filter: ListFilter,
};

export {
  AArrowDown, AArrowUp, Bold, BookOpen, Bug, CalendarDays, Check, ChevronDown, ChevronRight, ChevronUp,
  ChevronsLeft, ChevronsRight, CircleArrowDown, FilePenLine, FilePlus, FileText, FolderOpen, Globe, Link, PanelLeft,
  Save, Scale, StickyNote, Strikethrough, Underline,
  GripVertical, Hash, Italic, List, ListFilter, Paperclip, Pencil, Plus, RotateCcw, SquareCheck, Tag, Tags, Trash2, Type, X,
};

/** The `d` of each of an icon's paths, in order. */
const paths = (node: IconNode) => node.map(([, attrs]) => String(attrs.d));

const [saveBody, saveLabel, saveShutter] = paths(Save);
/** Save, for the ribbon's palette: the body's tint first and its ink outline
 *  last, so the outline is drawn over the blue label and the tint. */
export const SaveTinted: IconNode = [
  ["path", { d: saveBody, class: "rb-tint", stroke: "none" }],
  ["path", { d: saveLabel, class: "rb-accent" }],
  ["path", { d: saveShutter }],
  ["path", { d: saveBody }],
];

const [penPencil, penFold, penPage, penLine] = paths(FilePenLine);
/** Save As (FilePenLine), for the ribbon's palette: the page's tint is
 *  masked out under the pencil, so none of it shows inside the pencil. */
export const FilePenLineTinted: IconNode = [
  ["defs", {}, [
    ["mask", { id: "rb-file-pen-line-mask", maskUnits: "userSpaceOnUse", x: 0, y: 0, width: 24, height: 24 }, [
      ["rect", { x: 0, y: 0, width: 24, height: 24, fill: "white" }],
      ["path", { d: penPencil, fill: "black", stroke: "black", "stroke-width": 1 }],
    ]],
  ]],
  ["path", { d: penPage, class: "rb-tint", stroke: "none", mask: "url(#rb-file-pen-line-mask)" }],
  ["path", { d: penFold }],
  ["path", { d: penPage }],
  ["path", { d: penLine }],
  ["path", { d: penPencil, class: "rb-accent" }],
] as IconNode;

const cache = new Map<IconNode, SVGElement>();

/** Makes an icon as an inline SVG. Each icon is built once, then copied. */
export function icon(node: IconNode, size = 16): SVGElement {
  let svg = cache.get(node);
  if (!svg) {
    svg = createElement(node, { width: 16, height: 16, "stroke-width": 1.75, "aria-hidden": "true" });
    svg.classList.add("icon");
    cache.set(node, svg);
  }
  const copy = svg.cloneNode(true) as SVGElement;
  if (size !== 16) {
    copy.setAttribute("width", String(size));
    copy.setAttribute("height", String(size));
  }
  return copy;
}

/** Fills every element that has a `data-icon` attribute with that icon. */
export function insertIcons(root: ParentNode) {
  for (const el of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    const node = BY_NAME[el.dataset.icon!];
    if (node) el.prepend(icon(node));
  }
}
