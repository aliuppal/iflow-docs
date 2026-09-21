/**
 * Builds the documentation model from a parsed artefact.
 *
 * The parser knows about BPMN; this module knows about *documents* — what an
 * integration developer or an auditor needs to read: the processing steps in
 * execution order, the channels, what is externalised, what the flow depends on
 * outside its own archive, and what happens when it fails.
 */

import {
  describeStep, describeAdapter, humanise, labelFor, parseCellTable, isMeaningful, typeLabel,
  SECRET_KEYS, CATEGORIES,
} from './catalog.js';
import { analyzeFlow } from './flow.js';

const PARAM_RE = /\{\{([^}{]+)\}\}/g;

export function buildDoc(artifact) {
  const doc = {
    artifact,
    name: artifact.name,
    id: artifact.id,
    version: artifact.version,
    description: artifact.description,
    type: artifact.type,
    overview: {},
    senders: [],
    receivers: [],
    channels: [],
    processes: [],
    parameters: [],
    dependencies: { processDirect: [], queues: [], dataStores: [], valueMappings: [], endpoints: [], credentials: [], globalVariables: [] },
    errorHandling: [],
    scripts: artifact.scripts || [],
    stats: {},
    findings: [],
  };

  const model = artifact.iflw;
  if (!model) {
    doc.overview = { Name: artifact.name, Version: artifact.version, Type: typeLabel(artifact.type) };
    analyzeFlow(doc);
    return doc;
  }

  const participantsById = new Map(model.participants.map((p) => [p.id, p]));
  doc.senders = model.participants.filter((p) => p.type === 'sender');
  doc.receivers = model.participants.filter((p) => p.type === 'receiver');

  doc.channels = model.messageFlows.map((flow) => buildChannel(flow, participantsById, model));
  doc.processes = model.processes.map((proc) => buildProcess(proc, model, doc.channels));

  // Exception subprocesses are documented separately from the happy path.
  for (const proc of doc.processes) {
    for (const step of proc.steps) {
      if (step.raw.isExceptionSubprocess) doc.errorHandling.push({ process: proc, step });
    }
  }
  const errorProcesses = doc.processes.filter((p) => p.isErrorHandler);
  for (const p of errorProcesses) doc.errorHandling.push({ process: p, step: null });

  doc.parameters = buildParameters(artifact, model);
  doc.dependencies = buildDependencies(doc, artifact, model);
  analyzeFlow(doc);
  doc.overview = buildOverview(doc, artifact, model);
  doc.stats = buildStats(doc, artifact);
  doc.findings = buildFindings(doc, artifact);
  return doc;
}

/* ------------------------------------------------------------------ */
/* Channels                                                            */
/* ------------------------------------------------------------------ */

function buildChannel(flow, participantsById, model) {
  const source = participantsById.get(flow.sourceRef);
  const target = participantsById.get(flow.targetRef);
  const componentType = flow.componentType || flow.props.ComponentType || '';
  const meta = describeAdapter(componentType);

  let direction = flow.direction;
  if (!direction) direction = source && source.type === 'sender' ? 'Sender' : 'Receiver';

  const partner = direction === 'Sender' ? source : target;
  const attachedTo = direction === 'Sender' ? flow.targetRef : flow.sourceRef;

  return {
    id: flow.id,
    name: flow.name || meta.label,
    direction,
    adapter: meta.label,
    componentType,
    transportProtocol: flow.transportProtocol,
    messageProtocol: flow.messageProtocol,
    partner: partner ? partner.name || partner.id : '',
    partnerType: partner ? partner.type : '',
    attachedTo,
    attachedStepName: findElementName(model, attachedTo),
    details: pickDetails(flow.props, meta.keys),
    allProps: sortedProps(flow.props),
    endpoint: firstMeaningful(flow.props, ['address', 'httpAddressWithoutQuery', 'urlPath', 'host', 'queueName', 'destinationName', 'path']),
  };
}

function findElementName(model, id) {
  for (const proc of model.processes) {
    const hit = proc.elements.find((e) => e.id === id);
    if (hit) return hit.name || hit.id;
  }
  const participant = model.participants.find((p) => p.id === id);
  return participant ? participant.name : '';
}

/* ------------------------------------------------------------------ */
/* Processes and step ordering                                         */
/* ------------------------------------------------------------------ */

function buildProcess(proc, model, channels) {
  const byId = new Map(proc.elements.map((e) => [e.id, e]));
  const steps = proc.elements.map((el) => buildStep(el, proc, channels));
  const stepsById = new Map(steps.map((s) => [s.id, s]));

  const tree = orderSteps(proc, byId, stepsById);
  const ordered = flattenTree(tree);
  ordered.forEach((node, i) => {
    node.step.order = i + 1;
    node.step.label = node.label;
  });

  // Anything unreachable from a start event still belongs in the document.
  const unreached = steps.filter((s) => !s.label && s.raw.tag !== 'sequenceFlow');
  unreached.forEach((s, i) => {
    s.order = ordered.length + i + 1;
    s.label = `•`;
    s.unreachable = true;
  });

  const isErrorHandler = !proc.isMain && steps.some((s) => s.raw.tag === 'startEvent' && /error/i.test(s.raw.activityType || ''));

  return {
    id: proc.id,
    name: proc.name || (proc.isMain ? 'Integration Process' : 'Local Integration Process'),
    isMain: proc.isMain,
    isErrorHandler,
    transactionHandling: proc.transactionHandling || '',
    props: sortedProps(proc.props),
    steps: [...ordered.map((n) => n.step), ...unreached],
    tree,
    sequenceFlows: proc.sequenceFlows,
  };
}

function buildStep(el, proc, channels) {
  const meta = describeStep(el);
  const category = CATEGORIES[meta.category] ? meta.category : 'other';
  const step = {
    id: el.id,
    name: el.name || meta.label,
    typeLabel: meta.label,
    activityType: el.activityType || el.tag,
    category,
    categoryLabel: CATEGORIES[category].label,
    note: meta.note || '',
    tag: el.tag,
    raw: el,
    order: 0,
    label: '',
    unreachable: false,
    details: pickDetails(el.props, meta.keys),
    allProps: sortedProps(el.props),
    tables: [],
    script: null,
    channels: channels.filter((c) => c.attachedTo === el.id),
    branches: [],
  };

  enrichStep(step, el);
  return step;
}

/** Type-specific extras: the tables and code that make a step readable. */
function enrichStep(step, el) {
  const props = el.props || {};

  if (el.activityType === 'Enricher') {
    const headers = parseCellTable(props.headerTable);
    const properties = parseCellTable(props.propertyTable);
    if (properties.length) step.tables.push({ title: 'Exchange properties set', rows: normaliseCellRows(properties) });
    if (headers.length) step.tables.push({ title: 'Message headers set', rows: normaliseCellRows(headers) });
    if (isMeaningful(props.bodyContent)) {
      step.body = { type: props.bodyType || 'constant', content: props.bodyContent };
    }
  }

  if (el.activityType === 'WriteVariables') {
    const rows = parseCellTable(props.variableTable);
    if (rows.length) step.tables.push({ title: 'Variables written', rows: normaliseCellRows(rows) });
  }

  if (el.activityType === 'Script') {
    step.scriptRef = props.script || props.scriptFile || '';
    step.scriptFunction = props.scriptFunction || '';
  }

  if (el.activityType === 'Mapping' || el.activityType === 'XSLTMapping') {
    step.mappingRef = firstMeaningful(props, ['mappingpath', 'mappinguri', 'mappingname', 'mappingReference']);
  }

  // Router conditions live on the outgoing sequence flows.
  if (el.outgoing && el.outgoing.length > 1) {
    step.branches = el.outgoing.map((flow) => ({
      to: flow.targetRef,
      name: flow.name || '',
      condition: flow.condition || '',
      expressionType: flow.expressionType || '',
      isDefault: flow.isDefault,
    }));
  }
}

function normaliseCellRows(rows) {
  return rows.map((row) => ({
    action: row.Action || row.action || '',
    name: row.Name || row.name || row.Header || '',
    type: row.Type || row.type || '',
    value: row.Value || row.value || '',
    dataType: row.Datatype || row.datatype || '',
    default: row.Default || row.default || '',
  }));
}

/**
 * Depth-first walk from the start events, producing a tree so that router
 * branches can be numbered 3a / 3b rather than flattened into a misleading
 * straight line.
 *
 * Exception subprocesses are walked separately and numbered E.1, E.2, … — they
 * are not step 5 of the happy path, and numbering them as if they were is the
 * single most misleading thing a generated document can do.
 */
function orderSteps(proc, byId, stepsById) {
  const seen = new Set();
  const nodeById = new Map();
  const tree = [];
  let counter = 0;

  const makeNode = (el, label, edge) => {
    const node = { step: stepsById.get(el.id), label, edge, children: [] };
    nodeById.set(el.id, node);
    return node;
  };

  /** Main chain: each hop takes the next whole number. */
  const visit = (el, edge) => {
    if (!el || seen.has(el.id)) return null;
    seen.add(el.id);
    const node = makeNode(el, String(++counter), edge);
    const outgoing = el.outgoing || [];

    if (outgoing.length <= 1) {
      const next = outgoing[0] ? byId.get(outgoing[0].targetRef) : null;
      const child = next ? visit(next, outgoing[0]) : null;
      if (child) node.children.push(child);
      return node;
    }

    outgoing.forEach((flow, i) => {
      const next = byId.get(flow.targetRef);
      if (!next || seen.has(next.id)) return;
      const child = visitChain(next, `${node.label}${String.fromCharCode(97 + i)}`, flow);
      if (child) node.children.push(child);
    });
    return node;
  };

  /** Branch or subprocess chain: prefix.1, prefix.2, … */
  const visitChain = (el, prefix, edge) => {
    if (!el || seen.has(el.id)) return null;
    seen.add(el.id);
    let index = 1;
    const node = makeNode(el, `${prefix}.${index}`, edge);
    let current = el;
    let parent = node;

    for (;;) {
      const outgoing = current.outgoing || [];
      if (outgoing.length !== 1) {
        outgoing.forEach((flow, i) => {
          const next = byId.get(flow.targetRef);
          if (!next || seen.has(next.id)) return;
          const child = visitChain(next, `${prefix}.${index}${String.fromCharCode(97 + i)}`, flow);
          if (child) parent.children.push(child);
        });
        break;
      }
      const next = byId.get(outgoing[0].targetRef);
      if (!next || seen.has(next.id)) break;
      seen.add(next.id);
      index += 1;
      const child = makeNode(next, `${prefix}.${index}`, outgoing[0]);
      parent.children.push(child);
      parent = child;
      current = next;
    }
    return node;
  };

  /** Walk the interior of a subprocess, hanging it off the subprocess node. */
  const fillSubProcess = (sub, node) => {
    const inner = proc.elements.filter((e) => e.parentId === sub.id && !seen.has(e.id));
    const entry = inner.find((e) => e.tag === 'startEvent') || inner.find((e) => e.incoming.length === 0) || inner[0];
    if (!entry) return;
    const child = visitChain(entry, node.label, null);
    if (child) node.children.push(child);
  };

  const isExceptionSub = (e) => e.tag === 'subProcess' && e.triggeredByEvent;

  const roots = proc.elements.filter(
    (e) =>
      !e.parentId &&
      !isExceptionSub(e) &&
      (e.tag === 'startEvent' || (e.incoming.length === 0 && e.tag !== 'boundaryEvent'))
  );
  for (const root of roots) {
    const node = visit(root, null);
    if (node) tree.push(node);
  }

  const exceptionSubs = proc.elements.filter(isExceptionSub);
  exceptionSubs.forEach((sub, i) => {
    const prefix = exceptionSubs.length > 1 ? `E${i + 1}` : 'E';
    seen.add(sub.id);
    const node = makeNode(sub, prefix, null);
    tree.push(node);
    fillSubProcess(sub, node);
  });

  // Ordinary subprocesses were reached on the main chain; fill in their bodies.
  for (const sub of proc.elements.filter((e) => e.tag === 'subProcess' && !e.triggeredByEvent)) {
    const node = nodeById.get(sub.id);
    if (node) fillSubProcess(sub, node);
  }

  return tree;
}

function flattenTree(tree) {
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.step) out.push(node);
      walk(node.children);
    }
  };
  walk(tree);
  return out;
}

/* ------------------------------------------------------------------ */
/* Externalised parameters                                             */
/* ------------------------------------------------------------------ */

function buildParameters(artifact, model) {
  const usage = new Map();

  const record = (name, where) => {
    if (!usage.has(name)) usage.set(name, new Set());
    usage.get(name).add(where);
  };

  const scanProps = (props, where) => {
    for (const [key, value] of Object.entries(props || {})) {
      for (const match of String(value).matchAll(PARAM_RE)) {
        record(match[1].trim(), `${where} → ${labelFor(key)}`);
      }
    }
  };

  for (const flow of model.messageFlows) scanProps(flow.props, flow.name || flow.componentType || 'Channel');
  for (const proc of model.processes) {
    for (const el of proc.elements) scanProps(el.props, el.name || el.id);
    for (const flow of proc.sequenceFlows) scanProps(flow.props, `Route ${flow.name || flow.id}`);
  }
  for (const participant of model.participants) scanProps(participant.props, participant.name || participant.id);

  const defs = new Map((artifact.parameters.definitions || []).map((d) => [d.name, d]));
  const names = new Set([...usage.keys(), ...artifact.parameters.values.keys(), ...defs.keys()]);

  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => {
    const def = defs.get(name) || {};
    const value = artifact.parameters.values.has(name) ? artifact.parameters.values.get(name) : def.defaultValue || '';
    const used = usage.get(name);
    return {
      name,
      value,
      dataType: def.dataType || '',
      description: def.description || '',
      usedIn: used ? [...used].sort() : [],
      unused: !used,
      empty: !isMeaningful(value),
      secret: /password|secret|token|apikey|api_key|credential/i.test(name),
    };
  });
}

/* ------------------------------------------------------------------ */
/* External dependencies                                               */
/* ------------------------------------------------------------------ */

function buildDependencies(doc, artifact, model) {
  const deps = {
    processDirect: [], queues: [], dataStores: [], valueMappings: [],
    endpoints: [], credentials: [], globalVariables: [],
  };
  const push = (list, item, key) => {
    if (!item[key]) return;
    if (list.some((x) => x[key] === item[key] && x.direction === item.direction)) return;
    list.push(item);
  };

  for (const channel of doc.channels) {
    const props = channel.allProps.reduce((acc, p) => ((acc[p.key] = p.value), acc), {});
    if (channel.componentType === 'ProcessDirect') {
      push(deps.processDirect, {
        address: props.address || '',
        direction: channel.direction,
        channel: channel.name,
      }, 'address');
    }
    if (channel.componentType === 'JMS' || channel.componentType === 'AMQP') {
      push(deps.queues, {
        name: props.queueName || props.destinationName || '',
        direction: channel.direction,
        channel: channel.name,
        adapter: channel.adapter,
      }, 'name');
    }
    if (channel.endpoint && channel.componentType !== 'ProcessDirect') {
      push(deps.endpoints, {
        address: channel.endpoint,
        direction: channel.direction,
        adapter: channel.adapter,
        channel: channel.name,
        partner: channel.partner,
      }, 'address');
    }
    for (const key of SECRET_KEYS) {
      if (isMeaningful(props[key])) {
        push(deps.credentials, { alias: props[key], kind: labelFor(key), usedBy: channel.name, direction: channel.direction }, 'alias');
      }
    }
  }

  for (const proc of model.processes) {
    for (const el of proc.elements) {
      const props = el.props || {};
      if (isMeaningful(props.storeName)) {
        push(deps.dataStores, {
          name: props.storeName,
          operation: props.operation || '',
          visibility: props.visibility || '',
          direction: props.operation || '',
          usedBy: el.name || el.id,
        }, 'name');
      }
      if (isMeaningful(props.variableTable) || el.activityType === 'WriteVariables') {
        for (const row of parseCellTable(props.variableTable)) {
          const name = row.Name || row.name;
          if (name) push(deps.globalVariables, { name, scope: row.Type || row.type || '', usedBy: el.name || el.id, direction: '' }, 'name');
        }
      }
      for (const key of SECRET_KEYS) {
        if (isMeaningful(props[key])) {
          push(deps.credentials, { alias: props[key], kind: labelFor(key), usedBy: el.name || el.id, direction: '' }, 'alias');
        }
      }
    }
  }

  // Value mapping lookups appear in scripts and in ID mapping steps.
  for (const script of artifact.scripts || []) {
    for (const match of script.code.matchAll(/getMappedValue\s*\(\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]/g)) {
      push(deps.valueMappings, { agency: match[1], scheme: match[2], usedBy: script.name, direction: '' }, 'agency');
    }
  }

  return deps;
}

/* ------------------------------------------------------------------ */
/* Overview, stats, findings                                           */
/* ------------------------------------------------------------------ */

function buildOverview(doc, artifact, model) {
  const overview = {};
  const set = (k, v) => { if (isMeaningful(v)) overview[k] = v; };

  set('Integration flow', artifact.name);
  set('Technical name', artifact.id);
  set('Version', artifact.version);
  set('Description', artifact.description || model.properties.description);
  set('Source archive', artifact.zipName);
  set('Sender systems', doc.senders.map((p) => p.name).join(', '));
  set('Receiver systems', doc.receivers.map((p) => p.name).join(', '));
  set('Sender adapters', unique(doc.channels.filter((c) => c.direction === 'Sender').map((c) => c.adapter)).join(', '));
  set('Receiver adapters', unique(doc.channels.filter((c) => c.direction === 'Receiver').map((c) => c.adapter)).join(', '));
  set('Transaction handling', doc.processes.filter((p) => p.isMain).map((p) => p.transactionHandling).filter(Boolean).join(', '));
  return overview;
}

function buildStats(doc, artifact) {
  const stepCount = doc.processes.reduce((n, p) => n + p.steps.length, 0);
  return {
    processes: doc.processes.length,
    steps: stepCount,
    channels: doc.channels.length,
    scripts: (artifact.scripts || []).length,
    mappings: (artifact.messageMappings || []).length + (artifact.xsltMappings || []).length,
    parameters: doc.parameters.length,
    schemas: (artifact.schemas || []).length,
  };
}

/**
 * Observations worth flagging in a review: things that are legal but usually
 * indicate a gap. Deliberately conservative — every finding is checkable.
 */
function buildFindings(doc, artifact) {
  const findings = [];

  const mainProcesses = doc.processes.filter((p) => p.isMain);
  const hasErrorHandling = doc.errorHandling.length > 0;
  if (mainProcesses.length && !hasErrorHandling) {
    findings.push({
      severity: 'warning',
      title: 'No exception subprocess',
      detail: 'The integration flow defines no exception subprocess, so a runtime error ends the message in "Failed" with no compensating action or custom error payload.',
    });
  }

  for (const param of doc.parameters) {
    if (param.empty && !param.unused) {
      findings.push({
        severity: 'warning',
        title: `Externalised parameter "${param.name}" has no value`,
        detail: `Used by ${param.usedIn.slice(0, 3).join('; ')}${param.usedIn.length > 3 ? ' and others' : ''}. The flow will fail or behave unexpectedly unless a value is supplied at deployment.`,
      });
    }
    if (param.unused && isMeaningful(param.value)) {
      findings.push({
        severity: 'info',
        title: `Externalised parameter "${param.name}" is not referenced`,
        detail: 'A value is configured but no step or channel uses it. It may be left over from an earlier version.',
      });
    }
  }

  // Data flow: a property is only ever set by the flow itself (a caller cannot
  // pass one in), so reading one that nothing sets is a real gap. Headers are
  // excluded because a caller legitimately supplies those.
  for (const v of doc.dataFlow || []) {
    if (v.kind === 'property' && v.origin === 'external' && v.readBy.length) {
      findings.push({
        severity: 'warning',
        title: `Property "${v.name}" is read but never set`,
        detail: `Read by ${v.readBy.slice(0, 3).map((r) => `${r.label} ${r.name}`).join('; ')}, but no step or script in this flow sets it, so it will be empty at runtime.`,
      });
    }
  }
  for (const [name, a] of doc.scriptAnalysis || []) {
    for (const proc of doc.processes) {
      for (const step of proc.steps) {
        if (step.scriptRef && step.scriptRef.split('/').pop() === name && step.raw.props.scriptFunction && a.entryFound === false) {
          const missing = !a.functions.includes(step.raw.props.scriptFunction);
          if (missing) {
            findings.push({
              severity: 'error',
              title: `Script "${name}" has no function "${step.raw.props.scriptFunction}"`,
              detail: `Step "${step.name}" calls entry point ${step.raw.props.scriptFunction}, which the file does not define${a.functions.length ? ` (it defines ${a.functions.join(', ')})` : ''}. The step will fail at runtime.`,
            });
          }
        }
      }
    }
  }

  const scriptNames = new Set((artifact.scripts || []).map((s) => s.name));
  for (const proc of doc.processes) {
    for (const step of proc.steps) {
      if (step.scriptRef && !scriptNames.has(step.scriptRef.split('/').pop())) {
        findings.push({
          severity: 'error',
          title: `Script "${step.scriptRef}" is missing from the archive`,
          detail: `Step "${step.name}" references a script file that is not present in this export. Deployment will fail.`,
        });
      }
      if (step.unreachable) {
        findings.push({
          severity: 'info',
          title: `Step "${step.name}" is not reachable`,
          detail: 'No sequence flow leads to this step from a start event. It may be left over from editing.',
        });
      }
    }
  }

  const referencedScripts = new Set();
  for (const proc of doc.processes) {
    for (const step of proc.steps) if (step.scriptRef) referencedScripts.add(step.scriptRef.split('/').pop());
  }
  for (const script of artifact.scripts || []) {
    if (!referencedScripts.has(script.name)) {
      findings.push({
        severity: 'info',
        title: `Script "${script.name}" is not referenced by any step`,
        detail: 'The file ships with the flow but no script step calls it. It may be a shared helper or dead code.',
      });
    }
  }

  for (const channel of doc.channels) {
    const props = channel.allProps.reduce((acc, p) => ((acc[p.key] = p.value), acc), {});
    if (/^HTTPS?$/.test(channel.componentType) && /^(none|None)$/.test(props.senderAuthType || '')) {
      findings.push({
        severity: 'warning',
        title: `Sender channel "${channel.name}" has no authentication`,
        detail: 'The HTTPS sender channel is configured without client authentication.',
      });
    }
    if (String(props.address || props.httpAddressWithoutQuery || '').startsWith('http://')) {
      findings.push({
        severity: 'warning',
        title: `Channel "${channel.name}" uses plain HTTP`,
        detail: `The endpoint ${props.address || props.httpAddressWithoutQuery} is not encrypted in transit.`,
      });
    }
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export function pickDetails(props, keys) {
  const out = [];
  for (const key of keys || []) {
    if (isMeaningful(props[key])) out.push({ key, label: labelFor(key), value: props[key] });
  }
  return out;
}

export function sortedProps(props) {
  return Object.entries(props || {})
    .filter(([, v]) => isMeaningful(v))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, label: labelFor(key), value }));
}

function firstMeaningful(props, keys) {
  for (const key of keys) if (isMeaningful(props[key])) return props[key];
  return '';
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

/** Resolve {{Param}} placeholders against the externalised values. */
export function resolveParams(value, parameters) {
  if (!value || typeof value !== 'string') return value;
  return value.replace(PARAM_RE, (whole, name) => {
    const hit = parameters.find((p) => p.name === name.trim());
    return hit && isMeaningful(hit.value) ? hit.value : whole;
  });
}

export function findParamRefs(value) {
  return [...String(value || '').matchAll(PARAM_RE)].map((m) => m[1].trim());
}

