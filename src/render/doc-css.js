/**
 * Stylesheet for the rendered document, as a string.
 *
 * Kept here rather than in a .css file so the self-contained HTML export and the
 * live page share one source of truth — an exported document must look exactly
 * like the one on screen, with no network access.
 */

export const DOC_CSS = `
:root{
  --bg:#ffffff; --bg-sunk:#f5f7fa; --fg:#1c2530; --fg-muted:#5a6b7d;
  --line:#dde4ec; --line-soft:#eef2f6; --accent:#0a6ed1;
  --code-bg:#f6f8fa; --code-fg:#243141;
  --warn-bg:#fff7e6; --warn-line:#e8a33d;
  --err-bg:#fdeeed; --err-line:#b3261e;
  --info-bg:#eef5fd; --info-line:#0a6ed1;
  --dg-text:#1c2530; --dg-muted:#5a6b7d; --dg-pool-bg:#f4f7fa; --dg-pool-stroke:#c3ced9;
  --dg-process-bg:#fbfcfe; --dg-node-bg:#ffffff; --dg-node-stroke:#b9c4d0;
  --dg-edge:#7a8794; --dg-edge-msg:#0a6ed1; --dg-sub-bg:rgba(179,38,30,.05); --dg-sub-stroke:#e0a9a5;
  color-scheme:light;
}
:root[data-theme="dark"]{
  --bg:#12171d; --bg-sunk:#1a2027; --fg:#e6ecf2; --fg-muted:#9aa9b8;
  --line:#2c3743; --line-soft:#222b34; --accent:#6aa9e9;
  --code-bg:#0e1319; --code-fg:#d6e0ea;
  --warn-bg:#2e2410; --warn-line:#c98b28;
  --err-bg:#2e1614; --err-line:#e0776d;
  --info-bg:#122232; --info-line:#6aa9e9;
  --dg-text:#e6ecf2; --dg-muted:#9aa9b8; --dg-pool-bg:#1a2027; --dg-pool-stroke:#33404d;
  --dg-process-bg:#161c23; --dg-node-bg:#1e262e; --dg-node-stroke:#3a4855;
  --dg-edge:#7f8f9e; --dg-edge-msg:#6aa9e9; --dg-sub-bg:rgba(224,119,109,.08); --dg-sub-stroke:#7a4340;
  color-scheme:dark;
}

.doc{max-width:66rem;margin:0 auto;padding:0 0 5rem;color:var(--fg);
  font-family:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",sans-serif;
  font-size:15px;line-height:1.6;-webkit-text-size-adjust:100%}
.doc *{box-sizing:border-box}

.doc-header{padding:2rem 0 1.25rem;border-bottom:2px solid var(--line)}
.doc-kicker{margin:0;font-size:.75rem;letter-spacing:.09em;text-transform:uppercase;color:var(--fg-muted);font-weight:600}
.doc-header h1{margin:.2rem 0 .4rem;font-size:1.9rem;line-height:1.2;letter-spacing:-.01em}
.doc-description{margin:.35rem 0 .75rem;color:var(--fg-muted);max-width:52rem}
.chips{margin:.75rem 0 0;display:flex;flex-wrap:wrap;gap:.4rem}
.chip{display:inline-block;padding:.15rem .55rem;border:1px solid var(--line);border-radius:999px;
  font-size:.75rem;color:var(--fg-muted);background:var(--bg-sunk)}

.doc-section{padding-top:2.25rem;scroll-margin-top:5rem}
.doc-section > h2{margin:0 0 .35rem;font-size:1.3rem;letter-spacing:-.01em;
  padding-bottom:.35rem;border-bottom:1px solid var(--line)}
.doc-section h3{margin:1.75rem 0 .6rem;font-size:1.05rem}
.doc-section h4{margin:0;font-size:.97rem}
.doc-section h5{margin:1rem 0 .35rem;font-size:.8rem;text-transform:uppercase;
  letter-spacing:.06em;color:var(--fg-muted)}
.section-lede{margin:.15rem 0 1rem;color:var(--fg-muted);font-size:.9rem;max-width:52rem}
.hint{margin:.5rem 0 0;font-size:.85rem;color:var(--fg-muted);
  border-left:2px solid var(--line);padding-left:.7rem}
.muted{color:var(--fg-muted)}
.missing{color:var(--err-line)}
.path{font-size:.8rem;margin:.1rem 0 .6rem}

.kv{display:grid;grid-template-columns:minmax(8rem,14rem) 1fr;gap:.1rem 1rem;margin:.5rem 0}
.kv dt{color:var(--fg-muted);font-size:.85rem;padding:.2rem 0}
.kv dd{margin:0;padding:.2rem 0;min-width:0;overflow-wrap:anywhere}

.table-wrap{overflow-x:auto;margin:.6rem 0;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:.86rem}
thead th{position:sticky;top:0;background:var(--bg-sunk);text-align:left;font-weight:600;
  padding:.5rem .7rem;border-bottom:1px solid var(--line);white-space:nowrap}
tbody td{padding:.45rem .7rem;border-bottom:1px solid var(--line-soft);vertical-align:top;overflow-wrap:anywhere}
tbody tr:last-child td{border-bottom:0}
td .value{display:inline-block;max-width:38rem;overflow-wrap:anywhere}

.card{border:1px solid var(--line);border-radius:10px;padding:.9rem 1rem;margin:.7rem 0;background:var(--bg)}
.card-step{border-left:4px solid var(--accent, #0a6ed1)}
.card-head{display:flex;align-items:center;gap:.55rem;flex-wrap:wrap}
.card-head h4{flex:1 1 12rem;min-width:0;overflow-wrap:anywhere}
.step-number{display:inline-flex;align-items:center;justify-content:center;min-width:1.9rem;height:1.5rem;
  padding:0 .4rem;border-radius:999px;background:var(--accent,#0a6ed1);color:#fff;
  font-size:.75rem;font-weight:700;flex:none}
.card-error{border-left:4px solid var(--err-line);background:var(--err-bg)}
.card-channel{border-left:4px solid var(--fg-muted)}
.card-sender{border-left-color:#2e7d32}
.card-receiver{border-left-color:#c25e00}
.endpoint{margin:.5rem 0 .2rem}
.step-note{margin:.45rem 0 .2rem;color:var(--fg-muted);font-size:.88rem}
.step-ref{margin:.55rem 0 .2rem;font-size:.88rem}
.error-steps{margin:.5rem 0 0;padding-left:1.2rem}
.error-steps li{margin:.15rem 0}

.pill{display:inline-block;padding:.08rem .5rem;border-radius:999px;font-size:.72rem;
  font-weight:600;border:1px solid var(--line);color:var(--fg-muted);background:var(--bg-sunk);white-space:nowrap}
.pill-sender{border-color:#2e7d32;color:#2e7d32}
.pill-receiver{border-color:#c25e00;color:#c25e00}
.pill-warn{border-color:var(--warn-line);color:var(--warn-line);background:var(--warn-bg)}
.pill-inline{margin-right:.25rem}
.tag{display:inline-block;margin-left:.5rem;padding:.05rem .45rem;border-radius:4px;
  font-size:.7rem;font-weight:600;background:var(--info-bg);color:var(--info-line);vertical-align:middle}
.tag-muted{background:var(--bg-sunk);color:var(--fg-muted)}

code{font-family:"Cascadia Mono",Consolas,ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:.85em;background:var(--code-bg);color:var(--code-fg);
  padding:.08em .35em;border-radius:4px;overflow-wrap:anywhere}
pre.code{background:var(--code-bg);color:var(--code-fg);border:1px solid var(--line);
  border-radius:8px;padding:.8rem 1rem;overflow-x:auto;font-size:.82rem;line-height:1.5;margin:.5rem 0}
pre.code code{background:none;padding:0;font-size:1em}
.param{background:var(--info-bg);color:var(--info-line);border-radius:4px;
  padding:.05em .3em;font-weight:600;cursor:help}

details.more{margin:.65rem 0 0;border-top:1px dashed var(--line);padding-top:.5rem}
details.more > summary{cursor:pointer;font-size:.82rem;color:var(--fg-muted);
  list-style:none;user-select:none;display:inline-flex;align-items:center;gap:.35rem}
details.more > summary::before{content:"\\25b8";display:inline-block;transition:transform .15s}
details[open].more > summary::before{transform:rotate(90deg)}
details.more > summary::-webkit-details-marker{display:none}

.findings{list-style:none;margin:.5rem 0;padding:0}
.finding{display:flex;gap:.7rem;align-items:flex-start;padding:.6rem .8rem;margin:.4rem 0;
  border-radius:8px;border:1px solid var(--line);background:var(--bg-sunk)}
.finding-error{background:var(--err-bg);border-color:var(--err-line)}
.finding-warning{background:var(--warn-bg);border-color:var(--warn-line)}
.finding-info{background:var(--info-bg);border-color:var(--info-line)}
.finding-tag{flex:none;font-size:.68rem;font-weight:700;text-transform:uppercase;
  letter-spacing:.05em;padding:.15rem .45rem;border-radius:4px;background:rgba(0,0,0,.07)}
:root[data-theme="dark"] .finding-tag{background:rgba(255,255,255,.1)}
.finding-title{margin:0;font-weight:600;font-size:.9rem}
.finding-detail{margin:.15rem 0 0;font-size:.85rem;color:var(--fg-muted)}

.diagram-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;
  padding:1rem;background:var(--bg-sunk)}
.legend{display:flex;flex-wrap:wrap;gap:.75rem;margin:.6rem 0 0;font-size:.78rem;color:var(--fg-muted)}
.legend-item{display:inline-flex;align-items:center;gap:.35rem}
.legend-item i{width:.7rem;height:.7rem;border-radius:3px;display:inline-block}

.doc-index table a{color:var(--accent);text-decoration:none}
.doc-index table a:hover{text-decoration:underline}

/* ---- process summary ---- */
.summary-headline{margin:.4rem 0 1.1rem;padding:.85rem 1.1rem;font-size:1.02rem;line-height:1.65;
  border-left:4px solid var(--accent);background:var(--info-bg);border-radius:0 10px 10px 0}
.io-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin:1rem 0 .25rem}
.io-col{border:1px solid var(--line);border-radius:10px;padding:.2rem 1rem .8rem;background:var(--bg)}
.io-col h3{margin:.9rem 0 .5rem}
.io-col-in{border-top:3px solid #2e7d32}
.io-col-out{border-top:3px solid #c25e00}
.io-list{margin:0;padding-left:1.1rem}
.io-list li{margin:.4rem 0;font-size:.9rem;overflow-wrap:anywhere}
.io-at{white-space:nowrap;font-size:.78rem}
.step-link{color:var(--accent);text-decoration:none}
.step-link:hover{text-decoration:underline}
.step-link b{font-weight:700}

.walk{list-style:none;margin:.5rem 0;padding:0}
.walk-heading{margin:1.4rem 0 .2rem;font-size:.95rem}
.walk-step{display:grid;grid-template-columns:auto minmax(0,1fr);gap:.7rem;align-items:start;
  margin:.45rem 0 .45rem calc(var(--depth,0) * 1.5rem);padding:.7rem .9rem;
  border:1px solid var(--line);border-left:4px solid var(--accent,#0a6ed1);border-radius:9px;background:var(--bg)}
.walk-step .step-number{margin-top:.1rem}
.walk-body{min-width:0}
.walk-title{margin:0;font-weight:600;font-size:.92rem;display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}
.walk-text{margin:.3rem 0 0;font-size:.9rem;overflow-wrap:anywhere}
.walk-branches{margin:.5rem 0 0;padding-left:1.1rem;font-size:.86rem}
.walk-branches li{margin:.2rem 0;overflow-wrap:anywhere}
.walk-io{margin:.55rem 0 0;display:flex;flex-wrap:wrap;gap:.3rem .35rem;align-items:center;font-size:.8rem}
.io-label{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg-muted);min-width:3.6rem}
.io-chip{display:inline-flex;align-items:baseline;gap:.3rem;padding:.08rem .5rem;border-radius:6px;
  border:1px solid var(--line);border-left-width:3px;background:var(--bg-sunk);font-size:.78rem;overflow-wrap:anywhere}
.io-chip em{font-style:normal;font-size:.66rem;text-transform:uppercase;letter-spacing:.05em;color:var(--fg-muted)}
.io-header{border-left-color:#0a6ed1}
.io-property{border-left-color:#0f7b7b}
.io-variable{border-left-color:#7b5bd6}
.io-body{border-left-color:var(--fg-muted)}
.io-src{font-size:.7rem;color:var(--fg-muted);text-decoration:none;white-space:nowrap}
a.io-src{color:var(--accent)}
a.io-src:hover{text-decoration:underline}
.io-src-warn{color:var(--warn-line);font-weight:600}
.io-note{font-size:.78rem;color:var(--fg-muted);font-style:italic}

.results{list-style:none;margin:.5rem 0;padding:0}
.results li{margin:.5rem 0;padding:.6rem .9rem;border:1px solid var(--line);border-radius:9px;background:var(--bg-sunk);font-size:.9rem}
.result-end{display:inline-block;margin-right:.4rem;font-weight:700;font-size:.82rem}

.script-panel{margin:.6rem 0;padding:.7rem .95rem;border:1px solid var(--line);border-radius:9px;background:var(--bg-sunk)}
.script-title{margin:0 0 .3rem;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--fg-muted)}
.script-purpose{margin:.2rem 0 .4rem;font-size:.9rem}
.clauses{margin:.3rem 0;padding-left:1.15rem;font-size:.88rem}
.clauses li{margin:.2rem 0;overflow-wrap:anywhere}

/* ---- print picker ---- */
.print-picker,.print-picker *{box-sizing:border-box}
.print-picker{width:min(30rem,calc(100vw - 2rem));padding:0;border:1px solid var(--line);border-radius:14px;
  background:var(--bg);color:var(--fg);box-shadow:0 22px 60px rgba(0,0,0,.35);
  font:14px/1.5 "Segoe UI",system-ui,-apple-system,sans-serif}
.print-picker::backdrop{background:rgba(10,15,22,.55);backdrop-filter:blur(2px)}
.pp-body{padding:1.25rem 1.35rem .8rem}
.pp-title{margin:0 0 .2rem;font-size:1.1rem;letter-spacing:-.01em}
.pp-lede{margin:0 0 .9rem;color:var(--fg-muted);font-size:.88rem}
.pp-row{display:flex;align-items:center;gap:.65rem;padding:.5rem .6rem;border-radius:8px;cursor:pointer}
.pp-row:hover{background:var(--bg-sunk)}
.pp-row input{width:1.05rem;height:1.05rem;margin:0;flex:none;accent-color:var(--accent)}
.pp-all{margin-bottom:.25rem;border-bottom:1px solid var(--line);border-radius:8px 8px 0 0;font-weight:600}
.pp-count{margin-left:auto;font-size:.78rem;font-style:normal;font-weight:400;color:var(--fg-muted)}
.pp-list{list-style:none;margin:0;padding:0;max-height:min(50vh,20rem);overflow-y:auto}
.pp-name{min-width:0;overflow-wrap:anywhere}
.pp-name small{display:block;font-size:.74rem;line-height:1.3;color:var(--fg-muted)}
.pp-kind{margin-left:auto;padding-left:.5rem;font-size:.72rem;font-style:normal;color:var(--fg-muted);white-space:nowrap}
.pp-actions{display:flex;justify-content:flex-end;gap:.5rem;padding:.85rem 1.35rem 1.1rem;border-top:1px solid var(--line)}
.pp-btn{font:inherit;font-size:.86rem;font-weight:600;padding:.45rem .95rem;border-radius:8px;
  border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
.pp-btn:hover:not(:disabled){background:var(--bg-sunk)}
.pp-btn-primary,.pp-btn-primary:hover:not(:disabled){background:var(--accent);border-color:var(--accent);color:#fff}
.pp-btn-primary:hover:not(:disabled){filter:brightness(1.08)}
.pp-btn:disabled{opacity:.5;cursor:not-allowed}
.pp-btn:focus-visible,.pp-row input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

@media (max-width:760px){
  .io-grid{grid-template-columns:1fr}
}
@media (max-width:640px){
  .walk-step{margin-left:calc(var(--depth,0) * .7rem);padding:.6rem .7rem}
  .doc{font-size:14.5px}
  .doc-header h1{font-size:1.5rem}
  .kv{grid-template-columns:1fr;gap:0}
  .kv dt{padding-top:.5rem}
  .kv dd{padding-bottom:.35rem;border-bottom:1px solid var(--line-soft)}
}

@media print{
  :root{--bg:#fff;--bg-sunk:#fafbfc}
  .print-picker{display:none!important}
  /* Documents the user unticked in the print picker. */
  .doc[data-print-skip]{display:none!important}
  /* Each document starts on its own page. */
  .doc{break-before:page}
  .doc{max-width:none;font-size:10.5pt}
  .doc-section{page-break-inside:auto}
  .card,.finding,.table-wrap,.walk-step,.results li,.script-panel,.io-col{page-break-inside:avoid}
  .doc-section > h2{page-break-after:avoid}
  details.more{display:none}
  .diagram-wrap{border:1px solid #ccc}
  a{color:inherit;text-decoration:none}
}
`;
