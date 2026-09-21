/**
 * Renders a documentation model to HTML.
 *
 * Returns a string rather than DOM nodes so the identical renderer produces the
 * on-screen document and the self-contained HTML export — there is no second
 * code path that can drift out of step with what the user saw.
 */

import { renderDiagram, cssId } from './diagram.js';
import { CATEGORIES, humanise, isMeaningful, typeLabel } from '../model/catalog.js';
import { findParamRefs } from '../model/analyze.js';
import { scriptSummary } from '../model/flow.js';

export function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SEVERITY_LABEL = { error: 'Blocker', warning: 'Check', info: 'Note' };

/**
 * Section and step ids are scoped to their document. A package export renders
 * several documents into one page, and every one of them has an "Overview" —
 * without the scope, every contents link would jump to the first flow.
 */
function prefixOf(doc) {
  return `${cssId(doc.id || doc.name)}--`;
}

export function renderDocument(doc, options = {}) {
  const prefix = prefixOf(doc);
  const sections = [];
  sections.push(renderHeader(doc));
  sections.push(renderOverview(doc));
  sections.push(renderSummary(doc));
  if (doc.findings.length) sections.push(renderFindings(doc));
  sections.push(renderDiagramSection(doc, { ...options, linkPrefix: prefix }));
  sections.push(renderChannels(doc));
  sections.push(renderProcesses(doc));
  sections.push(renderParameters(doc));
  sections.push(renderDependencies(doc));
  sections.push(renderErrorHandling(doc));
  sections.push(renderScripts(doc));
  sections.push(renderMappings(doc));
  sections.push(renderAppendix(doc));
  return `<article class="doc" id="doc-${esc(cssId(doc.id || doc.name))}">${sections.filter(Boolean).join('')}</article>`;
}

/** The sections a document actually has, for the table of contents. */
export function documentSections(doc) {
  const p = prefixOf(doc);
  const out = [{ id: `${p}overview`, label: 'Overview' }];
  if (doc.summary) out.push({ id: `${p}summary`, label: 'Process summary' });
  if (doc.findings.length) out.push({ id: `${p}findings`, label: `Review notes (${doc.findings.length})` });
  if (doc.artifact.iflw && doc.artifact.iflw.shapes.size) out.push({ id: `${p}diagram`, label: 'Flow diagram' });
  if (doc.channels.length) out.push({ id: `${p}channels`, label: `Interfaces (${doc.channels.length})` });
  if (doc.processes.length) out.push({ id: `${p}processing`, label: `Processing steps (${doc.stats.steps})` });
  if (doc.parameters.length) out.push({ id: `${p}parameters`, label: `Parameters (${doc.parameters.length})` });
  if (hasDependencies(doc)) out.push({ id: `${p}dependencies`, label: 'Dependencies' });
  if (doc.errorHandling.length) out.push({ id: `${p}error-handling`, label: 'Error handling' });
  if (doc.scripts.length) out.push({ id: `${p}scripts`, label: `Scripts (${doc.scripts.length})` });
  if (doc.artifact.messageMappings.length + doc.artifact.xsltMappings.length + doc.artifact.schemas.length)
    out.push({ id: `${p}mappings`, label: 'Mappings & schemas' });
  out.push({ id: `${p}appendix`, label: 'Appendix' });
  return out;
}

function section(id, title, body, subtitle = '') {
  if (!body) return '';
  return (
    `<section class="doc-section" id="${esc(id)}">` +
    `<h2>${esc(title)}</h2>` +
    (subtitle ? `<p class="section-lede">${esc(subtitle)}</p>` : '') +
    body +
    '</section>'
  );
}

function renderHeader(doc) {
  const chips = [
    doc.version && `v${doc.version}`,
    doc.stats.steps && `${doc.stats.steps} steps`,
    doc.stats.channels && `${doc.stats.channels} channels`,
    doc.stats.scripts && `${doc.stats.scripts} scripts`,
    doc.stats.parameters && `${doc.stats.parameters} parameters`,
  ].filter(Boolean);

  return (
    '<header class="doc-header">' +
    `<p class="doc-kicker">${esc(typeLabel(doc.type))}</p>` +
    `<h1>${esc(doc.name)}</h1>` +
    (doc.description ? `<p class="doc-description">${esc(doc.description)}</p>` : '') +
    `<p class="chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</p>` +
    '</header>'
  );
}

function renderOverview(doc) {
  const rows = Object.entries(doc.overview);
  if (!rows.length) return '';
  return section(prefixOf(doc) + 'overview', 'Overview', defList(rows));
}

function renderFindings(doc) {
  const order = { error: 0, warning: 1, info: 2 };
  const items = [...doc.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  const body =
    '<ul class="findings">' +
    items
      .map(
        (f) =>
          `<li class="finding finding-${esc(f.severity)}">` +
          `<span class="finding-tag">${esc(SEVERITY_LABEL[f.severity] || f.severity)}</span>` +
          `<div><p class="finding-title">${esc(f.title)}</p><p class="finding-detail">${esc(f.detail)}</p></div></li>`
      )
      .join('') +
    '</ul>';
  return section(
    prefixOf(doc) + 'findings',
    'Review notes',
    body,
    'Observations derived from the export itself. Each one is checkable against the sections below.'
  );
}

function renderDiagramSection(doc, options) {
  const result = renderDiagram(doc, { linkPrefix: options.linkPrefix || '' });
  if (result.empty) return '';
  const legend = Object.entries(CATEGORIES)
    .filter(([key]) => doc.processes.some((p) => p.steps.some((s) => s.category === key)))
    .map(([key, meta]) => `<span class="legend-item"><i style="background:${meta.color}"></i>${esc(meta.label)}</span>`)
    .join('');
  return section(
    prefixOf(doc) + 'diagram',
    'Flow diagram',
    `<div class="diagram-wrap">${result.svg}</div><p class="legend">${legend}</p>`,
    'Reconstructed from the layout stored in the export, so it matches the flow as drawn in Cloud Integration.'
  );
}

function renderChannels(doc) {
  if (!doc.channels.length) return '';
  const groups = [
    ['Sender channels', doc.channels.filter((c) => c.direction === 'Sender')],
    ['Receiver channels', doc.channels.filter((c) => c.direction !== 'Sender')],
  ];
  const body = groups
    .filter(([, list]) => list.length)
    .map(([title, list]) => `<h3>${esc(title)}</h3>` + list.map(channelCard).join(''))
    .join('');
  return section(prefixOf(doc) + 'channels', 'Interfaces', body, 'Systems this flow talks to, and how.');
}

function channelCard(channel) {
  const meta = [
    channel.partner && ['Partner system', channel.partner],
    ['Adapter', channel.adapter],
    channel.transportProtocol && ['Transport protocol', channel.transportProtocol],
    channel.messageProtocol && ['Message protocol', channel.messageProtocol],
    channel.attachedStepName && ['Connected to', channel.attachedStepName],
  ].filter(Boolean);

  return (
    `<div class="card card-channel card-${channel.direction === 'Sender' ? 'sender' : 'receiver'}">` +
    `<div class="card-head"><span class="pill pill-${channel.direction === 'Sender' ? 'sender' : 'receiver'}">${esc(channel.direction)}</span>` +
    `<h4>${esc(channel.name)}</h4></div>` +
    (channel.endpoint ? `<p class="endpoint"><code>${esc(channel.endpoint)}</code></p>` : '') +
    defList(meta) +
    (channel.details.length ? `<h5>Configuration</h5>${defList(channel.details.map((d) => [d.label, d.value]))}` : '') +
    details('All channel properties', propTable(channel.allProps)) +
    '</div>'
  );
}

function renderProcesses(doc) {
  if (!doc.processes.length) return '';
  const ordered = [...doc.processes].sort((a, b) => Number(b.isMain) - Number(a.isMain));
  const body = ordered
    .map((proc) => {
      const heading =
        `<h3 class="process-heading">${esc(proc.name)}` +
        (proc.isMain ? '<span class="tag">main process</span>' : '<span class="tag tag-muted">local process</span>') +
        (proc.transactionHandling ? `<span class="tag tag-muted">transaction: ${esc(proc.transactionHandling)}</span>` : '') +
        '</h3>';
      return heading + proc.steps.map((step) => stepCard(step, doc)).join('');
    })
    .join('');
  return section(prefixOf(doc) + 'processing', 'Processing steps', body, 'In execution order. Branch numbers such as 4a.1 follow a router path.');
}

function stepCard(step, doc) {
  const color = CATEGORIES[step.category].color;
  const parts = [];

  if (step.note) parts.push(`<p class="step-note">${esc(step.note)}</p>`);
  if (step.details.length) parts.push(defList(step.details.map((d) => [d.label, paramAware(d.value, doc)], true)));

  for (const table of step.tables) {
    if (!table.rows.length) continue;
    parts.push(
      `<h5>${esc(table.title)}</h5>` +
      table$(
        ['Name', 'Source', 'Value'],
        table.rows.map((row) => [row.name, row.type || row.dataType || '', paramAware(row.value || row.default || '', doc)])
      )
    );
  }

  if (step.body) {
    parts.push(`<h5>Message body (${esc(step.body.type)})</h5>` + code(step.body.content));
  }

  if (step.branches.length) {
    parts.push(
      '<h5>Routing conditions</h5>' +
      table$(
        ['Branch', 'Condition', 'Type'],
        step.branches.map((b) => [
          b.name || (b.isDefault ? 'Default route' : b.to),
          b.isDefault && !b.condition ? '(default — taken when no other condition matches)' : b.condition,
          b.expressionType || '',
        ])
      )
    );
  }

  if (step.scriptRef) {
    const script = doc.scripts.find((s) => s.name === step.scriptRef.split('/').pop());
    parts.push(
      `<p class="step-ref">Script: <code>${esc(step.scriptRef)}</code>` +
      (step.scriptFunction ? `, entry point <code>${esc(step.scriptFunction)}</code>` : '') +
      (script ? '' : ' <strong class="missing">— not present in this export</strong>') +
      '</p>' +
      (script ? details(`Source of ${script.name}`, code(script.code, script.language)) : '')
    );
  }

  if (step.mappingRef) {
    parts.push(`<p class="step-ref">Mapping: <code>${esc(step.mappingRef)}</code></p>`);
  }

  if (step.channels.length) {
    parts.push(
      `<p class="step-ref">Channel${step.channels.length > 1 ? 's' : ''}: ` +
      step.channels.map((c) => `<span class="pill pill-inline">${esc(c.direction)} · ${esc(c.adapter)}${c.partner ? ' · ' + esc(c.partner) : ''}</span>`).join(' ') +
      '</p>'
    );
  }

  if (step.io && (step.io.reads.length || step.io.writes.length || step.io.removes.length)) {
    parts.push('<h5>Data used</h5>' + ioLine(step.io, doc));
  }

  parts.push(details('All step properties', propTable(step.allProps)));

  return (
    `<div class="card card-step" id="${esc(prefixOf(doc) + cssId(step.id))}" style="--accent:${color}">` +
    '<div class="card-head">' +
    `<span class="step-number">${esc(step.label || '•')}</span>` +
    `<h4>${esc(step.name)}</h4>` +
    `<span class="pill pill-type">${esc(step.typeLabel)}</span>` +
    (step.unreachable ? '<span class="pill pill-warn">unreachable</span>' : '') +
    '</div>' +
    parts.filter(Boolean).join('') +
    '</div>'
  );
}

/* ------------------------------------------------------------------ */
/* Process summary                                                     */
/* ------------------------------------------------------------------ */

/** Generated prose uses two bits of markup: backtick code and **bold**. Everything else is escaped. */
function inline(text) {
  return esc(text)
    .replace(/\u0060([^\u0060]+)\u0060/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function stepLink(doc, ref) {
  if (!ref) return '';
  const label = ref.label ? esc(ref.label) : '';
  return '<a class="step-link" href="#' + esc(prefixOf(doc) + cssId(ref.id)) + '">' +
    (label ? '<b>' + label + '</b> ' : '') + esc(ref.name || '') + '</a>';
}

function ioChip(item, doc) {
  const kind = item.kind === 'header' ? 'header' : item.kind === 'property' ? 'property' : 'variable';
  let src = '';
  if (item.from) {
    src = ' <a class="io-src" href="#' + esc(prefixOf(doc) + cssId(item.from.id)) + '" title="Set by ' + esc(item.from.label + ' ' + item.from.name) + '">\u2190 ' + esc(item.from.label) + '</a>';
  } else if (item.origin === 'runtime') src = ' <span class="io-src" title="Supplied by the runtime or the adapter">runtime</span>';
  else if (item.origin === 'external') src = ' <span class="io-src io-src-warn" title="No step in this flow sets it">from caller</span>';
  else if (item.origin === 'later') src = ' <span class="io-src io-src-warn" title="Only set by a later step">set later</span>';
  return '<span class="io-chip io-' + kind + '"><em>' + kind + '</em> ' + esc(item.name) + src + '</span>';
}

function ioLine(io, doc) {
  const rows = [];
  const uses = io.reads.map((r) => ioChip(r, doc));
  if (io.readsBody) uses.push('<span class="io-chip io-body"><em>message</em> body</span>');
  if (uses.length) rows.push('<span class="io-label">Uses</span>' + uses.join(''));
  const sets = io.writes.map((w) => ioChip({ ...w, origin: 'flow' }, doc));
  if (io.bodyEffect === 'replace') sets.push('<span class="io-chip io-body"><em>message</em> body</span>');
  if (sets.length) rows.push('<span class="io-label">Sets</span>' + sets.join(''));
  if (io.removes && io.removes.length) rows.push('<span class="io-label">Removes</span>' + io.removes.map((r) => ioChip({ ...r, origin: 'flow' }, doc)).join(''));
  if (io.notes && io.notes.length) rows.push('<span class="io-note">' + esc('Also ' + io.notes.join(' and ')) + '</span>');
  // One line per group so "Uses" and "Sets" read as separate statements.
  return rows.map((r) => '<p class="walk-io">' + r + '</p>').join('');
}

function walkStep(step, doc) {
  const color = CATEGORIES[step.category] ? CATEGORIES[step.category].color : CATEGORIES.other.color;
  const depth = Math.min(3, (String(step.label).match(/\./g) || []).length);
  const io = {
    reads: step.reads, writes: step.writes, removes: step.removes,
    readsBody: step.readsBody, bodyEffect: step.replacesBody ? 'replace' : 'keep', notes: step.notes,
  };

  const branches = step.branches && step.branches.length
    ? '<ul class="walk-branches">' + step.branches.map((b) =>
        '<li><strong>' + esc(b.name || 'Route') + '</strong>' +
        (b.isDefault && !b.condition ? ' \u2014 taken when nothing else matches' : (b.condition ? ' \u2014 when <code>' + esc(b.condition) + '</code>' : '')) +
        (b.toId ? ' \u2192 ' + stepLink(doc, { id: b.toId, label: b.toLabel, name: b.toName }) : '') +
        '</li>').join('') + '</ul>'
    : '';

  return '<li class="walk-step" style="--accent:' + color + ';--depth:' + depth + '">' +
    '<span class="step-number">' + esc(step.label || '\u2022') + '</span>' +
    '<div class="walk-body">' +
    '<p class="walk-title">' + stepLink(doc, { id: step.id, name: step.name }) + ' <span class="pill pill-type">' + esc(step.typeLabel) + '</span>' +
    (step.unreachable ? ' <span class="pill pill-warn">unreachable</span>' : '') + '</p>' +
    '<p class="walk-text">' + inline(step.text) + '</p>' +
    // A step that only passes the body along has nothing to add beyond its sentence.
    branches + (io.reads.length || io.writes.length || io.removes.length || io.notes.length ? ioLine(io, doc) : '') +
    '</div></li>';
}

function ioList(items, doc, empty) {
  if (!items.length) return '<p class="muted">' + esc(empty) + '</p>';
  return '<ul class="io-list">' + items.map((i) =>
    '<li>' + inline(i.text) + (i.at ? ' <span class="io-at">' + stepLink(doc, i.at) + '</span>' : '') + '</li>').join('') + '</ul>';
}

function renderSummary(doc) {
  const sm = doc.summary;
  if (!sm) return '';
  const blocks = [];

  blocks.push('<p class="summary-headline">' + inline(sm.headline) + '</p>');

  blocks.push(
    '<div class="io-grid">' +
    '<div class="io-col io-col-in"><h3>Data in</h3>' + ioList(sm.inputs, doc, 'Nothing enters this flow from outside.') + '</div>' +
    '<div class="io-col io-col-out"><h3>Data out</h3>' + ioList(sm.outputs, doc, 'This flow sends nothing anywhere.') + '</div>' +
    '</div>'
  );

  const walk = [];
  for (const flow of sm.flows) {
    if (!flow.steps.length) continue;
    if (!flow.isMain) walk.push('<h4 class="walk-heading">Local process: ' + esc(flow.name) + '</h4>');
    walk.push('<ol class="walk">' + flow.steps.map((st) => walkStep(st, doc)).join('') + '</ol>');
  }
  blocks.push('<h3>What happens, step by step</h3>' + walk.join(''));

  if (sm.results.length) {
    blocks.push(
      '<h3>Result</h3><ul class="results">' +
      sm.results.map((r) => '<li><span class="result-end">' + esc(r.label) + ' ' + esc(r.name) + '</span> ' + inline(r.text) + '</li>').join('') +
      '</ul>'
    );
  }

  const errorSteps = sm.flows.flatMap((f) => f.errorSteps).concat(sm.errorProcs.flatMap((p) => p.steps));
  blocks.push(
    '<h3>If something goes wrong</h3><p>' + inline(sm.errorText) + '</p>' +
    (errorSteps.length ? '<ol class="walk">' + errorSteps.map((st) => walkStep(st, doc)).join('') + '</ol>' : '')
  );

  if (doc.dataFlow.length) blocks.push('<h3>Data passed between steps</h3>' + dataFlowTable(doc));

  return section(
    prefixOf(doc) + 'summary',
    'Process summary',
    blocks.join(''),
    'A plain-language walkthrough derived from the export: where the data comes from, what each step and script does with it, and what comes out. Names computed at runtime inside scripts cannot be seen and are flagged rather than guessed.'
  );
}

function dataFlowTable(doc) {
  const kindLabel = { header: 'Header', property: 'Property', variable: 'Variable' };
  const links = (list) => list.map((r) => stepLink(doc, r)).join('<br>');
  const rows = doc.dataFlow.map((v) => [
    '<em class="muted">' + kindLabel[v.kind] + '</em> <code>' + esc(v.name) + '</code>',
    v.setBy.length ? links(v.setBy) : v.origin === 'runtime'
      ? '<span class="muted">Supplied by the runtime or adapter</span>'
      : '<span class="missing">Not set in this flow</span> <span class="muted">\u2014 comes from the caller</span>',
    v.readBy.length ? links(v.readBy) : '<span class="muted">Not read inside this flow</span>',
  ]);
  return table$(['Data', 'Set by', 'Used by'], rows, true) +
    '<p class="hint">Headers and properties are the values that travel with the message alongside its body. A property is created and read only inside the flow, so \u201Cnot set in this flow\u201D on a property usually means a gap; a header may legitimately arrive from the caller.</p>';
}

/** Per-script panel: the script's own description plus what it reads, sets and calls. */
function scriptPanel(script, doc) {
  const a = doc.scriptAnalysis && doc.scriptAnalysis.get(script.name);
  if (!a) return '';
  const clauses = scriptSummary(a);
  const users = [];
  for (const proc of doc.processes) {
    for (const st of proc.steps) {
      if (st.scriptRef && st.scriptRef.split('/').pop() === script.name) users.push(st);
    }
  }

  const chip = (kind, name) => '<span class="io-chip io-' + kind + '"><em>' + kind + '</em> ' + esc(name) + '</span>';
  const bodyChip = '<span class="io-chip io-body"><em>message</em> body</span>';
  const chips = [];
  if (a.headers.reads.length || a.properties.reads.length || a.body.reads.length) {
    chips.push('<p class="walk-io"><span class="io-label">Reads</span>' +
      a.headers.reads.map((x) => chip('header', x)).join('') +
      a.properties.reads.map((x) => chip('property', x)).join('') +
      (a.body.reads.length ? bodyChip : '') + '</p>');
  }
  if (a.headers.writes.length || a.properties.writes.length || a.body.writes.length) {
    chips.push('<p class="walk-io"><span class="io-label">Sets</span>' +
      a.headers.writes.map((x) => chip('header', x)).join('') +
      a.properties.writes.map((x) => chip('property', x)).join('') +
      (a.body.writes.length ? bodyChip : '') + '</p>');
  }

  return '<div class="script-panel">' +
    '<p class="script-title">What this script does</p>' +
    (a.purpose ? '<p class="script-purpose">\u201C' + esc(a.purpose) + '\u201D <span class="muted">\u2014 from the script\u2019s own comment</span></p>' : '') +
    (clauses.length
      ? '<ul class="clauses">' + clauses.map((c) => '<li>It ' + inline(c) + '.</li>').join('') + '</ul>'
      : '<p class="muted">No header, property or body access could be identified.</p>') +
    chips.join('') +
    (users.length
      ? '<p class="step-ref">Called from: ' + users.map((u) => stepLink(doc, { id: u.id, label: u.label, name: u.name })).join(', ') + '</p>'
      : '<p class="step-ref muted">Not called from any step.</p>') +
    '</div>';
}

function renderParameters(doc) {
  if (!doc.parameters.length) return '';
  const rows = doc.parameters.map((p) => [
    `<code>${esc(p.name)}</code>` + (p.secret ? ' <span class="pill pill-warn">secret</span>' : ''),
    p.dataType || '',
    p.empty ? '<em class="missing">not set</em>' : `<code>${esc(p.value)}</code>`,
    p.unused ? '<em class="muted">not referenced</em>' : p.usedIn.map((u) => esc(u)).join('<br>'),
  ]);
  const body = table$(['Parameter', 'Type', 'Configured value', 'Used by'], rows, true);
  return section(
    prefixOf(doc) + 'parameters',
    'Externalised parameters',
    body,
    'Values that are set per environment at deployment time. "Configured value" is what this export ships with.'
  );
}

function hasDependencies(doc) {
  return Object.values(doc.dependencies).some((list) => list.length);
}

function renderDependencies(doc) {
  if (!hasDependencies(doc)) return '';
  const d = doc.dependencies;
  const blocks = [];

  if (d.processDirect.length) {
    blocks.push(
      '<h3>ProcessDirect</h3>' +
      table$(['Address', 'Direction', 'Channel'], d.processDirect.map((x) => [`<code>${esc(x.address)}</code>`, x.direction, x.channel]), true) +
      '<p class="hint">Other integration flows in the same tenant bind to these addresses. Changing one breaks its counterpart.</p>'
    );
  }
  if (d.endpoints.length) {
    blocks.push('<h3>External endpoints</h3>' + table$(['Address', 'Direction', 'Adapter', 'Partner'],
      d.endpoints.map((x) => [`<code>${esc(x.address)}</code>`, x.direction, x.adapter, x.partner || '']), true));
  }
  if (d.queues.length) {
    blocks.push('<h3>Queues</h3>' + table$(['Queue', 'Direction', 'Adapter'], d.queues.map((x) => [`<code>${esc(x.name)}</code>`, x.direction, x.adapter]), true));
  }
  if (d.dataStores.length) {
    blocks.push('<h3>Data stores</h3>' + table$(['Store', 'Operation', 'Visibility', 'Used by'],
      d.dataStores.map((x) => [`<code>${esc(x.name)}</code>`, x.operation, x.visibility, x.usedBy]), true));
  }
  if (d.globalVariables.length) {
    blocks.push('<h3>Variables</h3>' + table$(['Variable', 'Scope', 'Written by'], d.globalVariables.map((x) => [`<code>${esc(x.name)}</code>`, x.scope, x.usedBy]), true));
  }
  if (d.valueMappings.length) {
    blocks.push('<h3>Value mapping lookups</h3>' + table$(['Agency', 'Scheme', 'Used by'], d.valueMappings.map((x) => [x.agency, x.scheme, x.usedBy])));
  }
  if (d.credentials.length) {
    blocks.push(
      '<h3>Security material</h3>' +
      table$(['Alias', 'Kind', 'Used by'], d.credentials.map((x) => [`<code>${esc(x.alias)}</code>`, x.kind, x.usedBy]), true) +
      '<p class="hint">These aliases must exist in the target tenant’s security material before deployment. Only the alias names are stored in the export — never the secrets themselves.</p>'
    );
  }

  return section(prefixOf(doc) + 'dependencies', 'Dependencies', blocks.join(''), 'What must exist outside this archive for the flow to run.');
}

function renderErrorHandling(doc) {
  if (!doc.errorHandling.length) return '';
  const body = doc.errorHandling
    .map(({ process, step }) => {
      if (step) {
        const inner = process.steps.filter((s) => s.raw.parentId === step.id);
        return (
          `<div class="card card-error"><div class="card-head"><h4>${esc(step.name || 'Exception Subprocess')}</h4>` +
          '<span class="pill pill-warn">exception subprocess</span></div>' +
          (inner.length
            ? '<ol class="error-steps">' + inner.map((s) => `<li><strong>${esc(s.name)}</strong> <span class="muted">${esc(s.typeLabel)}</span></li>`).join('') + '</ol>'
            : '<p class="muted">The subprocess contains no steps — the message simply ends in error.</p>') +
          '</div>'
        );
      }
      return (
        `<div class="card card-error"><div class="card-head"><h4>${esc(process.name)}</h4>` +
        '<span class="pill pill-warn">error handler</span></div>' +
        '<ol class="error-steps">' + process.steps.map((s) => `<li><strong>${esc(s.name)}</strong> <span class="muted">${esc(s.typeLabel)}</span></li>`).join('') + '</ol></div>'
      );
    })
    .join('');
  return section(prefixOf(doc) + 'error-handling', 'Error handling', body, 'What runs when a step raises an exception.');
}

function renderScripts(doc) {
  if (!doc.scripts.length) return '';
  const body = doc.scripts
    .map(
      (s) =>
        `<div class="card card-script"><div class="card-head"><h4>${esc(s.name)}</h4>` +
        `<span class="pill pill-type">${esc(s.language)}</span>` +
        `<span class="muted">${formatBytes(s.size)}</span></div>` +
        `<p class="muted path">${esc(s.path)}</p>` +
        scriptPanel(s, doc) +
        code(s.code, s.language) +
        '</div>'
    )
    .join('');
  return section(prefixOf(doc) + 'scripts', 'Scripts', body, 'Full source of every script shipped with the flow.');
}

function renderMappings(doc) {
  const a = doc.artifact;
  const blocks = [];

  if (a.messageMappings.length) {
    blocks.push(
      '<h3>Message mappings</h3>' +
      a.messageMappings
        .map((m) => {
          const rows = [
            m.sources.length && ['Source structures', m.sources.map((s) => s.name).join(', ')],
            m.targets.length && ['Target structures', m.targets.map((s) => s.name).join(', ')],
            m.functions.length && ['Functions used', m.functions.join(', ')],
            ['File', m.path],
          ].filter(Boolean);
          return (
            `<div class="card"><div class="card-head"><h4>${esc(m.name)}</h4><span class="pill pill-type">${esc(m.kind)}</span></div>` +
            defList(rows) +
            (m.links.length
              ? details(`Field mappings (${m.links.length})`, table$(['Source', 'Target'], m.links.map((l) => [l.source, l.target])))
              : '') +
            (m.note ? `<p class="hint">${esc(m.note)}</p>` : '') +
            '</div>'
          );
        })
        .join('')
    );
  }

  if (a.xsltMappings.length) {
    blocks.push(
      '<h3>XSLT mappings</h3>' +
      table$(
        ['File', 'Templates', 'Output method'],
        a.xsltMappings.map((x) => [`<code>${esc(x.path)}</code>`, x.templates.join(', ') || '—', x.outputMethod || '—']),
        true
      )
    );
  }

  if (a.schemas.length) {
    blocks.push(
      '<h3>Schemas</h3>' +
      table$(
        ['File', 'Kind', 'Target namespace', 'Root elements'],
        a.schemas.map((s) => [`<code>${esc(s.path)}</code>`, s.kind, s.targetNamespace || '—', (s.rootElements || []).join(', ') || '—']),
        true
      )
    );
  }

  if (a.valueMappings.length) {
    blocks.push(
      '<h3>Value mappings</h3>' +
      a.valueMappings
        .map(
          (v) =>
            `<div class="card"><div class="card-head"><h4>${esc(v.name)}</h4><span class="muted">${v.groups.length} groups</span></div>` +
            table$(['Agency', 'Scheme', 'Value'], v.groups.flatMap((g) => g.identifiers.map((i) => [i.agency, i.scheme, i.value]))) +
            '</div>'
        )
        .join('')
    );
  }

  if (!blocks.length) return '';
  return section(prefixOf(doc) + 'mappings', 'Mappings & schemas', blocks.join(''));
}

function renderAppendix(doc) {
  const a = doc.artifact;
  const blocks = [];

  if (a.manifestHeaders && a.manifestHeaders.length) {
    blocks.push('<h3>Manifest</h3>' + table$(['Header', 'Value'], a.manifestHeaders.map((h) => [h.key, h.value])));
  }
  if (a.otherResources.length) {
    blocks.push(
      '<h3>Other files in the archive</h3>' +
      table$(['File', 'Size'], a.otherResources.map((r) => [`<code>${esc(r.path)}</code>`, formatBytes(r.size)]), true)
    );
  }
  if (a.warnings.length) {
    blocks.push('<h3>Parser warnings</h3><ul>' + a.warnings.map((w) => `<li>${esc(w)}</li>`).join('') + '</ul>');
  }
  if (!blocks.length) return '';
  return section(prefixOf(doc) + 'appendix', 'Appendix', blocks.join(''));
}

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

function defList(rows, htmlValues = false) {
  const items = rows.filter((row) => row && isMeaningful(row[1]));
  if (!items.length) return '';
  return (
    '<dl class="kv">' +
    items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${htmlValues ? v : esc(v)}</dd>`).join('') +
    '</dl>'
  );
}

/** `table$` rather than `table` to avoid shadowing anything DOM-ish. */
function table$(headers, rows, htmlCells = false) {
  if (!rows.length) return '';
  return (
    '<div class="table-wrap"><table><thead><tr>' +
    headers.map((h) => `<th>${esc(h)}</th>`).join('') +
    '</tr></thead><tbody>' +
    rows
      .map((row) => '<tr>' + row.map((cell) => `<td>${htmlCells ? cell : esc(cell)}</td>`).join('') + '</tr>')
      .join('') +
    '</tbody></table></div>'
  );
}

function propTable(props) {
  if (!props.length) return '';
  return table$(['Property', 'Value'], props.map((p) => [`<code>${esc(p.key)}</code>`, `<span class="value">${esc(p.value)}</span>`]), true);
}

function details(summary, body) {
  if (!body) return '';
  return `<details class="more"><summary>${esc(summary)}</summary>${body}</details>`;
}

function code(value, language = '') {
  return `<pre class="code" data-lang="${esc(language)}"><code>${esc(value)}</code></pre>`;
}

/** Highlight {{Parameter}} references inside a value and escape everything else. */
function paramAware(value, doc) {
  const text = String(value === undefined ? '' : value);
  const refs = findParamRefs(text);
  if (!refs.length) return esc(text);
  return esc(text).replace(/\{\{([^}{]+)\}\}/g, (whole, name) => {
    const param = doc.parameters.find((p) => p.name === name.trim());
    const resolved = param && isMeaningful(param.value) ? param.value : null;
    const title = resolved ? `Externalised parameter — current value: ${resolved}` : 'Externalised parameter — no value configured';
    return `<span class="param" title="${esc(title)}">${esc(whole)}</span>`;
  });
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/* Package-level index                                                 */
/* ------------------------------------------------------------------ */

export function renderPackageIndex(archive, docs) {
  const rows = docs.map((d) => [
    `<a href="#doc-${esc(cssId(d.id || d.name))}">${esc(d.name)}</a>`,
    typeLabel(d.type),
    d.version || '',
    String(d.stats.steps || 0),
    d.senders.map((s) => esc(s.name)).join(', ') || '—',
    d.receivers.map((s) => esc(s.name)).join(', ') || '—',
    String(d.findings.length || 0),
  ]);

  const totals = docs.reduce(
    (acc, d) => ({
      steps: acc.steps + (d.stats.steps || 0),
      scripts: acc.scripts + (d.stats.scripts || 0),
      channels: acc.channels + (d.stats.channels || 0),
      findings: acc.findings + d.findings.length,
    }),
    { steps: 0, scripts: 0, channels: 0, findings: 0 }
  );

  return (
    '<article class="doc doc-index" id="package-index">' +
    '<header class="doc-header"><p class="doc-kicker">Integration package</p>' +
    `<h1>${esc(archive.sourceName.replace(/\.zip$/i, ''))}</h1>` +
    `<p class="chips"><span class="chip">${docs.length} artefacts</span>` +
    `<span class="chip">${totals.steps} steps</span>` +
    `<span class="chip">${totals.channels} channels</span>` +
    `<span class="chip">${totals.scripts} scripts</span>` +
    `<span class="chip">${totals.findings} review notes</span></p></header>` +
    section(
      'package-contents',
      'Contents',
      table$(['Artefact', 'Type', 'Version', 'Steps', 'Senders', 'Receivers', 'Notes'], rows, true),
      'Every artefact found in the package export.'
    ) +
    renderInterfaceMatrix(docs) +
    '</article>'
  );
}

/** Cross-flow view: which flows hand off to which, via ProcessDirect or queues. */
function renderInterfaceMatrix(docs) {
  const rows = [];
  for (const d of docs) {
    for (const p of d.dependencies.processDirect) {
      rows.push([esc(d.name), `<code>${esc(p.address)}</code>`, 'ProcessDirect', esc(p.direction)]);
    }
    for (const q of d.dependencies.queues) {
      rows.push([esc(d.name), `<code>${esc(q.name)}</code>`, esc(q.adapter), esc(q.direction)]);
    }
  }
  if (!rows.length) return '';
  return section(
    'package-handoffs',
    'Internal hand-offs',
    table$(['Artefact', 'Address / queue', 'Via', 'Direction'], rows, true),
    'Where flows in this package pass messages to each other. Matching a Receiver row to a Sender row on the same address shows the chain.'
  );
}
