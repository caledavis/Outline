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
  // From a ribbon button, as Magnolia's toolbar popovers: centred on the
  // button's icon and just below it, with an arrow pointing up at it.
  const tile = anchor.closest(".ribbon-btn")?.querySelector(".ribbon-tile");
  let arrow: HTMLElement | null = null;
  if (tile) {
    const icon = tile.getBoundingClientRect();
    const centre = icon.left + icon.width / 2;
    const left = Math.max(8, Math.min(centre - menu.offsetWidth / 2, window.innerWidth - menu.offsetWidth - 8));
    const top = icon.bottom + 9;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.maxHeight = `${Math.max(120, window.innerHeight - top - 8)}px`;
    // Outside the menu, which would clip it (it scrolls when it's long).
    arrow = document.createElement("div");
    arrow.className = "menu-arrow";
    arrow.style.left = `${centre - 6}px`;
    arrow.style.top = `${top - 6}px`;
    document.body.append(arrow);
  } else {
    const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
    const below = rect.bottom + 4;
    const top = below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - menu.offsetHeight - 4) : below;
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${top}px`;
  }

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
      arrow?.remove();
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
