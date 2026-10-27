// A dialog for finding items in the user's Zotero library (through
// zotero.rs) and linking them to rows.

import { invoke } from "@tauri-apps/api/core";
import { BookOpen, Check, icon } from "./icons";
import type { Link } from "./model";
import { noteText } from "./sanitize";

interface ZoteroItem {
  key: string;
  title: string;
  creators: string;
  year: string;
  itemType: string;
  uri: string;
}

const dialog = () => document.getElementById("zotero") as HTMLDialogElement;

/** Lets the user pick Zotero items; resolves to links to them (empty if cancelled). */
export function chooseZoteroItems(): Promise<Link[]> {
  const zoteroDialog = dialog();
  const query = zoteroDialog.querySelector<HTMLInputElement>("#zotero-query")!;
  const status = zoteroDialog.querySelector<HTMLElement>("#zotero-status")!;
  const results = zoteroDialog.querySelector<HTMLElement>("#zotero-results")!;
  const linkButton = zoteroDialog.querySelector<HTMLButtonElement>("#zotero-link")!;

  const chosen = new Map<string, ZoteroItem>();
  let latest = 0;
  let timer: number | undefined;

  const updateButton = () => {
    linkButton.disabled = chosen.size === 0;
    linkButton.textContent = chosen.size > 1 ? `Link ${chosen.size} items` : "Link";
  };

  const show = (items: ZoteroItem[]) => {
    status.textContent = items.length ? "" : "Nothing found.";
    results.replaceChildren(
      ...items.map((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "zotero-item";
        button.classList.toggle("chosen", chosen.has(item.key));
        const check = document.createElement("span");
        check.className = "zotero-check";
        check.append(icon(Check, 14));
        const title = Object.assign(document.createElement("span"), { className: "zotero-title", textContent: item.title });
        const byline = Object.assign(document.createElement("span"), {
          className: "zotero-byline",
          textContent: [item.creators, item.year].filter(Boolean).join(" · "),
        });
        const text = document.createElement("span");
        text.className = "zotero-text";
        text.append(title, byline);
        button.append(check, icon(BookOpen, 14), text);
        button.addEventListener("click", () => {
          if (chosen.has(item.key)) chosen.delete(item.key);
          else chosen.set(item.key, item);
          button.classList.toggle("chosen", chosen.has(item.key));
          updateButton();
        });
        // Double-click links just this item straight away.
        button.addEventListener("dblclick", () => {
          chosen.clear();
          chosen.set(item.key, item);
          zoteroDialog.close("ok");
        });
        return button;
      }),
    );
  };

  const search = async () => {
    const request = ++latest;
    status.textContent = "Searching…";
    try {
      const items = await invoke<ZoteroItem[]>("zotero_search", { query: query.value });
      if (request === latest) show(items);
    } catch (error) {
      if (request !== latest) return;
      results.replaceChildren();
      status.textContent = String(error);
    }
  };

  const onInput = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(search, 250);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    // Enter links what's chosen, or the top result if nothing is.
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!chosen.size) results.querySelector<HTMLButtonElement>(".zotero-item")?.click();
    if (chosen.size) zoteroDialog.close("ok");
  };

  query.value = "";
  results.replaceChildren();
  updateButton();
  query.addEventListener("input", onInput);
  query.addEventListener("keydown", onKeyDown);
  zoteroDialog.returnValue = "";
  zoteroDialog.showModal();
  query.focus();
  search();

  return new Promise((resolve) => {
    zoteroDialog.addEventListener(
      "close",
      () => {
        window.clearTimeout(timer);
        latest++;
        query.removeEventListener("input", onInput);
        query.removeEventListener("keydown", onKeyDown);
        const ok = zoteroDialog.returnValue === "ok";
        resolve(ok ? Promise.all([...chosen.values()].map(toLink)) : []);
      },
      { once: true },
    );
  });
}

async function toLink(item: ZoteroItem): Promise<Link> {
  const short = [item.creators, item.year].filter(Boolean).join(" ");
  let notes: string[] = [];
  try {
    notes = await fetchZoteroNotes(item.uri);
  } catch {
    // Link it anyway; the notes can be fetched later with "Update notes from Zotero".
  }
  return { kind: "zotero", target: item.uri, title: short || item.title, detail: item.title, notes };
}

/** The notes attached to a Zotero item, as plain text. */
export async function fetchZoteroNotes(uri: string): Promise<string[]> {
  const notes = await invoke<string[]>("zotero_notes", { uri });
  return notes.map(noteText).filter(Boolean);
}
