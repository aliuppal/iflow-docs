/**
 * Best-effort readers for the non-BPMN artefacts that ship inside an iFlow:
 * message mappings (.mmap), XSLT, value mappings and schema files.
 *
 * The .mmap format is an internal SAP format that has changed shape between
 * releases, so this deliberately extracts only what can be recognised
 * structurally and always falls back to "listed, with the raw XML available"
 * rather than guessing. Nothing here throws on an unexpected document.
 */

import { parseXml, descendants, attr, text, child } from '../lib/xml.js';

// "target" must match inside camelCase names such as targetStructures / targetPath,
// so there is no trailing word boundary; a bare "to" only counts as a whole word.
const SOURCE_HINT = /(source|src|(?:^|[_-])from(?:[_-]|$))/i;
const TARGET_HINT = /(target|tgt|(?:^|[_-])to(?:[_-]|$))/i;

export function parseMessageMapping(xmlText, path) {
  const info = {
    path,
    name: baseName(path),
    sources: [],
    targets: [],
    links: [],
    functions: [],
    parsed: false,
    note: '',
  };

  let doc;
  try {
    doc = parseXml(xmlText);
  } catch {
    info.note = 'Mapping could not be parsed; the raw definition is included verbatim.';
    return info;
  }

  // Structures are referenced by an .xsd / .wsdl / .edmx path somewhere in the
  // document; which element carries it varies, so collect by value shape and
  // classify by the nearest source/target hint in the attribute or element name.
  const seen = new Set();
  for (const node of descendants(doc)) {
    for (const [key, value] of Object.entries(node.attrs)) {
      if (!/\.(xsd|wsdl|edmx|json)$/i.test(value)) continue;
      const bucket = classify(`${node.local} ${key}`, node);
      addUnique(info[bucket], { name: baseName(value), path: value }, seen, bucket + value);
    }
    const body = node.children.length === 1 && node.children[0].text !== undefined ? node.children[0].text.trim() : '';
    if (body && /\.(xsd|wsdl|edmx|json)$/i.test(body)) {
      const bucket = classify(node.local, node);
      addUnique(info[bucket], { name: baseName(body), path: body }, seen, bucket + body);
    }
  }

  // Field-level links: any element that names both a source and a target path.
  for (const node of descendants(doc)) {
    const keys = Object.keys(node.attrs);
    const sourceKey = keys.find((k) => SOURCE_HINT.test(k) && /(path|field|ref|node|xpath)/i.test(k));
    const targetKey = keys.find((k) => TARGET_HINT.test(k) && /(path|field|ref|node|xpath)/i.test(k));
    if (sourceKey && targetKey) {
      info.links.push({ source: node.attrs[sourceKey], target: node.attrs[targetKey], via: node.local });
    }
  }

  for (const node of descendants(doc)) {
    if (/function/i.test(node.local)) {
      const name = attr(node, 'name') || attr(node, 'functionName') || text(child(node, 'name'));
      if (name && !info.functions.includes(name)) info.functions.push(name.trim());
    }
  }

  info.parsed = Boolean(info.sources.length || info.targets.length || info.links.length);
  if (!info.parsed) {
    info.note =
      'This mapping uses a structure this tool does not model field-by-field. ' +
      'It is listed with its referenced schemas; open the mapping in Cloud Integration for the field detail.';
  }
  return info;
}

/** Source or target? Decide from the name itself, then from the enclosing elements. */
function classify(hint, node) {
  const decide = (name) => {
    const t = TARGET_HINT.test(name);
    const s = SOURCE_HINT.test(name);
    if (t && !s) return 'targets';
    if (s && !t) return 'sources';
    return '';
  };
  const own = decide(hint);
  if (own) return own;
  let ancestor = node.parent;
  for (let depth = 0; ancestor && depth < 4; depth++, ancestor = ancestor.parent) {
    const found = decide(ancestor.local || '');
    if (found) return found;
  }
  return 'sources';
}

function addUnique(list, item, seen, key) {
  if (seen.has(key)) return;
  seen.add(key);
  list.push(item);
}

/** Value mapping artefacts: a table of agency/scheme/value tuples. */
export function parseValueMapping(xmlText, path) {
  const info = { path, name: baseName(path), groups: [], entryCount: 0 };
  let doc;
  try {
    doc = parseXml(xmlText);
  } catch {
    return info;
  }
  for (const group of descendants(doc, 'valmap_group')) {
    const entry = { identifiers: [], values: [] };
    for (const id of descendants(group, 'valmap_id')) {
      entry.identifiers.push({
        agency: text(child(id, 'agency')) || attr(id, 'agency') || '',
        scheme: text(child(id, 'scheme')) || attr(id, 'scheme') || '',
        value: text(child(id, 'value')) || attr(id, 'value') || '',
      });
    }
    info.groups.push(entry);
    info.entryCount += entry.identifiers.length;
  }
  return info;
}

/** Pull the top-level template names out of an XSLT so the doc says what it does. */
export function summariseXslt(xmlText, path) {
  const info = { path, name: baseName(path), templates: [], outputMethod: '', imports: [] };
  let doc;
  try {
    doc = parseXml(xmlText);
  } catch {
    return info;
  }
  for (const t of descendants(doc, 'template')) {
    const match = attr(t, 'match');
    const name = attr(t, 'name');
    if (match || name) info.templates.push(name ? `name="${name}"` : `match="${match}"`);
  }
  const output = descendants(doc, 'output')[0];
  if (output) info.outputMethod = attr(output, 'method') || '';
  for (const imp of [...descendants(doc, 'import'), ...descendants(doc, 'include')]) {
    const href = attr(imp, 'href');
    if (href) info.imports.push(href);
  }
  return info;
}

/** Root element + target namespace of an XSD, enough to identify a structure. */
export function summariseXsd(xmlText, path) {
  const info = { path, name: baseName(path), targetNamespace: '', rootElements: [], types: [] };
  let doc;
  try {
    doc = parseXml(xmlText);
  } catch {
    return info;
  }
  const schema = descendants(doc, 'schema')[0];
  if (schema) info.targetNamespace = attr(schema, 'targetNamespace') || '';
  for (const el of (schema ? schema.children : []).filter((c) => c.local === 'element')) {
    const name = attr(el, 'name');
    if (name) info.rootElements.push(name);
  }
  for (const t of (schema ? schema.children : []).filter((c) => c.local === 'complexType' || c.local === 'simpleType')) {
    const name = attr(t, 'name');
    if (name) info.types.push(name);
  }
  return info;
}

export function baseName(path) {
  return String(path || '').split('/').pop() || String(path || '');
}
