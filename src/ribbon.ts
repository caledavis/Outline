/**
 * The ribbon: an Office-style tabbed toolbar, ported from Magnolia's
 * (components/Toolbar/Ribbon.tsx there).
 *
 * The tab strip sits in the toolbar row, beside the outline's name and
 * clear of the Mac's window buttons, and the active tab's groups of large
 * labelled buttons sit in a strip below it. Each button is a glyph in the
 * four-colour icon palette (see "Icon palette" in styles.css).
 *
 * Double-clicking a tab (or clicking the chevron) folds the ribbon to its
 * tab strip; that's remembered on this computer. While folded, clicking a
 * tab shows its buttons over the outline until you click a button or
 * anywhere else.
 *
 * A button is at least 60px wide (Magnolia's are 76px; Outline's labels
 * are mostly short words), and wider when its label needs it: as
 * wide as the label's widest line when it's wrapped onto two lines as
 * evenly as its word breaks allow (see twoLineWidth), so no label takes a
 * third line. When that makes the tab too wide for the window, labels that
 * are one long word go back to 60px and are hyphenated (data-tight
 * "words"). If even that doesn't fit, the buttons scroll sideways between
 * chevrons that fade in while there's more that way; clicking one scrolls
 * a page.
 *
 * Each button keeps its `data-action`, so main.ts finds and updates them
 * (marks, disabled, pressed) as it did the old toolbar's.
 */

import { ChevronDown, ChevronUp, ChevronsLeft, ChevronsRight, icon } from "./icons";

type IconNode = Parameters<typeof icon>[0];

export interface RibbonButtonDef {
  /** The action main.ts runs (data-action). */
  action: string;
  label: string;
  icon: IconNode;
  /** The glyph's name, which picks its colours in the icon palette. */
  tint: string;
  title?: string;
  /** For the formatting buttons, which light up with their mark. */
  mark?: string;
}

export interface RibbonGroupDef {
  label: string;
  buttons: RibbonButtonDef[];
}

export interface RibbonTabDef {
  id: string;
  label: string;
  groups: RibbonGroupDef[];
}

const COLLAPSED_KEY = "ribbonCollapsed";
const TAB_KEY = "ribbonTab";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Remembering this is only a convenience.
  }
}

export class Ribbon {
  private tabButtons = new Map<string, HTMLButtonElement>();
  private panels = new Map<string, HTMLElement>();
  private collapseButton: HTMLButtonElement;
  private body: HTMLElement;
  private scroller!: HTMLElement;
  private startChevron: HTMLButtonElement;
  private endChevron: HTMLButtonElement;
  private active: string;
  private collapsed = readStored(COLLAPSED_KEY) === "1";
  private peek = false;
  private fitFrame = 0;
  private observer = new ResizeObserver(() => {
    // Refit on the next frame: fitting resizes the groups, which would
    // otherwise notify this observer again within the same frame.
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => this.fit());
  });

  /** Called when a button is clicked. */
  onAction: (action: string, button: HTMLButtonElement) => void = () => {};

  constructor(
    private strip: HTMLElement,
    private host: HTMLElement,
    private tabs: RibbonTabDef[],
  ) {
    const stored = readStored(TAB_KEY);
    this.active = tabs.some((t) => t.id === stored) ? stored! : tabs[0].id;

    strip.classList.add("ribbon-tabs");
    strip.setAttribute("role", "tablist");
    strip.setAttribute("aria-label", "Toolbar");
    tabs.forEach((tab, index) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ribbon-tab";
      b.setAttribute("role", "tab");
      b.textContent = tab.label;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => this.selectTab(tab.id));
      b.addEventListener("dblclick", () => this.toggleCollapsed());
      b.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const next = tabs[(index + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        this.selectTab(next.id);
        this.tabButtons.get(next.id)!.focus();
      });
      this.tabButtons.set(tab.id, b);
      strip.append(b);
    });
    this.collapseButton = document.createElement("button");
    this.collapseButton.type = "button";
    this.collapseButton.className = "ribbon-collapse";
    this.collapseButton.addEventListener("mousedown", (e) => e.preventDefault());
    this.collapseButton.addEventListener("click", () => this.toggleCollapsed());
    strip.append(this.collapseButton);

    this.body = document.createElement("div");
    this.body.className = "ribbon-body";
    this.body.setAttribute("role", "tabpanel");
    this.startChevron = this.chevron("start");
    this.endChevron = this.chevron("end");
    this.scroller = document.createElement("div");
    this.scroller.className = "ribbon-scroll";
    this.scroller.addEventListener("scroll", () => this.updateChevrons(), { passive: true });
    for (const tab of tabs) {
      const panel = document.createElement("div");
      panel.className = "ribbon-panel";
      for (const group of tab.groups) panel.append(this.group(group));
      this.panels.set(tab.id, panel);
      this.scroller.append(panel);
    }
    this.body.append(this.startChevron, this.scroller, this.endChevron);
    host.append(this.body);

    // A peeking ribbon closes on a click anywhere outside it, or Escape.
    document.addEventListener("mousedown", (e) => {
      if (this.peek && !(e.target as Element).closest?.(".ribbon-tabs, .ribbon-body")) this.setPeek(false);
    });
    document.addEventListener("keydown", (e) => {
      if (this.peek && e.key === "Escape") this.setPeek(false);
    });

    this.observer.observe(this.body);
    this.render();
  }

  /** A button, by its action. */
  button(action: string): HTMLButtonElement | null {
    return this.host.querySelector<HTMLButtonElement>(`.ribbon-btn[data-action="${action}"]`);
  }

  /** Shows or hides a dot on a button, and on its tab. */
  setBadge(action: string, shown: boolean) {
    const b = this.button(action);
    if (!b) return;
    b.querySelector(".ribbon-badge")?.toggleAttribute("hidden", !shown);
    const tab = this.tabs.find((t) => t.groups.some((g) => g.buttons.some((x) => x.action === action)));
    if (tab) this.tabButtons.get(tab.id)!.classList.toggle("has-badge", shown);
  }

  selectTab(id: string) {
    const again = id === this.active;
    this.active = id;
    writeStored(TAB_KEY, id);
    this.setPeek(this.collapsed ? !(this.peek && again) : false);
  }

  toggleCollapsed() {
    this.collapsed = !this.collapsed;
    writeStored(COLLAPSED_KEY, this.collapsed ? "1" : "0");
    this.setPeek(false);
  }

  private setPeek(peek: boolean) {
    this.peek = peek;
    this.render();
  }

  private render() {
    const shown = !this.collapsed || this.peek;
    this.strip.classList.toggle("ribbon-collapsed", !shown);
    for (const [id, b] of this.tabButtons) {
      b.setAttribute("aria-selected", String(id === this.active));
      b.tabIndex = id === this.active ? 0 : -1;
    }
    const label = this.collapsed ? "Show the ribbon" : "Hide the ribbon";
    this.collapseButton.title = label;
    this.collapseButton.setAttribute("aria-label", label);
    this.collapseButton.replaceChildren(icon(this.collapsed ? ChevronDown : ChevronUp, 16));

    this.host.hidden = !shown;
    this.host.classList.toggle("ribbon-peek", this.peek);
    const tab = this.tabs.find((t) => t.id === this.active)!;
    this.body.setAttribute("aria-label", tab.label);
    for (const [id, panel] of this.panels) panel.hidden = id !== this.active;
    // A tab starts scrolled to its first button.
    this.scroller.scrollLeft = 0;
    // Watch the shown groups, which change size when buttons do.
    this.observer.disconnect();
    this.observer.observe(this.body);
    for (const group of this.panels.get(this.active)!.children) this.observer.observe(group);
    if (shown) this.fit();
  }

  private group(def: RibbonGroupDef): HTMLElement {
    const group = document.createElement("div");
    group.className = "ribbon-group";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", def.label);
    const buttons = document.createElement("div");
    buttons.className = "ribbon-group-buttons";
    for (const b of def.buttons) buttons.append(this.makeButton(b));
    const label = document.createElement("div");
    label.className = "ribbon-group-label";
    label.textContent = def.label;
    group.append(buttons, label);
    return group;
  }

  private makeButton(def: RibbonButtonDef): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ribbon-btn";
    b.dataset.action = def.action;
    if (def.mark) b.dataset.mark = def.mark;
    b.title = (def.title ?? def.label).replace(/Mod\+/g, /Mac/.test(navigator.userAgent) ? "⌘" : "Ctrl+");
    const tile = document.createElement("span");
    tile.className = "ribbon-tile";
    const glyph = icon(def.icon, 24);
    glyph.classList.add("rb-icon", `rb-${def.tint}`);
    const badge = document.createElement("span");
    badge.className = "ribbon-badge";
    badge.hidden = true;
    badge.setAttribute("aria-hidden", "true");
    tile.append(glyph, badge);
    const label = document.createElement("span");
    label.className = "ribbon-label";
    label.textContent = def.label;
    // A label with nowhere to break but inside its word.
    label.toggleAttribute("data-one-word", !/[\s-]/.test(def.label.trim()));
    b.append(tile, label);
    // Keep the focus where it was (in the text being edited, say).
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      this.onAction(def.action, b);
      if (this.peek) this.setPeek(false);
    });
    return b;
  }

  /** A chevron beside the scrolling buttons, for mice without a sideways
   *  scroll. Hidden from keyboards and screen readers, which reach every
   *  button by Tab. */
  private chevron(side: "start" | "end"): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ribbon-scroll-hint";
    b.tabIndex = -1;
    b.setAttribute("aria-hidden", "true");
    b.append(icon(side === "start" ? ChevronsLeft : ChevronsRight, 16));
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      this.scroller.scrollBy({ left: (side === "end" ? 1 : -1) * this.scroller.clientWidth * 0.8, behavior: "smooth" });
    });
    return b;
  }

  /** Fits the buttons to the window: label widths first, then narrowed
   *  one-word labels, then scrolling between the chevrons. */
  private fit() {
    if (this.host.hidden) return;
    for (const label of this.panels.get(this.active)!.querySelectorAll<HTMLElement>(".ribbon-label")) {
      if (!label.style.minWidth) sizeLabel(label);
    }
    // Room inside the body's padding, whether or not the chevrons are
    // taking some of it now.
    const style = getComputedStyle(this.body);
    const room = this.body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const fits = () => this.scroller.scrollWidth <= room + 1;
    this.body.removeAttribute("data-tight");
    this.body.removeAttribute("data-overflow");
    if (!fits()) this.body.setAttribute("data-tight", "words");
    if (!fits()) this.body.setAttribute("data-overflow", "");
    this.updateChevrons();
  }

  private updateChevrons() {
    const el = this.scroller;
    const start = Math.abs(el.scrollLeft);
    const end = el.scrollWidth - el.clientWidth - start;
    this.startChevron.toggleAttribute("data-shown", start > 1);
    this.endChevron.toggleAttribute("data-shown", end > 1);
  }
}

/** Gives a label the narrowest width at which it fits on two lines, in ems
 *  of its own size, so it holds in the compact ribbon's smaller type too.
 *  Measured with a hidden copy of the label, in exactly its font. */
function sizeLabel(label: HTMLElement) {
  const probe = document.createElement("span");
  probe.className = label.className;
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;min-width:0;min-height:0";
  label.parentElement!.append(probe);
  const measure = (s: string) => {
    probe.textContent = s;
    return probe.getBoundingClientRect().width;
  };
  const px = twoLineWidth(label.textContent ?? "", measure);
  const size = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  // A hair extra, so rounding never pushes the last word onto a new line.
  if (size > 0 && px > 0) label.style.minWidth = `${(px / size + 0.05).toFixed(3)}em`;
}

/** The narrowest width at which `text` fits on at most two lines, given
 *  `measure` (a run of text's width). Lines break after spaces and
 *  hyphens, as the browser breaks them, and never inside a word. */
export function twoLineWidth(text: string, measure: (s: string) => number): number {
  const parts = text.trim().split(/(?<=[\s-])/);
  let best = measure(text.trim());
  for (let i = 1; i < parts.length; i++) {
    const first = measure(parts.slice(0, i).join("").trimEnd());
    const second = measure(parts.slice(i).join(""));
    best = Math.min(best, Math.max(first, second));
  }
  return best;
}
