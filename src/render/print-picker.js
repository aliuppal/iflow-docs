/**
 * "Which documents?" — shown before Download PDF (or, in an exported file, Print) whenever
 * more than one document is on the page (a package, or several exports).
 *
 * This is one self-contained function on purpose: the exported HTML file has its
 * own Print button and embeds this function's source verbatim (via toString), so
 * the site and the export behave identically and cannot drift apart. That means
 * it may not reference anything outside itself — no imports, no module constants.
 *
 * Unselected documents are hidden for the print only, by a data attribute that
 * the print stylesheet (doc-css.js) acts on, and are put back afterwards.
 *
 * @param {Element} container element whose direct children include the
 *   <article class="doc"> elements to choose between
 * @param {{ onPrint?: (documents: number) => unknown,
 *           onSelect?: (articles: Element[]) => unknown }} [options]
 *   onSelect: download mode. The chosen <article> elements are handed over and
 *     nothing is printed; the site turns each one into its own PDF file.
 *   onPrint: print mode. Told how many documents are being sent to the print
 *     dialog, just before it opens.
 *   The exported HTML file passes neither, so it prints (with the browser dialog,
 *   since it is a plain offline file with no PDF engine in it).
 */
export function printWithPicker(container, options) {
  const articles = Array.from(container.querySelectorAll(':scope > article.doc'));
  const download = Boolean(options && typeof options.onSelect === 'function');

  // A failing (or rejecting) callback must never get in the way of printing.
  const notify = (documents) => {
    if (!options || typeof options.onPrint !== 'function') return;
    try {
      Promise.resolve(options.onPrint(documents)).catch(() => {});
    } catch (err) {
      /* ignored on purpose */
    }
  };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const nameOf = (a) => { const h = a.querySelector('h1'); return h ? h.textContent.trim() : 'Document'; };
  const kindOf = (a) => { const k = a.querySelector('.doc-kicker'); return k ? k.textContent.trim() : ''; };
  // Which file it came from, so two documents with the same name can be told apart.
  const sourceOf = (a) => a.getAttribute('data-print-source') || '';

  /**
   * "Save as PDF" names the file after the page's <title>, so for the duration of
   * the print the title is set to the name of what was chosen:
   *   one document                   -> its name
   *   several from one uploaded file -> that file's name (the package)
   *   several from different files   -> "First + Second (+ N more)"
   * Characters a file name cannot contain are replaced.
   */
  const originalTitle = document.title;
  const titleFor = (chosen) => {
    const names = chosen.map(nameOf);
    let title;
    if (names.length === 1) {
      title = names[0];
    } else {
      const sources = Array.from(new Set(chosen.map(sourceOf).filter(Boolean)));
      title = sources.length === 1
        ? sources[0].replace(/\.zip$/i, '')
        : names.slice(0, 2).join(' + ') + (names.length > 2 ? ' + ' + (names.length - 2) + ' more' : '');
    }
    return title.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  };
  /** Set the title now; put everything back once the print dialog is done with. */
  const beginPrint = (chosen, onDone) => {
    const title = titleFor(chosen);
    if (title) document.title = title;
    const restore = () => {
      document.title = originalTitle;
      if (onDone) onDone();
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
  };

  // Nothing to choose between, or no <dialog> support: just do it.
  if (articles.length < 2 || typeof HTMLDialogElement !== 'function') {
    if (download) {
      options.onSelect(articles);
      return;
    }
    notify(Math.max(articles.length, 1));
    beginPrint(articles);
    window.print();
    return;
  }
  if (document.getElementById('print-picker')) return;

  const dialog = document.createElement('dialog');
  dialog.id = 'print-picker';
  dialog.className = 'print-picker';
  dialog.setAttribute('aria-labelledby', 'print-picker-title');
  dialog.innerHTML =
    '<div class="pp-body">' +
    '<h2 class="pp-title" id="print-picker-title">' + (download ? 'Choose documents to download' : 'Choose what to print') + '</h2>' +
    '<p class="pp-lede">' + articles.length + ' documents are loaded. ' + (download
      ? 'Each ticked document is saved as its own PDF file. If your browser asks to allow multiple downloads, choose Allow.'
      : 'Tick the ones to include in the PDF.') + '</p>' +
    '<label class="pp-row pp-all"><input type="checkbox" class="pp-master"><span>Select all</span><em class="pp-count"></em></label>' +
    '<ul class="pp-list">' +
    articles.map((a, i) =>
      '<li><label class="pp-row"><input type="checkbox" class="pp-item" data-i="' + i + '" checked>' +
      '<span class="pp-name">' + esc(nameOf(a)) + (sourceOf(a) ? '<small>' + esc(sourceOf(a)) + '</small>' : '') +
      '</span><em class="pp-kind">' + esc(kindOf(a)) + '</em></label></li>'
    ).join('') +
    '</ul></div>' +
    '<div class="pp-actions">' +
    '<button type="button" class="pp-btn pp-cancel">Cancel</button>' +
    '<button type="button" class="pp-btn pp-btn-primary pp-go"></button>' +
    '</div>';

  const master = dialog.querySelector('.pp-master');
  const count = dialog.querySelector('.pp-count');
  const go = dialog.querySelector('.pp-go');
  const boxes = Array.from(dialog.querySelectorAll('.pp-item'));

  // Keep the master box, the counter and the button label in step with the list.
  const sync = () => {
    const n = boxes.filter((b) => b.checked).length;
    master.checked = n === boxes.length;
    master.indeterminate = n > 0 && n < boxes.length;
    count.textContent = n + ' of ' + boxes.length + ' selected';
    go.disabled = n === 0;
    const verb = download ? 'Download' : 'Print';
    go.textContent = n === 0 ? 'Select at least one' : n === boxes.length ? verb + ' all (' + n + ')' : verb + ' ' + n + ' of ' + boxes.length;
  };

  master.addEventListener('change', () => {
    boxes.forEach((b) => { b.checked = master.checked; });
    sync();
  });
  boxes.forEach((b) => b.addEventListener('change', sync));

  dialog.querySelector('.pp-cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());   // Esc, Cancel and Print all end here

  go.addEventListener('click', () => {
    const chosen = boxes.map((b) => b.checked);
    if (!chosen.some(Boolean)) return;
    const selected = articles.filter((a, i) => chosen[i]);

    // Download mode: no printing at all; hand the chosen documents over.
    if (download) {
      dialog.close();
      options.onSelect(selected);
      return;
    }

    articles.forEach((a, i) => { if (!chosen[i]) a.setAttribute('data-print-skip', 'true'); });
    notify(selected.length);

    // Title for the PDF file name, and un-hide the skipped documents afterwards.
    beginPrint(selected, () => articles.forEach((a) => a.removeAttribute('data-print-skip')));

    dialog.close();
    // Let the dialog leave the page before the browser snapshots it for printing.
    setTimeout(() => window.print(), 60);
  });

  document.body.appendChild(dialog);
  dialog.showModal();
  sync();
}
