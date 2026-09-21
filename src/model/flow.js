/**
 * Process summary: what actually happens to the data as the flow runs.
 *
 * This module answers the questions a reader has before they open any single
 * step: where does the data come from, which steps and scripts touch it, what do
 * they read from earlier steps, and what leaves the flow at the end.
 *
 * Everything here is derived from the export by static analysis. Names that only
 * exist at runtime (a header built by string concatenation in a script, say) are
 * reported as such rather than guessed, and nothing is asserted that the export
 * does not contain.
 */

import { analyzeScript } from '../parse/groovy.js';
import { isMeaningful } from './catalog.js';

const PARAM_RE = /\{\{([^}{]+)\}\}/g;
const EXPR_RE = /\$\{\s*(?:in\.)?(header|headers|property|exchangeProperty)\.([\w-]+(?:\.[\w-]+)*)/g;
const BODY_RE = /\$\{\s*(?:in\.)?body\b/;
const SKIP_SCAN = new Set(['propertyTable', 'headerTable', 'variableTable', 'bodyContent', 'cmdVariantUri', 'componentVersion']);

/** Headers/properties the runtime or an adapter supplies; not something a flow must set. */
const RUNTIME_NAME = /^(Camel|SAP_)/;

/** Adapters whose caller normally waits for a reply. */
const SYNC_ADAPTERS = new Set(['HTTPS', 'SOAP', 'ProcessDirect', 'XI', 'OData', 'OData V2']);

const CONVERSIONS = {
  JsonToXmlConverter: 'JSON to XML',
  XmlToJsonConverter: 'XML to JSON',
  CsvToXmlConverter: 'CSV to XML',
  XmlToCsvConverter: 'XML to CSV',
  EDIToXmlConverter: 'EDI to XML',
  XmlToEdiConverter: 'XML to EDI',
};

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function analyzeFlow(doc) {
  const artifact = doc.artifact;
  const model = artifact.iflw;

  doc.scriptAnalysis = new Map();
  for (const script of doc.scripts) doc.scriptAnalysis.set(script.name, analyzeScript(script.code));

  if (!model || !doc.processes.length) {
    doc.dataFlow = [];
    doc.summary = null;
    return doc;
  }

  const ctx = makeContext(doc);

  // Order matters: per-step reads/writes first, then the lineage across steps,
  // then the prose that quotes both.
  for (const step of ctx.steps) step.io = stepIO(step, ctx);
  doc.dataFlow = buildLineage(ctx);
  annotateOrigins(ctx, doc.dataFlow);
  for (const step of ctx.steps) step.narrative = narrate(step, ctx);
  doc.summary = buildSummary(doc, ctx);
  addScriptCredentials(doc);
  return doc;
}

function makeContext(doc) {
  const ordered = [...doc.processes].sort((a, b) => Number(b.isMain) - Number(a.isMain));
  const steps = ordered.flatMap((p) => p.steps.filter((s) => s.tag !== 'sequenceFlow'));
  steps.forEach((s, i) => { s.seq = i; });
  const byId = new Map(steps.map((s) => [s.id, s]));
  const params = doc.parameters || [];

  return {
    doc,
    artifact: doc.artifact,
    processes: ordered,
    steps,
    byId,
    params,
    processOf: new Map(ordered.flatMap((p) => p.steps.map((s) => [s.id, p]))),
    resolve: (value) => String(value ?? '').replace(PARAM_RE, (whole, name) => {
      const hit = params.find((p) => p.name === name.trim());
      return hit && isMeaningful(hit.value) ? hit.value : whole;
    }),
    originMemo: new Map(),
  };
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

/** Inline code. Backticks are the only markup used in generated prose. */
const q = (v) => '`' + String(v ?? '').replace(/`/g, "'").replace(/\s+/g, ' ').trim() + '`';

function clip(value, max = 90) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function list(items, fmt = q) {
  const a = items.map(fmt);
  if (a.length <= 1) return a.join('');
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

const TAG_TYPES = { startEvent: 'StartEvent', endEvent: 'EndEvent', exclusiveGateway: 'ExclusiveGateway', parallelGateway: 'ParallelGateway' };
const typeOf = (raw) => raw.activityType || TAG_TYPES[raw.tag] || raw.tag;

/** "HTTP (receiver)" reads badly mid-sentence; the direction is already in the prose. */
const ad = (c) => String(c.adapter || '').replace(/\s*\((?:sender|receiver)\)$/i, '');

const truthy = (v) => String(v || '').toLowerCase() === 'true';
const base = (path) => String(path || '').split('/').pop();

/* ------------------------------------------------------------------ */
/* Per-step reads and writes                                           */
/* ------------------------------------------------------------------ */

const sameName = (kind, a, b) => (kind === 'header' ? a.toLowerCase() === b.toLowerCase() : a === b);

function scanExpressions(text) {
  const found = [];
  const s = String(text || '');
  for (const m of s.matchAll(EXPR_RE)) {
    found.push({ kind: /^header/.test(m[1]) ? 'header' : 'property', name: m[2] });
  }
  return { refs: found, body: BODY_RE.test(s) };
}

function channelProps(ch) {
  return Object.fromEntries((ch.allProps || []).map((p) => [p.key, p.value]));
}

function stepIO(step, ctx) {
  const io = {
    reads: [], writes: [], removes: [],
    readsBody: false,
    bodyEffect: 'keep',   // keep | replace | start
    bodyWhat: '',
    notes: [],
  };
  const raw = step.raw;
  const props = raw.props || {};
  const type = typeOf(raw);

  const add = (list_, kind, name, how = '') => {
    if (!name) return;
    if (!list_.some((x) => x.kind === kind && sameName(kind, x.name, name))) list_.push({ kind, name, how });
  };
  const noteScan = (text, where = '') => {
    const { refs, body } = scanExpressions(text);
    for (const r of refs) add(io.reads, r.kind, r.name, where);
    if (body) io.readsBody = true;
  };

  // --- generic expression scan: any property value may reference ${header.x} ---
  for (const [key, value] of Object.entries(props)) {
    if (SKIP_SCAN.has(key)) continue;
    noteScan(value);
  }
  for (const ch of step.channels) for (const p of ch.allProps) noteScan(p.value);
  for (const b of step.branches) noteScan(b.condition);
  if (step.body && /expression/i.test(step.body.type)) noteScan(step.body.content);

  // --- content modifier / write variables tables ---
  for (const table of step.tables) {
    const kind = /header/i.test(table.title) ? 'header' : /propert/i.test(table.title) ? 'property' : 'variable';
    for (const row of table.rows) {
      if (!row.name) continue;
      const src = String(row.type || row.dataType || '').toLowerCase();
      const value = row.value || row.default || '';
      if (/delete/i.test(row.action || '')) { add(io.removes, kind, row.name); continue; }

      let how = '';
      if (src === 'constant' || src === '') how = `constant ${q(clip(value, 60))}`;
      else if (src === 'expression') { how = `expression ${q(clip(value, 70))}`; noteScan(value, 'expression'); }
      else if (src === 'xpath') { how = `XPath ${q(clip(value, 60))} on the body`; io.readsBody = true; }
      else if (src === 'header') { how = `header ${q(value)}`; add(io.reads, 'header', value); }
      else if (src === 'property') { how = `property ${q(value)}`; add(io.reads, 'property', value); }
      else if (/variable/.test(src)) how = `${src} ${q(value)}`;
      else how = `${src} ${q(clip(value, 60))}`;
      add(io.writes, kind, row.name, how);
    }
  }

  // --- scripts ---
  if (type === 'Script' && step.scriptRef) {
    const a = ctx.doc.scriptAnalysis.get(base(step.scriptRef));
    if (a) {
      for (const n of a.headers.reads) add(io.reads, 'header', n, 'script');
      for (const n of a.properties.reads) add(io.reads, 'property', n, 'script');
      for (const n of a.headers.writes) add(io.writes, 'header', n, 'script');
      for (const n of a.properties.writes) add(io.writes, 'property', n, 'script');
      for (const n of a.headers.removes) add(io.removes, 'header', n);
      for (const n of a.properties.removes) add(io.removes, 'property', n);
      if (a.body.reads.length) io.readsBody = true;
      if (a.headers.dynamicRead || a.headers.dynamicWrite) io.notes.push('computes some header names at runtime');
      if (a.properties.dynamicRead || a.properties.dynamicWrite) io.notes.push('computes some property names at runtime');
    }
  }

  // --- what happens to the body ---
  const partner = receiverChannel(step);
  const set = (effect, what) => { io.bodyEffect = effect; io.bodyWhat = what; };

  switch (type) {
    case 'Timer': case 'TimerStartEvent':
      set('start', 'empty — a timer start carries no payload'); break;
    case 'StartEvent': case 'MessageStartEvent': {
      const sender = step.channels.find((c) => c.direction === 'Sender');
      set('start', sender
        ? `the message as received from ${sender.partner || ad(sender)} via ${ad(sender)}`
        : 'the message as it was received');
      break;
    }
    case 'ErrorStartEvent':
      set('start', 'the message as it was when the error occurred'); break;
    case 'ExternalCall':
      if (partner) set('replace', `the response from ${partner.partner || ad(partner)} (${ad(partner)})`);
      else set('replace', 'the response of an external call');
      io.readsBody = true;
      break;
    case 'ContentEnricher':
      set('replace', `the original message merged with the lookup response${partner ? ` from ${partner.partner || ad(partner)}` : ''}`);
      io.readsBody = true;
      break;
    case 'Mapping': case 'OperationMapping': {
      const m = findMapping(step, ctx);
      const target = m && m.targets.length ? ` (target ${list(m.targets.map((t) => t.name))})` : '';
      set('replace', `the output of mapping ${q(step.mappingRef ? base(step.mappingRef) : step.name)}${target}`);
      io.readsBody = true;
      break;
    }
    case 'XSLTMapping':
      set('replace', `the XSLT output of ${q(base(step.mappingRef || props.mappingpath || props.mappinguri || step.name))}`);
      io.readsBody = true;
      break;
    case 'Enricher':
      if (step.body) {
        set('replace', `the body defined in Content Modifier ${q(step.name)}`);
      }
      break;
    case 'Script': {
      const a = step.scriptRef && ctx.doc.scriptAnalysis.get(base(step.scriptRef));
      if (a && a.body.writes.length) {
        const empty = a.body.writes.every((w) => w.empty);
        set('replace', empty ? `an empty body set by script ${q(base(step.scriptRef))}` : `the body set by script ${q(base(step.scriptRef))}`);
      }
      break;
    }
    case 'GeneralSplitter': case 'IterativeSplitter': case 'Splitter': case 'EDISplitter': case 'ZipSplitter': case 'PKCS7Splitter':
      set('replace', props.xpath ? `one piece of the split (each ${q(props.xpath)} node)` : 'one piece of the split message');
      io.readsBody = true;
      break;
    case 'Gather': case 'Aggregator': case 'Join':
      set('replace', 'the combined result of the gathered messages'); break;
    case 'Filter':
      set('replace', `the part of the message matched by ${q(props.xpath || 'the filter')}`);
      io.readsBody = true;
      break;
    case 'DBstorage': {
      const op = String(props.operation || '').toLowerCase();
      if (op === 'get' || op === 'select') {
        set('replace', `the entry read from data store ${q(props.storeName || '')}`);
      }
      break;
    }
    case 'JsonToXmlConverter': case 'XmlToJsonConverter': case 'CsvToXmlConverter':
    case 'XmlToCsvConverter': case 'EDIToXmlConverter': case 'XmlToEdiConverter':
      set('replace', `the body converted from ${CONVERSIONS[type]}`);
      io.readsBody = true;
      break;
    case 'Encoder': case 'Decoder': case 'Encryptor': case 'Decryptor': case 'Signer': case 'XmlModifier':
      set('replace', `the ${step.typeLabel.toLowerCase()} output`);
      io.readsBody = true;
      break;
    case 'ProcessCallElement': {
      const called = ctx.processes.find((p) => p.id === props.processId);
      set('replace', `the result returned by local process ${q(called ? called.name : props.processId || '')}`);
      break;
    }
    default:
      break;
  }

  if (type === 'XmlValidator' || type === 'Persist') io.readsBody = true;
  return io;
}

function receiverChannel(step) {
  return step.channels.find((c) => c.direction === 'Receiver') || null;
}

function findMapping(step, ctx) {
  const ref = base(step.mappingRef || '');
  const name = String(step.raw.props.mappingname || '');
  const stem = (s) => base(s).replace(/\.[a-z]+$/i, '');
  return ctx.artifact.messageMappings.find((m) => (ref && base(m.path) === ref)
    || (ref && stem(m.path) === stem(ref))
    || (name && (m.name === name || stem(m.name) === name))) || null;
}

/* ------------------------------------------------------------------ */
/* Lineage: who sets a value, who reads it                             */
/* ------------------------------------------------------------------ */

function buildLineage(ctx) {
  const vars = new Map();
  const key = (kind, name) => `${kind}:${kind === 'header' ? name.toLowerCase() : name}`;
  const slot = (kind, name) => {
    const k = key(kind, name);
    if (!vars.has(k)) vars.set(k, { kind, name, setBy: [], readBy: [], removedBy: [] });
    return vars.get(k);
  };
  const ref = (s, extra = {}) => ({ id: s.id, label: s.label, name: s.name, seq: s.seq, ...extra });

  for (const step of ctx.steps) {
    for (const w of step.io.writes) slot(w.kind, w.name).setBy.push(ref(step, { how: w.how }));
    for (const r of step.io.reads) slot(r.kind, r.name).readBy.push(ref(step));
    for (const r of step.io.removes) slot(r.kind, r.name).removedBy.push(ref(step));
  }

  const out = [...vars.values()].map((v) => {
    let origin = 'flow';
    if (!v.setBy.length) origin = RUNTIME_NAME.test(v.name) ? 'runtime' : 'external';
    // Steps that read it before anything has set it (a script that reads a header
    // and then sets a default is the usual case): its first value came from outside.
    const externalReaders = origin === 'runtime' ? [] : v.readBy.filter((r) => !v.setBy.some((w) => w.seq < r.seq));
    return { ...v, origin, externalReaders };
  });

  const order = { header: 0, property: 1, variable: 2 };
  out.sort((a, b) => (order[a.kind] - order[b.kind]) || a.name.localeCompare(b.name));
  return out;
}

/** Tell each read where its value came from: the nearest earlier step that set it. */
function annotateOrigins(ctx, lineage) {
  const find = (kind, name) => lineage.find((v) => v.kind === kind && sameName(kind, v.name, name));
  for (const step of ctx.steps) {
    for (const r of step.io.reads) {
      const v = find(r.kind, r.name);
      if (!v) continue;
      const earlier = v.setBy.filter((s) => s.seq < step.seq && s.id !== step.id);
      const pick = earlier.length ? earlier[earlier.length - 1] : null;
      r.from = pick ? { label: pick.label, name: pick.name, id: pick.id } : null;
      r.origin = pick ? 'flow' : (v.setBy.some((s) => s.id !== step.id) ? 'later' : v.origin === 'runtime' ? 'runtime' : 'external');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Narrative: one sentence (or two) per step                           */
/* ------------------------------------------------------------------ */

function callKind(ch) {
  const d = channelProps(ch);
  const op = String(d.operation || '');
  const method = String(d.httpMethod || '');
  if (/create|insert|post|update|delete|merge|put|upsert/i.test(op) || /^(POST|PUT|PATCH|DELETE)$/i.test(method)) return 'write';
  if (/query|read|get/i.test(op) || /^GET$/i.test(method)) return 'read';
  return 'call';
}

function channelWhere(ch, ctx) {
  const d = channelProps(ch);
  const bits = [];
  const op = d.operation || d.httpMethod;
  if (op) bits.push(q(op));
  if (d.resourcePath) bits.push(`on ${q(d.resourcePath)}`);
  else if (d.queueName) bits.push(`queue ${q(d.queueName)}`);
  else if (d.path || d.fileName) bits.push(q([d.path, d.fileName].filter(Boolean).join('/')));
  else if (d.topic) bits.push(`topic ${q(d.topic)}`);
  if (d.queryOptions) bits.push(`with ${q(clip(ctx.resolve(d.queryOptions), 90))}`);
  return bits.join(' ');
}

function endpointOf(ch, ctx) {
  return ch.endpoint ? ctx.resolve(ch.endpoint) : '';
}

function narrate(step, ctx) {
  const raw = step.raw;
  const props = raw.props || {};
  const type = typeOf(raw);
  const ch = receiverChannel(step);
  const who = ch ? (ch.partner || ad(ch)) : '';
  const res = ctx.resolve;
  let text = '';
  let branches = [];

  switch (type) {
    case 'Timer': case 'TimerStartEvent':
    case 'StartEvent': case 'MessageStartEvent':
      text = triggerText(step, ctx);
      break;

    case 'ErrorStartEvent':
      text = 'Starts when a step in the main process raises an error.';
      break;

    case 'ExternalCall': {
      if (!ch) { text = 'Calls an external system and waits for the reply, which becomes the new message. No receiver channel is attached to this step in the export.'; break; }
      const where = channelWhere(ch, ctx);
      const at = endpointOf(ch, ctx);
      const kind = callKind(ch);
      const lead = kind === 'read' ? `Reads data from **${who}**` : kind === 'write' ? `Sends a request to **${who}**` : `Calls **${who}**`;
      text = `${lead} via ${ad(ch)}${where ? ` (${where})` : ''}${at ? ` at ${q(at)}` : ''}. `
        + `${kind === 'read' ? 'The response' : 'The reply'} replaces the message body.`;
      break;
    }

    case 'Send':
      text = ch
        ? `Sends the message to **${who}** via ${ad(ch)}${channelWhere(ch, ctx) ? ` (${channelWhere(ch, ctx)})` : ''}${endpointOf(ch, ctx) ? ` at ${q(endpointOf(ch, ctx))}` : ''}. The flow carries on with the message unchanged.`
        : 'Sends the message to a receiver. No receiver channel is attached to this step in the export.';
      break;

    case 'ContentEnricher':
      text = ch
        ? `Fetches additional data from **${who}** via ${ad(ch)} and merges it into the current message${props.aggregationAlgorithm ? ` (${props.aggregationAlgorithm})` : ''}.`
        : 'Fetches additional data from an external system and merges it into the current message.';
      break;

    case 'Enricher': {
      const parts = [];
      for (const w of step.io.writes) parts.push(`${w.kind === 'header' ? 'header' : w.kind === 'variable' ? 'variable' : 'property'} ${q(w.name)} = ${w.how}`);
      for (const r of step.io.removes) parts.push(`removes ${r.kind} ${q(r.name)}`);
      if (step.body) parts.push(`sets the message body (${step.body.type}) to ${q(clip(step.body.content, 100))}`);
      text = parts.length ? `Content Modifier — ${parts.join('; ')}.` : 'Content Modifier with nothing configured.';
      break;
    }

    case 'WriteVariables': {
      const parts = step.io.writes.map((w) => `${q(w.name)} = ${w.how}`);
      text = parts.length ? `Stores ${list(step.io.writes.map((w) => w.name))} as variables that outlive this message: ${parts.join('; ')}.` : 'Writes variables (none configured).';
      break;
    }

    case 'Mapping': case 'OperationMapping': {
      const m = findMapping(step, ctx);
      const ref = step.mappingRef ? q(base(step.mappingRef)) : q(step.name);
      if (!m) { text = `Transforms the message using mapping ${ref}. The mapping file is not part of this export.`; break; }
      const from = m.sources.length ? ` from ${list(m.sources.map((s) => s.name))}` : '';
      const to = m.targets.length ? ` to ${list(m.targets.map((s) => s.name))}` : '';
      const links = m.links.length ? ` It maps ${m.links.length} field${m.links.length === 1 ? '' : 's'}.` : '';
      text = `Transforms the message${from}${to} using mapping ${ref}.${links}`;
      break;
    }

    case 'XSLTMapping': {
      const file = base(step.mappingRef || props.mappingpath || props.mappinguri || '');
      const x = ctx.artifact.xsltMappings.find((s) => base(s.path) === file);
      text = `Transforms the message with XSLT stylesheet ${q(file || step.name)}${x && x.templates.length ? ` (${x.templates.length} template${x.templates.length === 1 ? '' : 's'})` : ''}.`;
      break;
    }

    case 'Script': {
      const file = base(step.scriptRef);
      const a = file && ctx.doc.scriptAnalysis.get(file);
      if (!file) { text = 'Runs a script (no script file is named on this step).'; break; }
      if (!a) { text = `Runs script ${q(file)}, but the file is missing from this export.`; break; }
      const fn = props.scriptFunction ? ` (entry point ${q(props.scriptFunction)}${a.entryFound === false ? ', **not defined in the file**' : ''})` : '';
      const language = (ctx.doc.scripts.find((x) => x.name === file) || {}).language || '';
      text = `Runs ${language ? `${language} ` : ''}script ${q(file)}${fn}. It ${scriptClauses(a).join('; ') || 'contains no header, property or body access that could be identified'}.`;
      if (a.purpose) text += ` The script describes itself as: “${a.purpose}”`;
      break;
    }

    case 'ExclusiveGateway': {
      branches = step.branches.map((b) => {
        const target = ctx.byId.get(b.to);
        return {
          name: b.name || (b.isDefault ? 'Default route' : ''),
          condition: b.condition,
          expressionType: b.expressionType,
          isDefault: b.isDefault,
          toLabel: target ? target.label : '',
          toName: target ? target.name : '',
          toId: target ? target.id : '',
        };
      });
      text = 'Chooses one path by evaluating the conditions in order; the first that matches wins, and the default route is taken when none do.';
      break;
    }
    case 'ParallelGateway':
      text = 'Continues down every outgoing path.'; break;

    case 'GeneralSplitter': case 'IterativeSplitter': case 'Splitter': {
      const parts = [`Splits the message into separate messages${props.xpath ? `, one per ${q(props.xpath)}` : ''}`];
      if (props.groupingValue && props.groupingValue !== '1') parts.push(`grouped ${props.groupingValue} at a time`);
      parts.push(truthy(props.parallelProcessing) ? 'processed in parallel' : 'processed one after another');
      if (props.stopOnException !== undefined && props.stopOnException !== '') parts.push(truthy(props.stopOnException) ? 'stopping at the first error' : 'continuing past errors');
      text = `${parts.join(', ')}. Every following step runs once per piece.`;
      break;
    }
    case 'Gather':
      text = `Gathers the split messages back into one${props.aggregationAlgorithm ? ` (${props.aggregationAlgorithm})` : ''}.`; break;
    case 'Aggregator':
      text = `Collects related messages${props.correlationExpression ? ` correlated by ${q(props.correlationExpression)}` : ''}${props.completionCondition ? ` until ${q(props.completionCondition)}` : ''} and emits them as one.`; break;

    case 'DBstorage': {
      const op = String(props.operation || 'Write');
      const store = q(props.storeName || '');
      const opts = [];
      if (props.visibility) opts.push(`${props.visibility} visibility`);
      if (isMeaningful(props.entryID)) opts.push(`entry ID ${q(props.entryID)}`);
      if (isMeaningful(props.retentionThreshold)) opts.push(`kept ${props.retentionThreshold} days`);
      if (truthy(props.overwriteExistingMessage)) opts.push('overwrites an existing entry with the same ID');
      if (truthy(props.encrypt)) opts.push('encrypted');
      const tail = opts.length ? ` (${opts.join(', ')})` : '';
      if (/^write$/i.test(op)) text = `Writes the current message to data store ${store}${tail}. The message itself is unchanged.`;
      else if (/^get$/i.test(op)) text = `Reads an entry from data store ${store}${tail}; the entry becomes the message body.`;
      else if (/^select$/i.test(op)) text = `Selects up to ${props.numberOfPolledMessages || 'several'} entries from data store ${store}${tail}.`;
      else if (/^delete$/i.test(op)) text = `Deletes an entry from data store ${store}${tail}.`;
      else text = `Data store operation ${q(op)} on ${store}${tail}.`;
      break;
    }

    case 'Persist':
      text = 'Persists the message at this point so it can be inspected in the message monitor.'; break;

    case 'XmlValidator':
      text = `Validates the XML body against ${q(base(props.xsdURI || 'a schema'))}. `
        + (truthy(props.preventException) ? 'A validation error is noted but does not stop the flow.' : 'An invalid message raises an error.');
      break;

    case 'JsonToXmlConverter': case 'XmlToJsonConverter': case 'CsvToXmlConverter':
    case 'XmlToCsvConverter': case 'EDIToXmlConverter': case 'XmlToEdiConverter':
      text = `Converts the message body from ${CONVERSIONS[type]}.`; break;

    case 'Filter':
      text = `Keeps only the part of the message matched by ${q(props.xpath || 'the filter expression')}.`; break;

    case 'Encryptor': case 'Decryptor': case 'Signer': case 'Verifier': case 'MessageDigest':
      text = `${step.typeLabel}${step.details.length ? ` (${step.details.slice(0, 3).map((d) => `${d.label}: ${clip(d.value, 40)}`).join(', ')})` : ''}.`;
      break;

    case 'ProcessCallElement': {
      const called = ctx.processes.find((p) => p.id === props.processId);
      text = `Hands the message to local integration process ${q(called ? called.name : props.processId || '')} and continues with what it returns.`;
      break;
    }

    case 'EndEvent': case 'MessageEndEvent': case 'TerminateEndEvent': case 'EscalationEndEvent':
      text = 'Ends the flow.'; break;
    case 'ErrorEndEvent':
      text = `Ends the flow in error${props.errorMessage ? `: “${props.errorMessage}”` : ''}.`; break;

    default:
      if (raw.tag === 'subProcess' && raw.triggeredByEvent) text = 'Exception handler: takes over when any step of the main process raises an error.';
      else if (raw.tag === 'subProcess') text = `Sub-process ${q(step.name)}.`;
      else text = step.note || `${step.typeLabel}.`;
  }

  return { text, branches };
}

function scriptClauses(a) {
  const out = [];
  const nouns = (n, one, many) => (n === 1 ? one : many);
  const hr = a.headers.reads, pr = a.properties.reads;
  if (hr.length) out.push(`reads ${nouns(hr.length, 'header', 'headers')} ${list(hr)}`);
  if (pr.length) out.push(`reads ${nouns(pr.length, 'property', 'properties')} ${list(pr)}`);
  if (a.body.reads.length) out.push(`reads the message body${a.body.reads[0] ? ` as ${q(a.body.reads[0])}` : ''}`);
  if (a.parses.length) out.push(`parses ${a.parses.join(' and ')}`);
  const hw = a.headers.writes, pw = a.properties.writes;
  if (hw.length) out.push(`sets ${nouns(hw.length, 'header', 'headers')} ${list(hw)}`);
  if (pw.length) out.push(`sets ${nouns(pw.length, 'property', 'properties')} ${list(pw)}`);
  if (a.headers.removes.length) out.push(`removes ${nouns(a.headers.removes.length, 'header', 'headers')} ${list(a.headers.removes)}`);
  if (a.properties.removes.length) out.push(`removes ${nouns(a.properties.removes.length, 'property', 'properties')} ${list(a.properties.removes)}`);
  if (a.body.writes.length) {
    out.push(a.body.writes.every((w) => w.empty) ? 'clears the message body' : `replaces the message body${a.builds.length ? ` with generated ${a.builds.join(' and ')}` : ''}`);
  }
  if (a.messageLog.used) {
    const bits = [];
    if (a.messageLog.properties.length) bits.push(`custom ${nouns(a.messageLog.properties.length, 'property', 'properties')} ${list(a.messageLog.properties)}`);
    if (a.messageLog.attachments.length) bits.push(`${nouns(a.messageLog.attachments.length, 'attachment', 'attachments')} ${list(a.messageLog.attachments)}`);
    out.push(`writes to the message log${bits.length ? ` (${bits.join(', ')})` : ''}`);
  }
  if (a.valueMappings.length) out.push(`looks up value mapping ${list(a.valueMappings.map((v) => `${v.agency}/${v.scheme}`))}`);
  if (a.credentials.length) out.push(`reads secure-store credential ${list(a.credentials)}`);
  for (const e of a.external) out.push(e);
  if (a.raises.length) out.push(`raises ${list([...new Set(a.raises.map((r) => r.type))])}${a.raises[0].message ? ` (“${clip(a.raises[0].message, 60)}”)` : ''} when it hits a problem`);
  if (a.headers.dynamicRead || a.headers.dynamicWrite || a.properties.dynamicRead || a.properties.dynamicWrite) {
    out.push('also uses header or property names computed at runtime, which cannot be listed');
  }
  return out;
}

export function scriptSummary(analysis) {
  return scriptClauses(analysis);
}

/* ------------------------------------------------------------------ */
/* Trigger                                                             */
/* ------------------------------------------------------------------ */

function triggerOf(step, ctx) {
  const type = step.raw.activityType || step.raw.tag;
  const senders = step.channels.filter((c) => c.direction === 'Sender');
  const isTimer = type === 'Timer' || type === 'TimerStartEvent' || step.raw.eventDefinitions.includes('timer');
  return { isTimer, senders };
}

/** The timer half of a trigger, or '' when the start event is not a timer. */
function timerPhrase(step, ctx) {
  if (!triggerOf(step, ctx).isTimer) return '';
  const key = String(step.raw.props.scheduleKey || '');
  const resolved = ctx.resolve(key);
  if (!isMeaningful(key)) return 'Runs on a timer, but no schedule is configured in this export';
  if (/\{\{[^}]+\}\}/.test(resolved)) return `Runs on a timer whose schedule comes from parameter ${q(key.replace(/[{}]/g, ''))}, which has no value in this export`;
  if (resolved.trim().startsWith('<')) return 'Runs on a schedule (configured in the timer start event)';
  return `Runs on a schedule (${q(clip(resolved, 60))})`;
}

function triggerText(step, ctx) {
  const { senders } = triggerOf(step, ctx);
  const timer = timerPhrase(step, ctx);
  const via = (s) => `**${s.partner || ad(s)}** ${timer ? 'via' : 'sends a message via'} ${ad(s)}${s.endpoint ? ` at ${q(ctx.resolve(s.endpoint))}` : ''}`;
  const parts = [];
  if (timer) parts.push(timer);
  senders.forEach((s, i) => {
    if (timer) parts.push(`${i === 0 ? 'can also be triggered by' : 'or by'} ${via(s)}`);
    else parts.push(`${i === 0 ? 'Starts when' : 'or when'} ${via(s)}`);
  });
  if (!parts.length) return 'Starts the flow when a message arrives.';
  return `${parts.join('; ')}.`;
}

/* ------------------------------------------------------------------ */
/* Body origin: where does the message body come from at each point?   */
/* ------------------------------------------------------------------ */

function bodyOriginAfter(step, ctx, seen = new Set()) {
  if (ctx.originMemo.has(step.id)) return ctx.originMemo.get(step.id);
  if (seen.has(step.id)) return { step: null, what: 'a message that loops back on itself' };
  seen.add(step.id);

  let result;
  const eff = step.io.bodyEffect;
  if (eff === 'replace' || eff === 'start') {
    result = { step, what: step.io.bodyWhat };
  } else {
    const inc = step.raw.incoming && step.raw.incoming[0];
    const prev = inc ? ctx.byId.get(inc.sourceRef) : null;
    result = prev ? bodyOriginAfter(prev, ctx, seen) : { step: null, what: 'the message as it was received' };
  }
  ctx.originMemo.set(step.id, result);
  return result;
}

/* ------------------------------------------------------------------ */
/* The summary itself                                                  */
/* ------------------------------------------------------------------ */

function buildSummary(doc, ctx) {
  const mainProc = ctx.processes.find((p) => p.isMain) || ctx.processes[0];
  const isError = (s) => /^E/.test(s.label);

  const entry = (s) => ({
    id: s.id,
    label: s.label,
    name: s.name,
    typeLabel: s.typeLabel,
    category: s.category,
    text: s.narrative.text,
    branches: s.narrative.branches,
    reads: s.io.reads,
    writes: s.io.writes,
    removes: s.io.removes,
    readsBody: s.io.readsBody,
    replacesBody: s.io.bodyEffect === 'replace',
    notes: s.io.notes,
    unreachable: s.unreachable,
  });

  const flows = ctx.processes
    .filter((p) => !p.isErrorHandler)
    .map((p) => ({
      id: p.id,
      name: p.name,
      isMain: p === mainProc,
      steps: p.steps.filter((s) => s.tag !== 'sequenceFlow' && !isError(s)).map(entry),
      errorSteps: p.steps.filter((s) => s.tag !== 'sequenceFlow' && isError(s)).map(entry),
    }));

  const errorProcs = ctx.processes.filter((p) => p.isErrorHandler)
    .map((p) => ({ id: p.id, name: p.name, steps: p.steps.filter((s) => s.tag !== 'sequenceFlow').map(entry) }));

  const mainSteps = mainProc ? mainProc.steps.filter((s) => !isError(s)) : [];
  const start = mainSteps.find((s) => s.tag === 'startEvent' && !s.raw.parentId);
  const trigger = start ? triggerOf(start, ctx) : { isTimer: false, senders: [] };

  const inputs = buildInputs(doc, ctx, start, trigger);
  const outputs = buildOutputs(doc, ctx);
  const results = buildResults(doc, ctx, mainSteps, trigger);

  const exceptionSub = ctx.steps.find((s) => s.raw.tag === 'subProcess' && s.raw.triggeredByEvent);
  const returnsError = truthy((doc.artifact.iflw.collaborationProps || {}).returnExceptionToSender);
  let errorText;
  if (exceptionSub) {
    errorText = `When a step fails, processing switches to the exception subprocess ${q(exceptionSub.name)}.`;
  } else if (errorProcs.length) {
    errorText = `When a step fails, processing switches to ${q(errorProcs[0].name)}.`;
  } else {
    errorText = 'There is no exception subprocess, so a failure ends the message in status Failed with no compensating action.';
  }
  if (returnsError) errorText += ' The error message is returned to the caller.';

  return {
    headline: buildHeadline(doc, ctx, trigger, mainSteps),
    trigger: start ? start.narrative.text : '',
    inputs,
    outputs,
    results,
    flows,
    errorProcs,
    errorText,
    hasErrorPath: Boolean(exceptionSub || errorProcs.length),
  };
}

function buildHeadline(doc, ctx, trigger, mainSteps) {
  const parts = [];
  const desc = doc.artifact.iflw.properties.description || doc.description;

  // trigger
  const callers = list(trigger.senders.map((s) => s.partner || ad(s)), (v) => `**${v}**`);
  let how;
  if (trigger.isTimer) how = trigger.senders.length ? `a timer (or a call from ${callers})` : 'a timer';
  else if (trigger.senders.length) how = `a message from ${callers}`;
  else how = 'an incoming message';

  // sources: request/reply channels that read
  const calls = mainSteps.filter((s) => ['ExternalCall', 'ContentEnricher'].includes(s.raw.activityType) && receiverChannel(s));
  const readers = unique(calls.filter((s) => callKind(receiverChannel(s)) === 'read').map((s) => receiverChannel(s).partner || ad(receiverChannel(s))));
  const sentence = [`Started by ${how}`];
  if (readers.length) sentence.push(`reads data from ${list(readers, (v) => `**${v}**`)}`);

  // processing
  const count = (t) => mainSteps.filter((s) => (s.raw.activityType || s.tag) === t).length;
  const proc = [];
  const scripts = mainSteps.filter((s) => s.raw.activityType === 'Script').length;
  if (count('Mapping') + count('OperationMapping')) proc.push(`${count('Mapping') + count('OperationMapping')} message mapping${count('Mapping') + count('OperationMapping') === 1 ? '' : 's'}`);
  if (count('XSLTMapping')) proc.push(`${count('XSLTMapping')} XSLT mapping${count('XSLTMapping') === 1 ? '' : 's'}`);
  if (scripts) proc.push(`${scripts} script${scripts === 1 ? '' : 's'}`);
  if (count('Enricher')) proc.push(`${count('Enricher')} content modifier${count('Enricher') === 1 ? '' : 's'}`);
  if (proc.length) sentence.push(`processes it with ${list(proc, (v) => v)}`);
  if (mainSteps.some((s) => /Splitter$/.test(s.raw.activityType || ''))) sentence.push('handles it record by record');
  if (mainSteps.some((s) => s.raw.tag === 'exclusiveGateway')) sentence.push('routes it on conditions');

  // deliveries
  const sends = ctx.steps.filter((s) => ['Send', 'ExternalCall'].includes(s.raw.activityType) && receiverChannel(s) && (s.raw.activityType === 'Send' || callKind(receiverChannel(s)) !== 'read'));
  const targets = unique(sends.map((s) => { const c = receiverChannel(s); return `${c.partner || ad(c)} (${ad(c)})`; }));
  if (targets.length) sentence.push(`delivers it to ${list(targets, (v) => `**${v}**`)}`);

  const stores = unique(ctx.steps.filter((s) => s.raw.activityType === 'DBstorage' && /^write$/i.test(s.raw.props.operation || 'Write')).map((s) => s.raw.props.storeName).filter(Boolean));
  if (stores.length) sentence.push(`keeps a copy in data store ${list(stores)}`);

  let text = '';
  if (isMeaningful(desc)) text += `${String(desc).trim().replace(/\.?$/, '.')} `;
  text += `${joinClauses(sentence)}.`;
  return text;
}

function unique(a) { return [...new Set(a.filter(Boolean))]; }

/** "A, B, and C" — clauses can contain commas of their own, so join by clause, not by string. */
function joinClauses(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/* ---------------- inputs / outputs ---------------- */

function buildInputs(doc, ctx, start, trigger) {
  const items = [];
  const at = (s) => (s ? { label: s.label, name: s.name, id: s.id } : null);

  if (trigger.isTimer) items.push({ text: timerPhrase(start, ctx), at: at(start) });
  for (const s of trigger.senders) {
    items.push({
      text: `A message from **${s.partner || ad(s)}** via ${ad(s)}${s.endpoint ? ` at ${q(ctx.resolve(s.endpoint))}` : ''}`,
      at: at(start),
    });
  }

  for (const s of ctx.steps) {
    const type = s.raw.activityType;
    const ch = receiverChannel(s);
    if ((type === 'ExternalCall' || type === 'ContentEnricher') && ch) {
      const where = channelWhere(ch, ctx);
      items.push({
        text: `${type === 'ContentEnricher' ? 'Lookup data' : 'Response'} from **${ch.partner || ad(ch)}** via ${ad(ch)}${where ? ` (${where})` : ''}`,
        at: at(s),
      });
    }
    if (type === 'DBstorage' && /^(get|select)$/i.test(s.raw.props.operation || '')) {
      items.push({ text: `Entries from data store ${q(s.raw.props.storeName || '')}`, at: at(s) });
    }
    if (type === 'Script' && s.scriptRef) {
      const a = ctx.doc.scriptAnalysis.get(base(s.scriptRef));
      if (a) for (const e of a.external) if (/HTTP/.test(e)) items.push({ text: `Data fetched by script ${q(base(s.scriptRef))} (${e})`, at: at(s) });
    }
  }

  // Values the flow relies on but never sets itself: they must come from the caller.
  for (const v of doc.dataFlow) {
    if (!v.externalReaders.length) continue;
    const readers = list(v.externalReaders.map((r) => `${r.label} ${r.name}`), (x) => x);
    const label = v.kind === 'header' ? 'Header' : v.kind === 'property' ? 'Exchange property' : 'Variable';
    items.push({
      text: v.setBy.length
        ? `${label} ${q(v.name)} — read by ${readers} before any step has set it, so its starting value has to come from the caller`
        : `${label} ${q(v.name)} — read by ${readers} but never set in this flow, so it has to come from the caller`,
      at: null,
    });
  }

  const paramCount = doc.parameters.length;
  if (paramCount) items.push({ text: `${paramCount} externalised parameter${paramCount === 1 ? '' : 's'} (configured per environment)`, at: null });
  return items;
}

function buildOutputs(doc, ctx) {
  const items = [];
  const at = (s) => ({ label: s.label, name: s.name, id: s.id });

  for (const s of ctx.steps) {
    const type = s.raw.activityType;
    const ch = receiverChannel(s);
    const step = at(s);

    if ((type === 'ExternalCall' || type === 'Send') && ch) {
      if (type === 'ExternalCall' && callKind(ch) === 'read') continue;
      const where = channelWhere(ch, ctx);
      const isPD = ch.componentType === 'ProcessDirect';
      items.push({
        text: `${isPD ? 'Hand-off to another integration flow' : type === 'ExternalCall' ? 'Request' : 'Message'} to **${ch.partner || ad(ch)}** via ${ad(ch)}${where ? ` (${where})` : ''}${endpointOf(ch, ctx) ? ` at ${q(endpointOf(ch, ctx))}` : ''}`,
        at: step,
      });
    }
    if (type === 'DBstorage' && /^(write|delete)$/i.test(s.raw.props.operation || 'Write')) {
      const op = /^delete$/i.test(s.raw.props.operation) ? 'Deletion from' : 'Write to';
      items.push({ text: `${op} data store ${q(s.raw.props.storeName || '')}${isMeaningful(s.raw.props.entryID) ? ` (entry ID ${q(s.raw.props.entryID)})` : ''}`, at: step });
    }
    if (type === 'WriteVariables' && s.io.writes.length) {
      items.push({ text: `Variables ${list(s.io.writes.map((w) => w.name))} (kept beyond this message)`, at: step });
    }
    if (type === 'Script' && s.scriptRef) {
      const a = ctx.doc.scriptAnalysis.get(base(s.scriptRef));
      if (a && a.messageLog.used && (a.messageLog.properties.length || a.messageLog.attachments.length)) {
        const bits = [];
        if (a.messageLog.properties.length) bits.push(`properties ${list(a.messageLog.properties)}`);
        if (a.messageLog.attachments.length) bits.push(`attachments ${list(a.messageLog.attachments)}`);
        items.push({ text: `Message processing log entries written by script ${q(base(s.scriptRef))}: ${bits.join(', ')}`, at: step });
      }
      if (a) for (const e of a.external) if (/HTTP/.test(e)) items.push({ text: `Outgoing HTTP call made by script ${q(base(s.scriptRef))}`, at: step });
    }
    if (type === 'ErrorEndEvent') {
      items.push({ text: `An error${s.raw.props.errorMessage ? ` “${s.raw.props.errorMessage}”` : ''} that ends the message as Failed`, at: step });
    }
  }
  return items;
}

function buildResults(doc, ctx, mainSteps, trigger) {
  const ends = mainSteps.filter((s) => s.raw.tag === 'endEvent' && s.raw.activityType !== 'ErrorEndEvent');
  const sync = trigger.senders.some((c) => SYNC_ADAPTERS.has(ad(c)) || SYNC_ADAPTERS.has(c.componentType));

  return ends.map((end) => {
    const origin = bodyOriginAfter(end, ctx);
    const from = origin.step && origin.step.raw.tag !== 'startEvent'
      ? `; it was last changed at ${origin.step.label} ${q(origin.step.name)}` : '';
    let text = `The message body at this point is ${origin.what}${from}.`;

    if (trigger.isTimer && !sync) text += ' The flow is timer-started, so nothing is returned to a caller; its result is the effects listed under “Data out”.';
    else if (trigger.isTimer) text += ' When the timer starts the flow nothing is returned; when a caller starts it and waits for a reply, this is what it receives.';
    else if (sync) text += ' If the caller waits for a reply, this is what it receives.';

    // What ran along the way that left something behind.
    return { id: end.id, label: end.label, name: end.name, text, origin: origin.step ? { label: origin.step.label, name: origin.step.name, id: origin.step.id } : null };
  });
}

/* ------------------------------------------------------------------ */
/* Dependencies contributed by scripts                                 */
/* ------------------------------------------------------------------ */

function addScriptCredentials(doc) {
  for (const script of doc.scripts) {
    const a = doc.scriptAnalysis.get(script.name);
    if (!a) continue;
    for (const alias of a.credentials) {
      if (!doc.dependencies.credentials.some((c) => c.alias === alias)) {
        doc.dependencies.credentials.push({ alias, kind: 'Secure store credential (read by script)', usedBy: script.name, direction: '' });
      }
    }
  }
}
