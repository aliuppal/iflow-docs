# iFlow Docs

Generates readable documentation from an **SAP Cloud Integration** integration flow
export, or from a whole integration package export.

Drop a `.zip` in, get back the flow diagram, every processing step with its
configuration, the channels, the externalised parameters, the scripts, the
external dependencies and the error handling — as a self-contained HTML file,
as Markdown, or straight to PDF via the browser's print dialog.

Everything runs in the browser. **No upload, no server call, no telemetry** — unless
you switch on the optional Google sign-in (see *Accounts* below), in which case the
only thing that ever leaves the browser is your name, email and a count of printed
documents, never the archive, its contents or its file names.
Integration exports carry endpoints, credential aliases and business logic, so
the archive is read locally with the File API and never leaves the machine.

---

## Running it

```bash
cd iflow-docs
node serve.mjs            # http://localhost:4173
```

Any static file server works — `python -m http.server`, `npx serve`, IIS, nginx.
The site is plain ES modules with **no build step and no runtime dependencies** (the
one vendored library, `vendor/supabase.js`, is downloaded only if sign-in is switched on); the only
requirement is that it is served over `http(s)` rather than opened as `file://`,
because browsers block module loading from the filesystem.

To deploy, copy `index.html`, `assets/` and `src/` to any static host.

### Try it without a tenant

```bash
node tools/make-samples.mjs     # writes three realistic exports to samples/
```

Then drop `samples/HR_Integration_Suite_package.zip` onto the page.

---

## What it accepts

| Input | Detected by |
| --- | --- |
| Integration flow export | `META-INF/MANIFEST.MF` + an `.iflw` under `src/main/resources` |
| Integration package export | a `.zip` whose entries are themselves artefact `.zip` files |
| Several exports at once | drop or pick multiple files; they are documented together |

Inside an artefact it reads the BPMN flow (`.iflw`), the OSGi manifest,
`parameters.prop` / `parameters.propdef`, Groovy and JavaScript, message and
operation mappings (`.mmap` / `.opmap`), XSLT, XSD / WSDL / EDMX and value
mapping tables. Anything it does not recognise is still listed in the appendix
with its path and size, so nothing in the archive goes unmentioned.

## What it produces

- **Overview** — name, version, description, sender and receiver systems, adapters, transaction handling.
- **Process summary** — a plain-language account of what the flow does: a one-paragraph headline, **Data in** (timer or sender, lookups, values the caller must supply), **Data out** (requests sent, data stores written, hand-offs to other flows, message-log entries, errors), a step-by-step walkthrough, and a **Result** per end event that traces the final message body back to the step that last changed it. Every step shows the headers and properties it *uses* — with a link to the step that set each one — and what it *sets*. Groovy and JavaScript are read statically: for each script the document lists the headers, properties and body it reads and sets, what it writes to the message log, any exception it raises, and quotes the script's own description comment. A **data-passed-between-steps** table shows, for every header and property, who sets it and who uses it.
- **Review notes** — missing scripts, a script whose entry point is not defined, properties that are read but never set, externalised parameters with no value, unreferenced parameters and scripts, unreachable steps, plain-HTTP endpoints, unauthenticated sender channels, and flows with no exception subprocess. Every note is checkable against a section below it.
- **Flow diagram** — SVG rebuilt from the layout coordinates stored in the export, so the picture matches what the developer arranged in the Web UI. Colour-coded by step category.
- **Interfaces** — every sender and receiver channel with its adapter, partner system, endpoint and full configuration.
- **Processing steps** — in execution order, with router branches numbered `4a.1`, `4a.2` and exception subprocesses numbered `E.1`, `E.2` so the error path is never mistaken for the happy path. Content Modifier property and header tables, routing conditions, message bodies and script sources are rendered inline; the complete property set of every step is available under a disclosure.
- **Externalised parameters** — the configured value, the data type, and every place the parameter is referenced.
- **Dependencies** — ProcessDirect addresses, queues, data stores, variables, external endpoints and the credential aliases the target tenant must already hold. This is the impact analysis you would otherwise do by hand before a change.
- **Error handling** — what runs when a step raises.
- **Scripts and mappings** — full script source; mappings with their referenced schemas.

For a **package**, an index page is produced first, including an *internal
hand-offs* table: matching a Receiver row against a Sender row on the same
ProcessDirect address or queue shows how the flows in the package chain together.

---

## Exports

| Button | Output |
| --- | --- |
| Download HTML | One self-contained file — styles, diagram and contents inlined, no network access needed to view it. |
| Download Markdown | Wiki- and repo-friendly, with the flow as a Mermaid `flowchart` that renders on GitHub, GitLab and Azure DevOps. |
| Copy Markdown | The same, to the clipboard. |
| Print / PDF | Opens the browser's print dialog (choose "Save as PDF"). With more than one document loaded, it first asks which to include, with a **Select all** option and the source file shown under each name; each chosen document starts on its own page. The exported HTML file has the same picker. |

The on-screen document and the HTML export come from the same renderer
(`src/render/document.js`) and the same stylesheet (`src/render/doc-css.js`), so
the exported file cannot drift from what you reviewed.

---

## Accounts (optional)

Google sign-in through Supabase, with a per-user **count of documents printed**
shown in the top bar and an account menu. It is **off until you configure it**:
with `src/config.js` left empty the site makes no network calls and does not even
download the Supabase library.

- **Setup:** [`SETUP-SUPABASE.md`](SETUP-SUPABASE.md) — about 15 minutes: a Supabase
  project, a Google OAuth client, and two values pasted into `src/config.js`.
- **Optional or required:** `requireSignIn: false` (default) lets anyone use the tool
  and counts prints only for signed-in users; `true` blocks loading a file until the
  visitor has signed in.
- **What is stored:** name, email, photo link, and two counters. The browser sends
  a number when someone prints; nothing about the files.
- **Tamper-resistant counter:** the browser can read only its own row and cannot
  write to the table; every change goes through two database functions
  (`supabase/schema.sql`). Tested against a real Postgres engine, including attempts
  to edit the counter, read other users' rows and abuse the functions.
- **What the count means:** documents sent to the browser's print dialog. A page
  cannot learn whether the user then printed or cancelled, so it counts print
  requests, and it is self-reported — an indicator, not proof.
- The exported HTML file has its own Print button and works fully offline; it never
  counts.

## Layout

```
index.html              landing page and workspace
assets/app.css          application shell only
src/
  lib/zip.js            ZIP reader (DecompressionStream; stored + deflate + ZIP64)
  lib/xml.js            small XML parser, namespace-tolerant, DOM-free
  lib/props.js          .properties and OSGi MANIFEST.MF readers
  parse/iflw.js         BPMN + SAP extension properties + diagram geometry
  parse/archive.js      iFlow vs package detection, resource extraction
  parse/mapping.js      .mmap / XSLT / XSD / value mapping readers
  parse/groovy.js       static analysis of Groovy/JS: headers, properties, body, log
  model/catalog.js      activityType and ComponentType -> human names
  model/analyze.js      step ordering, parameters, dependencies, findings
  model/flow.js         process summary: data lineage, narrative, inputs/outputs/results
  render/diagram.js     SVG from the stored BPMN layout
  render/document.js    documentation model -> HTML
  render/doc-css.js     document stylesheet (shared with the export)
  export/html.js        self-contained HTML
  export/markdown.js    Markdown + Mermaid
  render/print-picker.js  "which documents to print?" dialog (also embedded in the export)
  config.js             sign-in settings (empty = feature off)
  auth.js               Google sign-in + print counter, on Supabase
  account-ui.js         Google button, account chip and menu, sign-in gate
  app.js                file intake, navigation, downloads
vendor/supabase.js      @supabase/supabase-js (loaded only when sign-in is configured)
supabase/schema.sql     profiles table, row-level security, ensure_profile / record_print
serve.mjs               dependency-free static server
tools/                  sample generator and test harness (not shipped)
```

The parsing and rendering layers are deliberately DOM-free — they build strings,
not nodes — which is why the whole pipeline can be tested outside a browser.

## Tests

```bash
npm test          # generate samples, then run 158 end-to-end checks
npm run test:sql  # 40 checks of supabase/schema.sql against a real Postgres engine (PGlite)
npm run test:emit # also write the rendered HTML and Markdown to samples/out/
```

The harness drives the real modules — ZIP reading, BPMN parsing, analysis,
diagram, HTML and Markdown export — against generated exports that mirror the
structure Cloud Integration produces, and asserts on the documentation model
rather than on markup details.

---

## Known limits

- **Message mapping fields.** `.mmap` is an internal SAP format that has changed
  shape between releases. Source and target structures, referenced schemas and
  recognisable field links are extracted; where the structure is not recognised,
  the mapping is listed with its schemas and the document says so explicitly
  rather than inventing detail. XSLT and value mappings are read reliably.
- **The process summary is static analysis.** Scripts are read as text, not run.
  Header and property names written literally (`message.setHeader('X', …)`,
  `headers.get('X')`) are found; names built at runtime are reported as "computed
  at runtime" rather than guessed. Comments are ignored, so commented-out code is
  never reported as behaviour. The narrative only states what the export contains —
  for example, the final body is traced through steps whose effect is known, and a
  step type the tool does not recognise falls back to its label and properties.
- **Adapter coverage.** Around 25 adapter families have curated field lists. An
  adapter outside that set is still documented — named, with every property in a
  table — it just is not re-ordered into a curated layout.
- **Layout-free exports.** A few older exports carry no `BPMNDiagram` section.
  The diagram is then skipped and the document says why; every other section is
  unaffected, and the Markdown Mermaid diagram is built from the sequence flows
  and so still renders.
- The generator reads what the export contains. It cannot know a tenant's
  deployed parameter values, and it never guesses them.
