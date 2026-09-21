/**
 * Small XML parser producing a plain-object tree.
 *
 * DOMParser would do for the browser, but keeping this DOM-free means the whole
 * parsing pipeline also runs under Node, which is what the test harness in
 * tools/ relies on. It is deliberately forgiving: BPMN, .mmap and .propdef files
 * from SAP CI are well-formed but use prefixes inconsistently, so every lookup
 * here is by local name.
 *
 * Node shape: { name, prefix, local, attrs, children, parent }
 */

const NAME_RE = /[^\s/>=]+/y;

export function parseXml(text) {
  const src = String(text);
  const root = { name: '#document', prefix: '', local: '#document', attrs: {}, children: [], parent: null };
  const stack = [root];
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      pushText(stack[stack.length - 1], src.slice(i));
      break;
    }
    if (lt > i) pushText(stack[stack.length - 1], src.slice(i, lt));

    // Comments, CDATA, doctype, processing instructions.
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const body = src.slice(lt + 9, end === -1 ? src.length : end);
      pushText(stack[stack.length - 1], body, true);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const end = skipDoctype(src, lt);
      i = end;
      continue;
    }

    // Closing tag.
    if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      const name = src.slice(lt + 2, end === -1 ? src.length : end).trim();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].name === name) {
          stack.length = s;
          break;
        }
      }
      i = end === -1 ? src.length : end + 1;
      continue;
    }

    // Opening tag.
    NAME_RE.lastIndex = lt + 1;
    const m = NAME_RE.exec(src);
    if (!m) { i = lt + 1; continue; }
    const name = m[0];
    let p = NAME_RE.lastIndex;
    const attrs = {};
    let selfClosing = false;

    while (p < src.length) {
      while (p < src.length && /\s/.test(src[p])) p++;
      if (src[p] === '/' && src[p + 1] === '>') { selfClosing = true; p += 2; break; }
      if (src[p] === '>') { p += 1; break; }
      NAME_RE.lastIndex = p;
      const am = NAME_RE.exec(src);
      if (!am || am.index !== p) { p++; continue; }
      const attrName = am[0];
      p = NAME_RE.lastIndex;
      while (p < src.length && /\s/.test(src[p])) p++;
      let value = '';
      if (src[p] === '=') {
        p++;
        while (p < src.length && /\s/.test(src[p])) p++;
        const quote = src[p];
        if (quote === '"' || quote === "'") {
          const end = src.indexOf(quote, p + 1);
          value = src.slice(p + 1, end === -1 ? src.length : end);
          p = end === -1 ? src.length : end + 1;
        } else {
          NAME_RE.lastIndex = p;
          const vm = NAME_RE.exec(src);
          value = vm ? vm[0] : '';
          p = vm ? NAME_RE.lastIndex : p + 1;
        }
      }
      attrs[attrName] = decodeEntities(value);
    }

    const colon = name.indexOf(':');
    const node = {
      name,
      prefix: colon === -1 ? '' : name.slice(0, colon),
      local: colon === -1 ? name : name.slice(colon + 1),
      attrs,
      children: [],
      parent: stack[stack.length - 1],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = p;
  }

  return root;
}

function skipDoctype(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '<') depth++;
    else if (src[i] === '>') {
      depth--;
      if (depth <= 0) return i + 1;
    }
  }
  return src.length;
}

function pushText(parent, raw, literal = false) {
  if (!raw) return;
  const value = literal ? raw : decodeEntities(raw);
  if (!literal && !value.trim()) return;
  const last = parent.children[parent.children.length - 1];
  if (last && last.text !== undefined) last.text += value;
  else parent.children.push({ text: value, parent });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(value) {
  if (value.indexOf('&') === -1) return value;
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] !== undefined ? ENTITIES[body] : whole;
  });
}

/* ------------------------------------------------------------------ *
 * Navigation helpers — all matching is by local name, prefix ignored. *
 * ------------------------------------------------------------------ */

export function elements(node) {
  return node && node.children ? node.children.filter((c) => c.local !== undefined) : [];
}

/** Direct children with the given local name (or any, when omitted). */
export function childrenOf(node, local) {
  const kids = elements(node);
  return local ? kids.filter((c) => c.local === local) : kids;
}

export function child(node, local) {
  return childrenOf(node, local)[0] || null;
}

/** Depth-first search over the whole subtree. */
export function descendants(node, local) {
  const out = [];
  const walk = (n) => {
    for (const c of elements(n)) {
      if (!local || c.local === local) out.push(c);
      walk(c);
    }
  };
  if (node) walk(node);
  return out;
}

export function firstDescendant(node, local) {
  return descendants(node, local)[0] || null;
}

/** Attribute by local name, so `ifl:type` and `type` both resolve. */
export function attr(node, local) {
  if (!node) return undefined;
  if (node.attrs[local] !== undefined) return node.attrs[local];
  for (const key of Object.keys(node.attrs)) {
    const idx = key.indexOf(':');
    if (idx !== -1 && key.slice(idx + 1) === local) return node.attrs[key];
  }
  return undefined;
}

/** Concatenated text content of a node. */
export function text(node) {
  if (!node) return '';
  let out = '';
  const walk = (n) => {
    for (const c of n.children || []) {
      if (c.text !== undefined) out += c.text;
      else walk(c);
    }
  };
  walk(node);
  return out;
}

export function textOf(node, local) {
  return text(child(node, local));
}

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
