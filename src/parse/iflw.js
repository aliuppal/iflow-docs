/**
 * Parser for the .iflw file — the BPMN 2.0 document that is the integration flow.
 *
 * Everything SAP-specific hangs off <bpmn2:extensionElements> as a flat list of
 * <ifl:property><key/><value/></ifl:property> pairs, so the parser's main job is
 * to lift those into plain objects and to keep the diagram geometry, which lets
 * the renderer reproduce the layout the developer actually drew.
 */

import { parseXml, child, childrenOf, descendants, attr, text } from '../lib/xml.js';

const FLOW_NODE_TAGS = new Set([
  'startEvent', 'endEvent', 'callActivity', 'serviceTask', 'task', 'sendTask', 'receiveTask',
  'userTask', 'manualTask', 'scriptTask', 'businessRuleTask', 'exclusiveGateway',
  'parallelGateway', 'inclusiveGateway', 'eventBasedGateway', 'complexGateway',
  'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent', 'subProcess',
  'transaction', 'adHocSubProcess',
]);

/** Lift <ifl:property> pairs off an element into a plain object. */
export function extensionProps(node) {
  const props = {};
  const ext = child(node, 'extensionElements');
  if (!ext) return props;
  for (const prop of childrenOf(ext, 'property')) {
    const key = text(child(prop, 'key')).trim();
    if (!key) continue;
    props[key] = text(child(prop, 'value'));
  }
  return props;
}

export function parseIflw(xmlText, fileName = '') {
  const doc = parseXml(xmlText);
  const definitions = child(doc, 'definitions');
  if (!definitions) throw new Error(`${fileName || 'File'} is not a BPMN definitions document.`);

  const model = {
    fileName,
    id: attr(definitions, 'id') || '',
    properties: extensionProps(definitions),
    participants: [],
    messageFlows: [],
    processes: [],
    shapes: new Map(),
    edges: new Map(),
    warnings: [],
  };

  const collaboration = child(definitions, 'collaboration');
  if (collaboration) {
    model.collaborationName = attr(collaboration, 'name') || '';
    model.collaborationProps = extensionProps(collaboration);

    for (const p of childrenOf(collaboration, 'participant')) {
      const props = extensionProps(p);
      // SAP shipped "EndpointRecevier" (sic) for years; both spellings occur.
      const rawType = attr(p, 'type') || props.ifl_type || '';
      model.participants.push({
        id: attr(p, 'id') || '',
        name: attr(p, 'name') || '',
        processRef: attr(p, 'processRef') || '',
        type: normaliseParticipantType(rawType),
        rawType,
        props,
      });
    }

    for (const mf of childrenOf(collaboration, 'messageFlow')) {
      const props = extensionProps(mf);
      model.messageFlows.push({
        id: attr(mf, 'id') || '',
        name: attr(mf, 'name') || '',
        sourceRef: attr(mf, 'sourceRef') || '',
        targetRef: attr(mf, 'targetRef') || '',
        componentType: props.ComponentType || props.componentType || '',
        direction: props.direction || '',
        transportProtocol: props.TransportProtocol || '',
        messageProtocol: props.MessageProtocol || '',
        props,
      });
    }
  }

  const mainProcessIds = new Set(
    model.participants.filter((p) => p.type === 'process' && p.processRef).map((p) => p.processRef)
  );

  for (const proc of childrenOf(definitions, 'process')) {
    model.processes.push(parseProcess(proc, mainProcessIds));
  }

  readDiagram(definitions, model);
  linkFlows(model);
  return model;
}

function normaliseParticipantType(raw) {
  const value = String(raw || '').toLowerCase();
  if (value.includes('integrationprocess')) return 'process';
  if (value.includes('sender')) return 'sender';
  if (value.includes('recevier') || value.includes('receiver')) return 'receiver';
  return 'other';
}

function parseProcess(proc, mainProcessIds) {
  const props = extensionProps(proc);
  const id = attr(proc, 'id') || '';
  const model = {
    id,
    name: attr(proc, 'name') || '',
    props,
    isMain: mainProcessIds.has(id),
    isExceptionSubprocess: false,
    elements: [],
    sequenceFlows: [],
  };

  collectFlowElements(proc, model, null);

  // A local integration process that is only reachable through an error handler
  // is documented as exception handling rather than as a numbered main branch.
  const transaction = props.transactionalHandling || '';
  model.transactionHandling = transaction;
  return model;
}

function collectFlowElements(container, model, parentId) {
  for (const node of childrenOf(container)) {
    const tag = node.local;
    if (tag === 'sequenceFlow') {
      const props = extensionProps(node);
      model.sequenceFlows.push({
        id: attr(node, 'id') || '',
        name: attr(node, 'name') || '',
        sourceRef: attr(node, 'sourceRef') || '',
        targetRef: attr(node, 'targetRef') || '',
        condition: props.condition || text(child(node, 'conditionExpression')) || '',
        expressionType: props.expressionType || '',
        isDefault: String(props.isDefault || '').toLowerCase() === 'true',
        parentId,
        props,
      });
      continue;
    }
    if (!FLOW_NODE_TAGS.has(tag)) continue;

    const props = extensionProps(node);
    const element = {
      id: attr(node, 'id') || '',
      tag,
      name: (attr(node, 'name') || '').trim(),
      activityType: props.activityType || props.bpmnType || '',
      props,
      parentId,
      attachedToRef: attr(node, 'attachedToRef') || '',
      triggeredByEvent: String(attr(node, 'triggeredByEvent') || '').toLowerCase() === 'true',
      incoming: [],
      outgoing: [],
      eventDefinitions: childrenOf(node)
        .filter((c) => c.local.endsWith('EventDefinition'))
        .map((c) => c.local.replace(/EventDefinition$/, '')),
    };

    // A start event carrying a timerEventDefinition is a scheduler, which the
    // activityType alone does not always say.
    if (!element.activityType && element.eventDefinitions.length) {
      const def = element.eventDefinitions[0];
      if (tag === 'startEvent' && def === 'timer') element.activityType = 'Timer';
      else if (tag === 'endEvent' && def === 'error') element.activityType = 'ErrorEndEvent';
      else if (tag === 'endEvent' && def === 'escalation') element.activityType = 'EscalationEndEvent';
      else if (tag === 'endEvent' && def === 'terminate') element.activityType = 'TerminateEndEvent';
    }

    model.elements.push(element);

    if (tag === 'subProcess' || tag === 'transaction' || tag === 'adHocSubProcess') {
      element.isExceptionSubprocess = element.triggeredByEvent;
      collectFlowElements(node, model, element.id);
    }
  }
}

function readDiagram(definitions, model) {
  for (const diagram of childrenOf(definitions, 'BPMNDiagram')) {
    for (const plane of childrenOf(diagram, 'BPMNPlane')) {
      for (const shape of descendants(plane, 'BPMNShape')) {
        const ref = attr(shape, 'bpmnElement');
        const bounds = child(shape, 'Bounds');
        if (!ref || !bounds) continue;
        model.shapes.set(ref, {
          x: num(attr(bounds, 'x')),
          y: num(attr(bounds, 'y')),
          width: num(attr(bounds, 'width')),
          height: num(attr(bounds, 'height')),
        });
      }
      for (const edge of descendants(plane, 'BPMNEdge')) {
        const ref = attr(edge, 'bpmnElement');
        if (!ref) continue;
        const points = childrenOf(edge, 'waypoint').map((w) => ({
          x: num(attr(w, 'x')),
          y: num(attr(w, 'y')),
        }));
        if (points.length) model.edges.set(ref, points);
      }
    }
  }
}

function num(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** Populate incoming/outgoing on every element from the sequence flows. */
function linkFlows(model) {
  for (const proc of model.processes) {
    const byId = new Map(proc.elements.map((e) => [e.id, e]));
    for (const flow of proc.sequenceFlows) {
      const from = byId.get(flow.sourceRef);
      const to = byId.get(flow.targetRef);
      if (from) from.outgoing.push(flow);
      if (to) to.incoming.push(flow);
    }
  }
}

/** All elements across every process, for lookups by id. */
export function allElements(model) {
  const out = [];
  for (const proc of model.processes) {
    for (const el of proc.elements) out.push({ ...el, processId: proc.id });
  }
  return out;
}
