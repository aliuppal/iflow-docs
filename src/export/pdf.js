/**
 * PDF documents, built directly from the documentation model.
 *
 * A web page cannot print without the browser's print dialog, so PDFs that
 * download straight away have to be made by the page itself. This module turns
 * the same analysis model the HTML view uses into a pdfmake document definition.
 * The result is a real vector PDF — selectable, searchable text and sharp
 * tables, tens of kilobytes rather than screenshots of the page.
 *
 * It is pure data in, pure data out: no DOM, no pdfmake import. The browser glue
 * (pdf-download.js) supplies the diagram as an image and feeds the definition to
 * pdfmake; the tests feed the same definitions to pdfmake in Node.
 */

import { CATEGORIES, typeLabel } from '../model/catalog.js';
import { scriptSummary } from '../model/flow.js';

/* ------------------------------------------------------------------ */
/* Look                                                                */
/* ------------------------------------------------------------------ */

const C = {
  ink: '#1c2530', muted: '#5a6b7d', line: '#dde4ec', accent: '#0a6ed1', sunk: '#f5f7fa',
  codeBg: '#f6f8fa', codeInk: '#243141', inlineBg: '#eef1f5', infoBg: '#eef5fd',
  warn: '#c9820f', warnBg: '#fff7e6', err: '#b3261e', errBg: '#fdeeed', ok: '#2e7d32',
};
const WIDTH = 515;               // A4 (595pt) minus 40pt margins
const PAGE_HEIGHT = 842;         // A4
const BOTTOM_MARGIN = 54;
const MONO = 'RobotoMono';
const SEVERITY = {
  error: { tag: 'BLOCKER', color: C.err, bg: C.errBg },
  warning: { tag: 'CHECK', color: C.warn, bg: C.warnBg },
  info: { tag: 'NOTE', color: C.accent, bg: C.infoBg },
};

/* ------------------------------------------------------------------ */
/* Text that is safe to put in the PDF                                 */
/* ------------------------------------------------------------------ */

/**
 * Characters both PDF fonts (Roboto and Roboto Mono) can draw. Anything outside
 * this set would print as an empty box, so it is replaced first. The set is
 * checked against the real font files by tools/test-pdf.mjs.
 */
const PUNCTUATION = new Set([
  0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2022, 0x2026,
  0x20ac, 0x2122, 0x2212, 0x2260, 0x2264, 0x2265, 0x200b,
]);
export function isDrawable(cp) {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0x17f) || (cp >= 0x400 && cp <= 0x4ff && cp !== 0x487) || PUNCTUATION.has(cp);
}
export const DRAWABLE_RANGES = { punctuation: [...PUNCTUATION] };

/** Readable stand-ins for symbols the fonts lack (arrows are used a lot in the generated prose). */
const SWAPS = {
  0x2192: '->', 0x2190: '<-', 0x2191: '^', 0x2193: 'v', 0x25b8: '>', 0x25ba: '>', 0x2713: 'ok', 0x2714: 'ok',
  0x2717: 'x', 0x26a0: '!', 0x2010: '-', 0x2011: '-', 0x2012: '-', 0x2028: '\n', 0x2029: '\n', 0x00d7: '×',
};

export function pdfSafe(input) {
  let out = '';
  for (const ch of String(input === undefined || input === null ? '' : input)) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0a) { out += '\n'; continue; }
    if (cp === 0x09) { out += '    '; continue; }
    if (cp === 0x0d || cp < 0x20) continue;
    if (SWAPS[cp] !== undefined) { out += SWAPS[cp]; continue; }
    out += isDrawable(cp) ? ch : '?';
  }
  return out;
}

/** Give long unbroken identifiers (paths, URLs, snake_case) somewhere to wrap. */
function breakable(text) {
  return String(text).replace(/\S{24,}/g, (word) => word.replace(/([_./,=&?:;-])/g, '$1​'));
}

/** Prose with `code` and **bold** (the two bits of markup the generated text uses). */
export function runs(text, { size = 9.5, color } = {}) {
  const parts = String(text === undefined || text === null ? '' : text).split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      return { text: pdfSafe(breakable(part.slice(1, -1))), font: MONO, fontSize: size - 1, color: C.codeInk, background: C.inlineBg };
    }
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      return { text: pdfSafe(breakable(part.slice(2, -2))), bold: true, ...(color ? { color } : {}) };
    }
    return { text: pdfSafe(breakable(part)), ...(color ? { color } : {}) };
  });
}

/** Wrap one line of code at `max` characters, continuing with a small indent. */
function wrapLine(line, max) {
  if (line.length <= max) return [line];
  const indent = (line.match(/^\s*/) || [''])[0];
  const out = [];
  let rest = line;
  let first = true;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.6) cut = max;
    out.push(rest.slice(0, cut));
    rest = (first ? indent + '  ' : indent + '  ') + rest.slice(cut).replace(/^ +/, '');
    first = false;
  }
  out.push(rest);
  return out;
}

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

const tableLayout = {
  hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0.6 : 0.4),
  vLineWidth: () => 0,
  hLineColor: () => C.line,
  paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 3.5, paddingBottom: () => 3.5,
};
const plainLayout = {
  hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0,
};

function h2(title, lede, { width = WIDTH, extra = {} } = {}) {
  return [
    { text: pdfSafe(title), fontSize: 15, bold: true, margin: [0, 20, 0, 3], headlineLevel: 1, ...extra },
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 0.8, lineColor: C.line }], margin: [0, 0, 0, 6] },
    ...(lede ? [{ text: runs(lede, { size: 8.5 }), fontSize: 8.5, color: C.muted, margin: [0, 0, 0, 8] }] : []),
  ];
}
const h3 = (title, extra = {}) => ({ text: pdfSafe(title), fontSize: 11.5, bold: true, margin: [0, 12, 0, 4], headlineLevel: 2, ...extra });
const h5 = (title) => ({ text: pdfSafe(title).toUpperCase(), fontSize: 7, bold: true, color: C.muted, characterSpacing: 0.6, margin: [0, 6, 0, 2], headlineLevel: 3 });
const muted = (text, size = 8.5) => ({ text: runs(text, { size }), fontSize: size, color: C.muted, margin: [0, 0, 0, 3] });

function pill(text, color) {
  return { text: ` ${pdfSafe(text)} `, color: '#ffffff', background: color, bold: true, fontSize: 7.5 };
}

function cell(v, size = 8.5) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (v.code !== undefined) return { text: pdfSafe(breakable(v.code)), font: MONO, fontSize: size - 0.5, color: C.codeInk };
    if (v.muted !== undefined) return { text: runs(v.muted, { size }), fontSize: size, color: C.muted, italics: true };
    if (v.alert !== undefined) return { text: runs(v.alert, { size }), fontSize: size, color: C.err, italics: true };
    return v;
  }
  return { text: runs(v, { size }), fontSize: size };
}

function dataTable(headers, rows, widths) {
  if (!rows.length) return null;
  return {
    table: {
      headerRows: 1,
      dontBreakRows: true,
      widths: widths || headers.map(() => '*'),
      body: [
        headers.map((h) => ({ text: pdfSafe(h), bold: true, fillColor: C.sunk, fontSize: 8.5 })),
        ...rows.map((r) => r.map((v) => cell(v))),
      ],
    },
    layout: tableLayout,
    margin: [0, 4, 0, 8],
  };
}

/** Label / value pairs, skipping empty values. */
function kv(rows, labelWidth = 120) {
  const items = rows.filter((r) => r && r[1] !== undefined && r[1] !== null && String(r[1]).trim() !== '');
  if (!items.length) return null;
  return {
    table: {
      widths: [labelWidth, '*'],
      body: items.map(([k, v]) => [
        { text: pdfSafe(k), color: C.muted, fontSize: 8.5 },
        cell(v),
      ]),
    },
    layout: { ...plainLayout, paddingTop: () => 1.6, paddingBottom: () => 1.6 },
    margin: [0, 2, 0, 6],
  };
}

function codeBlock(code, size = 7.2) {
  const lines = String(code === undefined || code === null ? '' : code)
    .replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
    .flatMap((l) => wrapLine(pdfSafe(l), 112))
    .map((l) => (l === '' ? ' ' : l));
  const chunks = [];
  for (let i = 0; i < lines.length; i += 34) chunks.push(lines.slice(i, i + 34).join('\n'));
  if (!chunks.length) chunks.push(' ');
  return {
    table: {
      widths: ['*'],
      body: chunks.map((c) => [{ text: c, font: MONO, fontSize: size, lineHeight: 1.18, preserveLeadingSpaces: true, color: C.codeInk, fillColor: C.codeBg, margin: [7, 3, 7, 3] }]),
    },
    layout: plainLayout,
    margin: [0, 3, 0, 8],
  };
}

/** A shaded box with a coloured bar on its left. */
function callout(content, bg, bar) {
  return {
    table: { widths: ['*'], body: [[{ ...content, fillColor: bg, margin: [10, 7, 10, 7] }]] },
    layout: { ...plainLayout, vLineWidth: (i) => (i === 0 ? 3 : 0), vLineColor: () => bar },
    margin: [0, 2, 0, 8],
  };
}

function bullets(items, emptyText) {
  if (!items.length) return { text: pdfSafe(emptyText), italics: true, color: C.muted, margin: [0, 0, 0, 6] };
  return {
    ul: items.map((i) => ({
      text: [
        ...runs(i.text, { size: 9 }),
        ...(i.at ? [{ text: pdfSafe(`  (${i.at.label} ${i.at.name})`), color: C.muted, fontSize: 8 }] : []),
      ],
      fontSize: 9,
      margin: [0, 0, 0, 2.5],
    })),
    margin: [6, 2, 0, 6],
    markerColor: C.muted,
  };
}

const categoryColor = (key) => (CATEGORIES[key] ? CATEGORIES[key].color : C.accent);
const depthOf = (label) => Math.min(3, (String(label).match(/\./g) || []).length);
const labelled = (r) => `${r.label} ${r.name}`.trim();

/* ------------------------------------------------------------------ */
/* Process summary                                                     */
/* ------------------------------------------------------------------ */

function ioLines(step) {
  const out = [];
  const origin = (r) => {
    if (r.from) return ` (set at ${r.from.label})`;
    if (r.origin === 'runtime') return ' (runtime)';
    if (r.origin === 'external') return ' (from the caller)';
    if (r.origin === 'later') return ' (only set by a later step)';
    return '';
  };
  const uses = (step.reads || []).map((r) => `${r.kind} \`${r.name}\`${origin(r)}`);
  if (step.readsBody) uses.push('the message body');
  const sets = (step.writes || []).map((w) => `${w.kind} \`${w.name}\``);
  if (step.replacesBody) sets.push('the message body');
  const removes = (step.removes || []).map((r) => `${r.kind} \`${r.name}\``);
  for (const [label, list] of [['USES', uses], ['SETS', sets], ['REMOVES', removes]]) {
    if (!list.length) continue;
    out.push({ text: [{ text: `${label}  `, bold: true, fontSize: 6.8, color: C.muted, characterSpacing: 0.5 }, ...runs(list.join(', '), { size: 8.5 })], fontSize: 8.5, margin: [0, 1, 0, 0] });
  }
  return out;
}

function walkStep(step) {
  const color = categoryColor(step.category);
  const head = {
    stack: [
      {
        text: [
          pill(step.label || '•', color),
          { text: `  ${pdfSafe(step.name)}`, bold: true, fontSize: 10 },
          { text: `   ${pdfSafe(step.typeLabel)}`, color: C.muted, fontSize: 8 },
          ...(step.unreachable ? [{ text: '   unreachable', color: C.warn, fontSize: 8 }] : []),
        ],
        margin: [0, 0, 0, 2],
      },
      { text: runs(step.text, { size: 9 }), fontSize: 9 },
    ],
    unbreakable: true,
  };
  const stack = [head];

  if (step.branches && step.branches.length) {
    stack.push({
      ul: step.branches.map((b) => ({
        text: [
          { text: pdfSafe(b.name || 'Route'), bold: true },
          ...(b.isDefault && !b.condition ? [{ text: ' — taken when nothing else matches' }] : b.condition ? [{ text: ' — when ' }, { text: pdfSafe(b.condition), font: MONO, fontSize: 7.8, background: C.inlineBg }] : []),
          ...(b.toLabel ? [{ text: pdfSafe(` -> ${b.toLabel} ${b.toName}`), color: C.muted }] : []),
        ],
        fontSize: 8.5,
        margin: [0, 0, 0, 1.5],
      })),
      margin: [8, 3, 0, 2],
      markerColor: C.muted,
    });
  }
  // A step that only passes the body along has nothing to add beyond its sentence.
  if ((step.reads || []).length || (step.writes || []).length || (step.removes || []).length) stack.push(...ioLines(step));
  return { stack, margin: [depthOf(step.label) * 14, 6, 0, 4] };
}

function summarySection(doc) {
  const sm = doc.summary;
  if (!sm) return [];
  const out = [...h2('Process summary', 'A plain-language walkthrough derived from the export: where the data comes from, what each step and script does with it, and what comes out.')];

  out.push(callout({ text: runs(sm.headline, { size: 10.5 }), fontSize: 10.5, lineHeight: 1.4 }, C.infoBg, C.accent));

  out.push(h3('Data in'), bullets(sm.inputs, 'Nothing enters this flow from outside.'));
  out.push(h3('Data out'), bullets(sm.outputs, 'This flow sends nothing anywhere.'));

  out.push(h3('What happens, step by step'));
  for (const flow of sm.flows) {
    if (!flow.steps.length) continue;
    if (!flow.isMain) out.push({ text: pdfSafe(`Local process: ${flow.name}`), bold: true, fontSize: 10, margin: [0, 10, 0, 2] });
    for (const step of flow.steps) out.push(walkStep(step));
  }

  if (sm.results.length) {
    out.push(h3('Result'));
    for (const r of sm.results) {
      out.push({ text: [{ text: pdfSafe(`${r.label} ${r.name}   `), bold: true, fontSize: 9 }, ...runs(r.text, { size: 9 })], fontSize: 9, margin: [0, 2, 0, 5] });
    }
  }

  out.push(h3('If something goes wrong'), { text: runs(sm.errorText, { size: 9.5 }), margin: [0, 0, 0, 4] });
  const errorSteps = sm.flows.flatMap((f) => f.errorSteps).concat(sm.errorProcs.flatMap((p) => p.steps));
  for (const step of errorSteps) out.push(walkStep(step));

  if (doc.dataFlow && doc.dataFlow.length) {
    out.push(h3('Data passed between steps'));
    const kindLabel = { header: 'Header', property: 'Property', variable: 'Variable' };
    const refs = (list) => list.map(labelled).join('\n');
    out.push(dataTable(
      ['Data', 'Set by', 'Used by'],
      doc.dataFlow.map((v) => [
        { text: [{ text: `${kindLabel[v.kind]}  `, color: C.muted, italics: true, fontSize: 8 }, { text: pdfSafe(v.name), font: MONO, fontSize: 8 }] },
        v.setBy.length ? refs(v.setBy) : v.origin === 'runtime' ? { muted: 'Supplied by the runtime or adapter' } : { alert: 'Not set in this flow — comes from the caller' },
        v.readBy.length ? refs(v.readBy) : { muted: 'Not read inside this flow' },
      ]),
      [150, '*', '*']
    ));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The other sections                                                  */
/* ------------------------------------------------------------------ */

function findingsSection(doc) {
  if (!doc.findings.length) return [];
  const order = { error: 0, warning: 1, info: 2 };
  const out = [...h2('Review notes', 'Observations derived from the export itself. Each one is checkable against the sections of this document.')];
  for (const f of [...doc.findings].sort((a, b) => order[a.severity] - order[b.severity])) {
    const s = SEVERITY[f.severity] || SEVERITY.info;
    out.push({
      table: {
        widths: [46, '*'],
        body: [[
          { text: s.tag, bold: true, fontSize: 7, color: '#ffffff', fillColor: s.color, alignment: 'center', margin: [0, 2, 0, 2] },
          { stack: [{ text: pdfSafe(f.title), bold: true, fontSize: 9 }, { text: runs(f.detail, { size: 8.5 }), fontSize: 8.5, color: C.muted }], fillColor: s.bg, margin: [6, 3, 6, 3] },
        ]],
      },
      layout: plainLayout,
      margin: [0, 2, 0, 3],
    });
  }
  return out;
}

function legendFor(doc) {
  return Object.entries(CATEGORIES)
    .filter(([key]) => doc.processes.some((p) => p.steps.some((s) => s.category === key)))
    .map(([, meta]) => ({ label: meta.label, color: meta.color }));
}

/** A flow that is much wider than it is tall is unreadable on a portrait page. */
const isWide = (diagram) => diagram && diagram.width && diagram.height && diagram.width / diagram.height > 1.25;
const LANDSCAPE_WIDTH = 842 - 80;

function diagramSection(doc, diagram) {
  if (!diagram || !diagram.dataUrl) return [];
  const legend = legendFor(doc);
  const wide = isWide(diagram);
  const width = wide ? LANDSCAPE_WIDTH : WIDTH;
  const lede = 'Reconstructed from the layout stored in the export, so it matches the flow as drawn in Cloud Integration.';
  return [
    // A wide diagram gets a landscape page of its own...
    ...(wide ? h2('Flow diagram', lede, { width, extra: { pageBreak: 'before', pageOrientation: 'landscape', margin: [0, 0, 0, 3] } }) : h2('Flow diagram', lede)),
    // Height is capped so the heading, the image and the legend always share one page.
    { image: diagram.dataUrl, fit: [width, wide ? 395 : 540], margin: [0, 2, 0, 6] },
    ...(legend.length ? [{
      columns: legend.map((l) => ({
        width: 'auto',
        columns: [
          { width: 10, canvas: [{ type: 'rect', x: 0, y: 2, w: 7, h: 7, color: l.color }] },
          { width: 'auto', text: pdfSafe(l.label), fontSize: 8, color: C.muted, margin: [0, 0, 12, 0] },
        ],
      })),
      margin: [0, 0, 0, 4],
    }] : []),
    // ...and the document goes back to portrait right after it.
    ...(wide ? [{ text: ' ', fontSize: 1, pageBreak: 'before', pageOrientation: 'portrait' }] : []),
  ];
}

function channelsSection(doc) {
  if (!doc.channels.length) return [];
  const out = [...h2('Interfaces', 'Systems this flow talks to, and how.')];
  const groups = [['Sender channels', doc.channels.filter((c) => c.direction === 'Sender')], ['Receiver channels', doc.channels.filter((c) => c.direction !== 'Sender')]];
  for (const [title, list] of groups) {
    if (!list.length) continue;
    out.push(h3(title));
    for (const ch of list) {
      out.push({
        stack: [
          { text: [pill(ch.direction, ch.direction === 'Sender' ? C.ok : '#c25e00'), { text: `  ${pdfSafe(ch.name)}`, bold: true, fontSize: 10 }], margin: [0, 0, 0, 2] },
          ...(ch.endpoint ? [{ text: pdfSafe(breakable(ch.endpoint)), font: MONO, fontSize: 8, color: C.codeInk, margin: [0, 0, 0, 3] }] : []),
          kv([
            ['Partner system', ch.partner],
            ['Adapter', ch.adapter],
            ['Transport protocol', ch.transportProtocol],
            ['Message protocol', ch.messageProtocol],
            ['Connected to', ch.attachedStepName],
          ]),
          ...(ch.details.length ? [h5('Configuration'), kv(ch.details.map((d) => [d.label, d.value]))] : []),
        ].filter(Boolean),
        margin: [0, 4, 0, 6],
      });
    }
  }
  return out;
}

function stepDetailBlock(step) {
  const color = categoryColor(step.category);
  const stack = [{
    stack: [{
      text: [
        pill(step.label || '•', color),
        { text: `  ${pdfSafe(step.name)}`, bold: true, fontSize: 10 },
        { text: `   ${pdfSafe(step.typeLabel)}`, color: C.muted, fontSize: 8 },
        ...(step.unreachable ? [{ text: '   unreachable', color: C.warn, fontSize: 8 }] : []),
      ],
    }],
    unbreakable: true,
    margin: [0, 0, 0, 2],
  }];

  if (step.note) stack.push(muted(step.note));
  if (step.details.length) stack.push(kv(step.details.map((d) => [d.label, d.value]), 110));
  for (const t of step.tables) {
    if (!t.rows.length) continue;
    stack.push(h5(t.title), dataTable(['Name', 'Source', 'Value'], t.rows.map((r) => [r.name, r.type || r.dataType || '', r.value || r.default || '']), [120, 70, '*']));
  }
  if (step.body) stack.push(h5(`Message body (${step.body.type})`), codeBlock(step.body.content));
  if (step.branches.length) {
    stack.push(h5('Routing conditions'), dataTable(
      ['Branch', 'Condition', 'Type'],
      step.branches.map((b) => [b.name || (b.isDefault ? 'Default route' : b.to), b.isDefault && !b.condition ? { muted: '(default — taken when no other condition matches)' } : { code: b.condition }, b.expressionType || '']),
      [110, '*', 50]
    ));
  }
  if (step.scriptRef) {
    stack.push({ text: [{ text: 'Script: ', color: C.muted }, { text: pdfSafe(step.scriptRef), font: MONO, fontSize: 8, background: C.inlineBg }, ...(step.scriptFunction ? [{ text: '   entry point ', color: C.muted }, { text: pdfSafe(step.scriptFunction), font: MONO, fontSize: 8, background: C.inlineBg }] : [])], fontSize: 8.5, margin: [0, 2, 0, 2] });
  }
  if (step.mappingRef) stack.push({ text: [{ text: 'Mapping: ', color: C.muted }, { text: pdfSafe(breakable(step.mappingRef)), font: MONO, fontSize: 8, background: C.inlineBg }], fontSize: 8.5, margin: [0, 2, 0, 2] });
  if (step.channels.length) {
    stack.push({ text: [{ text: step.channels.length > 1 ? 'Channels: ' : 'Channel: ', color: C.muted }, { text: pdfSafe(step.channels.map((c) => `${c.direction} · ${c.adapter}${c.partner ? ' · ' + c.partner : ''}`).join('   |   ')) }], fontSize: 8.5, margin: [0, 2, 0, 2] });
  }
  const io = { reads: step.io ? step.io.reads : [], writes: step.io ? step.io.writes : [], removes: step.io ? step.io.removes : [], readsBody: step.io && step.io.readsBody, replacesBody: step.io && step.io.bodyEffect === 'replace' };
  if (io.reads.length || io.writes.length || io.removes.length) stack.push(h5('Data used'), ...ioLines(io));
  return { stack: stack.filter(Boolean), margin: [0, 7, 0, 5] };
}

function processingSection(doc) {
  if (!doc.processes.length) return [];
  const out = [...h2('Processing steps', 'In execution order. Branch numbers such as 4a.1 follow a router path.')];
  const ordered = [...doc.processes].sort((a, b) => Number(b.isMain) - Number(a.isMain));
  for (const proc of ordered) {
    out.push(h3(`${proc.name}${proc.isMain ? '  (main process)' : '  (local process)'}${proc.transactionHandling ? `  ·  transaction: ${proc.transactionHandling}` : ''}`));
    for (const step of proc.steps) out.push(stepDetailBlock(step));
  }
  return out;
}

function parametersSection(doc) {
  if (!doc.parameters.length) return [];
  return [
    ...h2('Externalised parameters', 'Values that are set per environment at deployment time. "Configured value" is what this export ships with.'),
    dataTable(
      ['Parameter', 'Type', 'Configured value', 'Used by'],
      doc.parameters.map((p) => [
        { text: [{ text: pdfSafe(p.name), font: MONO, fontSize: 8 }, ...(p.secret ? [{ text: '  secret', color: C.warn, fontSize: 7.5, bold: true }] : [])] },
        p.dataType || '',
        p.empty ? { alert: 'not set' } : { code: p.value },
        p.unused ? { muted: 'not referenced' } : p.usedIn.join('\n'),
      ]),
      [120, 50, 115, '*']
    ),
  ];
}

function dependenciesSection(doc) {
  const d = doc.dependencies;
  if (!Object.values(d).some((list) => list.length)) return [];
  const out = [...h2('Dependencies', 'What must exist outside this archive for the flow to run.')];
  if (d.processDirect.length) {
    out.push(h3('ProcessDirect'), dataTable(['Address', 'Direction', 'Channel'], d.processDirect.map((x) => [{ code: x.address }, x.direction, x.channel]), ['*', 70, '*']),
      muted('Other integration flows in the same tenant bind to these addresses. Changing one breaks its counterpart.'));
  }
  if (d.endpoints.length) out.push(h3('External endpoints'), dataTable(['Address', 'Direction', 'Adapter', 'Partner'], d.endpoints.map((x) => [{ code: x.address }, x.direction, x.adapter, x.partner || '']), ['*', 60, 80, 90]));
  if (d.queues.length) out.push(h3('Queues'), dataTable(['Queue', 'Direction', 'Adapter'], d.queues.map((x) => [{ code: x.name }, x.direction, x.adapter]), ['*', 70, 100]));
  if (d.dataStores.length) out.push(h3('Data stores'), dataTable(['Store', 'Operation', 'Visibility', 'Used by'], d.dataStores.map((x) => [{ code: x.name }, x.operation, x.visibility, x.usedBy]), ['*', 70, 70, 130]));
  if (d.globalVariables.length) out.push(h3('Variables'), dataTable(['Variable', 'Scope', 'Written by'], d.globalVariables.map((x) => [{ code: x.name }, x.scope, x.usedBy]), ['*', 80, 140]));
  if (d.valueMappings.length) out.push(h3('Value mapping lookups'), dataTable(['Agency', 'Scheme', 'Used by'], d.valueMappings.map((x) => [x.agency, x.scheme, x.usedBy])));
  if (d.credentials.length) {
    out.push(h3('Security material'), dataTable(['Alias', 'Kind', 'Used by'], d.credentials.map((x) => [{ code: x.alias }, x.kind, x.usedBy]), ['*', 130, 130]),
      muted('These aliases must exist in the target tenant’s security material before deployment. Only the alias names are stored in the export — never the secrets themselves.'));
  }
  return out;
}

function errorSection(doc) {
  if (!doc.errorHandling.length) return [];
  const out = [...h2('Error handling', 'What runs when a step raises an exception.')];
  for (const { process, step } of doc.errorHandling) {
    const steps = step ? process.steps.filter((s) => s.raw.parentId === step.id) : process.steps;
    out.push({ text: [pill(step ? 'EXCEPTION SUBPROCESS' : 'ERROR HANDLER', C.err), { text: `  ${pdfSafe(step ? step.name || 'Exception Subprocess' : process.name)}`, bold: true, fontSize: 10 }], margin: [0, 8, 0, 3] });
    out.push(steps.length
      ? { ol: steps.map((s) => ({ text: [{ text: pdfSafe(s.name), bold: true }, { text: pdfSafe(`   ${s.typeLabel}`), color: C.muted, fontSize: 8 }], margin: [0, 0, 0, 2] })), margin: [10, 0, 0, 6] }
      : muted('The subprocess contains no steps — the message simply ends in error.'));
  }
  return out;
}

function scriptsSection(doc) {
  if (!doc.scripts.length) return [];
  const out = [...h2('Scripts', 'Full source of every script shipped with the flow.')];
  for (const script of doc.scripts) {
    const a = doc.scriptAnalysis && doc.scriptAnalysis.get(script.name);
    out.push({ text: [{ text: pdfSafe(script.name), bold: true, fontSize: 11 }, { text: `   ${pdfSafe(script.language)}`, color: C.muted, fontSize: 8 }], margin: [0, 12, 0, 1], headlineLevel: 2 });
    out.push({ text: pdfSafe(script.path), color: C.muted, fontSize: 7.5, margin: [0, 0, 0, 4] });
    if (a) {
      const clauses = scriptSummary(a);
      const users = [];
      for (const proc of doc.processes) for (const st of proc.steps) if (st.scriptRef && st.scriptRef.split('/').pop() === script.name) users.push(st);
      const box = [{ text: 'WHAT THIS SCRIPT DOES', bold: true, fontSize: 7, color: C.muted, characterSpacing: 0.6, margin: [0, 0, 0, 3] }];
      if (a.purpose) box.push({ text: [{ text: `“${pdfSafe(a.purpose)}”`, italics: true }, { text: '  — from the script’s own comment', color: C.muted, fontSize: 8 }], fontSize: 9, margin: [0, 0, 0, 3] });
      box.push(clauses.length
        ? { ul: clauses.map((c) => ({ text: [{ text: 'It ' }, ...runs(c, { size: 8.8 }), { text: '.' }], fontSize: 8.8, margin: [0, 0, 0, 1.5] })), margin: [6, 0, 0, 3], markerColor: C.muted }
        : muted('No header, property or body access could be identified.'));
      box.push(users.length
        ? { text: [{ text: 'Called from: ', color: C.muted }, { text: users.map((u) => labelled(u)).join(', ') }], fontSize: 8.5 }
        : { text: 'Not called from any step.', fontSize: 8.5, color: C.muted });
      out.push({ table: { widths: ['*'], body: [[{ stack: box, fillColor: C.sunk, margin: [9, 7, 9, 7] }]] }, layout: plainLayout, margin: [0, 0, 0, 5] });
    }
    out.push(codeBlock(script.code));
  }
  return out;
}

function mappingsSection(doc) {
  const a = doc.artifact;
  if (!(a.messageMappings.length || a.xsltMappings.length || a.schemas.length || a.valueMappings.length)) return [];
  const out = [...h2('Mappings & schemas')];

  if (a.messageMappings.length) {
    out.push(h3('Message mappings'));
    for (const m of a.messageMappings) {
      out.push({
        stack: [
          { text: [{ text: pdfSafe(m.name), bold: true, fontSize: 10 }, { text: `   ${pdfSafe(m.kind)}`, color: C.muted, fontSize: 8 }], margin: [0, 0, 0, 2] },
          kv([
            m.sources.length ? ['Source structures', m.sources.map((s) => s.name).join(', ')] : null,
            m.targets.length ? ['Target structures', m.targets.map((s) => s.name).join(', ')] : null,
            m.functions.length ? ['Functions used', m.functions.join(', ')] : null,
            ['File', m.path],
          ]),
          ...(m.links.length ? [h5(`Field mappings (${m.links.length})`), dataTable(['Source', 'Target'], m.links.map((l) => [{ code: l.source }, { code: l.target }]))] : []),
          ...(m.note ? [muted(m.note)] : []),
        ].filter(Boolean),
        margin: [0, 4, 0, 6],
      });
    }
  }
  if (a.xsltMappings.length) {
    out.push(h3('XSLT mappings'), dataTable(['File', 'Templates', 'Output method'], a.xsltMappings.map((x) => [{ code: x.path }, x.templates.join(', ') || '—', x.outputMethod || '—']), ['*', 150, 80]));
  }
  if (a.schemas.length) {
    out.push(h3('Schemas'), dataTable(['File', 'Kind', 'Target namespace', 'Root elements'], a.schemas.map((s) => [{ code: s.path }, s.kind, s.targetNamespace || '—', (s.rootElements || []).join(', ') || '—']), ['*', 40, 120, 90]));
  }
  if (a.valueMappings.length) {
    out.push(h3('Value mappings'));
    for (const v of a.valueMappings) {
      out.push({ text: [{ text: pdfSafe(v.name), bold: true }, { text: `   ${v.groups.length} groups`, color: C.muted, fontSize: 8 }], margin: [0, 4, 0, 0] },
        dataTable(['Agency', 'Scheme', 'Value'], v.groups.flatMap((g) => g.identifiers.map((i) => [i.agency, i.scheme, i.value]))));
    }
  }
  return out;
}

function appendixSection(doc) {
  const a = doc.artifact;
  const out = [];
  if (a.manifestHeaders && a.manifestHeaders.length) out.push(h3('Manifest'), dataTable(['Header', 'Value'], a.manifestHeaders.map((h) => [h.key, { code: h.value }]), [140, '*']));
  if (a.otherResources.length) out.push(h3('Other files in the archive'), dataTable(['File', 'Size'], a.otherResources.map((r) => [{ code: r.path }, formatBytes(r.size)]), ['*', 70]));
  if (a.warnings.length) out.push(h3('Parser warnings'), { ul: a.warnings.map((w) => ({ text: pdfSafe(w), fontSize: 8.5 })), margin: [6, 0, 0, 6] });
  return out.length ? [...h2('Appendix'), ...out] : [];
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

function frame(title, content, subject) {
  const name = pdfSafe(title);
  return {
    pageSize: 'A4',
    pageMargins: [40, 46, 40, BOTTOM_MARGIN],
    info: { title: name, subject, creator: 'iFlow Docs', producer: 'iFlow Docs (pdfmake)' },
    defaultStyle: { font: 'Roboto', fontSize: 9.5, lineHeight: 1.28, color: C.ink },
    footer: (page, pages) => ({
      columns: [
        { text: name.length > 80 ? `${name.slice(0, 79)}…` : name, fontSize: 7.5, color: C.muted },
        { text: `Page ${page} of ${pages}`, alignment: 'right', fontSize: 7.5, color: C.muted, width: 80 },
      ],
      margin: [40, 22, 40, 0],
    }),
    // Do not strand a heading at the foot of a page with its content on the next:
    // a heading that starts in the last stretch of a page moves to the next one.
    pageBreakBefore: (node) => {
      if (!node.headlineLevel) return false;
      const top = node.startPosition && node.startPosition.top;
      if (typeof top !== 'number' || top < 100) return false;       // already at the top of a page
      // Room a heading needs below it: a section heading also has to fit its first sub-heading.
      const reserve = node.headlineLevel === 1 ? 175 : node.headlineLevel === 2 ? 90 : 62;
      return top > PAGE_HEIGHT - BOTTOM_MARGIN - reserve;
    },
    content: content.filter(Boolean),
  };
}

function header(kicker, title, description, chips) {
  return [
    { text: pdfSafe(kicker).toUpperCase(), fontSize: 8, color: C.muted, characterSpacing: 1, margin: [0, 0, 0, 2] },
    { text: pdfSafe(title), fontSize: 22, bold: true, lineHeight: 1.15, margin: [0, 0, 0, 5] },
    ...(description ? [{ text: runs(description, { size: 10 }), fontSize: 10, color: C.muted, margin: [0, 0, 0, 6] }] : []),
    ...(chips.length ? [{ text: pdfSafe(chips.join('   ·   ')), fontSize: 8.5, color: C.muted }] : []),
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: WIDTH, y2: 0, lineWidth: 1.6, lineColor: C.line }], margin: [0, 8, 0, 0] },
  ];
}

/**
 * @param {object} doc a documentation model (src/model/analyze.js)
 * @param {{ diagram?: { dataUrl: string } }} [options]
 */
export function buildDocumentPdf(doc, options = {}) {
  const chips = [
    doc.version && `v${doc.version}`,
    doc.stats.steps && `${doc.stats.steps} steps`,
    doc.stats.channels && `${doc.stats.channels} channels`,
    doc.stats.scripts && `${doc.stats.scripts} scripts`,
    doc.stats.parameters && `${doc.stats.parameters} parameters`,
  ].filter(Boolean);

  const overview = Object.entries(doc.overview);
  return frame(doc.name, [
    ...header(typeLabel(doc.type), doc.name, doc.description, chips),
    ...(overview.length ? [...h2('Overview'), kv(overview, 130)] : []),
    ...summarySection(doc),
    ...findingsSection(doc),
    ...diagramSection(doc, options.diagram),
    ...channelsSection(doc),
    ...processingSection(doc),
    ...parametersSection(doc),
    ...dependenciesSection(doc),
    ...errorSection(doc),
    ...scriptsSection(doc),
    ...mappingsSection(doc),
    ...appendixSection(doc),
  ], 'SAP Cloud Integration documentation');
}

/** The package overview: what is in the package, and how the flows hand off to each other. */
export function buildIndexPdf(archive, docs) {
  const name = archive.sourceName.replace(/\.zip$/i, '');
  const totals = docs.reduce((t, d) => ({
    steps: t.steps + (d.stats.steps || 0), scripts: t.scripts + (d.stats.scripts || 0),
    channels: t.channels + (d.stats.channels || 0), findings: t.findings + d.findings.length,
  }), { steps: 0, scripts: 0, channels: 0, findings: 0 });

  const handoffs = [];
  for (const d of docs) {
    for (const p of d.dependencies.processDirect) handoffs.push([d.name, { code: p.address }, 'ProcessDirect', p.direction]);
    for (const q of d.dependencies.queues) handoffs.push([d.name, { code: q.name }, q.adapter, q.direction]);
  }

  return frame(name, [
    ...header('Integration package', name, '', [`${docs.length} artefacts`, `${totals.steps} steps`, `${totals.channels} channels`, `${totals.scripts} scripts`, `${totals.findings} review notes`]),
    ...h2('Contents', 'Every artefact found in the package export.'),
    dataTable(
      ['Artefact', 'Type', 'Version', 'Steps', 'Senders', 'Receivers', 'Notes'],
      docs.map((d) => [{ text: pdfSafe(d.name), bold: true, fontSize: 8.5 }, typeLabel(d.type), d.version || '', String(d.stats.steps || 0), d.senders.map((s) => s.name).join(', ') || '—', d.receivers.map((s) => s.name).join(', ') || '—', String(d.findings.length || 0)]),
      ['*', 62, 40, 32, 70, 70, 34]
    ),
    ...(handoffs.length ? [
      ...h2('Internal hand-offs', 'Where flows in this package pass messages to each other. Matching a Receiver row to a Sender row on the same address shows the chain.'),
      dataTable(['Artefact', 'Address / queue', 'Via', 'Direction'], handoffs, ['*', '*', 80, 60]),
    ] : []),
  ], 'SAP Cloud Integration package documentation');
}

/* ------------------------------------------------------------------ */
/* File names                                                          */
/* ------------------------------------------------------------------ */

/** "Audit Sink" -> "Audit Sink.pdf"; a repeated name becomes "Audit Sink (2).pdf". */
export function pdfFileName(name, used = new Set()) {
  const stem = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120) || 'document';
  let candidate = `${stem}.pdf`;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n}).pdf`;
  used.add(candidate.toLowerCase());
  return candidate;
}
