/**
 * Domain catalogue: maps the raw `activityType` / `ComponentType` values found in
 * an .iflw onto the names integration developers actually use, plus the handful
 * of properties worth putting in a document for each kind of step.
 *
 * `keys` lists property keys surfaced as a detail table, in order. Anything not
 * listed still shows up under the step's full property dump, so an unknown or
 * newly-released step type degrades to "named, with all properties" rather than
 * being dropped.
 */

import { parseXml, childrenOf, text } from '../lib/xml.js';

export const CATEGORIES = {
  start: { label: 'Start', color: '#2e7d32' },
  end: { label: 'End', color: '#b3261e' },
  transform: { label: 'Transformation', color: '#0a6ed1' },
  routing: { label: 'Routing', color: '#7b5bd6' },
  call: { label: 'Call', color: '#c25e00' },
  persistence: { label: 'Persistence', color: '#0f7b7b' },
  security: { label: 'Security', color: '#8a1c5a' },
  flow: { label: 'Flow control', color: '#5a6b7d' },
  event: { label: 'Event', color: '#6b6b00' },
  other: { label: 'Step', color: '#5a6b7d' },
};

const T = (label, category, keys = [], note = '') => ({ label, category, keys, note });

export const ACTIVITY_TYPES = {
  // --- Transformation -------------------------------------------------
  // bodyContent is deliberately absent: it is rendered as its own block rather
  // than truncated into a detail row.
  Enricher: T('Content Modifier', 'transform', ['bodyType', 'wrapContent'],
    'Sets the message body, headers and exchange properties.'),
  Mapping: T('Message Mapping', 'transform', ['mappingType', 'mappingname', 'mappingpath', 'mappinguri', 'messageMappingBundleId'],
    'Maps the message from a source structure to a target structure.'),
  XSLTMapping: T('XSLT Mapping', 'transform', ['mappingSource', 'mappingpath', 'mappinguri'],
    'Transforms the payload with an XSLT stylesheet.'),
  OperationMapping: T('Operation Mapping', 'transform', ['mappingpath', 'mappinguri']),
  Script: T('Script', 'transform', ['scriptFunction', 'script', 'scriptBundleId'],
    'Runs custom Groovy or JavaScript against the exchange.'),
  JsonToXmlConverter: T('JSON to XML Converter', 'transform', ['additionalRootElementName', 'useNamespaceMapping', 'jsonNamespaceMapping']),
  XmlToJsonConverter: T('XML to JSON Converter', 'transform', ['suppressJsonRootElement', 'jsonOutputEncoding', 'useNamespaceMapping']),
  CsvToXmlConverter: T('CSV to XML Converter', 'transform', ['fieldSeparator', 'recordMarker', 'xsdFilePath', 'includeParentElement']),
  XmlToCsvConverter: T('XML to CSV Converter', 'transform', ['fieldSeparator', 'includeHeaderLine', 'pathToTargetElement']),
  EDIToXmlConverter: T('EDI to XML Converter', 'transform', ['sourceEncoding', 'transactionMode']),
  XmlToEdiConverter: T('XML to EDI Converter', 'transform', ['targetEncoding']),
  Encoder: T('Encoder', 'transform', ['encodeType', 'encodingCharset'], 'Base64 / MIME encoding of the payload.'),
  Decoder: T('Decoder', 'transform', ['decodeType', 'encodingCharset']),
  XmlModifier: T('XML Modifier', 'transform', ['removeXmlDeclaration', 'removeInvalidChars']),
  XmlValidator: T('XML Validator', 'transform', ['xsdURI', 'preventException', 'payloadType'],
    'Validates the payload against an XSD and fails the flow when invalid.'),
  Filter: T('Filter', 'transform', ['xpath', 'valueType'], 'Reduces the payload to the nodes selected by an XPath.'),
  MessageDigest: T('Message Digest', 'security', ['digestAlgorithm']),
  IDMapper: T('ID Mapping', 'transform', ['idMapperContext', 'sourceAgency', 'sourceScheme', 'targetAgency', 'targetScheme']),

  // --- Calls ----------------------------------------------------------
  ExternalCall: T('Request Reply', 'call', [],
    'Calls an external system and waits for the response.'),
  Send: T('Send', 'call', [], 'Calls a receiver without waiting for a response.'),
  ContentEnricher: T('Content Enricher', 'call', ['aggregationAlgorithm', 'xpathOriginal', 'xpathLookup', 'nodeOriginal', 'nodeLookup'],
    'Merges the response of a lookup call into the original message.'),
  ProcessCallElement: T('Process Call', 'flow', ['processId', 'subActivityType'],
    'Hands the message to a local integration process.'),

  // --- Persistence ----------------------------------------------------
  DBstorage: T('Data Store Operation', 'persistence', ['operation', 'storeName', 'visibility', 'entryID', 'retentionThreshold', 'overwriteExistingMessage', 'numberOfPolledMessages'],
    'Reads from or writes to an integration data store.'),
  Persist: T('Persist Message', 'persistence', ['persistMessageId', 'encrypt']),
  WriteVariables: T('Write Variables', 'persistence', ['variableTable']),
  DataStoreSelect: T('Data Store Select', 'persistence', ['storeName', 'visibility', 'numberOfPolledMessages']),

  // --- Security -------------------------------------------------------
  Encryptor: T('Encryptor', 'security', ['encryptionType', 'signatureAlgorithm', 'encryptionAlgorithm', 'userIds']),
  Decryptor: T('Decryptor', 'security', ['decryptionType', 'secretKeyAlias']),
  Signer: T('Signer', 'security', ['signatureType', 'signatureAlgorithm', 'privateKeyAlias']),
  Verifier: T('Verifier', 'security', ['verificationType', 'publicKeyAlias', 'includedSignerPublicKeys']),

  // --- Flow control ---------------------------------------------------
  Splitter: T('Splitter', 'flow', ['splitterType', 'xpath', 'groupingValue', 'parallelProcessing', 'stopOnException', 'streaming']),
  GeneralSplitter: T('General Splitter', 'flow', ['xpath', 'groupingValue', 'parallelProcessing', 'stopOnException', 'streaming']),
  IterativeSplitter: T('Iterating Splitter', 'flow', ['xpath', 'groupingValue', 'parallelProcessing', 'stopOnException', 'streaming']),
  EDISplitter: T('EDI Splitter', 'flow', ['splitterType', 'stopOnException']),
  ZipSplitter: T('Zip Splitter', 'flow', []),
  PKCS7Splitter: T('PKCS7/CMS Splitter', 'flow', []),
  Gather: T('Gather', 'flow', ['aggregationAlgorithm', 'incomingFormat']),
  Join: T('Join', 'flow', []),
  Aggregator: T('Aggregator', 'flow', ['correlationExpression', 'completionCondition', 'completionTimeout', 'aggregationAlgorithm', 'dataStoreName']),
  Multicast: T('Multicast', 'routing', ['multicastType']),
  ParallelMulticast: T('Parallel Multicast', 'routing', []),
  SequentialMulticast: T('Sequential Multicast', 'routing', ['sequence']),
};

export const EVENT_TYPES = {
  StartEvent: T('Start', 'start', []),
  MessageStartEvent: T('Message Start', 'start', []),
  Timer: T('Timer Start', 'start', ['scheduleKey', 'throwException'], 'Schedules the integration flow.'),
  TimerStartEvent: T('Timer Start', 'start', ['scheduleKey']),
  ErrorStartEvent: T('Error Start', 'start', []),
  EndEvent: T('End', 'end', []),
  MessageEndEvent: T('Message End', 'end', []),
  ErrorEndEvent: T('Error End', 'end', ['errorMessage'], 'Terminates the flow with an error.'),
  EscalationEndEvent: T('Escalation End', 'end', []),
  TerminateEndEvent: T('Terminate', 'end', []),
  DelayEvent: T('Delay', 'event', ['delayValue', 'delayUnit']),
  ErrorEvent: T('Error', 'event', []),
};

export const GATEWAY_TYPES = {
  ExclusiveGateway: T('Router', 'routing', ['throwException'], 'Routes the message down the first branch whose condition matches.'),
  ParallelGateway: T('Parallel Gateway', 'routing', []),
  EventBasedGateway: T('Event-based Gateway', 'routing', []),
};

/** Adapter families, keyed by the ComponentType property on a message flow. */
export const ADAPTERS = {
  HTTPS: { label: 'HTTPS (sender)', keys: ['urlPath', 'senderAuthType', 'userRole', 'clientCertificates', 'maximumBodySize', 'xsrfProtection'] },
  HTTP: { label: 'HTTP (receiver)', keys: ['httpAddressWithoutQuery', 'httpMethod', 'httpRequestTimeout', 'authenticationMethod', 'credentialName', 'privateKeyAlias', 'httpRequestHeaders'] },
  SOAP: { label: 'SOAP', keys: ['address', 'wsdlURL', 'operationName', 'authenticationMethod', 'credentialName', 'privateKeyAlias', 'proxyType', 'allowChunking'] },
  IDOC: { label: 'IDoc', keys: ['address', 'authenticationMethod', 'credentialName', 'idocSenderPort', 'idocReceiverPort'] },
  SFTP: { label: 'SFTP', keys: ['host', 'path', 'fileName', 'authenticationMethod', 'userName', 'credentialName', 'privateKeyAlias', 'scheduleKey', 'postProcessing', 'archiveDirectory'] },
  FTP: { label: 'FTP', keys: ['host', 'path', 'fileName', 'credentialName', 'scheduleKey', 'postProcessing'] },
  FILE: { label: 'File', keys: ['path', 'fileName', 'postProcessing'] },
  MAIL: { label: 'Mail', keys: ['address', 'from', 'to', 'cc', 'subject', 'credentialName', 'protection'] },
  JMS: { label: 'JMS', keys: ['queueName', 'retryInterval', 'exponentialBackoff', 'maximumRetryInterval', 'expirationPeriod', 'deadLetterQueue'] },
  AMQP: { label: 'AMQP', keys: ['queueName', 'destinationName', 'host', 'credentialName'] },
  Kafka: { label: 'Kafka', keys: ['host', 'topic', 'consumerGroup', 'credentialName', 'saslMechanism'] },
  ProcessDirect: { label: 'ProcessDirect', keys: ['address'] },
  XI: { label: 'XI', keys: ['address', 'authenticationMethod', 'credentialName', 'senderPartyName', 'senderComponentName', 'receiverPartyName', 'receiverComponentName', 'interfaceName', 'interfaceNamespace'] },
  AS2: { label: 'AS2', keys: ['address', 'as2From', 'as2To', 'messageSubject', 'mdnType', 'signingAlgorithm', 'encryptionAlgorithm'] },
  AS4: { label: 'AS4', keys: ['address', 'fromPartyId', 'toPartyId', 'agreementRef'] },
  OData: { label: 'OData', keys: ['address', 'resourcePath', 'operation', 'odataFields', 'queryOptions', 'authenticationMethod', 'credentialName', 'pageSize'] },
  ODataV2: { label: 'OData V2', keys: ['address', 'resourcePath', 'operation', 'queryOptions', 'credentialName'] },
  SuccessFactors: { label: 'SuccessFactors', keys: ['address', 'operation', 'credentialName', 'entity', 'queryOptions'] },
  SFSF: { label: 'SuccessFactors', keys: ['address', 'operation', 'credentialName', 'entity'] },
  Ariba: { label: 'Ariba', keys: ['address', 'credentialName', 'operation'] },
  RFC: { label: 'RFC', keys: ['destinationName', 'rfcName'] },
  JDBC: { label: 'JDBC', keys: ['jdbcDataSourceAlias', 'batchMode'] },
  OpenConnectors: { label: 'Open Connectors', keys: ['address', 'resource', 'credentialName'] },
  ELSTER: { label: 'ELSTER', keys: ['address'] },
  Splitter: { label: 'Splitter', keys: [] },
};

/** Property keys whose *value* is a credential/secret alias rather than a secret. */
export const SECRET_KEYS = [
  'credentialName', 'privateKeyAlias', 'publicKeyAlias', 'secretKeyAlias',
  'userCredentialName', 'oauthCredentialName', 'jdbcDataSourceAlias',
];

const CONNECTOR_STEP = { label: 'Sequence Flow', category: 'flow', keys: [] };

/** Look up display metadata for a parsed step. */
export function describeStep(step) {
  const type = step.activityType || '';
  const byActivity = ACTIVITY_TYPES[type] || EVENT_TYPES[type] || GATEWAY_TYPES[type];
  if (byActivity) return byActivity;

  switch (step.tag) {
    case 'startEvent': return EVENT_TYPES.StartEvent;
    case 'endEvent': return EVENT_TYPES.EndEvent;
    case 'exclusiveGateway': return GATEWAY_TYPES.ExclusiveGateway;
    case 'parallelGateway': return GATEWAY_TYPES.ParallelGateway;
    case 'eventBasedGateway': return GATEWAY_TYPES.EventBasedGateway;
    case 'boundaryEvent': return T('Boundary Event', 'event', []);
    case 'intermediateCatchEvent':
    case 'intermediateThrowEvent': return T('Intermediate Event', 'event', []);
    case 'subProcess': return T('Sub-process', 'flow', []);
    case 'receiveTask': return T('Receive', 'call', []);
    case 'serviceTask': return T('Service Task', 'call', []);
    case 'callActivity': return T(humanise(type) || 'Step', 'other', []);
    case 'sequenceFlow': return CONNECTOR_STEP;
    default: return T(humanise(type) || humanise(step.tag) || 'Step', 'other', []);
  }
}

export function describeAdapter(componentType) {
  return ADAPTERS[componentType] || { label: humanise(componentType) || 'Adapter', keys: [] };
}

/**
 * Property keys whose camel-case split reads badly or whose SAP-internal name
 * means nothing to a reader. Everything else falls through to humanise().
 */
const LABELS = {
  mappingname: 'Mapping name',
  mappingpath: 'Mapping file',
  mappinguri: 'Mapping URI',
  mappingType: 'Mapping type',
  mappingSource: 'Stylesheet',
  xpath: 'XPath',
  xsdURI: 'Schema (XSD)',
  urlPath: 'URL path',
  httpAddressWithoutQuery: 'Address',
  httpMethod: 'HTTP method',
  httpRequestTimeout: 'Request timeout (ms)',
  httpRequestHeaders: 'Request headers',
  scheduleKey: 'Schedule',
  entryID: 'Entry ID',
  storeName: 'Data store',
  credentialName: 'Credential alias',
  privateKeyAlias: 'Private key alias',
  publicKeyAlias: 'Public key alias',
  secretKeyAlias: 'Secret key alias',
  jdbcDataSourceAlias: 'JDBC data source alias',
  queueName: 'Queue',
  senderAuthType: 'Sender authentication',
  userRole: 'Authorisation role',
  retentionThreshold: 'Retention (days)',
  numberOfPolledMessages: 'Messages per poll',
  overwriteExistingMessage: 'Overwrite existing entry',
  groupingValue: 'Grouping',
  parallelProcessing: 'Parallel processing',
  stopOnException: 'Stop on exception',
  throwException: 'Throw exception on failure',
  preventException: 'Continue on validation error',
  odataFields: 'Selected fields',
  queryOptions: 'Query options',
  resourcePath: 'Resource path',
  pageSize: 'Page size',
  wsdlURL: 'WSDL',
  as2From: 'AS2 sender ID',
  as2To: 'AS2 receiver ID',
  bodyType: 'Body source',
  wrapContent: 'Wrap content in',
  scriptFunction: 'Entry point',
  script: 'Script file',
  errorMessage: 'Error message',
  correlationExpression: 'Correlation',
  completionCondition: 'Completion condition',
  completionTimeout: 'Completion timeout',
  aggregationAlgorithm: 'Aggregation strategy',
  postProcessing: 'After processing',
  archiveDirectory: 'Archive directory',
  deadLetterQueue: 'Dead-letter queue',
  expirationPeriod: 'Expiry (days)',
  retryInterval: 'Retry interval',
};

/** Reader-facing label for a property key. */
export function labelFor(key) {
  return LABELS[key] || humanise(key);
}

const ARTEFACT_TYPES = {
  iflow: 'Integration flow',
  valuemapping: 'Value mapping',
  scriptcollection: 'Script collection',
  other: 'Artefact',
};

/** Reader-facing name for an artefact type ("iflow" -> "Integration flow"). */
export function typeLabel(type) {
  return ARTEFACT_TYPES[type] || humanise(type) || 'Artefact';
}

/** "JsonToXmlConverter" -> "Json To Xml Converter" */
export function humanise(value) {
  if (!value) return '';
  return String(value)
    .replace(/[_.]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Content Modifier property/header tables are stored as an escaped XML blob of
 * <row><cell><id>..</id><value>..</value></cell>...</row>. Returns one object
 * per row, keyed by cell id.
 */
export function parseCellTable(value) {
  if (!value || value.indexOf('<row') === -1) return [];
  const doc = parseXml(`<table>${value}</table>`);
  const table = childrenOf(doc, 'table')[0];
  return childrenOf(table, 'row').map((row) => {
    const entry = {};
    for (const cell of childrenOf(row, 'cell')) {
      const id = text(childrenOf(cell, 'id')[0]).trim();
      if (id) entry[id] = text(childrenOf(cell, 'value')[0]);
    }
    return entry;
  });
}

/** True when a property value is worth rendering (non-empty, not a default marker). */
export function isMeaningful(value) {
  if (value === undefined || value === null) return false;
  const v = String(value).trim();
  return v !== '' && v !== 'null' && v !== 'undefined';
}
