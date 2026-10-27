// The sidebar: an overview of the outline's top-level rows, then the styles
// and the tags, where each is applied to rows and managed.

import { ask, message } from "@tauri-apps/plugin-dialog";
import { Bold, ChevronDown, ChevronUp, Italic, ListFilter, Pencil, Plus, RotateCcw, Trash2, icon } from "./icons";
import { toggleMenu } from "./menu";
import * as model from "./model";
import type { Style } from "./model";
import { promptText } from "./prompt";
import { isMac, type OutlineView } from "./view";

const MOD = isMac ? "⌘" : "Ctrl+";

export class Sidebar {
  private overview = el("ol", "overview");
  private tags = el("div", "tag-chips");
  private addTagButton = el("button", "add-style");
  private styles = el("ul", "styles");
  private addStyleButton = el("button", "add-style");
  /** The style whose settings are open for editing. */
  private openStyleId: string | null = null;
  /** Set when the style list needs redrawing but one of its fields has focus. */
  private stylesStale = false;
  /** The document before the style being edited was changed, for undo. */
  private snapshot: string | null = null;

  constructor(root: HTMLElement, private view: OutlineView) {
    this.addStyleButton.append(icon(Plus, 14), "New style");
    this.addStyleButton.addEventListener("click", () => this.addStyle());

    this.addTagButton.append(icon(Plus, 14), "New tag");
    this.addTagButton.addEventListener("click", () => this.addTag());

    // The overview scrolls on its own, so styles and tags stay put at the bottom.
    root.append(
      section("overview-pane", "Overview", this.overview),
      section("styles-pane", "Styles", this.styles, this.addStyleButton),
      section("tags-pane", "Tags", this.tags, this.addTagButton),
    );
    // Redraw the lists once the user has finished with a field in them.
    this.styles.addEventListener("focusout", (e) => {
      if (this.stylesStale && !this.styles.contains(e.relatedTarget as Node | null)) this.renderStyles();
    });
    this.refresh();
  }

  /** Redraws everything (after the document changes). */
  refresh() {
    this.renderOverview();
    if (this.styles.contains(document.activeElement)) this.stylesStale = true;
    else this.renderStyles();
    this.renderTags();
  }

  /** Highlights what applies to the selected rows (after the selection changes). */
  updateSelection() {
    const top = this.view.selectedId ? model.path(this.view.doc, this.view.selectedId)[0]?.id : null;
    for (const item of this.overview.querySelectorAll<HTMLElement>("[data-id]")) {
      item.classList.toggle("active", item.dataset.id === top);
    }
    const used = this.view.selectedStyles();
    for (const item of this.styles.querySelectorAll<HTMLElement>("[data-style-id]")) {
      item.classList.toggle("active", used.has(item.dataset.styleId || null));
    }
    const tagged = this.view.selectedTags();
    for (const item of this.tags.querySelectorAll<HTMLElement>(".tag-chip")) {
      item.classList.toggle("active", tagged.has(item.dataset.tag!));
    }
  }

  // -------------------------------------------------------------------------
  // Overview
  // -------------------------------------------------------------------------

  private renderOverview() {
    const items = this.view.doc.rows.map((row) => {
      const button = el("button", "overview-item");
      button.dataset.id = row.id;
      const text = this.view.topicText(row).trim();
      button.textContent = text || "Untitled";
      button.classList.toggle("untitled", !text);
      button.title = text;
      button.addEventListener("click", () => this.view.reveal(row.id));
      const li = el("li");
      li.append(button);
      return li;
    });
    this.overview.replaceChildren(...items);
    this.updateSelection();
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  /**
   * Every tag as a chip, with how many rows have it. Clicking a chip adds the
   * tag to (or removes it from) the selected rows; its ⌄ menu filters by the
   * tag, renames it or deletes it.
   */
  private renderTags() {
    this.tags.replaceChildren(...model.allTags(this.view.doc).map(({ tag, count }) => this.renderTag(tag, count)));
    this.updateSelection();
  }

  private renderTag(tag: string, count: number): HTMLElement {
    const filtering = this.view.filter.tags.includes(tag);
    const chip = el("span", "tag-chip");
    chip.dataset.tag = tag;
    chip.classList.toggle("filtering", filtering);

    const apply = el("button", "tag-apply");
    apply.title = `Add “${tag}” to the selected rows, or remove it`;
    if (filtering) apply.append(icon(ListFilter, 12));
    apply.append(text("tag-name", tag), text("tag-count", String(count)));
    // Keep the focus (and any text being edited) in the outline.
    apply.addEventListener("mousedown", (e) => e.preventDefault());
    apply.addEventListener("click", () => this.view.applyTag(tag));

    const menu = iconButton(ChevronDown, "Filter, rename or delete", () =>
      toggleMenu(menu, () => [
        {
          label: filtering ? "Stop filtering by this tag" : "Show only rows with this tag",
          icon: ListFilter,
          action: () => this.view.toggleTagFilter(tag),
        },
        { label: "Rename…", icon: Pencil, action: () => this.renameTag(tag) },
        "separator",
        { label: "Delete tag", icon: Trash2, danger: true, action: () => this.deleteTag(tag, count) },
      ]),
    );
    menu.className = "tag-menu";
    menu.addEventListener("mousedown", (e) => e.preventDefault());

    chip.append(apply, menu);
    return chip;
  }

  private async addTag() {
    const name = await promptText("New tag", "");
    if (name && !this.view.createTag(name)) {
      await message(`There's already a tag called “${model.cleanTags([name])[0]}”.`, { title: "New tag" });
    }
  }

  private async renameTag(tag: string) {
    const name = await promptText(`Rename “${tag}” (on every row that has it)`, tag);
    if (name) this.view.renameTag(tag, name);
  }

  private async deleteTag(tag: string, count: number) {
    const used = count ? ` It will be removed from ${count} ${count === 1 ? "row" : "rows"}.` : "";
    if (await ask(`Delete the tag “${tag}”?${used}`, { title: "Delete tag", kind: "warning", okLabel: "Delete" })) {
      this.view.deleteTag(tag);
    }
  }

  // -------------------------------------------------------------------------
  // Styles
  // -------------------------------------------------------------------------

  private renderStyles() {
    this.stylesStale = false;
    const styles = this.view.doc.styles;
    const items = styles.map((style, i) => this.renderStyle(style, i));
    // Default comes last: applying it removes a row's style (⌘0), and its
    // settings set how every row without a style looks.
    items.push(this.renderStyle(this.view.doc.defaultStyle!, -1));

    this.styles.replaceChildren(...items);
    this.addStyleButton.disabled = styles.length >= model.MAX_STYLES;
    this.addStyleButton.title = this.addStyleButton.disabled ? `Up to ${model.MAX_STYLES} styles` : "";
    this.updateSelection();
  }

  private renderStyle(style: Style, index: number): HTMLElement {
    const item = el("li", "style-item");
    const open = style.id === this.openStyleId;
    item.classList.toggle("open", open);

    const isDefault = style.id === model.DEFAULT_STYLE;
    const apply = el("button", "style-apply");
    apply.dataset.styleId = isDefault ? "" : style.id;
    apply.title = isDefault ? "Set the selected rows back to Default" : "Apply to the selected rows";
    const name = text("style-name", style.name || "Untitled");
    name.dataset.style = style.id;
    apply.append(kbd(`${MOD}${index + 1}`), name);
    // Keep the focus (and any text being edited) in the outline.
    apply.addEventListener("mousedown", (e) => e.preventDefault());
    apply.addEventListener("click", () => this.view.applyStyle(isDefault ? null : style.id));

    const edit = iconButton(Pencil, open ? "Close settings" : "Edit style", () => {
      this.openStyleId = open ? null : style.id;
      this.renderStyles();
    });
    edit.classList.add("style-edit");
    edit.classList.toggle("active", open);

    item.append(apply, edit);
    if (open) item.append(this.renderSettings(style, index, name));
    return item;
  }

  /** The fields for changing a style. Changes show straight away in the outline. */
  private renderSettings(style: Style, index: number, preview: HTMLElement): HTMLElement {
    const settings = el("div", "style-settings");
    // Default has no name, order or delete. Each style stands alone: whatever it
    // leaves unset is the app's normal look, whatever Default says.
    const isDefault = style.id === model.DEFAULT_STYLE;

    // Typing previews the change; each finished change becomes one undo step.
    const live = (update: () => void) => {
      this.snapshot ??= this.view.snapshot();
      update();
      this.view.updateStyleSheet();
    };
    const done = () => {
      if (this.snapshot) this.view.commit(this.snapshot);
      this.snapshot = null;
    };

    const nameInput = el("input");
    nameInput.type = "text";
    nameInput.value = style.name;
    nameInput.addEventListener("input", () =>
      live(() => {
        style.name = nameInput.value;
        preview.textContent = style.name || "Untitled";
      }),
    );
    nameInput.addEventListener("change", done);
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") nameInput.blur();
    });

    const sizeInput = el("input");
    sizeInput.type = "number";
    sizeInput.min = "6";
    sizeInput.max = "96";
    sizeInput.placeholder = "14";
    sizeInput.value = style.size ? String(style.size) : "";
    sizeInput.addEventListener("input", () =>
      live(() => {
        const size = Math.round(Number(sizeInput.value));
        style.size = sizeInput.value && size >= 6 && size <= 96 ? size : null;
      }),
    );
    sizeInput.addEventListener("change", done);

    /** A colour picker with a button to go back to having no colour. */
    const colorPicker = (key: "color" | "background", suggestion: string, noneLabel: string) => {
      const input = el("input");
      input.type = "color";
      input.value = style[key] ?? suggestion;
      input.classList.toggle("unset", !style[key]);
      input.title = style[key] ?? `${noneLabel} (click to choose)`;
      input.addEventListener("input", () =>
        live(() => {
          style[key] = input.value;
          input.classList.remove("unset");
          reset.hidden = false;
        }),
      );
      input.addEventListener("change", done);

      const reset = iconButton(RotateCcw, noneLabel, () => {
        live(() => (style[key] = null));
        done();
        this.renderStyles();
      });
      reset.hidden = !style[key];

      const wrapper = el("div", "color-field");
      wrapper.append(input, reset);
      return wrapper;
    };

    /** A button that switches bold or italic on and off. */
    const toggle = (key: "bold" | "italic", node: Parameters<typeof icon>[0], label: string) => {
      const button = iconButton(node, label, () => {
        live(() => (style[key] = !style[key]));
        done();
        button.classList.toggle("active", !!style[key]);
        button.setAttribute("aria-pressed", String(!!style[key]));
      });
      button.classList.toggle("active", !!style[key]);
      button.setAttribute("aria-pressed", String(!!style[key]));
      return button;
    };

    const up = iconButton(ChevronUp, "Move up (changes its shortcut)", () => this.moveStyle(style, -1));
    up.disabled = index === 0;
    const down = iconButton(ChevronDown, "Move down (changes its shortcut)", () => this.moveStyle(style, 1));
    down.disabled = index === this.view.doc.styles.length - 1;
    const remove = iconButton(Trash2, "Delete style", () => {
      this.openStyleId = null;
      this.view.change(() => (model.removeStyle(this.view.doc, style.id), true));
      this.renderStyles();
    });
    remove.classList.add("danger");

    // The normal font is serif, so choosing Serif clears the setting.
    const fonts: [string, Style["font"]][] = [["Serif", null], ["Sans", "sans"], ["Mono", "mono"]];
    const fontField = el("div", "segmented");
    for (const [label, font] of fonts) {
      const option = el("button");
      option.textContent = label;
      option.style.fontFamily = `var(--${font ?? "serif"})`;
      option.classList.toggle("active", (style.font === "serif" ? null : (style.font ?? null)) === font);
      option.addEventListener("click", () => {
        live(() => (style.font = font));
        done();
        for (const other of fontField.children) other.classList.toggle("active", other === option);
      });
      fontField.append(option);
    }

    const textField = el("div", "toggle-field");
    textField.append(toggle("bold", Bold, "Bold"), toggle("italic", Italic, "Italic"));
    const sizeField = el("div", "size-field");
    sizeField.append(sizeInput, text("unit", "px"));
    const actions = el("div", "style-actions");
    actions.append(up, down, el("span", "spacer"), remove);

    if (!isDefault) settings.append(field("Name", nameInput));
    settings.append(
      field("Size", sizeField),
      field("Font", fontField),
      field("Text", textField),
      field("Colour", colorPicker("color", "#1f5fbf", "Normal colour")),
      field("Highlight", colorPicker("background", "#fff3bf", "No highlight")),
    );
    if (!isDefault) settings.append(actions);
    return settings;
  }

  private addStyle() {
    let style: Style | null = null;
    this.view.change(() => !!(style = model.addStyle(this.view.doc)));
    if (!style) return;
    this.openStyleId = (style as Style).id;
    this.renderStyles();
    this.styles.querySelector<HTMLInputElement>(".style-settings input")?.select();
  }

  private moveStyle(style: Style, delta: -1 | 1) {
    this.view.change(() => model.moveStyle(this.view.doc, style.id, delta));
    this.renderStyles();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function text(className: string, value: string): HTMLElement {
  const span = el("span", className);
  span.textContent = value;
  return span;
}

function kbd(value: string): HTMLElement {
  const k = el("kbd");
  k.textContent = value;
  return k;
}

function iconButton(node: Parameters<typeof icon>[0], label: string, onClick: () => void): HTMLButtonElement {
  const button = el("button", "icon-button");
  button.append(icon(node, 14));
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);
  return button;
}

function field(label: string, input: HTMLElement): HTMLElement {
  const wrapper = el("label", "field");
  wrapper.append(text("label", label), input);
  return wrapper;
}

function section(className: string, title: string, ...children: HTMLElement[]): HTMLElement {
  const sectionEl = el("section", className);
  const heading = el("h2");
  heading.textContent = title;
  sectionEl.append(heading, ...children);
  return sectionEl;
}
