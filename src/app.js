/**
 * Application shell: file intake, navigation, exports.
 *
 * All parsing and rendering lives in src/parse, src/model and src/render; this
 * module only wires them to the page. The archive is read from the File object
 * and never leaves the browser. The only network traffic in the whole site is
 * the optional sign-in in src/auth.js, which sends a name, an email and a print
 * count — never the archive, its contents or its file names.
 */

import { createAuth, signInRequired } from './auth.js';
import { mountAccount } from './account-ui.js';
import { loadArchive } from './parse/archive.js';
import { buildDoc } from './model/analyze.js';
import { renderDocument, renderPackageIndex, documentSections } from './render/document.js';
import { DOC_CSS } from './render/doc-css.js';
import { buildStandaloneHtml } from './export/html.js';
import { renderMarkdown, renderPackageMarkdown } from './export/markdown.js';
import { cssId } from './render/diagram.js';
import { printWithPicker } from './render/print-picker.js';

const el = (id) => document.getElementById(id);
const state = {
  /** @type {{archive:object, docs:object[]}[]} */
  loads: [],
  activeDocId: null,
};

/* ---------------- boot ---------------- */

function boot() {
  injectDocStyles();
  restoreTheme();
  wireIntake();
  wireToolbar();
  startAccount();
  el('btn-theme').addEventListener('click', toggleTheme);
  window.addEventListener('hashchange', highlightActive);
}

/* ---------------- account: Google sign-in and the print count ---------------- */

let auth = null;
let authState = { status: 'off' };

function startAccount() {
  const account = mountAccount({
    signIn: () => {
      // Google sign-in leaves this page and comes back, which clears what is loaded.
      if (state.loads.length && !window.confirm(
        'Signing in with Google reloads the page, so the documents you have loaded will need to be loaded again.\n\nSign in anyway?'
      )) return;
      auth.signIn();
    },
    signOut: () => auth.signOut(),
    required: signInRequired(),
  });
  auth = createAuth({
    onChange: (next) => {
      const wasSignedIn = authState.status === 'in';
      authState = next;
      account.render(next);
      // When sign-in is required, signing out must not leave the tool usable.
      if (signInRequired() && wasSignedIn && next.status === 'out') resetWorkspace();
    },
    onError: (message) => toast(message, 'error'),
  });
  auth.start();
}

/** Called when documents are sent to the print dialog. Never blocks the printing itself. */
async function countPrint(documents) {
  if (!auth || authState.status !== 'in') return;
  try {
    await auth.recordPrint(documents);
  } catch (err) {
    toast(`Sent to print, but your printed-documents count could not be updated: ${err.message}.`, 'error');
  }
}

function injectDocStyles() {
  const style = document.createElement('style');
  style.id = 'doc-styles';
  style.textContent = DOC_CSS;
  document.head.appendChild(style);
}

/* ---------------- theme ---------------- */

function restoreTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem('iflow-docs-theme');
  } catch {
    /* private browsing or blocked storage — fall back to the system preference */
  }
  const theme = stored || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('iflow-docs-theme', next);
  } catch {
    /* not important enough to surface */
  }
}

/* ---------------- file intake ---------------- */

function wireIntake() {
  const dropzone = el('dropzone');
  const input = el('file-input');

  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    if (input.files.length) handleFiles([...input.files]);
    input.value = '';
  });
  el('btn-add').addEventListener('click', () => input.click());

  for (const type of ['dragenter', 'dragover']) {
    document.addEventListener(type, (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dropzone.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'dragend']) {
    document.addEventListener(type, (e) => {
      if (e.relatedTarget) return;
      dropzone.classList.remove('is-over');
    });
  }
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropzone.classList.remove('is-over');
    const files = [...e.dataTransfer.files].filter((f) => /\.zip$/i.test(f.name));
    if (!files.length) {
      toast('Only .zip exports can be read. Export the integration flow or package from Cloud Integration first.', 'error');
      return;
    }
    handleFiles(files);
  });
}

function hasFiles(event) {
  return Boolean(event.dataTransfer && [...event.dataTransfer.types].includes('Files'));
}

async function handleFiles(files) {
  // Files can still be dropped anywhere on the page, so the gate is enforced here
  // as well as by hiding the dropzone.
  if (signInRequired() && authState.status !== 'in') {
    toast('Sign in with Google to load a file.', 'error');
    return;
  }
  showStatus(`Reading ${files.length === 1 ? files[0].name : `${files.length} archives`}…`);
  const problems = [];

  for (const file of files) {
    try {
      const archive = await loadArchive(file);
      const docs = archive.artifacts.map(buildDoc);
      if (!docs.length) {
        problems.push(`${file.name}: no documentable artefacts found.`);
        continue;
      }
      state.loads.push({ archive, docs });
      for (const w of archive.warnings) problems.push(`${file.name}: ${w}`);
    } catch (err) {
      problems.push(err.message);
    }
  }

  hideStatus();

  if (!state.loads.length) {
    toast(problems[0] || 'Nothing could be read from those files.', 'error');
    return;
  }

  renderWorkspace();
  const total = state.loads.reduce((n, l) => n + l.docs.length, 0);
  if (problems.length) toast(`Documented ${total} artefact${total === 1 ? '' : 's'}. ${problems.length} item${problems.length === 1 ? '' : 's'} skipped — see the sidebar.`, 'error');
  else toast(`Documented ${total} artefact${total === 1 ? '' : 's'}.`, 'ok');
}

/* ---------------- rendering ---------------- */

function renderWorkspace() {
  el('landing').hidden = true;
  el('workspace').hidden = false;
  el('toolbar').hidden = false;

  const content = el('content');
  const parts = [];
  const sources = [];   // which uploaded file each rendered document came from
  for (const load of state.loads) {
    if (load.archive.kind === 'package' || load.docs.length > 1) {
      parts.push(renderPackageIndex(load.archive, load.docs));
      sources.push(load.archive.sourceName);
    }
    for (const doc of load.docs) {
      parts.push(renderDocument(doc, { linkPrefix: '' }));
      sources.push(load.archive.sourceName);
    }
  }
  content.innerHTML = parts.join('');
  // The print picker shows this so identically named documents can be told apart.
  content.querySelectorAll(':scope > article.doc').forEach((article, i) => {
    if (sources[i]) article.setAttribute('data-print-source', sources[i]);
  });

  renderNav();
  highlightActive();
  content.focus({ preventScroll: true });
}

function renderNav() {
  const nav = el('artefact-nav');
  const blocks = [];

  for (const load of state.loads) {
    const archiveLabel = load.archive.sourceName;
    blocks.push(`<p class="side-archive">${escapeHtml(archiveLabel)}</p>`);
    if (load.archive.kind === 'package' || load.docs.length > 1) {
      blocks.push(
        '<div class="side-group">' +
          `<button type="button" class="side-artefact" data-target="package-index">Package overview` +
          `<span class="count">${load.docs.length}</span></button></div>`
      );
    }
    for (const doc of load.docs) {
      const anchor = `doc-${cssId(doc.id || doc.name)}`;
      blocks.push(
        '<div class="side-group">' +
          `<button type="button" class="side-artefact" data-doc="${escapeHtml(anchor)}" data-target="${escapeHtml(anchor)}">` +
          `${escapeHtml(doc.name)}<span class="count">${doc.stats.steps || 0}</span></button>` +
          '<ul class="side-sections">' +
          documentSections(doc)
            .map((s) => `<li><a href="#${escapeHtml(s.id)}" data-doc="${escapeHtml(anchor)}">${escapeHtml(s.label)}</a></li>`)
            .join('') +
          '</ul></div>'
      );
    }
    for (const warning of load.archive.warnings) {
      blocks.push(`<p class="side-warn">⚠ ${escapeHtml(warning)}</p>`);
    }
  }

  nav.innerHTML = blocks.join('');
  nav.querySelectorAll('.side-artefact').forEach((button) => {
    button.addEventListener('click', () => {
      const target = document.getElementById(button.dataset.target);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      state.activeDocId = button.dataset.doc || button.dataset.target;
      highlightActive();
    });
  });
}

function highlightActive() {
  const buttons = el('artefact-nav').querySelectorAll('.side-artefact');
  buttons.forEach((b) => b.classList.toggle('is-active', (b.dataset.doc || b.dataset.target) === state.activeDocId));
}

/* ---------------- exports ---------------- */

function wireToolbar() {
  el('btn-export-html').addEventListener('click', () => {
    const { archive, docs } = combined();
    download(buildStandaloneHtml(archive, docs), `${baseFileName()}.html`, 'text/html;charset=utf-8');
  });

  el('btn-export-md').addEventListener('click', () => {
    download(markdown(), `${baseFileName()}.md`, 'text/markdown;charset=utf-8');
  });

  el('btn-copy-md').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(markdown());
      toast('Markdown copied to the clipboard.', 'ok');
    } catch {
      toast('The browser blocked clipboard access. Use "Download Markdown" instead.', 'error');
    }
  });

  // With several documents loaded this asks which ones to include first.
  el('btn-print').addEventListener('click', () => printWithPicker(el('content'), { onPrint: countPrint }));

  el('btn-reset').addEventListener('click', resetWorkspace);
}

/** Drop everything that was loaded and return to the landing page. */
function resetWorkspace() {
  state.loads = [];
  state.activeDocId = null;
  el('content').innerHTML = '';
  el('artefact-nav').innerHTML = '';
  el('workspace').hidden = true;
  el('toolbar').hidden = true;
  el('landing').hidden = false;
  window.scrollTo({ top: 0 });
}

/** Treat every loaded archive as one document set for export purposes. */
function combined() {
  if (state.loads.length === 1) return state.loads[0];
  return {
    archive: {
      sourceName: `${state.loads.length} exports`,
      kind: 'package',
      warnings: state.loads.flatMap((l) => l.archive.warnings),
    },
    docs: state.loads.flatMap((l) => l.docs),
  };
}

function markdown() {
  const { archive, docs } = combined();
  return docs.length > 1 || archive.kind === 'package'
    ? renderPackageMarkdown(archive, docs)
    : renderMarkdown(docs[0]);
}

/** The downloaded file is named exactly after the document (or the package for several). */
function baseFileName() {
  const { archive, docs } = combined();
  const stem = docs.length === 1 ? docs[0].name : archive.sourceName.replace(/\.zip$/i, '');
  return safeFileName(stem);
}

/** Keep the name as written; only replace what a file name cannot contain. */
function safeFileName(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  return cleaned || 'documentation';
}

function download(text, fileName, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`Saved ${fileName}.`, 'ok');
}

/* ---------------- small UI helpers ---------------- */

function showStatus(message) {
  const status = el('status');
  status.innerHTML = `<div class="spinner"></div><p>${escapeHtml(message)}</p>`;
  status.hidden = false;
}

function hideStatus() {
  el('status').hidden = true;
}

let toastTimer = null;
function toast(message, kind = '') {
  const node = el('toast');
  node.textContent = message;
  node.className = `toast${kind ? ` is-${kind}` : ''}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, kind === 'error' ? 9000 : 4000);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

boot();
