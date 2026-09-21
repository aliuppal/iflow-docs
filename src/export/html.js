/**
 * Self-contained HTML export.
 *
 * One file, no network access, no external scripts: it can be attached to a
 * change request, checked into a repo or opened years later from a shared drive
 * and still render exactly as it did on screen. The only script is the small
 * inline one behind the Print button (and a one-line theme toggle).
 */

import { DOC_CSS } from '../render/doc-css.js';
import { printWithPicker } from '../render/print-picker.js';
import { renderDocument, renderPackageIndex, documentSections, esc } from '../render/document.js';
import { cssId } from '../render/diagram.js';

export function buildStandaloneHtml(archive, docs, options = {}) {
  const multi = docs.length > 1 || archive.kind === 'package';
  const title = multi ? archive.sourceName.replace(/\.zip$/i, '') : docs[0] ? docs[0].name : 'Integration documentation';
  const generated = new Date();

  // Tells the print picker which file each document came from, so a PDF of
  // several of them is named after the package rather than after one document.
  const source = (articleHtml) =>
    articleHtml.replace('<article class="doc', `<article data-print-source="${esc(archive.sourceName)}" class="doc`);

  const body = [];
  if (multi) body.push(source(renderPackageIndex(archive, docs)));
  for (const doc of docs) body.push(source(renderDocument(doc, { linkPrefix: '' })));

  const toc = buildToc(archive, docs, multi);

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)} — integration documentation</title>
<meta name="generator" content="SAP CPI iFlow Documentation Generator">
<style>
${DOC_CSS}
${SHELL_CSS}
</style>
</head>
<body>
<div class="export-shell">
  <nav class="export-toc" aria-label="Contents">
    <p class="toc-title">Contents</p>
    ${toc}
  </nav>
  <main class="export-main">
    <p class="export-meta">Generated ${esc(generated.toLocaleString())} from <code>${esc(archive.sourceName)}</code>
      · <button type="button" class="theme-btn" onclick="(function(r){r.dataset.theme=r.dataset.theme==='dark'?'light':'dark'})(document.documentElement)">Toggle theme</button>
      · <button type="button" class="theme-btn" onclick="printDocuments()">Print / PDF</button></p>
    ${body.join('')}
  </main>
</div>
<script>
/* Print / PDF: with several documents in the file, ask which to include first. */
window.printDocuments = function () {
  (${printWithPicker.toString()})(document.querySelector('.export-main'));
};
</script>
</body>
</html>`;
}

function buildToc(archive, docs, multi) {
  const parts = [];
  if (multi) parts.push('<ul class="toc-list"><li><a href="#package-index">Package overview</a></li></ul>');
  for (const doc of docs) {
    const anchor = `doc-${cssId(doc.id || doc.name)}`;
    parts.push(
      `<p class="toc-doc"><a href="#${esc(anchor)}">${esc(doc.name)}</a></p>` +
      '<ul class="toc-list">' +
      documentSections(doc)
        .map((s) => `<li><a href="#${esc(s.id)}">${esc(s.label)}</a></li>`)
        .join('') +
      '</ul>'
    );
  }
  return parts.join('');
}

const SHELL_CSS = `
body{margin:0;background:var(--bg);color:var(--fg);
  font-family:"Segoe UI",system-ui,-apple-system,sans-serif}
.export-shell{display:grid;grid-template-columns:16rem minmax(0,1fr);gap:2rem;
  max-width:88rem;margin:0 auto;padding:0 1.5rem}
.export-toc{position:sticky;top:0;align-self:start;max-height:100vh;overflow-y:auto;
  padding:2rem .5rem 2rem 0;font-size:.85rem}
.toc-title{margin:0 0 .5rem;font-size:.7rem;text-transform:uppercase;letter-spacing:.09em;
  color:var(--fg-muted);font-weight:700}
.toc-doc{margin:1rem 0 .25rem;font-weight:600}
.toc-doc a{color:var(--fg);text-decoration:none}
.toc-list{list-style:none;margin:0 0 .5rem;padding:0 0 0 .1rem;border-left:1px solid var(--line)}
.toc-list li{margin:0}
.toc-list a{display:block;padding:.2rem .6rem;color:var(--fg-muted);text-decoration:none;border-radius:0 4px 4px 0}
.toc-list a:hover{background:var(--bg-sunk);color:var(--fg)}
.export-main{min-width:0;padding-bottom:4rem}
.export-meta{margin:1.5rem 0 0;font-size:.78rem;color:var(--fg-muted)}
.theme-btn{font:inherit;font-size:.78rem;background:none;border:0;padding:0;
  color:var(--accent);cursor:pointer;text-decoration:underline}
@media (max-width:900px){
  .export-shell{grid-template-columns:1fr;gap:0}
  .export-toc{position:static;max-height:none;padding:1.5rem 0 0}
}
@media print{
  .export-toc,.export-meta{display:none}
  .export-shell{display:block;padding:0;max-width:none}
}
`;
