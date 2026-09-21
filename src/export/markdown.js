/**
 * Markdown export — for teams that keep integration documentation in a wiki,
 * a repository or a pull request rather than as an attachment.
 *
 * Mirrors the sections of the HTML document. The diagram is emitted as a Mermaid
 * flowchart rather than SVG, because that is what renders in GitHub, GitLab,
 * Azure DevOps and most wikis.
 */

import { humanise, isMeaningful, typeLabel } from '../model/catalog.js';
import { scriptSummary } from '../model/flow.js';

export function renderMarkdown(doc, options = {}) {
  const out = [];
  const h = options.headingOffset || 0;
  const H = (level, text) => out.push(`${'#'.repeat(Math.min(6, level + h))} ${text}`, '');

  H(1, doc.name);
  if (doc.description) out.push(doc.description, '');
  const chips = [
    doc.version && `**Version** ${doc.version}`,
    `**Steps** ${doc.stats.steps || 0}`,
    `**Channels** ${doc.stats.channels || 0}`,
    `**Scripts** ${doc.stats.scripts || 0}`,
    `**Parameters** ${doc.stats.parameters || 0}`,
  ].filter(Boolean);
  out.push(chips.join(' · '), '');

  const overview = Object.entries(doc.overview);
  if (overview.length) {
    H(2, 'Overview');
    out.push(...table(['Field', 'Value'], overview.map(([k, v]) => [k, v])));
  }

  if (doc.summary) out.push(...summaryMarkdown(doc, H));

  if (doc.findings.length) {
    H(2, 'Review notes');
    const icon = { error: '🔴', warning: '🟠', info: '🔵' };
    for (const f of doc.findings) out.push(`- ${icon[f.severity] || '•'} **${f.title}** — ${f.detail}`);
    out.push('');
  }

  const mermaid = renderMermaid(doc);
  if (mermaid) {
    H(2, 'Flow diagram');
    out.push('```mermaid', mermaid, '```', '');
  }

  if (doc.channels.length) {
    H(2, 'Interfaces');
    out.push(
      ...table(
        ['Direction', 'Channel', 'Adapter', 'Partner system', 'Endpoint'],
        doc.channels.map((c) => [c.direction, c.name, c.adapter, c.partner || '—', c.endpoint ? '`' + c.endpoint + '`' : '—'])
      )
    );
  }

  if (doc.processes.length) {
    H(2, 'Processing steps');
    for (const proc of [...doc.processes].sort((a, b) => Number(b.isMain) - Number(a.isMain))) {
      H(3, `${proc.name}${proc.isMain ? ' (main process)' : ''}`);
      out.push(
        ...table(
          ['#', 'Step', 'Type', 'Configuration'],
          proc.steps.map((s) => [s.label || '•', s.name, s.typeLabel, stepSummary(s)])
        )
      );
      for (const step of proc.steps) {
        const detail = stepDetail(step, doc);
        if (!detail.length) continue;
        H(4, `${step.label || '•'}. ${step.name}`);
        out.push(...detail);
      }
    }
  }

  if (doc.parameters.length) {
    H(2, 'Externalised parameters');
    out.push(
      ...table(
        ['Parameter', 'Type', 'Configured value', 'Used by'],
        doc.parameters.map((p) => [
          '`' + p.name + '`',
          p.dataType || '—',
          p.empty ? '_not set_' : '`' + p.value + '`',
          p.unused ? '_not referenced_' : p.usedIn.join('; ') || '—',
        ])
      )
    );
  }

  const d = doc.dependencies;
  if (Object.values(d).some((list) => list.length)) {
    H(2, 'Dependencies');
    if (d.processDirect.length) {
      H(3, 'ProcessDirect');
      out.push(...table(['Address', 'Direction', 'Channel'], d.processDirect.map((x) => ['`' + x.address + '`', x.direction, x.channel])));
    }
    if (d.endpoints.length) {
      H(3, 'External endpoints');
      out.push(...table(['Address', 'Direction', 'Adapter', 'Partner'], d.endpoints.map((x) => ['`' + x.address + '`', x.direction, x.adapter, x.partner || '—'])));
    }
    if (d.queues.length) {
      H(3, 'Queues');
      out.push(...table(['Queue', 'Direction', 'Adapter'], d.queues.map((x) => ['`' + x.name + '`', x.direction, x.adapter])));
    }
    if (d.dataStores.length) {
      H(3, 'Data stores');
      out.push(...table(['Store', 'Operation', 'Visibility', 'Used by'], d.dataStores.map((x) => ['`' + x.name + '`', x.operation, x.visibility, x.usedBy])));
    }
    if (d.credentials.length) {
      H(3, 'Security material');
      out.push(...table(['Alias', 'Kind', 'Used by'], d.credentials.map((x) => ['`' + x.alias + '`', x.kind, x.usedBy])));
      out.push('> These aliases must exist in the target tenant before deployment. The export contains alias names only, never secrets.', '');
    }
  }

  if (doc.errorHandling.length) {
    H(2, 'Error handling');
    for (const { process, step } of doc.errorHandling) {
      const name = step ? step.name || 'Exception Subprocess' : process.name;
      const steps = step ? process.steps.filter((s) => s.raw.parentId === step.id) : process.steps;
      out.push(`**${name}**`, '');
      if (steps.length) for (const s of steps) out.push(`1. ${s.name} — _${s.typeLabel}_`);
      else out.push('_No steps: the message ends in error without compensating action._');
      out.push('');
    }
  }

  if (doc.scripts.length) {
    H(2, 'Scripts');
    for (const s of doc.scripts) {
      H(3, s.name);
      const analysis = doc.scriptAnalysis && doc.scriptAnalysis.get(s.name);
      if (analysis) {
        if (analysis.purpose) out.push(`> ${analysis.purpose}`, '');
        const clauses = scriptSummary(analysis);
        if (clauses.length) out.push(...clauses.map((c) => `- It ${c}.`), '');
      }
      out.push('```' + (s.language === 'JavaScript' ? 'javascript' : 'groovy'), s.code.trimEnd(), '```', '');
    }
  }

  const a = doc.artifact;
  if (a.messageMappings.length || a.xsltMappings.length || a.schemas.length) {
    H(2, 'Mappings & schemas');
    if (a.messageMappings.length) {
      out.push(...table(['Mapping', 'Kind', 'Sources', 'Targets'], a.messageMappings.map((m) => [
        m.name, m.kind, m.sources.map((s) => s.name).join(', ') || '—', m.targets.map((s) => s.name).join(', ') || '—',
      ])));
    }
    if (a.xsltMappings.length) {
      out.push(...table(['XSLT', 'Templates'], a.xsltMappings.map((x) => ['`' + x.path + '`', x.templates.join(', ') || '—'])));
    }
    if (a.schemas.length) {
      out.push(...table(['Schema', 'Kind', 'Target namespace'], a.schemas.map((s) => ['`' + s.path + '`', s.kind, s.targetNamespace || '—'])));
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/* ------------------------------------------------------------------ */
/* Process summary                                                     */
/* ------------------------------------------------------------------ */

/** Generated prose already uses Markdown's own `code` and **bold**, so it passes through. */
function summaryMarkdown(doc, H) {
  const sm = doc.summary;
  const out = [];
  const at = (ref) => (ref ? ` _(${ref.label} ${ref.name})_` : '');

  H(2, 'Process summary');
  out.push(sm.headline, '');

  H(3, 'Data in');
  out.push(...(sm.inputs.length ? sm.inputs.map((i) => `- ${i.text}${at(i.at)}`) : ['_Nothing enters this flow from outside._']), '');

  H(3, 'Data out');
  out.push(...(sm.outputs.length ? sm.outputs.map((i) => `- ${i.text}${at(i.at)}`) : ['_This flow sends nothing anywhere._']), '');

  H(3, 'What happens, step by step');
  const stepLines = (steps) => {
    const lines = [];
    for (const st of steps) {
      const depth = Math.min(3, (String(st.label).match(/\./g) || []).length);
      const pad = '  '.repeat(depth);
      lines.push(`${pad}- **${st.label} ${st.name}** — ${st.text}`);
      for (const b of st.branches || []) {
        const when = b.isDefault && !b.condition ? 'taken when nothing else matches' : b.condition ? `when \`${b.condition}\`` : '';
        lines.push(`${pad}  - _${b.name || 'Route'}_${when ? ` — ${when}` : ''}${b.toLabel ? ` → ${b.toLabel} ${b.toName}` : ''}`);
      }
      const io = ioMarkdown(st);
      for (const line of io) lines.push(`${pad}  - ${line}`);
    }
    return lines;
  };
  for (const flow of sm.flows) {
    if (!flow.steps.length) continue;
    if (!flow.isMain) out.push(`**Local process: ${flow.name}**`, '');
    out.push(...stepLines(flow.steps), '');
  }

  if (sm.results.length) {
    H(3, 'Result');
    out.push(...sm.results.map((r) => `- **${r.label} ${r.name}** — ${r.text}`), '');
  }

  H(3, 'If something goes wrong');
  out.push(sm.errorText, '');
  const errorSteps = sm.flows.flatMap((f) => f.errorSteps).concat(sm.errorProcs.flatMap((p) => p.steps));
  if (errorSteps.length) out.push(...stepLines(errorSteps), '');

  if (doc.dataFlow.length) {
    H(3, 'Data passed between steps');
    const label = { header: 'Header', property: 'Property', variable: 'Variable' };
    const refs = (list) => list.map((r) => `${r.label} ${r.name}`).join('<br>');
    out.push(
      ...table(
        ['Data', 'Set by', 'Used by'],
        doc.dataFlow.map((v) => [
          `${label[v.kind]} \`${v.name}\``,
          v.setBy.length ? refs(v.setBy) : v.origin === 'runtime' ? '_supplied by the runtime or adapter_' : '_not set in this flow — from the caller_',
          v.readBy.length ? refs(v.readBy) : '_not read inside this flow_',
        ])
      )
    );
  }
  return out;
}

/** "Uses / Sets / Removes" lines for one step. */
function ioMarkdown(step) {
  const lines = [];
  const item = (x) => {
    let from = '';
    if (x.from) from = ` (set at ${x.from.label})`;
    else if (x.origin === 'runtime') from = ' (runtime)';
    else if (x.origin === 'external') from = ' (from the caller)';
    else if (x.origin === 'later') from = ' (only set by a later step)';
    return `${x.kind} \`${x.name}\`${from}`;
  };
  const uses = step.reads.map(item);
  if (step.readsBody) uses.push('the message body');
  if (uses.length) lines.push(`Uses: ${uses.join(', ')}`);
  const sets = step.writes.map((w) => `${w.kind} \`${w.name}\``);
  if (step.replacesBody) sets.push('the message body');
  if (sets.length) lines.push(`Sets: ${sets.join(', ')}`);
  if (step.removes && step.removes.length) lines.push(`Removes: ${step.removes.map((r) => `${r.kind} \`${r.name}\``).join(', ')}`);
  return lines;
}

function stepSummary(step) {
  const bits = step.details.slice(0, 3).map((d) => `${d.label}: ${oneLine(d.value, 60)}`);
  if (bits.length) return bits.join('; ');
  // A Request Reply or Send carries its configuration on the channel, not the step.
  if (step.channels.length) {
    return step.channels.map((c) => `via ${c.adapter}${c.partner ? ` → ${c.partner}` : ''}`).join('; ');
  }
  if (step.tables.length) return step.tables.map((t) => `${t.title.toLowerCase()}: ${t.rows.length}`).join('; ');
  return step.note || '—';
}

function stepDetail(step, doc) {
  const out = [];
  for (const t of step.tables) {
    if (!t.rows.length) continue;
    out.push(`_${t.title}_`, '');
    out.push(...table(['Name', 'Source', 'Value'], t.rows.map((r) => [r.name, r.type || r.dataType || '—', oneLine(r.value || r.default || '', 120)])));
  }
  if (step.branches.length) {
    out.push('_Routing conditions_', '');
    out.push(...table(['Branch', 'Condition'], step.branches.map((b) => [
      b.name || (b.isDefault ? 'Default route' : b.to),
      b.isDefault && !b.condition ? '_default_' : '`' + oneLine(b.condition, 160) + '`',
    ])));
  }
  if (step.body) {
    out.push(`_Message body (${step.body.type})_`, '', '```', step.body.content.trimEnd(), '```', '');
  }
  if (step.scriptRef) out.push(`Script: \`${step.scriptRef}\`${step.scriptFunction ? `, entry point \`${step.scriptFunction}\`` : ''}`, '');
  if (step.mappingRef) out.push(`Mapping: \`${step.mappingRef}\``, '');
  return out;
}

/**
 * Mermaid rendering of the main process. Kept structural — the exact geometry
 * belongs to the SVG export; here the point is that the branch structure is
 * readable in a diff and in a wiki.
 */
export function renderMermaid(doc) {
  const main = doc.processes.find((p) => p.isMain) || doc.processes[0];
  if (!main || !main.steps.length) return '';

  const lines = ['flowchart TD'];
  const ids = new Map();
  let n = 0;
  const idOf = (stepId) => {
    if (!ids.has(stepId)) ids.set(stepId, `n${n++}`);
    return ids.get(stepId);
  };

  for (const step of main.steps) {
    if (step.tag === 'subProcess') continue;
    const id = idOf(step.id);
    const label = mermaidLabel(`${step.label ? step.label + '. ' : ''}${step.name}`);
    if (step.tag === 'startEvent' || step.tag === 'endEvent') lines.push(`  ${id}(["${label}"])`);
    else if (/Gateway/i.test(step.tag)) lines.push(`  ${id}{"${label}"}`);
    else lines.push(`  ${id}["${label}"]`);
  }

  const known = new Set(main.steps.filter((s) => s.tag !== 'subProcess').map((s) => s.id));
  for (const flow of main.sequenceFlows) {
    if (!known.has(flow.sourceRef) || !known.has(flow.targetRef)) continue;
    const label = flow.name || (flow.isDefault ? 'default' : '');
    lines.push(`  ${idOf(flow.sourceRef)} -->${label ? `|${mermaidLabel(label)}|` : ''} ${idOf(flow.targetRef)}`);
  }

  return lines.join('\n');
}

function mermaidLabel(value) {
  return String(value || '')
    .replace(/["`]/g, "'")
    .replace(/[\r\n]+/g, ' ')
    .replace(/[<>{}|]/g, '')
    .slice(0, 60)
    .trim();
}

export function renderPackageMarkdown(archive, docs) {
  const out = [];
  out.push(`# ${archive.sourceName.replace(/\.zip$/i, '')}`, '');
  out.push(`Integration package documentation · ${docs.length} artefacts · generated ${new Date().toISOString().slice(0, 10)}`, '');
  out.push(
    ...table(
      ['Artefact', 'Type', 'Version', 'Steps', 'Senders', 'Receivers'],
      docs.map((d) => [
        d.name,
        typeLabel(d.type),
        d.version || '—',
        String(d.stats.steps || 0),
        d.senders.map((s) => s.name).join(', ') || '—',
        d.receivers.map((s) => s.name).join(', ') || '—',
      ])
    )
  );

  const handoffs = [];
  for (const d of docs) {
    for (const p of d.dependencies.processDirect) handoffs.push([d.name, '`' + p.address + '`', 'ProcessDirect', p.direction]);
    for (const q of d.dependencies.queues) handoffs.push([d.name, '`' + q.name + '`', q.adapter, q.direction]);
  }
  if (handoffs.length) {
    out.push('## Internal hand-offs', '');
    out.push(...table(['Artefact', 'Address / queue', 'Via', 'Direction'], handoffs));
  }

  for (const d of docs) {
    out.push('---', '');
    out.push(renderMarkdown(d, { headingOffset: 0 }));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function table(headers, rows) {
  const clean = rows.filter(Boolean).map((row) => row.map((cell) => cellText(cell)));
  if (!clean.length) return [];
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...clean.map((row) => `| ${row.join(' | ')} |`),
    '',
  ];
}

function cellText(value) {
  if (!isMeaningful(value)) return '—';
  return String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, '<br>');
}

function oneLine(value, max) {
  const v = String(value || '').replace(/\s+/g, ' ').trim();
  return v.length > max ? v.slice(0, max - 1) + '…' : v;
}
