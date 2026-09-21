/**
 * End-to-end check of the parsing and rendering pipeline, outside the browser.
 *
 *   node tools/test-parse.mjs            run the checks
 *   node tools/test-parse.mjs --emit     also write the rendered output to samples/out/
 *
 * The site's modules are DOM-free up to the point of producing HTML strings, so
 * the same code that runs in the browser runs here.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { loadArchive } from '../src/parse/archive.js';
import { buildDoc } from '../src/model/analyze.js';
import { buildStandaloneHtml } from '../src/export/html.js';
import { renderMarkdown, renderPackageMarkdown } from '../src/export/markdown.js';
import { renderDiagram } from '../src/render/diagram.js';
import { analyzeScript } from '../src/parse/groovy.js';
import { makeZip } from './zip-writer.mjs';

const SAMPLES = fileURLToPath(new URL('../samples/', import.meta.url));
const EMIT = process.argv.includes('--emit');

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Node has no File; loadArchive only needs .name/.size/.arrayBuffer(). */
async function fileFrom(path, name) {
  const buffer = await readFile(path);
  return {
    name,
    size: buffer.length,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

async function testSingleIflow() {
  console.log('\nSingle integration flow export');
  const archive = await loadArchive(await fileFrom(join(SAMPLES, 'Employee_Replication_SFSF_to_S4.zip'), 'Employee_Replication_SFSF_to_S4.zip'));

  check('archive recognised as an iFlow', archive.kind === 'iflow', `got "${archive.kind}"`);
  check('one artefact found', archive.artifacts.length === 1);

  const artifact = archive.artifacts[0];
  check('bundle name read from the manifest', artifact.name === 'Employee Replication SFSF to S4', `got "${artifact.name}"`);
  check('version read from the manifest', artifact.version === '1.3.2', `got "${artifact.version}"`);
  check('folded Import-Package header rejoined', (artifact.importPackages || []).includes('com.sap.esb.camel.security.cms'));
  check('three scripts extracted', artifact.scripts.length === 3, `got ${artifact.scripts.length}`);
  check('message mapping found', artifact.messageMappings.length === 1);
  check('two XSDs found', artifact.schemas.length === 2, `got ${artifact.schemas.length}`);
  check('XSLT found', artifact.xsltMappings.length === 1);
  check('parameters.prop read', artifact.parameters.values.get('Target_Company') === '1710');
  check('parameters.propdef read', artifact.parameters.definitions.length === 6, `got ${artifact.parameters.definitions.length}`);

  const doc = buildDoc(artifact);

  check('main process identified', doc.processes.some((p) => p.isMain));
  check('sender system listed', doc.senders.some((s) => s.name === 'Scheduler'));
  check('three receiver systems listed', doc.receivers.length === 3, `got ${doc.receivers.length}`);
  check('four channels documented', doc.channels.length === 4, `got ${doc.channels.length}`);
  check('one sender and three receiver channels', doc.channels.filter((c) => c.direction === 'Sender').length === 1);

  const odata = doc.channels.find((c) => c.componentType === 'OData');
  check('OData channel classified as receiver', odata && odata.direction === 'Receiver');
  check('OData endpoint carries the parameter placeholder', odata && odata.endpoint === '{{SFSF_Address}}', odata && odata.endpoint);

  const main = doc.processes.find((p) => p.isMain);
  const setup = main.steps.find((s) => s.id === 'CallActivity_Setup');
  check('content modifier named', setup && setup.typeLabel === 'Content Modifier');
  check('exchange property table parsed', setup && setup.tables.some((t) => t.title.includes('properties') && t.rows.length === 3));
  check('header table parsed', setup && setup.tables.some((t) => t.title.includes('headers') && t.rows.length === 1));
  check('message body captured', setup && setup.body && setup.body.content.includes('<Replication>'));

  const gateway = main.steps.find((s) => s.id === 'Gateway_1');
  check('router recognised', gateway && gateway.typeLabel === 'Router');
  check('two routing branches with conditions', gateway && gateway.branches.length === 2, gateway && String(gateway.branches.length));
  check('router condition text read', gateway && gateway.branches.some((b) => b.condition.includes('count(/Employees/Employee)')));
  check('default branch flagged', gateway && gateway.branches.some((b) => b.isDefault));

  const start = main.steps.find((s) => s.id === 'StartEvent_1');
  check('timer start event labelled', start && start.typeLabel === 'Timer Start');
  check('start event is step 1', start && start.label === '1');

  const mapped = main.steps.find((s) => s.id === 'CallActivity_Map');
  check('router branch numbering applied', mapped && /^4a\./.test(mapped.label), mapped && mapped.label);

  const store = main.steps.find((s) => s.id === 'CallActivity_Store');
  check('data store step named', store && store.typeLabel === 'Data Store Operation');
  check('data store operation surfaced', store && store.details.some((d) => d.key === 'operation' && d.value === 'Write'));

  check('exception subprocess documented', doc.errorHandling.length >= 1);
  const errorSteps = main.steps.filter((s) => s.raw.parentId === 'SubProcess_Error');
  check('exception subprocess contains its steps', errorSteps.length === 4, `got ${errorSteps.length}`);
  check('exception subprocess labelled E, not a main-path number',
    main.steps.find((s) => s.id === 'SubProcess_Error').label === 'E',
    main.steps.find((s) => s.id === 'SubProcess_Error').label);
  check('exception steps numbered inside E', errorSteps.every((s) => /^E\.\d/.test(s.label)), errorSteps.map((s) => s.label).join(','));
  check('main path numbering stops at the router branches',
    main.steps.filter((s) => /^\d+$/.test(s.label)).length === 4,
    main.steps.filter((s) => /^\d+$/.test(s.label)).map((s) => s.label).join(','));
  check('no step is left unlabelled', main.steps.every((s) => s.label));

  const params = new Map(doc.parameters.map((p) => [p.name, p]));
  check('parameter usage traced to a channel', params.get('SFSF_Address').usedIn.length > 0);
  check('unset-but-used parameter flagged', params.get('Timer_Schedule').empty && !params.get('Timer_Schedule').unused);
  check('unused parameter flagged', params.get('Obsolete_Endpoint').unused);

  const pd = doc.dependencies.processDirect;
  check('ProcessDirect dependency captured', pd.length === 1 && pd[0].address === '/audit/employee-replication');
  check('data store dependency captured', doc.dependencies.dataStores.some((d) => d.name === 'EMPLOYEE_ARCHIVE'));
  check('credential aliases captured', doc.dependencies.credentials.some((c) => c.alias === 'S4_BASIC_CRED'));
  check('external endpoint captured', doc.dependencies.endpoints.some((e) => e.address.includes('s4-legacy.internal.corp')));

  const titles = doc.findings.map((f) => f.title);
  check('missing script reported', titles.some((t) => t.includes('RaiseAlert.groovy') && t.includes('missing')), titles.join(' | '));
  check('unreferenced script reported', titles.some((t) => t.includes('ErrorHelper.groovy')));
  check('plain HTTP endpoint reported', titles.some((t) => t.includes('plain HTTP')));
  check('unset parameter reported', titles.some((t) => t.includes('Timer_Schedule')));
  check('anonymous sender channel reported', titles.some((t) => t.includes('no authentication')));

  const diagram = renderDiagram(doc, {});
  check('diagram rendered', !diagram.empty);
  check('diagram contains every node', countOccurrences(diagram.svg, 'class="dg-node') >= 15, String(countOccurrences(diagram.svg, 'class="dg-node')));
  check('diagram draws pools', diagram.svg.includes('dg-pool-process'));
  check('diagram draws message flows', diagram.svg.includes('dg-msg'));
  const svgTextBodies = [...diagram.svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1]);
  check('diagram label text is escaped', svgTextBodies.length > 0 && svgTextBodies.every((t) => !/[<>&](?!(amp|lt|gt|quot|#\d+);)/.test(t)));

  // Every node sets one variable name that the embedded stylesheet actually reads.
  const nodeColors = [...diagram.svg.matchAll(/style="--node-color:(#[0-9a-f]{6})"/gi)].map((m) => m[1].toLowerCase());
  check('every node carries a colour', nodeColors.length === countOccurrences(diagram.svg, 'class="dg-node'), `${nodeColors.length} coloured`);
  check('categories are visually distinguished', new Set(nodeColors).size >= 5, `${new Set(nodeColors).size} distinct colours`);
  check('no orphan --cat- variables remain', !diagram.svg.includes('--cat-'));

  // Nothing may be drawn outside the viewBox, or it is silently clipped.
  const [, , vbW, vbH] = diagram.svg.match(/viewBox="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"/).slice(1).map(Number);
  const coords = [...diagram.svg.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)];
  check('all shapes lie inside the viewBox',
    coords.every(([, x, y, w, h]) => Number(x) >= -1 && Number(y) >= -1 && Number(x) + Number(w) <= vbW + 1 && Number(y) + Number(h) <= vbH + 1),
    `viewBox ${vbW}x${vbH}`);

  // --- message mapping: structures and field links -------------------------------
  const mm = artifact.messageMappings[0];
  check('mapping source structure identified', mm.sources.some((s) => s.name === 'SFSF_PerPerson.xsd'), JSON.stringify(mm.sources.map((s) => s.name)));
  check('mapping target structure identified', mm.targets.some((s) => s.name === 'S4_Employee.xsd'), JSON.stringify(mm.targets.map((s) => s.name)));
  check('mapping field links read', mm.links.length === 4, String(mm.links.length));

  // --- script analysis ------------------------------------------------------------
  const cid = doc.scriptAnalysis.get('AddCorrelationId.groovy');
  check('script: headers read', cid.headers.reads.includes('X-Correlation-Id'));
  check('script: properties read via a map variable', cid.properties.reads.includes('RunId') && cid.properties.reads.includes('CompanyCode'), cid.properties.reads.join(','));
  check('script: header and properties set', cid.headers.writes.includes('X-Correlation-Id') && cid.properties.writes.includes('CorrelationId') && cid.properties.writes.includes('PayloadSize'));
  check('script: body read but not replaced', cid.body.reads.length === 1 && cid.body.writes.length === 0);
  check('script: message log attachment and properties', cid.messageLog.attachments.includes('Mapped payload') && cid.messageLog.properties.includes('RunId'));
  check('script: raised exception captured', cid.raises.some((r) => r.type === 'IllegalStateException'));
  check('script: own description used as its purpose', /Stamps a correlation id/.test(cid.purpose), cid.purpose);
  check('script: entry point found', cid.functions.includes('processData'));
  const empty = doc.scriptAnalysis.get('LogEmptyResult.groovy');
  check('script: an empty setBody is recognised as clearing the body', empty.body.writes.length === 1 && empty.body.writes[0].empty);

  // --- process summary ------------------------------------------------------------
  const sm = doc.summary;
  check('summary built', Boolean(sm));
  check('headline names the trigger, source, targets and store',
    /timer/.test(sm.headline) && sm.headline.includes('SuccessFactors EC') && sm.headline.includes('S/4HANA') && sm.headline.includes('EMPLOYEE_ARCHIVE'), sm.headline);
  check('headline reports both the timer and the callable sender', /timer \(or a call from \*\*Scheduler\*\*\)/.test(sm.headline), sm.headline);

  const flow = sm.flows.find((f) => f.isMain);
  const byId = (id) => flow.steps.find((s) => s.id === id) || flow.errorSteps.find((s) => s.id === id);
  check('walkthrough covers every main-path step', flow.steps.length === 13, String(flow.steps.length));
  check('walkthrough separates the error path', flow.errorSteps.length === 5, String(flow.errorSteps.length));
  check('read step says where data comes from', /Reads data from \*\*SuccessFactors EC\*\* via OData/.test(byId('CallActivity_Fetch').text) && byId('CallActivity_Fetch').text.includes('https://api4.successfactors.com/odata/v2'));
  check('endpoint parameters are resolved to their values', !byId('CallActivity_Fetch').text.includes('{{SFSF_Address}}'));
  check('write step says where data goes', /Sends a request to \*\*S\/4HANA\*\*/.test(byId('CallActivity_Post').text));
  check('mapping step names source, target and field count', /from `SFSF_PerPerson\.xsd` to `S4_Employee\.xsd`/.test(byId('CallActivity_Map').text) && byId('CallActivity_Map').text.includes('4 fields'), byId('CallActivity_Map').text);
  check('script step summarises what the script does', /reads header `X-Correlation-Id`/.test(byId('CallActivity_Enrich').text) && /Groovy script/.test(byId('CallActivity_Enrich').text), byId('CallActivity_Enrich').text.slice(0, 120));
  check('router lists each branch with its condition and target', (() => {
    const g = byId('Gateway_1');
    return g.branches.length === 2 && g.branches.some((b) => b.condition.includes('count(/Employees/Employee) > 0') && b.toLabel === '4a.1') && g.branches.some((b) => b.isDefault && b.toLabel === '4b.1');
  })());

  // --- data lineage -----------------------------------------------------------------
  const lineage = new Map(doc.dataFlow.map((v) => [`${v.kind}:${v.name}`, v]));
  const runId = lineage.get('property:RunId');
  check('lineage: property set by the content modifier', runId.setBy.length === 1 && runId.setBy[0].id === 'CallActivity_Setup');
  check('lineage: property read by the script and the data store', ['CallActivity_Enrich', 'CallActivity_Store'].every((id) => runId.readBy.some((r) => r.id === id)));
  const enrichReads = byId('CallActivity_Enrich').reads.find((r) => r.name === 'RunId');
  check('a read points back at the step that set it', enrichReads && enrichReads.from && enrichReads.from.label === '2' && enrichReads.origin === 'flow', JSON.stringify(enrichReads && enrichReads.from));
  check('runtime-supplied headers are recognised', lineage.get('header:CamelCorrelationId').origin === 'runtime');
  const xcid = lineage.get('header:X-Correlation-Id');
  check('a header read before anything sets it is expected from the caller', xcid.externalReaders.length === 1 && xcid.externalReaders[0].id === 'CallActivity_Enrich');
  check('that header is listed under Data in', sm.inputs.some((i) => i.text.includes('X-Correlation-Id') && /caller/.test(i.text)));

  // --- inputs, outputs, results -----------------------------------------------------
  check('data in lists the timer, the sender and the lookup', sm.inputs.some((i) => /timer/i.test(i.text)) && sm.inputs.some((i) => i.text.includes('/employee/replicate')) && sm.inputs.some((i) => /SuccessFactors EC/.test(i.text)));
  check('data out lists the S/4 request, data store, hand-off and log', ['S/4HANA', 'EMPLOYEE_ARCHIVE', '/audit/employee-replication', 'Mapped payload'].every((needle) => sm.outputs.some((o) => o.text.includes(needle))));
  check('a read-only call is not listed as data out', !sm.outputs.some((o) => o.text.includes('SuccessFactors EC')));
  const end1 = sm.results.find((r) => r.id === 'EndEvent_1');
  check('result traces the final body to the last step that changed it', end1 && end1.origin && end1.origin.id === 'CallActivity_Post' && /response from S\/4HANA/.test(end1.text), end1 && end1.text);
  const end2 = sm.results.find((r) => r.id === 'EndEvent_Empty');
  check('result recognises a body cleared by a script', end2 && end2.origin.id === 'CallActivity_NoData' && /empty body/.test(end2.text), end2 && end2.text);
  check('timer + caller flow explains both cases', /When the timer starts the flow nothing is returned/.test(end1.text) && /waits for a reply/.test(end1.text), end1.text);
  check('error path is described', /exception subprocess/.test(sm.errorText) && sm.hasErrorPath);
  check('runtime-computed names would be flagged, not guessed', (() => {
    const a = analyzeScript("message.setHeader(someVar, 'x')\nmessage.getProperty(other)");
    return a.headers.dynamicWrite && a.properties.dynamicRead && a.headers.writes.length === 0;
  })());

  const html = buildStandaloneHtml(archive, [doc]);
  check('HTML has the process summary section', html.includes('>Process summary<') && html.includes('Data in') && html.includes('Data out') && html.includes('What happens, step by step'));
  check('HTML shows what each script does', html.includes('What this script does') && html.includes('It reads header'));
  check('HTML shows the data lineage table', html.includes('Data passed between steps'));
  check('HTML step cards show the data they use', html.includes('Data used'));
  check('HTML export has no external script; the only script is the inline print picker',
    !/<script[^>]*\ssrc=/i.test(html) && (html.match(/<script/gi) || []).length === 1 && html.includes('window.printDocuments'));
  check('the embedded print picker is valid JavaScript', (() => {
    const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    try { new Function(src); return true; } catch (err) { return false; }
  })());
  check('print picker and print-skip styles ship in the export', html.includes('.print-picker') && html.includes('.doc[data-print-skip]'));
  check('every document in the export records its source file for the print picker',
    (html.match(/<article data-print-source="Employee_Replication_SFSF_to_S4\.zip" class="doc/g) || []).length === 1);
  check('the embedded print picker sets the PDF file name from the selection', html.includes('titleFor') && html.includes('afterprint'));
  check('artefact types read as words, not identifiers', html.includes('>Integration flow<') && !html.includes('>Iflow<'));
  check('standalone HTML is a full document', html.startsWith('<!doctype html>'));
  check('standalone HTML embeds the stylesheet', html.includes('.card-step'));
  check('standalone HTML embeds the diagram', html.includes('<svg class="iflow-diagram"'));
  check('standalone HTML has no external references', !/(src|href)\s*=\s*"(https?:)?\/\//i.test(html));
  check('script source included verbatim', html.includes('messageLogFactory.getMessageLog'));

  const md = renderMarkdown(doc);
  check('markdown has a title', md.startsWith('# Employee Replication SFSF to S4'));
  check('markdown includes a mermaid diagram', md.includes('```mermaid') && md.includes('flowchart TD'));
  check('markdown lists parameters', md.includes('| `Target_Company` |'));
  check('markdown includes script source', md.includes('```groovy'));
  check('markdown has the process summary', md.includes('## Process summary') && md.includes('### Data in') && md.includes('### Data out') && md.includes('### Result'));
  check('markdown lists what steps use and set', md.includes('Uses: property `RunId` (set at 2)') && md.includes('Sets: header `X-Correlation-Id`'));
  check('markdown explains each script', md.includes('- It reads header `X-Correlation-Id`'));
  check('markdown has the lineage table', md.includes('### Data passed between steps') && md.includes('| Property `RunId` |'));
  check('markdown documents dependencies', md.includes('## Dependencies') && md.includes('/audit/employee-replication'));
  check('markdown documents error handling', md.includes('## Error handling') && md.includes('Build Error Payload'));
  check('markdown table cells escape pipes', !md.split('\n').some((line) => line.startsWith('|') && /[^\\]\|/.test(line.slice(1, -1).replace(/ \| /g, ''))));

  return { archive, doc, html, md };
}

async function testPackage() {
  console.log('\nIntegration package export');
  const archive = await loadArchive(await fileFrom(join(SAMPLES, 'HR_Integration_Suite_package.zip'), 'HR_Integration_Suite_package.zip'));

  check('archive recognised as a package', archive.kind === 'package', `got "${archive.kind}"`);
  check('three artefacts found', archive.artifacts.length === 3, `got ${archive.artifacts.length}`);

  const docs = archive.artifacts.map(buildDoc);
  check('value mapping artefact typed', docs.some((d) => d.type === 'valuemapping'), docs.map((d) => d.type).join(','));
  check('value mapping entries parsed', archive.artifacts.some((a) => a.valueMappings.some((v) => v.groups.length === 2)));

  const audit = docs.find((d) => d.name === 'Audit Sink');
  check('audit flow parsed', Boolean(audit));
  check('audit flow has a ProcessDirect sender', audit.dependencies.processDirect.some((p) => p.direction === 'Sender' && p.address === '/audit/employee-replication'));
  check('audit flow has a JMS queue', audit.dependencies.queues.some((q) => q.name === 'audit.employee.events'));

  check('sender-started flow: headline names the caller', /Started by a message from \*\*Any Flow\*\*/.test(audit.summary.headline), audit.summary.headline);
  check('sender-started flow: result says the caller receives the body', audit.summary.results.length === 1 && /waits for a reply/.test(audit.summary.results[0].text) && /as received from Any Flow/.test(audit.summary.results[0].text), audit.summary.results[0].text);
  check('flow with no exception subprocess says so', /no exception subprocess/.test(audit.summary.errorText) && !audit.summary.hasErrorPath);
  check('artefact without a flow has no summary', docs.filter((d) => d.type === 'valuemapping').every((d) => d.summary === null));

  const employee = docs.find((d) => d.name.startsWith('Employee'));
  check('package links the two flows on the same address',
    employee.dependencies.processDirect[0].address === audit.dependencies.processDirect[0].address);

  const html = buildStandaloneHtml(archive, docs);
  check('package HTML has an index', html.includes('id="package-index"'));
  check('package HTML lists internal hand-offs', html.includes('Internal hand-offs'));
  check('package HTML contains all three artefacts', countOccurrences(html, 'class="doc-header"') === 4, String(countOccurrences(html, 'class="doc-header"')));

  // Several documents on one page: ids must not collide or the contents links
  // and the clickable diagram all jump to the first flow.
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  check('no duplicate element ids across documents', duplicates.length === 0, [...new Set(duplicates)].slice(0, 5).join(', '));

  const idSet = new Set(ids);
  const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  const dangling = [...new Set(hrefs)].filter((h) => !idSet.has(h));
  check('every internal link resolves to an element', dangling.length === 0, dangling.slice(0, 5).join(', '));
  check('contents covers every document', hrefs.filter((h) => h.endsWith('--overview')).length === docs.length);
  check('diagram nodes link into their own document', hrefs.some((h) => /--step-/.test(h)));

  const md = renderPackageMarkdown(archive, docs);
  check('package markdown lists artefacts', md.includes('| Audit Sink |'));

  return { archive, docs, html, md };
}

function testEdgeCases() {
  console.log('\nRobustness');
  const empty = {
    name: 'Empty', id: 'empty', version: '', description: '', type: 'other', zipName: 'x.zip',
    iflw: null, scripts: [], messageMappings: [], xsltMappings: [], schemas: [], valueMappings: [],
    otherResources: [], manifestHeaders: [], warnings: [], parameters: { values: new Map(), definitions: [] },
  };
  const doc = buildDoc(empty);
  check('artefact without an iFlow still builds a document', doc.name === 'Empty' && doc.processes.length === 0);

  const diagram = renderDiagram(doc, {});
  check('missing diagram degrades gracefully', diagram.empty && Boolean(diagram.reason));
}

/**
 * A real package export has no ".zip" anywhere: artefacts are "<id>_content".
 * Detection must go by content, and survive a wrapper folder or a re-zip.
 */
async function testPackageLayouts() {
  console.log('\nPackage layouts as Cloud Integration writes them');
  const layouts = [
    ['HR_Integration_Suite_cpi_layout.zip', 'extension-less <id>_content entries'],
    ['HR_Integration_Suite_wrapped.zip', 'wrapped in an extra folder'],
    ['HR_Integration_Suite_zip_in_zip.zip', 'package zipped inside another zip'],
  ];
  for (const [file, label] of layouts) {
    const archive = await loadArchive(await fileFrom(join(SAMPLES, file), file));
    check(`${label}: recognised as a package`, archive.kind === 'package', archive.kind);
    check(`${label}: all three artefacts found`, archive.artifacts.length === 3, `${archive.artifacts.length}: ${archive.artifacts.map((a) => a.name).join(', ')}`);
    check(`${label}: nothing skipped`, archive.warnings.length === 0, archive.warnings.join(' | '));
    check(`${label}: flow, flow and value mapping told apart`,
      archive.artifacts.filter((a) => a.type === 'iflow').length === 2 && archive.artifacts.some((a) => a.type === 'valuemapping'),
      archive.artifacts.map((a) => a.type).join(','));
  }

  const archive = await loadArchive(await fileFrom(join(SAMPLES, 'HR_Integration_Suite_cpi_layout.zip'), 'x.zip'));
  check('the <id>.json display name is used as the artefact label',
    archive.artifacts.some((a) => a.zipName === 'Employee Replication (display name)'), archive.artifacts.map((a) => a.zipName).join(' | '));
  const docs = archive.artifacts.map(buildDoc);
  check('a package in that layout documents every flow',
    docs.filter((d) => d.summary).length === 2 && docs.some((d) => d.name === 'Audit Sink'));

  // When nothing is recognisable, the error says what was found instead.
  const junk = makeZip({ 'readme.txt': 'hello', 'data/notes.csv': 'a,b' });
  let message = '';
  try {
    await loadArchive({ name: 'junk.zip', size: junk.length, arrayBuffer: async () => junk.buffer.slice(junk.byteOffset, junk.byteOffset + junk.byteLength) });
  } catch (err) { message = err.message; }
  check('an unrecognised zip is rejected with a list of what it contains', /readme\.txt/.test(message) && /notes\.csv/.test(message), message);
}

/** A description typed in Cloud Integration lives in metainfo.prop, not the manifest. */
async function testMetaInfoDescription() {
  console.log('\nFlow description from metainfo.prop');
  const zip = makeZip({
    'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\nBundle-Name: Described Flow\nBundle-SymbolicName: Described_Flow\nBundle-Version: 1.0.0\n',
    'metainfo.prop': '#Store metainfo properties\ndescription=Copies orders from the shop to the ERP every night.\n',
    'src/main/resources/scenarioflows/integrationflow/Described_Flow.iflw':
      '<?xml version="1.0"?><bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D"/>',
  });
  const archive = await loadArchive({ name: 'Described_Flow.zip', size: zip.length, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) });
  const doc = buildDoc(archive.artifacts[0]);
  check('description is read from metainfo.prop', doc.description === 'Copies orders from the shop to the ERP every night.', doc.description);
  check('description appears in the overview', doc.overview.Description === doc.description);
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

async function main() {
  const single = await testSingleIflow();
  const pkg = await testPackage();
  await testPackageLayouts();
  await testMetaInfoDescription();
  testEdgeCases();

  if (EMIT) {
    const out = join(SAMPLES, 'out');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'Employee_Replication.html'), single.html);
    await writeFile(join(out, 'Employee_Replication.md'), single.md);
    await writeFile(join(out, 'HR_Integration_Suite.html'), pkg.html);
    await writeFile(join(out, 'HR_Integration_Suite.md'), pkg.md);
    console.log(`\nWrote rendered output to samples/out/`);
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error('\nUnexpected failure:', err);
  process.exit(1);
});
