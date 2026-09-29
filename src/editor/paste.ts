/**
 * Paste sanitization. Rich HTML from Word, Google Docs, web pages etc. is
 * reduced to semantic structure before ProseMirror parses it against our
 * schema: no inline styles, classes, fonts, scripts, or tracking attributes.
 */
const DROP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'NOSCRIPT', 'TEMPLATE', 'IMG']);
const KEEP_ATTRS: Record<string, string[]> = { A: ['href'], OL: ['start'] };
const SAFE_HREF = /^(https?:|mailto:)/i;

function unwrap(el: Element) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function clean(node: Node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const tag = el.tagName.toUpperCase();
    if (DROP.has(tag) || tag.includes(':')) {
      // Office namespaces (o:p, w:sdt…) carry no content we want.
      if (tag.includes(':')) unwrap(el);
      else el.remove();
      continue;
    }
    clean(el);
    // Google Docs wraps everything in <b style="font-weight:normal" id="docs-internal-guid-…">.
    if (tag === 'B' && (/font-weight:\s*(normal|400)/i.test(el.getAttribute('style') ?? '') || el.id.startsWith('docs-internal-guid'))) {
      unwrap(el);
      continue;
    }
    // Spans carry only presentation; styled spans that meant bold/italic become real marks.
    if (tag === 'SPAN' || tag === 'FONT') {
      const style = el.getAttribute('style') ?? '';
      const bold = /font-weight:\s*(bold|[6-9]00)/i.test(style);
      const italic = /font-style:\s*italic/i.test(style);
      if (bold || italic) {
        let inner: Element = el;
        const doc = el.ownerDocument;
        const wrapper = doc.createElement(bold ? 'strong' : 'em');
        if (bold && italic) {
          const em = doc.createElement('em');
          wrapper.appendChild(em);
          inner = em;
        } else inner = wrapper;
        while (el.firstChild) inner.appendChild(el.firstChild);
        el.replaceWith(wrapper);
      } else unwrap(el);
      continue;
    }
    for (const attr of [...el.attributes]) {
      const allowed = KEEP_ATTRS[tag]?.includes(attr.name.toLowerCase());
      if (!allowed) el.removeAttribute(attr.name);
    }
    if (tag === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (!SAFE_HREF.test(href.trim())) el.removeAttribute('href');
    }
  }
}

export function sanitizePastedHTML(html: string): string {
  if (typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  clean(doc.body);
  return doc.body.innerHTML;
}
