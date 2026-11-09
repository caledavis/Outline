/// <reference types="vite/client" />
// The Sparkle-style software update window, as in Magnolia. The backend
// (updater.rs) opens it and decides what it shows: the prompt with release
// notes and the three standard choices when an update is available,
//   - Skip This Version → the automatic check stays quiet until a newer
//                         version is published
//   - Remind Me Later   → close; the next check offers it again
//   - Install Update    → download it (progress, Cancel), then
//                         "Ready to Install" with Install and Relaunch
// and otherwise a small status panel (checking, downloading, ready,
// installing, up to date, error). Closing the window is Remind Me Later on
// the prompt, Cancel mid-check or download, and install-on-quit once
// downloaded.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { marked } from "marked";
import appIcon from "../../src-tauri/icons/128x128@2x.png";
import { sanitizeNotes } from "../sanitize";

type UpdateView =
  | {
      state: "available";
      version: string;
      currentVersion: string;
      releaseDate: string | null;
      releaseNotes: string;
      /** False for the portable Windows .exe, which downloads by hand. */
      installsItself: boolean;
    }
  | { state: "checking" }
  | { state: "downloading"; version: string; received: number; total: number | null }
  | { state: "ready"; version: string }
  | { state: "installing"; version: string }
  | { state: "up-to-date"; version: string }
  | { state: "error"; title: string; message: string };

/** The status panel's width in points (STATUS_WIDTH in updater.rs). */
const STATUS_WIDTH = 440;

const ua = navigator.userAgent;
document.documentElement.dataset.platform = /Mac/.test(ua) ? "darwin" : /Windows/.test(ua) ? "win32" : "linux";

const root = document.getElementById("root")!;
/** Return and Escape press these, as in a native panel. */
let defaultButton: HTMLButtonElement | null = null;
let cancelButton: HTMLButtonElement | null = null;
let stopFitting: (() => void) | null = null;

window.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && defaultButton && !e.isComposing) {
    e.preventDefault();
    defaultButton.click();
  } else if (e.key === "Escape" && cancelButton) {
    e.preventDefault();
    cancelButton.click();
  }
});

// Links in the release notes open in the browser, not in this window.
root.addEventListener("click", (e) => {
  const link = (e.target as Element).closest?.("a[href]");
  if (!link) return;
  e.preventDefault();
  openUrl(link.getAttribute("href")!);
});

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void, className?: string): HTMLButtonElement {
  const b = el("button", className, label);
  b.addEventListener("click", onClick);
  return b;
}

function icon(): HTMLImageElement {
  const img = el("img", "update-icon");
  img.src = appIcon;
  img.alt = "";
  img.draggable = false;
  return img;
}

const dismiss = () => invoke("update_dismiss");
const install = () => invoke("update_install");

function render(view: UpdateView) {
  stopFitting?.();
  stopFitting = null;
  defaultButton = cancelButton = null;
  root.replaceChildren(view.state === "available" ? prompt(view) : status(view));
}

function prompt(view: Extract<UpdateView, { state: "available" }>): HTMLElement {
  const panel = el("div", "update-window update-prompt");
  const body = el("div", "update-body");
  body.append(
    el("h1", undefined, "A new version of Outline is available!"),
    el(
      "p",
      "update-info",
      view.installsItself
        ? `Outline ${view.version} is now available—you have ${view.currentVersion}. Would you like to download it now?`
        : `Outline ${view.version} is now available—you have ${view.currentVersion}. Download it from Outline's website and replace this copy with it.`,
    ),
  );

  const label = el("div", "update-notes-label");
  label.append(el("span", undefined, "Release Notes:"));
  const released = formatDay(view.releaseDate);
  if (released) label.append(el("span", "update-released", `Released ${released}`));

  const notes = el("div", "update-notes");
  notes.tabIndex = -1;
  if (view.releaseNotes.trim()) {
    notes.innerHTML = sanitizeNotes(marked.parse(view.releaseNotes, { async: false, gfm: true, breaks: true }) as string);
  } else {
    notes.append(el("p", "update-notes-empty", "No release notes were provided for this version."));
  }
  body.append(label, notes);

  const buttons = el("div", "update-buttons");
  cancelButton = button("Remind Me Later", dismiss);
  defaultButton = button(view.installsItself ? "Install Update" : "Download Update", install, "update-default");
  buttons.append(
    button("Skip This Version", () => invoke("update_skip", { version: view.version }), "update-skip"),
    el("span", "update-spacer"),
    cancelButton,
    defaultButton,
  );

  panel.append(icon(), body, buttons);
  return panel;
}

function status(view: Exclude<UpdateView, { state: "available" }>): HTMLElement {
  let title: string;
  let detail = "";
  let progress: number | null | undefined; // undefined: no bar; null: indeterminate
  let action: "cancel" | "ok" | "install" | null = null;

  switch (view.state) {
    case "checking":
      title = "Checking for updates…";
      progress = null;
      action = "cancel";
      break;
    case "downloading":
      title = `Downloading Outline ${view.version}…`;
      progress = view.total ? view.received / view.total : null;
      detail = view.total
        ? `${formatBytes(view.received)} of ${formatBytes(view.total)}`
        : view.received
          ? formatBytes(view.received)
          : " ";
      action = "cancel";
      break;
    case "ready":
      title = "Ready to Install";
      progress = 1;
      detail = `Outline ${view.version} has been downloaded. If you close this window, it installs when you quit Outline.`;
      action = "install";
      break;
    case "installing":
      title = "Installing update…";
      detail = "Outline will relaunch when it’s done.";
      progress = null;
      break;
    case "up-to-date":
      title = "You’re up to date!";
      detail = `Outline ${view.version} is currently the newest version available.`;
      action = "ok";
      break;
    case "error":
      title = view.title;
      detail = view.message;
      action = "ok";
      break;
  }

  const panel = el("div", "update-window update-status");
  const body = el("div", "update-body");
  body.append(el("h1", undefined, title));
  if (progress !== undefined) body.append(progressBar(progress));
  if (detail) body.append(el("p", "update-info", detail));

  const buttons = el("div", "update-buttons");
  buttons.append(el("span", "update-spacer"));
  if (action === "cancel") {
    cancelButton = button("Cancel", dismiss);
    buttons.append(cancelButton);
  } else if (action === "ok") {
    defaultButton = cancelButton = button("OK", dismiss, "update-default");
    buttons.append(defaultButton);
  } else if (action === "install") {
    defaultButton = button("Install and Relaunch", install, "update-default");
    buttons.append(defaultButton);
  }

  panel.append(icon(), body, buttons);
  stopFitting = fitWindow(panel);
  return panel;
}

/**
 * Fits the window to the status panel, whatever the text (long errors, other
 * platforms' fonts). It compares the panel with the viewport rather than
 * sending a height, since how the window's size maps to the viewport (title
 * bar or not) differs by platform. One correction at a time: it measures
 * again only once the window has resized (or a resize evidently isn't
 * coming), or a stale viewport would get the same correction twice.
 */
function fitWindow(panel: HTMLElement): () => void {
  let waiting: ReturnType<typeof setTimeout> | null = null;
  const fit = () => {
    // Coming from the prompt, the window shrinks to the panel's width
    // first; measuring before then would size it for the wrong layout.
    if (waiting || Math.abs(window.innerWidth - STATUS_WIDTH) > 2) return;
    const delta = Math.ceil(panel.getBoundingClientRect().height) - window.innerHeight;
    if (delta === 0) return;
    invoke("update_window_fit", { delta });
    waiting = setTimeout(settled, 400);
  };
  const settled = () => {
    if (waiting) clearTimeout(waiting);
    waiting = null;
    fit();
  };
  const observer = new ResizeObserver(fit); // also fires once on observe
  observer.observe(panel);
  window.addEventListener("resize", settled);
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", settled);
    if (waiting) clearTimeout(waiting);
  };
}

function progressBar(value: number | null): HTMLElement {
  const bar = el("div", `update-progress${value === null ? " indeterminate" : ""}`);
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  if (value !== null) bar.setAttribute("aria-valuenow", String(Math.round(value * 100)));
  const fill = el("div", "update-progress-fill");
  if (value !== null) fill.style.width = `${value * 100}%`;
  bar.append(fill);
  return bar;
}

/** "9 November 2026" from YYYY-MM-DD, without a timezone shifting the day. */
function formatDay(day: string | null): string | null {
  const m = day && /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function formatBytes(n: number): string {
  if (n < 1e6) return `${Math.max(1, Math.round(n / 1e3)).toLocaleString()} KB`;
  return `${(n / 1e6).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

// Follow the backend from here on, starting from what it shows now.
let shown = false;
listen<UpdateView>("update-window:state", (e) => {
  shown = true;
  render(e.payload);
});
invoke<UpdateView | null>("update_window_state").then((view) => {
  if (view && !shown) render(view);
});
