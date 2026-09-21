/**
 * Renders the integration flow as SVG, reusing the coordinates SAP stored in the
 * .iflw's BPMNDiagram section. That matters more than it sounds: the picture in
 * the documentation is then the same picture the developer arranged in the Web
 * UI, so a reviewer can match the document against the tool.
 *
 * Output is a plain SVG string with an embedded <style>, so the same function
 * serves the live page and the self-contained HTML export.
 */

import { CATEGORIES } from '../model/catalog.js';
import { escapeXml } from '../lib/xml.js';

const PAD = 28;
const EVENT_TAGS = new Set(['startEvent', 'endEvent', 'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent']);
const GATEWAY_TAGS = new Set(['exclusiveGateway', 'parallelGateway', 'inclusiveGateway', 'eventBasedGateway', 'complexGateway']);

export function renderDiagram(doc, options = {}) {
  const model = doc.artifact.iflw;
  if (!model || !model.shapes.size) {
    return { svg: '', empty: true, reason: 'This export contains no diagram layout information.' };
  }

  const stepsById = new Map();
  for (const proc of doc.processes) for (const step of proc.steps) stepsById.set(step.id, step);
  const participantsById = new Map(model.participants.map((p) => [p.id, p]));
  const channelsById = new Map(doc.channels.map((c) => [c.id, c]));

  // Marker ids are document-global once several diagrams share a page, so they
  // are namespaced per diagram rather than reused.
  const uid = String(options.linkPrefix || doc.id || doc.name || 'd').replace(/[^A-Za-z0-9_-]/g, '') || 'd';

  const bounds = measure(model);
  const width = bounds.maxX - bounds.minX + PAD * 2;
  const height = bounds.maxY - bounds.minY + PAD * 2;
  const dx = PAD - bounds.minX;
  const dy = PAD - bounds.minY;

  const layers = { pools: [], edges: [], nodes: [], labels: [] };

  // Pools first so everything else draws on top of them.
  for (const participant of model.participants) {
    const box = model.shapes.get(participant.id);
    if (!box) continue;
    const kind = participant.type === 'process' ? 'process' : 'endpoint';
    layers.pools.push(
      `<g class="dg-pool dg-pool-${kind}">` +
        rect(box.x + dx, box.y + dy, box.width, box.height, 6) +
        poolLabel(participant.name || participant.id, box, dx, dy, kind) +
        '</g>'
    );
  }
  // Sub-process frames (exception handlers) sit above the pool, below the nodes.
  for (const proc of doc.processes) {
    for (const step of proc.steps) {
      if (step.tag !== 'subProcess') continue;
      const box = model.shapes.get(step.id);
      if (!box) continue;
      layers.pools.push(
        `<g class="dg-subprocess">${rect(box.x + dx, box.y + dy, box.width, box.height, 6)}` +
          `<text class="dg-subprocess-label" x="${r(box.x + dx + 8)}" y="${r(box.y + dy + 16)}">${escapeXml(step.name)}</text></g>`
      );
    }
  }

  for (const proc of doc.processes) {
    for (const flow of proc.sequenceFlows) {
      const points = model.edges.get(flow.id) || inferEdge(model, flow.sourceRef, flow.targetRef);
      if (!points || points.length < 2) continue;
      const label = flow.name || (flow.isDefault ? 'default' : '');
      layers.edges.push(edge(points, dx, dy, 'dg-seq', label, uid));
    }
  }
  for (const flow of model.messageFlows) {
    const points = model.edges.get(flow.id) || inferEdge(model, flow.sourceRef, flow.targetRef);
    if (!points || points.length < 2) continue;
    const channel = channelsById.get(flow.id);
    layers.edges.push(edge(points, dx, dy, 'dg-msg', channel ? channel.adapter : flow.componentType, uid));
  }

  for (const proc of doc.processes) {
    for (const step of proc.steps) {
      if (step.tag === 'subProcess') continue;
      const box = model.shapes.get(step.id);
      if (!box) continue;
      layers.nodes.push(node(step, box, dx, dy, options));
    }
  }

  const svg =
    `<svg class="iflow-diagram" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r(width)} ${r(height)}" ` +
    `width="${r(width)}" height="${r(height)}" role="img" aria-label="Integration flow diagram for ${escapeXml(doc.name)}">` +
    defs(uid) +
    STYLE +
    `<g class="dg-layer-pools">${layers.pools.join('')}</g>` +
    `<g class="dg-layer-edges">${layers.edges.join('')}</g>` +
    `<g class="dg-layer-nodes">${layers.nodes.join('')}</g>` +
    '</svg>';

  return { svg, empty: false, width, height };
}

function measure(model) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const consider = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const box of model.shapes.values()) {
    consider(box.x, box.y);
    consider(box.x + box.width, box.y + box.height + 26); // room for labels under events
  }
  for (const points of model.edges.values()) for (const p of points) consider(p.x, p.y);
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  return { minX, minY, maxX, maxY };
}

/** Straight-line fallback for an edge with no stored waypoints. */
function inferEdge(model, sourceRef, targetRef) {
  const a = model.shapes.get(sourceRef);
  const b = model.shapes.get(targetRef);
  if (!a || !b) return null;
  return [
    { x: a.x + a.width, y: a.y + a.height / 2 },
    { x: b.x, y: b.y + b.height / 2 },
  ];
}

function node(step, box, dx, dy, options) {
  const x = box.x + dx;
  const y = box.y + dy;
  const w = box.width || 32;
  const h = box.height || 32;
  // One variable name for every category, so the rules below can read it.
  const color = CATEGORIES[step.category] ? CATEGORIES[step.category].color : CATEGORIES.other.color;
  const style = `--node-color:${color}`;
  const anchor = options.linkPrefix ? `${options.linkPrefix}${cssId(step.id)}` : '';
  const open = anchor ? `<a href="#${anchor}" class="dg-node dg-${step.category}" style="${style}">` : `<g class="dg-node dg-${step.category}" style="${style}">`;
  const close = anchor ? '</a>' : '</g>';
  const title = `<title>${escapeXml(`${step.label ? step.label + '. ' : ''}${step.name} — ${step.typeLabel}`)}</title>`;

  if (EVENT_TAGS.has(step.tag)) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rad = Math.min(w, h) / 2;
    const double = step.tag !== 'startEvent' && step.tag !== 'endEvent';
    const thick = step.tag === 'endEvent';
    return (
      open + title +
      `<circle class="dg-event${thick ? ' dg-event-end' : ''}" cx="${r(cx)}" cy="${r(cy)}" r="${r(rad)}"/>` +
      (double ? `<circle class="dg-event-inner" cx="${r(cx)}" cy="${r(cy)}" r="${r(rad - 3)}"/>` : '') +
      badge(step, x, y) +
      caption(step.name, cx, y + h + 13, w + 60) +
      close
    );
  }

  if (GATEWAY_TAGS.has(step.tag)) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rad = Math.min(w, h) / 2;
    const mark = step.tag === 'parallelGateway' ? '+' : step.tag === 'eventBasedGateway' ? '○' : '×';
    return (
      open + title +
      `<polygon class="dg-gateway" points="${r(cx)},${r(cy - rad)} ${r(cx + rad)},${r(cy)} ${r(cx)},${r(cy + rad)} ${r(cx - rad)},${r(cy)}"/>` +
      `<text class="dg-gateway-mark" x="${r(cx)}" y="${r(cy + 5)}">${mark}</text>` +
      badge(step, x, y) +
      caption(step.name, cx, y + h + 13, w + 70) +
      close
    );
  }

  const lines = wrap(step.name, Math.max(10, Math.floor(w / 6.2)), 3);
  const startY = y + h / 2 - ((lines.length - 1) * 12) / 2 + 4;
  return (
    open + title +
    `<rect class="dg-activity" x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="8"/>` +
    `<rect class="dg-activity-accent" x="${r(x)}" y="${r(y)}" width="${r(w)}" height="4" rx="2"/>` +
    lines.map((line, i) => `<text class="dg-activity-label" x="${r(x + w / 2)}" y="${r(startY + i * 12)}">${escapeXml(line)}</text>`).join('') +
    `<text class="dg-activity-type" x="${r(x + w / 2)}" y="${r(y + h - 6)}">${escapeXml(step.typeLabel)}</text>` +
    badge(step, x, y) +
    close
  );
}

function badge(step, x, y) {
  if (!step.label || step.label === '•') return '';
  const wide = step.label.length > 2;
  return (
    `<g class="dg-badge"><rect x="${r(x - 9)}" y="${r(y - 9)}" width="${r(wide ? 12 + step.label.length * 5 : 18)}" height="16" rx="8"/>` +
    `<text x="${r(x - 9 + (wide ? 6 + step.label.length * 2.5 : 9))}" y="${r(y + 2)}">${escapeXml(step.label)}</text></g>`
  );
}

function caption(label, cx, y, maxWidth) {
  if (!label) return '';
  const lines = wrap(label, Math.max(12, Math.floor(maxWidth / 5.6)), 2);
  return lines
    .map((line, i) => `<text class="dg-caption" x="${r(cx)}" y="${r(y + i * 11)}">${escapeXml(line)}</text>`)
    .join('');
}

function edge(points, dx, dy, className, label, uid) {
  const pts = points.map((p) => `${r(p.x + dx)},${r(p.y + dy)}`).join(' ');
  const mid = points[Math.floor(points.length / 2)] || points[0];
  const text = label
    ? `<text class="dg-edge-label" x="${r(mid.x + dx)}" y="${r(mid.y + dy - 5)}">${escapeXml(truncate(label, 28))}</text>`
    : '';
  const marker = className === 'dg-msg' ? `dg-arrow-open-${uid}` : `dg-arrow-${uid}`;
  return `<g class="dg-edge ${className}"><polyline points="${pts}" marker-end="url(#${marker})"/>${text}</g>`;
}

function rect(x, y, w, h, radius) {
  return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="${radius}"/>`;
}

function poolLabel(name, box, dx, dy, kind) {
  if (!name) return '';
  // Endpoint pools are tall and narrow; their label reads better rotated.
  if (kind === 'endpoint' && box.height > box.width * 1.4) {
    const cx = box.x + dx + 14;
    const cy = box.y + dy + box.height / 2;
    return `<text class="dg-pool-label" transform="rotate(-90 ${r(cx)} ${r(cy)})" x="${r(cx)}" y="${r(cy)}">${escapeXml(truncate(name, 40))}</text>`;
  }
  return `<text class="dg-pool-label dg-pool-label-h" x="${r(box.x + dx + 10)}" y="${r(box.y + dy + 16)}">${escapeXml(truncate(name, 60))}</text>`;
}

function wrap(value, perLine, maxLines) {
  const words = String(value || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if ((current + ' ' + word).length <= perLine) current += ' ' + word;
    else { lines.push(current); current = word; }
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines) {
    const consumed = lines.join(' ').split(/\s+/).length;
    if (consumed < words.length) lines[maxLines - 1] = truncate(lines[maxLines - 1], perLine - 1) + '…';
  }
  return lines.length ? lines : [''];
}

function truncate(value, max) {
  const v = String(value || '');
  return v.length > max ? v.slice(0, max - 1) + '…' : v;
}

function r(value) {
  return Math.round(Number(value) * 100) / 100;
}

export function cssId(value) {
  return `step-${String(value).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

const defs = (uid) => `<defs>
<marker id="dg-arrow-${uid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker>
<marker id="dg-arrow-open-${uid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10" fill="none" stroke-width="1.5"/></marker>
</defs>`;

/** Kept inside the SVG so exported documents render identically with no external CSS. */
const STYLE = `<style>
.iflow-diagram{font-family:"Segoe UI",system-ui,-apple-system,sans-serif;max-width:100%;height:auto}
.iflow-diagram text{fill:var(--dg-text,#1c2530)}
.dg-pool rect{fill:var(--dg-pool-bg,#f4f7fa);stroke:var(--dg-pool-stroke,#c3ced9);stroke-width:1}
.dg-pool-process rect{fill:var(--dg-process-bg,#fbfcfe)}
.dg-pool-label{font-size:11px;font-weight:600;text-anchor:middle;fill:var(--dg-muted,#5a6b7d)}
.dg-pool-label-h{text-anchor:start}
.dg-subprocess rect{fill:var(--dg-sub-bg,rgba(179,38,30,.05));stroke:var(--dg-sub-stroke,#d99);stroke-width:1;stroke-dasharray:4 3}
.dg-subprocess-label{font-size:10px;font-weight:600;fill:var(--dg-muted,#5a6b7d)}
.dg-edge polyline{fill:none;stroke:var(--dg-edge,#7a8794);stroke-width:1.4}
.dg-edge marker path,.dg-edge polyline{vector-effect:non-scaling-stroke}
.dg-msg polyline{stroke-dasharray:5 4;stroke:var(--dg-edge-msg,#0a6ed1)}
.dg-edge-label{font-size:9px;text-anchor:middle;fill:var(--dg-muted,#5a6b7d)}
.iflow-diagram marker path{fill:var(--dg-edge,#7a8794);stroke:var(--dg-edge,#7a8794)}
.dg-activity{fill:var(--dg-node-bg,#fff);stroke:var(--dg-node-stroke,#b9c4d0);stroke-width:1}
.dg-activity-accent{fill:var(--node-color,#5a6b7d)}
.dg-activity-label{font-size:10.5px;font-weight:600;text-anchor:middle}
.dg-activity-type{font-size:8.5px;text-anchor:middle;fill:var(--dg-muted,#5a6b7d)}
.dg-event{fill:var(--dg-node-bg,#fff);stroke:var(--node-color,#5a6b7d);stroke-width:2}
.dg-event-end{stroke-width:3.5}
.dg-event-inner{fill:none;stroke:var(--node-color,#5a6b7d);stroke-width:1.2}
.dg-gateway{fill:var(--dg-node-bg,#fff);stroke:var(--node-color,#7b5bd6);stroke-width:1.6}
.dg-gateway-mark{font-size:13px;text-anchor:middle;fill:var(--node-color,#7b5bd6)}
.dg-caption{font-size:9.5px;text-anchor:middle;fill:var(--dg-muted,#5a6b7d)}
.dg-badge rect{fill:var(--node-color,#5a6b7d)}
.dg-badge text{font-size:9px;font-weight:700;text-anchor:middle;fill:#fff}
.dg-node{cursor:default}
a.dg-node{cursor:pointer}
a.dg-node:hover .dg-activity,a.dg-node:hover .dg-event,a.dg-node:hover .dg-gateway{stroke:var(--node-color,#5a6b7d);stroke-width:2.4}
</style>`;
