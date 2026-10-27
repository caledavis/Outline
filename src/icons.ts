// Icons from the Lucide set (https://lucide.dev). Importing each icon by name
// means only the ones we use end up in the app.

import {
  Bold, ChevronDown, ChevronRight, FilePlus, FolderOpen, GripVertical, Italic,
  Link, Plus, Save, StickyNote, Strikethrough, Underline, X, createElement,
} from "lucide";

type IconNode = Parameters<typeof createElement>[0];

/** Icons that can be named in HTML with a `data-icon` attribute. */
const BY_NAME: Record<string, IconNode> = {
  "file-plus": FilePlus,
  "folder-open": FolderOpen,
  save: Save,
  bold: Bold,
  italic: Italic,
  underline: Underline,
  strikethrough: Strikethrough,
  link: Link,
  note: StickyNote,
};

export { ChevronDown, ChevronRight, GripVertical, Plus, X };

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
