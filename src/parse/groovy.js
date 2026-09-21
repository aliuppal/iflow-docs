/**
 * Static analysis of the Groovy / JavaScript files shipped with an iFlow.
 *
 * The goal is to answer, for documentation purposes: what does this script take
 * from the message, and what does it leave behind? That is, which headers and
 * exchange properties it reads and sets, whether it reads or replaces the body,
 * what it writes to the message log, and what it reaches out to.
 *
 * This is pattern matching over source text, not an interpreter. It reads what
 * is written literally (`message.getHeader('X')`) and reports when a name is
 * computed at runtime rather than guessing it. Comments are blanked first so
 * commented-out code is never reported as behaviour.
 */

/** A quoted string literal; the text is in group s1 (single quotes) or s2 (double). */
const Q = String.raw`(?:'(?<s1>(?:[^'\\\n]|\\.)*)'|"(?<s2>(?:[^"\\\n]|\\.)*)")`;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function analyzeScript(source, options = {}) {
  const { code, comments } = stripComments(String(source || ''));

  const headers = access(code, {
    getter: 'getHeader', setter: 'setHeader', mapGetter: 'getHeaders', mapProperty: 'headers',
  });
  const properties = access(code, {
    getter: 'getProperty', setter: 'setProperty', mapGetter: 'getProperties', mapProperty: 'properties',
  });

  const functions = findFunctions(code);
  const entry = options.entryPoint ? functions.find((f) => f.name === options.entryPoint) : null;

  const body = {
    reads: [...code.matchAll(/\.getBody\s*\(\s*([\w.]*)\s*\)?/g)].map((m) => m[1] || ''),
    writes: [...code.matchAll(/\.setBody\s*\(/g)].map((m) => {
      const expr = argText(code, m.index + m[0].length).trim();
      return { expr: clip(expr, 70), empty: /^(?:''|""|null)$/.test(expr) };
    }),
  };
  // Groovy property syntax: message.body
  if (/\bmessage\s*\.\s*body\b(?!\s*=[^=])/.test(code) && !body.reads.length) body.reads.push('');
  if (/\bmessage\s*\.\s*body\s*=[^=]/.test(code) && !body.writes.length) body.writes.push({ expr: '', empty: false });

  const messageLog = {
    used: /messageLogFactory\s*\.\s*getMessageLog|\bgetMessageLog\s*\(/.test(code),
    properties: unique(names(code, String.raw`\.(?:setStringProperty|addCustomHeaderProperty)\s*\(\s*${Q}`)),
    attachments: unique(names(code, String.raw`\.addAttachmentAsString\s*\(\s*${Q}`)),
  };

  const parses = [];
  if (/XmlSlurper|XmlParser|DocumentBuilder|SAXParser|XMLStreamReader/.test(code)) parses.push('XML');
  if (/JsonSlurper/.test(code)) parses.push('JSON');
  const builds = [];
  if (/MarkupBuilder|StreamingMarkupBuilder|XmlUtil\s*\.\s*serialize|XMLStreamWriter/.test(code)) builds.push('XML');
  if (/JsonOutput|JsonBuilder/.test(code)) builds.push('JSON');

  const credentials = unique(names(code, String.raw`\.getUserCredential\s*\(\s*${Q}`));

  const valueMappings = [...code.matchAll(new RegExp(
    String.raw`\.getMappedValue\s*\(\s*${Q}\s*,\s*${Q.replace(/s1/g, 't1').replace(/s2/g, 't2')}`, 'g'))]
    .map((m) => ({ agency: m.groups.s1 ?? m.groups.s2, scheme: m.groups.t1 ?? m.groups.t2 }));

  const external = [];
  if (/HttpURLConnection|HttpClient|\.openConnection\s*\(|new\s+URL\s*\(|RESTClient|HTTPBuilder/.test(code)) {
    external.push('makes its own HTTP call');
  }
  if (/KeystoreService/.test(code)) external.push('reads the tenant keystore');
  if (/DataStoreService/.test(code)) external.push('accesses a data store directly');
  if (/SecureStoreService/.test(code) && !credentials.length) external.push('reads the secure store');

  const raises = [...code.matchAll(/\bthrow\s+new\s+([\w.]+)\s*\(\s*(?:'([^'\n]*)'|"([^"\n]*)")?/g)].map((m) => ({
    type: m[1].split('.').pop(),
    message: m[2] ?? m[3] ?? '',
  }));

  return {
    lineCount: String(source || '').split(/\r?\n/).length,
    purpose: findPurpose(code, comments, entry || functions[0]),
    functions: functions.map((f) => f.name),
    entryFound: options.entryPoint ? Boolean(entry) : null,
    headers,
    properties,
    body,
    messageLog,
    parses,
    builds,
    credentials,
    valueMappings,
    external,
    raises,
    catches: /\bcatch\s*\(/.test(code),
  };
}

/* ------------------------------------------------------------------ */
/* Header / property access                                            */
/* ------------------------------------------------------------------ */

/**
 * Both headers and properties are reached the same way: a getter/setter on the
 * message, or a map obtained from getHeaders()/getProperties() and then indexed.
 * Local variables holding that map are tracked so `headers.get('X')` counts.
 */
function access(code, { getter, setter, mapGetter, mapProperty }) {
  const reads = [];
  const writes = [];
  const removes = [];
  let dynamicRead = false;
  let dynamicWrite = false;

  // System.getProperty is a JVM setting, not an exchange property.
  const dot = getter === 'getProperty' ? String.raw`(?<!System)\.` : String.raw`\.`;

  reads.push(...names(code, String.raw`${dot}${getter}\s*\(\s*${Q}`));
  writes.push(...names(code, String.raw`\.${setter}\s*\(\s*${Q}`));
  if (new RegExp(String.raw`${dot}${getter}\s*\(\s*(?!['"\s)])`).test(code)) dynamicRead = true;
  if (new RegExp(String.raw`\.${setter}\s*\(\s*(?!['"\s)])`).test(code)) dynamicWrite = true;

  // Direct chains: message.getHeaders().get('X')
  reads.push(...names(code, String.raw`\.${mapGetter}\s*\(\s*\)\s*\.\s*(?:get|getOrDefault)\s*\(\s*${Q}`));
  reads.push(...names(code, String.raw`\.${mapGetter}\s*\(\s*\)\s*\[\s*${Q}\s*\](?!\s*=[^=])`));
  writes.push(...names(code, String.raw`\.${mapGetter}\s*\(\s*\)\s*\.\s*put\s*\(\s*${Q}`));

  // Variables that hold the map.
  const vars = new Set();
  const assign = String.raw`\b(\w+)\s*=\s*(?:\w+\s*\.\s*)?`;
  for (const m of code.matchAll(new RegExp(`${assign}${mapGetter}\\s*\\(\\s*\\)`, 'g'))) vars.add(m[1]);
  for (const m of code.matchAll(new RegExp(`${assign}${mapProperty}\\b(?![\\w(.])`, 'g'))) vars.add(m[1]);

  for (const v of vars) {
    const name = escapeRe(v);
    reads.push(...names(code, String.raw`\b${name}\s*\.\s*(?:get|getOrDefault)\s*\(\s*${Q}`));
    reads.push(...names(code, String.raw`\b${name}\s*\[\s*${Q}\s*\](?!\s*=[^=])`));
    writes.push(...names(code, String.raw`\b${name}\s*\.\s*put\s*\(\s*${Q}`));
    writes.push(...names(code, String.raw`\b${name}\s*\[\s*${Q}\s*\]\s*=(?!=)`));
    removes.push(...names(code, String.raw`\b${name}\s*\.\s*remove\s*\(\s*${Q}`));
    if (new RegExp(String.raw`\b${name}\s*\.\s*(?:get|getOrDefault)\s*\(\s*(?!['"\s)])`).test(code)) dynamicRead = true;
    if (new RegExp(String.raw`\b${name}\s*\.\s*put\s*\(\s*(?!['"\s)])`).test(code)) dynamicWrite = true;
  }

  return {
    reads: unique(reads),
    writes: unique(writes),
    removes: unique(removes),
    dynamicRead,
    dynamicWrite,
  };
}

function names(code, pattern) {
  const out = [];
  for (const m of code.matchAll(new RegExp(pattern, 'g'))) {
    const value = m.groups.s1 ?? m.groups.s2;
    if (value !== undefined && value !== '') out.push(value);
  }
  return out;
}

function unique(list) {
  return [...new Set(list)];
}

/* ------------------------------------------------------------------ */
/* Functions and the script's own description                          */
/* ------------------------------------------------------------------ */

function findFunctions(code) {
  const re = /^[ \t]*(?:(?:public|private|protected|static|final)\s+)*(?:def\s+)?(?:Message|void|Object|def)\s+(\w+)\s*\(/gm;
  const out = [];
  for (const m of code.matchAll(re)) out.push({ name: m[1], index: m.index });
  return out;
}

/**
 * The script's own explanation of itself: the comment sitting directly above its
 * entry function, or failing that a block comment at the very top of the file.
 * Licence headers are ignored.
 */
function findPurpose(code, comments, fn) {
  const usable = comments.filter((c) => !/copyright|licen[sc]e|all rights reserved/i.test(c.text));

  if (fn) {
    const above = [];
    let cursor = fn.index;
    for (let i = usable.length - 1; i >= 0; i--) {
      const c = usable[i];
      if (c.end > cursor) continue;
      if (code.slice(c.end, cursor).trim() !== '') break;
      above.unshift(c);
      cursor = c.start;
      if (c.block) break;
    }
    const text = cleanComment(above);
    if (text) return text;
  }

  const first = usable[0];
  if (first && first.block && code.slice(0, first.start).trim() === '') return cleanComment([first]);
  return '';
}

function cleanComment(list) {
  if (!list.length) return '';
  const lines = [];
  for (const c of list) {
    const raw = c.text.replace(/^\/\*+/, '').replace(/\*+\/$/, '');
    for (const line of raw.split('\n')) lines.push(line.replace(/^\s*(?:\*+|\/\/+)\s?/, '').trim());
  }
  const paragraph = [];
  for (const line of lines) {
    if (line.startsWith('@')) break;
    if (!line) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line);
  }
  return clip(paragraph.join(' '), 320);
}

/* ------------------------------------------------------------------ */
/* Source scanning                                                     */
/* ------------------------------------------------------------------ */

/**
 * Blank out comments while leaving string literals intact, preserving offsets so
 * positions in the result still line up with the original source.
 */
function stripComments(source) {
  let out = '';
  const comments = [];
  const n = source.length;
  let i = 0;

  while (i < n) {
    const c = source[i];
    const d = source[i + 1];

    if (c === '/' && d === '/') {
      const nl = source.indexOf('\n', i);
      const stop = nl === -1 ? n : nl;
      comments.push({ start: i, end: stop, text: source.slice(i, stop), block: false });
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === '/' && d === '*') {
      const close = source.indexOf('*/', i + 2);
      const stop = close === -1 ? n : close + 2;
      const text = source.slice(i, stop);
      comments.push({ start: i, end: stop, text, block: true });
      out += text.replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = source.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source.startsWith(quote, j)) { j += quote.length; break; }
        if (!triple && source[j] === '\n') break;
        j++;
      }
      j = Math.min(j, n);
      out += source.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return { code: out, comments };
}

/** Text of a call's first argument, from just after "(" to its matching ")" or ",". */
function argText(code, from) {
  let depth = 0;
  let quote = '';
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return code.slice(from, i);
      depth--;
    } else if (c === ',' && depth === 0) return code.slice(from, i);
  }
  return code.slice(from);
}

function clip(value, max) {
  const v = String(value || '').replace(/\s+/g, ' ').trim();
  return v.length > max ? v.slice(0, max - 1) + '…' : v;
}
