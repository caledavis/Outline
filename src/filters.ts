// The search box and filter menu in the toolbar, and the bar below it that
// shows which filters are on.

import { X, icon } from "./icons";
import { toggleMenu, type MenuEntry } from "./menu";
import * as model from "./model";
import type { OutlineView } from "./view";

export class Filters {
  private input = document.getElementById("search") as HTMLInputElement;
  private button = document.querySelector<HTMLButtonElement>('[data-action="filter"]')!;
  private bar = document.getElementById("filter-bar")!;
  private timer: number | undefined;

  constructor(private view: OutlineView) {
    this.input.addEventListener("input", () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.view.setFilter({ ...this.view.filter, text: this.input.value }), 150);
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.input.value = "";
        this.view.setFilter({ ...this.view.filter, text: "" });
        this.input.blur();
      } else if (e.key === "Enter" || e.key === "ArrowDown") {
        e.preventDefault();
        this.input.blur(); // on to the results
      }
    });
    this.button.addEventListener("click", () => toggleMenu(this.button, () => this.menu()));
    this.update();
  }

  focusSearch() {
    this.input.focus();
    this.input.select();
  }

  /** Brings the search box, filter button and filter bar up to date. */
  update() {
    const { text, tags, columns } = this.view.filter;
    if (document.activeElement !== this.input) this.input.value = text;

    const chips: HTMLElement[] = [];
    for (const tag of tags) {
      chips.push(this.chip(`Tag: ${tag}`, () => this.view.toggleTagFilter(tag)));
    }
    for (const [id, value] of Object.entries(columns)) {
      const column = this.view.doc.columns.find((c) => c.id === id);
      if (!column) continue;
      const shown = model.columnType(column) === "checkbox" ? (value ? "ticked" : "not ticked") : value;
      chips.push(this.chip(`${column.name}: ${shown}`, () => this.setColumn(id, null)));
    }
    if (chips.length > 1) {
      const clear = document.createElement("button");
      clear.className = "filter-clear";
      clear.textContent = "Clear all";
      clear.addEventListener("click", () => this.view.setFilter({ text: this.view.filter.text, tags: [], columns: {} }));
      chips.push(clear);
    }
    this.bar.replaceChildren(...chips);
    this.bar.hidden = chips.length === 0;
    this.button.classList.toggle("active", tags.length > 0 || Object.keys(columns).length > 0);
  }

  private chip(label: string, remove: () => void): HTMLElement {
    const chip = document.createElement("button");
    chip.className = "filter-chip";
    chip.title = "Remove this filter";
    chip.append(Object.assign(document.createElement("span"), { textContent: label }), icon(X, 12));
    chip.addEventListener("click", remove);
    return chip;
  }

  private setColumn(id: string, value: string | null) {
    const columns = { ...this.view.filter.columns };
    if (value === null) delete columns[id];
    else columns[id] = value;
    this.view.setFilter({ ...this.view.filter, columns });
  }

  /** Things to filter by: tags, and the values of checkbox and pop-up list columns. */
  private menu(): MenuEntry[] {
    const { tags, columns } = this.view.filter;
    const entries: MenuEntry[] = [];

    const allTags = model.allTags(this.view.doc);
    if (allTags.length) {
      entries.push({ heading: "Tags" });
      for (const { tag } of allTags) {
        entries.push({ label: tag, checked: tags.includes(tag), action: () => this.view.toggleTagFilter(tag) });
      }
    }

    for (const column of this.view.doc.columns) {
      const type = model.columnType(column);
      const choices: [string, string][] =
        type === "checkbox"
          ? [["true", "Ticked"], ["", "Not ticked"]]
          : type === "select"
            ? (column.options ?? []).map((o) => [o, o])
            : [];
      if (!choices.length) continue;
      if (entries.length) entries.push("separator");
      entries.push({ heading: column.name });
      for (const [value, label] of choices) {
        const on = columns[column.id] === value;
        entries.push({ label, checked: on, action: () => this.setColumn(column.id, on ? null : value) });
      }
    }

    if (!entries.length) entries.push({ heading: "Nothing to filter by yet" });
    return entries;
  }
}
