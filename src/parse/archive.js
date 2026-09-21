/**
 * Turns an uploaded .zip into a list of documented artefacts.
 *
 * Two shapes are accepted:
 *   1. a single integration flow export — META-INF/MANIFEST.MF plus
 *      src/main/resources/scenarioflows/integrationflow/*.iflw
 *   2. an integration package export — a zip whose entries are themselves
 *      artefact zips (iFlows, value mappings, script collections)
 *
 * Anything that is neither is reported as a warning rather than throwing, so a
 * package containing one odd artefact still documents the rest.
 */

import { readZip, looksLikeZip } from '../lib/zip.js';
import { parseProperties, parseManifest, splitHeader } from '../lib/props.js';
import { parseXml, descendants, child, text, attr } from '../lib/xml.js';
import { parseIflw } from './iflw.js';
import { parseMessageMapping, parseValueMapping, summariseXslt, summariseXsd, baseName } from './mapping.js';

const SCRIPT_LANGUAGES = { groovy: 'Groovy', js: 'JavaScript', javascript: 'JavaScript' };

export async function loadArchive(file) {
  const result = {
    sourceName: file.name || 'archive.zip',
    sourceSize: file.size || 0,
    kind: 'unknown',
    packageInfo: null,
    artifacts: [],
    warnings: [],
  };

  let zip;
  try {
    zip = await readZip(file);
  } catch (err) {
    throw new Error(`"${result.sourceName}" could not be read as a ZIP archive: ${err.message}`);
  }

  if (isIflowArchive(zip)) {
    result.kind = 'iflow';
    result.artifacts.push(await readArtifact(zip, result.sourceName, result.warnings));
    return result;
  }

  // A package export: artefacts are zips nested inside the zip. They are found
  // by their contents, not their names — Cloud Integration names them
  // "<id>_content" with no extension, so an ".zip" test finds nothing.
  const found = await collectNested(zip, result.sourceName, 0, result.warnings);
  if (found.length) {
    result.kind = 'package';
    result.packageInfo = readPackageMetadata(zip);
    result.artifacts.push(...found);
    result.artifacts.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }

  // A lone artefact with a manifest but no .iflw (a value mapping, script collection…).
  if (zip.get('META-INF/MANIFEST.MF')) {
    result.kind = 'iflow';
    result.artifacts.push(await readArtifact(zip, result.sourceName, result.warnings));
    return result;
  }

  // An iFlow whose folder was wrapped in an extra directory.
  if (zip.find('.iflw').length) {
    result.kind = 'iflow';
    result.artifacts.push(await readArtifact(zip, result.sourceName, result.warnings));
    return result;
  }

  const names = zip.files().map((e) => e.name);
  const sample = names.slice(0, 8).join(', ') + (names.length > 8 ? `, … (${names.length} entries)` : '');
  throw new Error(
    `"${result.sourceName}" does not look like an integration flow or package export. ` +
      'Expected a META-INF/MANIFEST.MF with an .iflw, or a zip that contains artefact zips. ' +
      `What the archive actually contains: ${sample || 'nothing'}.`
  );
}

function isIflowArchive(zip) {
  return Boolean(zip.get('META-INF/MANIFEST.MF')) && zip.find('.iflw').length > 0;
}

/** Entries that are certainly not nested archives; everything else is checked by signature. */
const NOT_AN_ARCHIVE = /\.(json|md|cnt|txt|prop|properties|propdef|xml|mf|html?|css|js|groovy|xsd|wsdl|edmx|xsl|xslt|mmap|opmap|iflw|png|jpe?g|gif|svg|ico|jar|class)$/i;

/**
 * Artefacts inside a package (or a package inside a zip, one level deeper).
 * Each nested zip that has a manifest is an artefact; one that only contains
 * more zips is unwrapped. Anything else is reported, not silently dropped.
 */
async function collectNested(zip, label, depth, warnings) {
  if (depth > 3) return [];
  const out = [];

  for (const entry of zip.files()) {
    if (entry.size < 30 || NOT_AN_ARCHIVE.test(entry.name)) continue;

    let bytes;
    try {
      bytes = await entry.bytes();
    } catch (err) {
      warnings.push(`Could not read "${entry.name}": ${err.message}`);
      continue;
    }
    if (!looksLikeZip(bytes)) continue;

    try {
      const inner = await readZip(bytes);
      const display = await displayNameFor(zip, entry);
      if (inner.get('META-INF/MANIFEST.MF') || inner.find('.iflw').length) {
        out.push(await readArtifact(inner, display, warnings));
      } else {
        const deeper = await collectNested(inner, display, depth + 1, warnings);
        if (deeper.length) out.push(...deeper);
        else warnings.push(`Skipped "${entry.name}": a zip with no manifest and no artefacts inside it.`);
      }
    } catch (err) {
      warnings.push(`Skipped "${entry.name}": ${err.message}`);
    }
  }
  return out;
}

/**
 * A readable name for a nested artefact. Package exports carry a "<id>.json"
 * beside each "<id>_content"; when it can be read it gives the display name,
 * otherwise the file name is used (the manifest inside usually names it anyway).
 */
async function displayNameFor(zip, entry) {
  const fileName = baseName(entry.name);
  const stem = fileName.replace(/_content$/i, '').replace(/\.zip$/i, '');
  const dir = entry.name.slice(0, entry.name.length - fileName.length);
  const sibling = zip.get(`${dir}${stem}.json`);
  if (sibling) {
    try {
      const meta = JSON.parse(await sibling.text());
      const name = meta.displayName || meta.DisplayName || meta.Name || meta.name;
      if (typeof name === 'string' && name.trim()) return name.trim();
    } catch {
      /* not JSON, or not the shape expected: fall back to the file name */
    }
  }
  return fileName;
}

function readPackageMetadata(zip) {
  const info = { name: '', description: '', vendor: '', version: '', raw: {} };
  const meta = zip.findOne((e) => /(^|\/)(contentmetadata\.md|metainfo\.prop|resources\.cnt)$/i.test(e.name));
  if (!meta) return info;
  info.file = meta.name;
  return info;
}

async function readArtifact(zip, zipName, warnings) {
  const artifact = {
    id: '',
    name: '',
    zipName,
    type: 'other',
    version: '',
    description: '',
    manifest: new Map(),
    manifestHeaders: [],
    iflw: null,
    iflwPath: '',
    scripts: [],
    messageMappings: [],
    xsltMappings: [],
    schemas: [],
    valueMappings: [],
    otherResources: [],
    parameters: { values: new Map(), definitions: [] },
    warnings: [],
  };

  const manifestEntry = zip.get('META-INF/MANIFEST.MF');
  if (manifestEntry) {
    artifact.manifest = parseManifest(await manifestEntry.text());
    artifact.id = stripAttributes(artifact.manifest.get('Bundle-SymbolicName') || '');
    artifact.name = artifact.manifest.get('Bundle-Name') || artifact.id || zipName.replace(/\.zip$/i, '');
    artifact.version = artifact.manifest.get('Bundle-Version') || '';
    artifact.description = artifact.manifest.get('Bundle-Description') || '';
    artifact.manifestHeaders = [...artifact.manifest.entries()]
      .filter(([k]) => k !== 'Import-Package' && k !== 'Export-Package')
      .map(([key, value]) => ({ key, value }));
    artifact.importPackages = splitHeader(artifact.manifest.get('Import-Package'));
  }
  if (!artifact.name) artifact.name = zipName.replace(/\.zip$/i, '');

  // --- integration flow -------------------------------------------------
  const iflwEntry = zip.findOne('.iflw');
  if (iflwEntry) {
    artifact.type = 'iflow';
    artifact.iflwPath = iflwEntry.name;
    try {
      artifact.iflw = parseIflw(await iflwEntry.text(), iflwEntry.name);
    } catch (err) {
      artifact.warnings.push(`Integration flow could not be parsed: ${err.message}`);
      warnings.push(`${artifact.name}: ${err.message}`);
    }
  }

  // --- externalised parameters -----------------------------------------
  const propEntry = zip.findOne((e) => /parameters\.prop$/i.test(e.name));
  if (propEntry) artifact.parameters.values = parseProperties(await propEntry.text());

  const propdefEntry = zip.findOne((e) => /parameters\.propdef$/i.test(e.name));
  if (propdefEntry) {
    try {
      artifact.parameters.definitions = parseParameterDefinitions(await propdefEntry.text());
    } catch (err) {
      artifact.warnings.push(`Parameter definitions could not be read: ${err.message}`);
    }
  }

  const metaInfo = zip.findOne((e) => /(^|\/)metainfo\.prop$/i.test(e.name));
  if (metaInfo) {
    artifact.metaInfo = parseProperties(await metaInfo.text());
    // The description typed on the flow in Cloud Integration is saved here, and
    // the manifest often has none, so it is the fallback.
    if (!artifact.description) artifact.description = (artifact.metaInfo.get('description') || '').trim();
  }

  // --- resources --------------------------------------------------------
  for (const entry of zip.files()) {
    const path = entry.name;
    const lower = path.toLowerCase();
    if (lower.endsWith('.iflw') || lower.endsWith('manifest.mf')) continue;
    if (/parameters\.(prop|propdef)$/i.test(path) || /metainfo\.prop$/i.test(path)) continue;

    const ext = lower.split('.').pop();

    if (ext === 'groovy' || ext === 'js') {
      artifact.scripts.push({
        path,
        name: baseName(path),
        language: SCRIPT_LANGUAGES[ext] || ext,
        code: await entry.text(),
        size: entry.size,
      });
      continue;
    }
    if (ext === 'mmap' || ext === 'opmap') {
      artifact.messageMappings.push({
        ...parseMessageMapping(await entry.text(), path),
        kind: ext === 'opmap' ? 'Operation mapping' : 'Message mapping',
        size: entry.size,
      });
      continue;
    }
    if (ext === 'xsl' || ext === 'xslt') {
      artifact.xsltMappings.push({ ...summariseXslt(await entry.text(), path), size: entry.size });
      continue;
    }
    if (ext === 'xsd') {
      artifact.schemas.push({ ...summariseXsd(await entry.text(), path), kind: 'XSD', size: entry.size });
      continue;
    }
    if (ext === 'wsdl' || ext === 'edmx') {
      artifact.schemas.push({ path, name: baseName(path), kind: ext.toUpperCase(), size: entry.size, rootElements: [], types: [] });
      continue;
    }
    if (/value_?mapping|valmap/i.test(path) && ext === 'xml') {
      artifact.valueMappings.push(parseValueMapping(await entry.text(), path));
      artifact.type = artifact.type === 'other' ? 'valuemapping' : artifact.type;
      continue;
    }
    artifact.otherResources.push({ path, name: baseName(path), size: entry.size, ext });
  }

  if (artifact.type === 'other' && artifact.scripts.length && !iflwEntry) artifact.type = 'scriptcollection';

  artifact.scripts.sort((a, b) => a.name.localeCompare(b.name));
  artifact.messageMappings.sort((a, b) => a.name.localeCompare(b.name));
  return artifact;
}

function stripAttributes(value) {
  return String(value).split(';')[0].trim();
}

/**
 * parameters.propdef is an XML list of externalised parameter declarations.
 * Element naming has varied; read every <parameter>-ish node generically.
 */
function parseParameterDefinitions(xmlText) {
  const doc = parseXml(xmlText);
  const out = [];
  const nodes = descendants(doc).filter((n) => /^param(eter)?$/i.test(n.local));
  for (const node of nodes) {
    const name = text(child(node, 'name')) || attr(node, 'name') || '';
    if (!name) continue;
    out.push({
      name: name.trim(),
      dataType: (text(child(node, 'datatype')) || attr(node, 'datatype') || '').replace(/^xsd:/, ''),
      defaultValue: text(child(node, 'default')) || attr(node, 'default') || '',
      description: text(child(node, 'description')) || '',
    });
  }
  return out;
}
