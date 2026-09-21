/**
 * Java .properties and OSGi MANIFEST.MF readers.
 *
 * SAP CI uses .properties for parameters.prop / metainfo.prop and an OSGi
 * manifest for the iFlow's identity, both with their own continuation rules.
 */

/** Parse a java.util.Properties file into an ordered Map. */
export function parseProperties(text) {
  const out = new Map();
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.replace(/^\s+/, '');
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;

    // A line ending in an odd number of backslashes continues on the next line.
    while (endsWithOddBackslash(line) && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i].replace(/^\s+/, '');
    }

    let key = '';
    let value = '';
    let k = 0;
    const src = line.replace(/^\s+/, '');
    for (; k < src.length; k++) {
      const ch = src[k];
      if (ch === '\\') { key += src[k] + src[k + 1]; k++; continue; }
      if (ch === '=' || ch === ':' || /\s/.test(ch)) break;
      key += ch;
    }
    while (k < src.length && /\s/.test(src[k])) k++;
    if (src[k] === '=' || src[k] === ':') k++;
    while (k < src.length && /\s/.test(src[k])) k++;
    value = src.slice(k);

    if (key) out.set(unescapeProperty(key), unescapeProperty(value));
  }
  return out;
}

function endsWithOddBackslash(line) {
  let n = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i--) n++;
  return n % 2 === 1;
}

function unescapeProperty(value) {
  return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (whole, body) => {
    if (body[0] === 'u') return String.fromCharCode(parseInt(body.slice(1), 16));
    switch (body) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'f': return '\f';
      default: return body;
    }
  });
}

/**
 * Parse an OSGi MANIFEST.MF. Continuation lines start with a single space and
 * must be joined before the colon split, otherwise long Import-Package headers
 * come out shredded.
 */
export function parseManifest(text) {
  const out = new Map();
  const raw = String(text).replace(/\r\n?/g, '\n');
  const joined = raw.replace(/\n[ \t]/g, '');
  for (const line of joined.split('\n')) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    out.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  return out;
}

/** Split an OSGi header value on commas that are not inside quotes. */
export function splitHeader(value) {
  if (!value) return [];
  const parts = [];
  let current = '';
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) { parts.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
