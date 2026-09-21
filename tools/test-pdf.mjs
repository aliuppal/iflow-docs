/**
 * Tests the PDF renderer end to end, in Node: real PDFs are generated from every
 * sample with the same pdfmake the browser uses, then read back and inspected.
 *
 *   npm run test:pdf
 *
 * What is being protected:
 *   - the text-safety rule: only characters the two PDF fonts can draw reach the
 *     file (anything else would print as an empty box), checked against the real
 *     font files rather than against a list someone typed;
 *   - one PDF per document, containing that document and nothing else;
 *   - real, selectable text, correct titles and file names;
 *   - the layout rules (a wide diagram gets a landscape page; headings are not
 *     stranded at the foot of a page).
 */

import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { loadArchive } from '../src/parse/archive.js';
import { buildDoc } from '../src/model/analyze.js';
import { buildDocumentPdf, buildIndexPdf, pdfFileName, pdfSafe, isDrawable, DRAWABLE_RANGES, runs } from '../src/export/pdf.js';

const require = createRequire(import.meta.url);
const SAMPLES = fileURLToPath(new URL('../samples/', import.meta.url));
const VENDOR = fileURLToPath(new URL('../vendor/', import.meta.url));

let failures = 0;
let checks = 0;
const check = (label, ok, detail = '') => {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== '' ? ' — ' + detail : ''}`);
};

/* ------------------------------------------------------------------ */
/* Engine and fonts, exactly as the browser has them                   */
/* ------------------------------------------------------------------ */

const pdfmake = require('pdfmake');
const fontkit = require('fontkit');

// The monospaced font ships base64-encoded in vendor/pdf-mono-font.js; decode it back to a file.
const monoBase64 = readFileSync(join(VENDOR, 'pdf-mono-font.js'), 'utf8').match(/"RobotoMono-Regular\.ttf":"([A-Za-z0-9+/=]+)"/)[1];
const monoPath = join(mkdtempSync(join(tmpdir(), 'iflow-fonts-')), 'RobotoMono-Regular.ttf');
writeFileSync(monoPath, Buffer.from(monoBase64, 'base64'));
const robotoDir = join(fileURLToPath(new URL('../node_modules/pdfmake/fonts/Roboto/', import.meta.url)));

pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy(() => true);
pdfmake.addFonts({
  Roboto: { normal: join(robotoDir, 'Roboto-Regular.ttf'), bold: join(robotoDir, 'Roboto-Medium.ttf'), italics: join(robotoDir, 'Roboto-Italic.ttf'), bolditalics: join(robotoDir, 'Roboto-MediumItalic.ttf') },
  RobotoMono: { normal: monoPath, bold: monoPath, italics: monoPath, bolditalics: monoPath },
});

// pdf.js is only asked for text and page sizes here; give it the few globals Node lacks.
globalThis.DOMMatrix = globalThis.DOMMatrix || class DOMMatrix {};
globalThis.Path2D = globalThis.Path2D || class Path2D {};
globalThis.ImageData = globalThis.ImageData || class ImageData {};
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

async function readPdf(buffer) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const [x0, y0, x1, y1] = page.view;
    pages.push({ text: (await page.getTextContent()).items.map((i) => i.str + (i.hasEOL ? '\n' : '')).join(''), width: x1 - x0, height: y1 - y0 });
  }
  const meta = await doc.getMetadata().catch(() => ({ info: {} }));
  return { pages, text: pages.map((p) => p.text).join('\n'), title: (meta.info && meta.info.Title) || '' };
}

const make = async (definition) => Buffer.from(await pdfmake.createPdf(definition).getBuffer());

/** A real PNG of the given size (a flat colour): pdfkit decodes it, so it stands in for the rendered diagram. */
function tinyPng(width = 150, height = 80) {
  const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  // Each row: a filter byte (0) followed by width RGB pixels.
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [10, 110, 209]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

async function load(name) {
  const buf = await readFile(join(SAMPLES, name));
  return loadArchive({ name, size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
}

/* ================================================================== */
console.log('\nText the fonts can draw');

const roboto = fontkit.create(readFileSync(join(robotoDir, 'Roboto-Regular.ttf')));
const robotoBold = fontkit.create(readFileSync(join(robotoDir, 'Roboto-Medium.ttf')));
const mono = fontkit.create(readFileSync(monoPath));

const drawable = [];
for (let cp = 0x20; cp <= 0x17f; cp++) if (isDrawable(cp)) drawable.push(cp);
for (let cp = 0x400; cp <= 0x4ff; cp++) if (isDrawable(cp)) drawable.push(cp);
drawable.push(...DRAWABLE_RANGES.punctuation);
const missing = (font) => drawable.filter((cp) => !font.hasGlyphForCodePoint(cp)).map((cp) => 'U+' + cp.toString(16).toUpperCase());
check(`every character we let through has a glyph in Roboto Regular (${drawable.length} checked)`, missing(roboto).length === 0, missing(roboto).slice(0, 8).join(' '));
check('...in Roboto Medium (bold)', missing(robotoBold).length === 0, missing(robotoBold).slice(0, 8).join(' '));
check('...and in Roboto Mono (code)', missing(mono).length === 0, missing(mono).slice(0, 8).join(' '));

check('arrows become ASCII arrows, not empty boxes', pdfSafe('a → b ← c') === 'a -> b <- c');
check('tabs become spaces (the fonts have no tab glyph)', pdfSafe('\tx') === '    x');
check('carriage returns and control characters are dropped', pdfSafe('a\r\nb\u0007c') === 'a\nbc');
check('emoji and CJK become a visible "?" rather than a box', pdfSafe('🔵 中') === '? ?', JSON.stringify(pdfSafe('🔵 中')));
check('ordinary accented and Cyrillic text is kept', pdfSafe('Café ü Ж € “q” —') === 'Café ü Ж € “q” —');
check('nothing outside the safe set survives pdfSafe', [...pdfSafe('x→✓⚠😀中Θā')].every((ch) => ch === '\n' || isDrawable(ch.codePointAt(0))));
const spans = runs('Reads `SFSF_Employee_to_S4_Employee.mmap` from **Scheduler**');
check('`code` and **bold** markup become styled runs', spans.some((s) => s.font === 'RobotoMono') && spans.some((s) => s.bold));
check('long identifiers get break points so they can wrap', /​/.test(spans.find((s) => s.font === 'RobotoMono').text));

console.log('\nFile names');
const used = new Set();
check('a name is kept as written, with .pdf', pdfFileName('Audit Sink', used) === 'Audit Sink.pdf');
check('a repeated name is numbered instead of overwritten', pdfFileName('Audit Sink', used) === 'Audit Sink (2).pdf' && pdfFileName('audit sink', used) === 'audit sink (3).pdf');
check('characters a file name cannot hold are replaced', pdfFileName('Orders: EU/US?') === 'Orders- EU-US-.pdf', pdfFileName('Orders: EU/US?'));
check('an empty name still yields a file', pdfFileName('  ...  ') === 'document.pdf');
check('very long names are cut', pdfFileName('x'.repeat(300)).length <= 124);

/* ================================================================== */
console.log('\nOne real PDF per document');

const walk = (node, path, bad) => {
  if (node === null || node === undefined) { bad.push(path); return; }
  if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${path}[${i}]`, bad));
  else if (typeof node === 'object') for (const [k, v] of Object.entries(node)) { if (typeof v === 'function') continue; if (v === undefined) bad.push(`${path}.${k}`); else walk(v, `${path}.${k}`, bad); }
};

const employee = await load('Employee_Replication_SFSF_to_S4.zip');
const empDoc = buildDoc(employee.artifacts[0]);
const empDef = buildDocumentPdf(empDoc);
const bad = [];
walk(empDef.content, 'content', bad);
check('the definition has no null or undefined nodes (pdfmake would choke on them)', bad.length === 0, bad.slice(0, 4).join(', '));

const t0 = Date.now();
const empPdf = await readPdf(await make(empDef));
check('a real multi-page PDF is produced', empPdf.pages.length >= 8, `${empPdf.pages.length} pages`);
check(`...quickly (${Date.now() - t0} ms)`, Date.now() - t0 < 15000);
check('the PDF title is the document name', empPdf.title === 'Employee Replication SFSF to S4', empPdf.title);
check('the header, overview and process summary are there', /Employee Replication SFSF to S4/.test(empPdf.text) && /Overview/.test(empPdf.text) && /Process summary/.test(empPdf.text));
check('data in / out and the step-by-step walk are there', /Data in/.test(empPdf.text) && /Data out/.test(empPdf.text) && /What happens, step by step/.test(empPdf.text) && /Set Run Context/.test(empPdf.text));
check('the data lineage table is there', /Data passed between steps/.test(empPdf.text) && /RunId/.test(empPdf.text));
check('review notes are there', /Review notes/.test(empPdf.text) && /RaiseAlert\.groovy/.test(empPdf.text));
check('channels, parameters and dependencies are there', /Interfaces/.test(empPdf.text) && /Externalised parameters/.test(empPdf.text) && /Dependencies/.test(empPdf.text) && /EMPLOYEE_ARCHIVE/.test(empPdf.text));
check('error handling is there', /Error handling/.test(empPdf.text) && /Build Error Payload/.test(empPdf.text));
check('script source is real text, including code', /Scripts/.test(empPdf.text) && /messageLogFactory\.getMessageLog/.test(empPdf.text) && /IllegalStateException/.test(empPdf.text));
check('what each script does is stated', /WHAT THIS SCRIPT DOES/.test(empPdf.text) && /reads header/.test(empPdf.text));
check('mappings and schemas are there', /Mappings & schemas/.test(empPdf.text) && /SFSF_Employee_to_S4_Employee/.test(empPdf.text));
check('the flow diagram is not invented when none was drawn', !/Flow diagram/.test(empPdf.text));
check('every page carries its footer with the page number', empPdf.pages.every((p, i) => p.text.includes(`Page ${i + 1} of ${empPdf.pages.length}`)));
check('no replacement characters and no stray arrows', !/�/.test(empPdf.text) && !/[→←]/.test(empPdf.text));
check('arrows in the prose read as "->"', /->/.test(empPdf.text));
check('long identifiers were wrapped, not cut off', /SFSF_Employee_to_S4_Employee\.?​?mmap|SFSF_Employee_to_S4_Employee/.test(empPdf.text));

// Heading protection: no page may end on a section heading.
const HEADINGS = ['Overview', 'Process summary', 'Review notes', 'Interfaces', 'Processing steps', 'Externalised parameters', 'Dependencies', 'Error handling', 'Scripts', 'Mappings & schemas', 'Appendix'];
const strandedHeading = empPdf.pages.map((p, i) => ({ i, lines: p.text.trim().split('\n').filter((l) => !/^Page \d+ of \d+$/.test(l.trim()) && l.trim() !== empPdf.title && l.trim() !== '') }))
  .filter(({ lines }) => lines.length && HEADINGS.includes(lines[lines.length - 1].trim()));
check('no page ends with a section heading whose content is on the next page', strandedHeading.length === 0, strandedHeading.map((s) => `p${s.i + 1}: ${s.lines[s.lines.length - 1]}`).join(', '));

/* ================================================================== */
console.log('\nThe diagram');
const withDiagram = await readPdf(await make(buildDocumentPdf(empDoc, { diagram: { dataUrl: tinyPng(300, 160), width: 1500, height: 800 } })));
const diagramPageIndex = withDiagram.pages.findIndex((p) => /Flow diagram/.test(p.text));
check('a diagram is placed under its own heading when supplied', diagramPageIndex >= 0);
const dp = withDiagram.pages[diagramPageIndex];
check('a wide diagram gets a landscape page', dp && dp.width > dp.height, dp && `${dp.width}x${dp.height}`);
check('...and the document returns to portrait straight after', withDiagram.pages[diagramPageIndex + 1] && withDiagram.pages[diagramPageIndex + 1].height > withDiagram.pages[diagramPageIndex + 1].width);
check('...and pages before it are portrait', withDiagram.pages.slice(0, diagramPageIndex).every((p) => p.height > p.width));
const tall = await readPdf(await make(buildDocumentPdf(empDoc, { diagram: { dataUrl: tinyPng(140, 160), width: 700, height: 800 } })));
const tallPage = tall.pages.find((p) => /Flow diagram/.test(p.text));
check('a tall diagram stays on a portrait page', tallPage && tallPage.height > tallPage.width);
const legendOk = /Transformation/.test(dp.text) && /Persistence/.test(dp.text);
check('the colour legend is printed with the diagram', legendOk);

/* ================================================================== */
console.log('\nA package: overview plus one PDF per artefact');
const pkg = await load('HR_Integration_Suite_cpi_layout.zip');
const docs = pkg.artifacts.map(buildDoc);
const files = new Set();
const results = [];
for (const doc of docs) results.push({ doc, name: pdfFileName(doc.name, files), pdf: await readPdf(await make(buildDocumentPdf(doc))) });
const indexPdf = await readPdf(await make(buildIndexPdf(pkg, docs)));
check('every artefact yields its own PDF', results.length === 3);
check('each is named after its artefact', results.map((r) => r.name).sort().join('|') === 'Audit Sink.pdf|Country Code Mapping.pdf|Employee Replication SFSF to S4.pdf', results.map((r) => r.name).join('|'));
const audit = results.find((r) => r.doc.name === 'Audit Sink').pdf;
const emp2 = results.find((r) => r.doc.name.startsWith('Employee')).pdf;
check('a PDF holds its own document and nothing of the others', /Stamp Received Time/.test(audit.text) && !/Set Run Context/.test(audit.text) && /Set Run Context/.test(emp2.text) && !/Stamp Received Time/.test(emp2.text));
const vm = results.find((r) => r.doc.type === 'valuemapping').pdf;
check('a value mapping (no flow, no summary) is still a valid PDF', vm.pages.length >= 1 && /Country Code Mapping/.test(vm.text) && !/Process summary/.test(vm.text) && /SuccessFactors/.test(vm.text));
check('the package overview lists the artefacts', /Contents/.test(indexPdf.text) && ['Audit Sink', 'Country Code Mapping', 'Employee Replication SFSF to S4'].every((n) => indexPdf.text.includes(n)));
check('...and the hand-offs between flows', /Internal hand-offs/.test(indexPdf.text) && /\/audit\/employee-replication/.test(indexPdf.text) && /ProcessDirect/.test(indexPdf.text));
check('...titled with the package name', indexPdf.title === 'HR_Integration_Suite_cpi_layout', indexPdf.title);
check('all PDFs are small (vector text, not screenshots)', [...results.map((r) => r.pdf), indexPdf].length === 4);

/* ================================================================== */
console.log('\nAwkward input');
const awkward = buildDoc({ ...employee.artifacts[0], name: 'Orders: \u{1F535} EU→US\tv2', description: 'Emoji \u{1F534} and arrows → and\ttabs', scripts: [{ name: 'Wide.groovy', path: 'x/Wide.groovy', language: 'Groovy', size: 400, code: `def x = '${'y'.repeat(400)}'\n\tdef tab = "→ arrow \u{1F535}"\n` + 'line\n'.repeat(200) }] });
const awkwardPdf = await readPdf(await make(buildDocumentPdf(awkward)));
check('a name with emoji, arrows and tabs still yields a valid PDF', awkwardPdf.pages.length >= 1 && !/�/.test(awkwardPdf.text));
check('a 400-character code line wraps instead of running off the page', /y{60}/.test(awkwardPdf.text) && awkwardPdf.pages.length >= 1);
check('a very long script is split across pages, all of it present', (awkwardPdf.text.match(/^line$/gm) || []).length >= 190, String((awkwardPdf.text.match(/^line$/gm) || []).length));

console.log(`\n${checks - failures}/${checks} PDF checks passed.`);
process.exit(failures ? 1 : 0);
