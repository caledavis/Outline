// Cell and note text is stored as HTML. A file could come from anywhere, so
// before showing it we strip everything except the simple formatting the app
// itself produces. This stops a malicious file from running scripts.

const ALLOWED: Record<string, string[]> = {
  P: [], BR: [], STRONG: [], B: [], EM: [], I: [], U: [], S: [], DEL: [], CODE: [],
  A: ["href"],
};

/** Elements whose contents should be dropped entirely, not just unwrapped. */
const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "NOSCRIPT", "SVG", "MATH"]);

const SAFE_LINK = /^(https?:|mailto:)/i;

export function sanitize(html: string): string {
  if (!html.includes("<")) return html;
  const body = new DOMParser().parseFromString(html, "text/html").body;
  clean(body);
  return body.innerHTML;
}

function clean(parent: Element) {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE) continue;
    if (node.nodeType !== Node.ELEMENT_NODE) {
      node.remove();
      continue;
    }
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    clean(el);
    if (DROP.has(tag)) {
      el.remove();
    } else if (!(tag in ALLOWED)) {
      el.replaceWith(...el.childNodes);
    } else {
      for (const attr of [...el.attributes]) {
        const keep = ALLOWED[tag].includes(attr.name) && (attr.name !== "href" || SAFE_LINK.test(attr.value));
        if (!keep) el.removeAttribute(attr.name);
      }
    }
  }
}

/** The text of some HTML with all formatting removed. */
export function plainText(html: string): string {
  if (!html.includes("<") && !html.includes("&")) return html;
  // DOMParser builds an inert document, so nothing in the HTML can run or load.
  return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
}
