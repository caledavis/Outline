// The tag dialogs, ported from Magnolia's (DocumentBrowser.tsx there):
//
// - Manage Tags, from the ribbon's Tags button: the tag categories (each with
//   its values) and the uncategorised tags, where they're added, renamed and
//   deleted, and a form for adding a category.
// - Edit Tags, from ⌘⇧T or a row's Tags cell: every tag as a checkbox for the
//   selected rows, grouped by category, with a way to add a value.
//
// A category ("Country") has a type: text, date or numeric values are typed
// in; a list offers its options. Its values are tags ("Country:Australia"),
// so rows, filters and other apps see plain tags (see "Tag categories" in
// model.ts).

import { ask } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ChevronRight, X, icon } from "./icons";
import * as model from "./model";
import type { TagCategory, TagCategoryType } from "./model";
import type { OutlineView } from "./view";

const GENERAL = "\u0000general";
const TYPE_NAMES: Record<TagCategoryType, string> = { text: "Text", date: "Date", numeric: "Numeric", list: "List" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A dialog built here, opened as a modal and removed when it closes. */
function makeDialog(className: string, title: string): { dialog: HTMLDialogElement; body: HTMLElement; actions: HTMLMenuElement } {
  const dialog = el("dialog", `tags-dialog ${className}`);
  const body = el("div", "tags-body");
  const actions = el("menu");
  dialog.append(el("h2", "", title), body, actions);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  return { dialog, body, actions };
}

function actionButton(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const button = el("button", primary ? "primary" : "", label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

/**
 * Rebuilds `body` with `build`, keeping the focus (and the text typed so far)
 * in whichever field had it: each field has a data-key naming it.
 */
function rebuild(body: HTMLElement, build: () => Node[]) {
  const active = document.activeElement as HTMLInputElement | null;
  const key = active && body.contains(active) ? active.dataset.key : undefined;
  const typed = new Map<string, string>();
  for (const input of body.querySelectorAll<HTMLInputElement>("input[data-key]:not([type=checkbox])")) {
    typed.set(input.dataset.key!, input.value);
  }
  const scroll = body.scrollTop;
  body.replaceChildren(...build());
  body.scrollTop = scroll;
  for (const input of body.querySelectorAll<HTMLInputElement>("input[data-key]:not([type=checkbox])")) {
    if (typed.has(input.dataset.key!) && !input.dataset.fresh) input.value = typed.get(input.dataset.key!)!;
  }
  const again = key && body.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
  if (again) again.focus();
}

/** A text field that runs `onEnter` with its trimmed text when Enter is pressed. */
function entryField(key: string, placeholder: string, onEnter: (value: string) => void, type = "text"): HTMLInputElement {
  const input = el("input");
  input.type = type;
  input.placeholder = placeholder;
  input.dataset.key = key;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    input.value = "";
    onEnter(value);
  });
  return input;
}

/** A section header that folds its section, with a chevron. */
function sectionHeader(open: boolean, onToggle: () => void, ...content: Node[]): HTMLElement {
  const header = el("div", "tags-section-header");
  header.append(icon(open ? ChevronDown : ChevronRight, 12), ...content);
  header.addEventListener("click", onToggle);
  return header;
}

// ---------------------------------------------------------------------------
// Edit Tags
// ---------------------------------------------------------------------------

/** Ticks and unticks tags on the selected rows. */
export function editTags(view: OutlineView, manage: () => void) {
  if (!view.selectedRowObjects().length) return;
  const count = view.selectedRowObjects().length;
  const { dialog, body, actions } = makeDialog("tags-apply", count > 1 ? `Edit Tags (${count} rows)` : "Edit Tags");
  // Every section starts folded, as in Magnolia.
  const open = new Set<string>();

  const toggle = (key: string) => {
    if (!open.delete(key)) open.add(key);
    render();
  };

  const checkbox = (tag: string | null, label: string, create?: () => string | null) => {
    const all = view.selectedTags();
    const some = view.partlySelectedTags();
    const row = el("label", "tags-check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = !!tag && all.has(tag);
    box.indeterminate = !!tag && some.has(tag);
    box.dataset.key = `check:${tag ?? label}`;
    box.addEventListener("change", () => {
      const t = tag ?? create?.();
      if (t) view.setTagOnSelection(t, box.checked);
      render();
    });
    row.append(box, el("span", "", label));
    return row;
  };

  const build = (): Node[] => {
    const doc = view.doc;
    const out: Node[] = [];
    const general = model.categoryTags(doc, null);
    const section = (key: string, header: Node[], content: () => Node[]) => {
      const wrap = el("div", "tags-section");
      wrap.append(sectionHeader(open.has(key), () => toggle(key), ...header));
      if (open.has(key)) {
        const inner = el("div", "tags-section-body");
        inner.append(...content());
        wrap.append(inner);
      }
      out.push(wrap);
    };

    section(GENERAL, [el("span", "tags-section-name", "General")], () => [
      ...general.map(({ tag }) => checkbox(tag, tag)),
      entryField("add:general", "Add tag...", (value) => {
        const [tag] = model.cleanTags([value]);
        if (tag) view.setTagOnSelection(tag, true);
        render();
      }),
    ]);

    for (const category of doc.tagCategories ?? []) {
      const tags = model.categoryTags(doc, category);
      section(category.name, [el("span", "tags-section-name", category.name), el("span", "tags-type", `(${category.type})`)], () => {
        if (category.type === "list") {
          const box = el("div", "tags-list-options");
          box.append(
            ...model.sortedListOptions(category).map((option) => {
              const tag = model.categoryTag(category.name, option);
              const exists = tags.some((t) => t.tag === tag);
              return checkbox(exists ? tag : null, option, () => view.createCategoryTag(category, option));
            }),
          );
          return [box];
        }
        const placeholder = category.type === "date" ? "dd/mm/yyyy, mm/yyyy, yyyy, etc." : `Add ${category.name} value...`;
        const add = entryField(
          `add:${category.name}`,
          placeholder,
          (value) => {
            const tag = view.createCategoryTag(category, value) ?? existingTag(category, value);
            if (tag) view.setTagOnSelection(tag, true);
            render();
          },
          category.type === "numeric" ? "number" : "text",
        );
        return [...tags.map(({ tag, value }) => checkbox(tag, value)), add];
      });
    }

    if (!general.length && !(doc.tagCategories ?? []).length) {
      out.push(el("p", "tags-empty", "No tags yet. Add one under General, or use Manage Tags... to create categories."));
    }
    return out;
  };

  /** A value's tag, if its category already has it (createCategoryTag
   *  returns null both for an invalid value and one that exists). */
  const existingTag = (category: TagCategory, value: string): string | null => {
    if (!model.validCategoryValue(category, value)) return null;
    const tag = model.categoryTag(category.name, model.cleanTags([value])[0]);
    return model.allTags(view.doc).some((t) => t.tag === tag) ? tag : null;
  };

  const render = () => rebuild(body, build);

  const manageButton = actionButton("Manage Tags...", false, () => {
    dialog.close();
    manage();
  });
  manageButton.classList.add("tags-manage");
  actions.append(manageButton, actionButton("Done", true, () => dialog.close()));
  render();
  dialog.showModal();
}

// ---------------------------------------------------------------------------
// Manage Tags
// ---------------------------------------------------------------------------

/** Adds, renames and deletes tag categories and tags. */
export function manageTags(view: OutlineView) {
  const { dialog, body, actions } = makeDialog("tags-manage-dialog", "Manage Tags");
  // Everything starts unfolded, so it's all in view.
  const folded = new Set<string>();
  // Sorted once, when the dialog opens, so editing doesn't shuffle the list
  // under the pointer; new tags go at the end of their section.
  const order = new Map<string, number>();
  const snapshotOrder = () => {
    let i = 0;
    for (const category of [null, ...(view.doc.tagCategories ?? [])]) {
      for (const { tag } of model.categoryTags(view.doc, category)) order.set(tag, i++);
    }
  };
  snapshotOrder();
  const inOrder = <T extends { tag: string }>(tags: T[]) =>
    [...tags].sort((a, b) => (order.get(a.tag) ?? Infinity) - (order.get(b.tag) ?? Infinity));

  let renaming: string | null = null;
  let newType: TagCategoryType = "text";

  const render = () => rebuild(body, build);

  /** A name that turns into a field when clicked, and is renamed on Enter or leaving it. */
  const renameable = (key: string, label: string, className: string, onRename: (to: string) => void): HTMLElement => {
    if (renaming !== key) {
      const span = el("span", `${className} tags-renameable`, label);
      span.title = "Click to rename";
      span.addEventListener("click", (e) => {
        e.stopPropagation();
        renaming = key;
        render();
        const input = body.querySelector<HTMLInputElement>(`[data-key="${CSS.escape(`rename:${key}`)}"]`);
        input?.focus();
        input?.select();
      });
      return span;
    }
    const input = el("input", `${className} tags-rename`);
    input.value = label;
    input.dataset.key = `rename:${key}`;
    input.dataset.fresh = "1";
    input.spellcheck = false;
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      renaming = null;
      const to = input.value.trim();
      if (save && to && to !== label) onRename(to);
      render();
    };
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        // Leave the dialog open; just stop renaming.
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    return input;
  };

  const deleteButton = (title: string, onClick: () => void): HTMLButtonElement => {
    const button = el("button", "tags-delete");
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.append(icon(X, 14));
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return button;
  };

  const deleteTag = async (tag: string, count: number) => {
    if (count && !(await ask(`Remove “${tag}” from ${plural(count, "row")} and delete it?`, { title: "Delete tag", kind: "warning" }))) return;
    view.deleteTag(tag);
    render();
  };

  const tagRow = (tag: string, label: string, count: number, onRename: (to: string) => void): HTMLElement => {
    const row = el("div", "tags-row");
    row.append(
      renameable(`tag:${tag}`, label, "tags-row-name", onRename),
      el("span", "tags-count", plural(count, "row")),
      deleteButton("Delete", () => void deleteTag(tag, count)),
    );
    return row;
  };

  const addRow = (key: string, placeholder: string, onAdd: (value: string) => void, type = "text"): HTMLElement => {
    const row = el("div", "tags-row tags-add");
    const input = entryField(key, placeholder, onAdd, type);
    const add = el("button", "", "Add");
    add.type = "button";
    add.addEventListener("click", () => {
      const value = input.value.trim();
      if (!value) return;
      input.value = "";
      onAdd(value);
    });
    row.append(input, add);
    return row;
  };

  const build = (): Node[] => {
    const doc = view.doc;
    const out: Node[] = [];
    const general = inOrder(model.categoryTags(doc, null));

    for (const category of doc.tagCategories ?? []) {
      const tags = inOrder(model.categoryTags(doc, category));
      const isOpen = !folded.has(category.name);
      const wrap = el("div", "tags-section");
      const header = sectionHeader(
        isOpen,
        () => {
          if (!folded.delete(category.name)) folded.add(category.name);
          render();
        },
        renameable(`category:${category.name}`, category.name, "tags-section-name", (to) => {
          if (isOpen) folded.delete(category.name);
          view.renameCategory(category.name, to);
          renameOrder(category.name, to);
        }),
        el("span", "tags-type", category.type),
        el("span", "tags-count", plural(tags.length, "value")),
      );
      if (category.type === "list") {
        const edit = el("button", "tags-edit-options", "Edit Options");
        edit.type = "button";
        edit.addEventListener("click", (e) => {
          e.stopPropagation();
          editListOptions(view, category, render);
        });
        header.append(edit);
      }
      header.append(
        deleteButton("Delete category", async () => {
          const used = tags.reduce((n, t) => n + t.count, 0);
          const prompt = used
            ? `Delete the “${category.name}” category? Its ${plural(tags.length, "value")} will be removed from every row that has them.`
            : `Delete the “${category.name}” category?`;
          if (tags.length && !(await ask(prompt, { title: "Delete category", kind: "warning" }))) return;
          view.deleteCategory(category.name);
          render();
        }),
      );
      wrap.append(header);
      if (isOpen) {
        const inner = el("div", "tags-section-body");
        if (!tags.length) inner.append(el("div", "tags-row tags-none", "No values yet — add one below."));
        for (const { tag, value, count } of tags) {
          inner.append(
            tagRow(tag, value, count, (to) => {
              if (!model.validCategoryValue(category, to)) return;
              view.renameTag(tag, model.categoryTag(category.name, model.cleanTags([to])[0]));
            }),
          );
        }
        if (category.type !== "list") {
          const placeholder = category.type === "date" ? "Add value (dd/mm/yyyy, yyyy, etc.)..." : `Add ${category.name} value...`;
          inner.append(
            addRow(
              `add:${category.name}`,
              placeholder,
              (value) => {
                view.createCategoryTag(category, value);
                render();
              },
              category.type === "numeric" ? "number" : "text",
            ),
          );
        }
        wrap.append(inner);
      }
      out.push(wrap);
    }

    if (general.length || !(doc.tagCategories ?? []).length) {
      const isOpen = !folded.has(GENERAL);
      const wrap = el("div", "tags-section");
      wrap.append(
        sectionHeader(
          isOpen,
          () => {
            if (!folded.delete(GENERAL)) folded.add(GENERAL);
            render();
          },
          el("span", "tags-section-name", "General"),
          el("span", "tags-type", "uncategorised"),
          el("span", "tags-count", plural(general.length, "tag")),
        ),
      );
      if (isOpen) {
        const inner = el("div", "tags-section-body");
        if (!general.length) inner.append(el("div", "tags-row tags-none", "No tags yet — add one below."));
        for (const { tag, count } of general) inner.append(tagRow(tag, tag, count, (to) => view.renameTag(tag, to)));
        inner.append(
          addRow("add:general", "Add tag...", (value) => {
            view.createTag(value);
            render();
          }),
        );
        wrap.append(inner);
      }
      out.push(wrap);
    }
    if (!general.length && !(doc.tagCategories ?? []).length) {
      out.push(el("p", "tags-empty", "No tags or categories yet. Create a category below to get started."));
    }
    return out;
  };

  /** Keeps a renamed category's tags where they were in the order. */
  const renameOrder = (from: string, to: string) => {
    const name = model.cleanCategoryName(to);
    for (const [tag, i] of [...order]) {
      if (tag.startsWith(`${from}:`)) order.set(model.categoryTag(name, tag.slice(from.length + 1)), i);
    }
  };

  // The form for a new category, below the list.
  const form = el("div", "tags-new-category");
  const name = el("input");
  name.placeholder = "Category name (e.g. Country)...";
  name.spellcheck = false;
  const type = el("select");
  for (const kind of model.TAG_CATEGORY_TYPES) type.append(new Option(TYPE_NAMES[kind], kind));
  const options = el("input", "tags-new-options");
  options.placeholder = "Options (comma-separated, e.g. Australia, Netherlands)";
  options.hidden = true;
  type.addEventListener("change", () => {
    newType = type.value as TagCategoryType;
    options.hidden = newType !== "list";
  });
  const addCategory = async () => {
    const value = name.value.trim();
    if (!value) return;
    const list = newType === "list" ? options.value.split(",") : [];
    if (!view.createCategory(value, newType, list)) {
      name.select();
      return;
    }
    name.value = "";
    options.value = "";
    type.value = "text";
    newType = "text";
    options.hidden = true;
    snapshotOrder();
    render();
    body.scrollTop = body.scrollHeight;
    name.focus();
  };
  name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void addCategory();
    }
  });
  const add = el("button", "", "Add");
  add.type = "button";
  add.addEventListener("click", () => void addCategory());
  const line = el("div", "tags-new-line");
  line.append(name, type, add);
  form.append(el("div", "tags-form-label", "Add Category"), line, options);

  actions.append(actionButton("Done", true, () => dialog.close()));
  dialog.insertBefore(form, actions);
  render();
  dialog.showModal();
}

/** The options of a list category, one per line. */
function editListOptions(view: OutlineView, category: TagCategory, then: () => void) {
  const { dialog, body, actions } = makeDialog("tags-options-dialog", "Edit List Options");
  const area = el("textarea");
  area.rows = 8;
  area.spellcheck = false;
  area.value = (category.listOptions ?? []).join("\n");
  body.append(el("p", "tags-hint", "One option per line:"), area);
  actions.append(
    actionButton("Cancel", false, () => dialog.close()),
    actionButton("Save", true, () => {
      view.setListOptions(category.name, area.value.split("\n"));
      dialog.close();
      then();
    }),
  );
  // Escape closes only this dialog, not Manage Tags beneath it.
  dialog.addEventListener("cancel", (e) => e.stopPropagation());
  dialog.showModal();
  area.focus();
}
