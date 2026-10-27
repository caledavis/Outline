// A small pop-up menu, shown below a button.

import { Check, icon } from "./icons";

type IconNode = Parameters<typeof icon>[0];

export type MenuEntry =
  | { label: string; icon?: IconNode; checked?: boolean; danger?: boolean; action: () => void }
  | { heading: string }
  | "separator";

let current: { menu: HTMLElement; close: () => void } | null = null;

export function closeMenu() {
  current?.close();
}

export function showMenu(anchor: HTMLElement, entries: MenuEntry[]) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  const hasChecks = entries.some((e) => typeof e === "object" && "checked" in e);

  for (const entry of entries) {
    if (entry === "separator") {
      menu.append(Object.assign(document.createElement("hr"), { className: "menu-separator" }));
    } else if ("heading" in entry) {
      menu.append(Object.assign(document.createElement("div"), { className: "menu-heading", textContent: entry.heading }));
    } else {
      const item = document.createElement("button");
      item.className = "menu-item";
      item.setAttribute("role", "menuitem");
      item.classList.toggle("danger", !!entry.danger);
      if (hasChecks) {
        const mark = document.createElement("span");
        mark.className = "menu-check";
        if (entry.checked) mark.append(icon(Check, 14));
        item.append(mark);
      }
      if (entry.icon) item.append(icon(entry.icon, 14));
      item.append(Object.assign(document.createElement("span"), { textContent: entry.label }));
      // Keep the focus where it was (e.g. in the text being edited).
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => {
        closeMenu();
        entry.action();
      });
      menu.append(item);
    }
  }

  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
  const below = rect.bottom + 4;
  const top = below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - menu.offsetHeight - 4) : below;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${top}px`;

  const onPointerDown = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) closeMenu();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    }
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", closeMenu);

  current = {
    menu,
    close: () => {
      menu.remove();
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", closeMenu);
      current = null;
    },
  };
}

/** Shows the menu, or closes it if it's already open for this button. */
export function toggleMenu(anchor: HTMLElement, entries: () => MenuEntry[]) {
  if (current && anchor.classList.contains("menu-open")) {
    closeMenu();
    return;
  }
  showMenu(anchor, entries());
  anchor.classList.add("menu-open");
  const close = current!.close;
  current!.close = () => {
    anchor.classList.remove("menu-open");
    close();
  };
}
