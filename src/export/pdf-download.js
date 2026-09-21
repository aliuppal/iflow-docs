/**
 * Saves documents as PDF files, one file per document, without the browser's
 * print dialog.
 *
 * The PDF engine (vendor/pdfmake*) is about 2 MB, so it is fetched only the first
 * time someone asks for a PDF. Each document is built and saved on its own: a
 * failure on one document is reported and does not stop the others.
 */

import { renderDiagram } from '../render/diagram.js';
import { buildDocumentPdf, buildIndexPdf, pdfFileName } from './pdf.js';

const ENGINE = ['pdfmake.min.js', 'pdfmake-vfs_fonts.js', 'pdf-mono-font.js'];
const MONO_FONT = { RobotoMono: { normal: 'RobotoMono-Regular.ttf', bold: 'RobotoMono-Regular.ttf', italics: 'RobotoMono-Regular.ttf', bolditalics: 'RobotoMono-Regular.ttf' } };

/** A hung PDF build (for instance on a damaged image) must not hang the page. */
const BUILD_TIMEOUT_MS = 60000;
const DIAGRAM_TIMEOUT_MS = 15000;
/** Browsers drop downloads that start in the same instant; a short gap keeps them all. */
const GAP_BETWEEN_DOWNLOADS_MS = 450;

function withTimeout(promise, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} seconds`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`could not load ${src.split('/').pop()}`));
    document.head.appendChild(script);
  });
}

let engine = null;

/** Load the PDF engine once; a failed load can be retried. */
export function loadPdfEngine() {
  if (engine) return engine;
  engine = (async () => {
    if (!window.pdfMake) {
      for (const file of ENGINE) await loadScript(new URL(`../../vendor/${file}`, import.meta.url).href);
    }
    if (!window.pdfMake || typeof window.pdfMake.createPdf !== 'function') throw new Error('the PDF engine did not initialise');
    window.pdfMake.addFonts(MONO_FONT);
  })().catch((err) => {
    engine = null;
    throw err;
  });
  return engine;
}

/**
 * The flow diagram as a PNG for embedding. The SVG is drawn by the browser, so
 * it looks exactly as it does on screen (light colours; the variables in its
 * stylesheet all carry light fallbacks). Returns null when there is no diagram.
 */
export async function diagramImage(doc) {
  const drawn = renderDiagram(doc, {});
  if (drawn.empty) return null;

  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('the diagram could not be drawn'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(drawn.svg)}`;
  });

  // Sharp when zoomed in, without producing an enormous bitmap.
  const scale = Math.min(2.5, 3800 / drawn.width, Math.sqrt(14e6 / (drawn.width * drawn.height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(drawn.width * scale));
  canvas.height = Math.max(1, Math.round(drawn.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL('image/png'), width: drawn.width, height: drawn.height };
}

function save(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {Array<{kind: 'doc'|'index', name: string, doc?: object, archive?: object, docs?: object[]}>} items
 * @param {{ onProgress?: (done: number, total: number, name: string) => void }} [options]
 * @returns {Promise<{ saved: string[], failed: Array<{ name: string, error: string }> }>}
 */
export async function downloadPdfs(items, options = {}) {
  const saved = [];
  const failed = [];
  const say = options.onProgress || (() => {});

  say(0, items.length, 'the PDF engine');
  await loadPdfEngine();

  const usedNames = new Set();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    say(i + 1, items.length, item.name);
    try {
      let definition;
      if (item.kind === 'index') {
        definition = buildIndexPdf(item.archive, item.docs);
      } else {
        // A diagram that cannot be drawn must not cost the whole document.
        const diagram = await withTimeout(diagramImage(item.doc), DIAGRAM_TIMEOUT_MS, 'Drawing the diagram').catch(() => null);
        definition = buildDocumentPdf(item.doc, { diagram });
      }
      const blob = await withTimeout(window.pdfMake.createPdf(definition).getBlob(), BUILD_TIMEOUT_MS, 'Building the PDF');
      const fileName = pdfFileName(item.name, usedNames);
      save(blob, fileName);
      saved.push(fileName);
      if (i < items.length - 1) await sleep(GAP_BETWEEN_DOWNLOADS_MS);
    } catch (err) {
      failed.push({ name: item.name, error: err && err.message ? err.message : String(err) });
    }
  }
  return { saved, failed };
}
