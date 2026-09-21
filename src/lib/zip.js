/**
 * Minimal, dependency-free ZIP reader.
 *
 * Handles the subset of the format SAP Cloud Integration exports actually use:
 * stored (method 0) and deflate (method 8) entries, optional ZIP64 end-of-central
 * directory records. Inflation is done by the platform's DecompressionStream, which
 * exists in every current browser and in Node 18+, so nothing needs to be bundled.
 */

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;

const utf8 = new TextDecoder('utf-8');
const cp437 = new TextDecoder('windows-1252'); // close enough for legacy names

class ZipEntry {
  constructor(archive, meta) {
    this.archive = archive;
    this.name = meta.name;
    this.compressedSize = meta.compressedSize;
    this.size = meta.size;
    this.method = meta.method;
    this.localHeaderOffset = meta.localHeaderOffset;
    this.crc32 = meta.crc32;
    this.date = meta.date;
    this.isDirectory = meta.name.endsWith('/');
    this._bytes = null;
  }

  /** @returns {Promise<Uint8Array>} */
  async bytes() {
    if (this._bytes) return this._bytes;
    this._bytes = await this.archive._readEntry(this);
    return this._bytes;
  }

  /** @returns {Promise<string>} decoded as UTF-8, BOM stripped */
  async text() {
    const bytes = await this.bytes();
    let out = utf8.decode(bytes);
    if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
    return out;
  }
}

export class ZipArchive {
  constructor(buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    /** @type {Map<string, ZipEntry>} */
    this.entries = new Map();
  }

  /** All entries, directories excluded. */
  files() {
    return [...this.entries.values()].filter((e) => !e.isDirectory);
  }

  get(path) {
    return this.entries.get(path) || null;
  }

  /** Entries whose path matches a predicate or a case-insensitive suffix. */
  find(test) {
    const fn =
      typeof test === 'function'
        ? test
        : (e) => e.name.toLowerCase().endsWith(String(test).toLowerCase());
    return this.files().filter(fn);
  }

  findOne(test) {
    return this.find(test)[0] || null;
  }

  _locateEocd() {
    const max = Math.min(this.bytes.length, 0xffff + 22);
    for (let i = 22; i <= max; i++) {
      const off = this.bytes.length - i;
      if (this.view.getUint32(off, true) === EOCD_SIG) return off;
    }
    throw new Error('Not a ZIP file (no end-of-central-directory record found).');
  }

  _readCentralDirectory() {
    const eocd = this._locateEocd();
    let count = this.view.getUint16(eocd + 10, true);
    let cdOffset = this.view.getUint32(eocd + 16, true);

    // ZIP64: the 32-bit fields are saturated and the real values live in the
    // ZIP64 EOCD record pointed at by the locator that precedes the EOCD.
    if (cdOffset === 0xffffffff || count === 0xffff) {
      const locator = eocd - 20;
      if (locator >= 0 && this.view.getUint32(locator, true) === EOCD64_LOCATOR_SIG) {
        const z64 = Number(this.view.getBigUint64(locator + 8, true));
        if (this.view.getUint32(z64, true) === EOCD64_SIG) {
          count = Number(this.view.getBigUint64(z64 + 32, true));
          cdOffset = Number(this.view.getBigUint64(z64 + 48, true));
        }
      }
    }

    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (this.view.getUint32(p, true) !== CEN_SIG) break;
      const flags = this.view.getUint16(p + 8, true);
      const method = this.view.getUint16(p + 10, true);
      const modTime = this.view.getUint16(p + 12, true);
      const modDate = this.view.getUint16(p + 14, true);
      const crc32 = this.view.getUint32(p + 16, true);
      let compressedSize = this.view.getUint32(p + 20, true);
      let size = this.view.getUint32(p + 24, true);
      const nameLen = this.view.getUint16(p + 28, true);
      const extraLen = this.view.getUint16(p + 30, true);
      const commentLen = this.view.getUint16(p + 32, true);
      let localHeaderOffset = this.view.getUint32(p + 42, true);

      const nameBytes = this.bytes.subarray(p + 46, p + 46 + nameLen);
      const name = ((flags & 0x800) === 0 ? cp437 : utf8).decode(nameBytes).replace(/\\/g, '/');

      if (size === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        const extra = p + 46 + nameLen;
        let q = extra;
        while (q < extra + extraLen - 3) {
          const id = this.view.getUint16(q, true);
          const len = this.view.getUint16(q + 2, true);
          if (id === 0x0001) {
            let r = q + 4;
            if (size === 0xffffffff) { size = Number(this.view.getBigUint64(r, true)); r += 8; }
            if (compressedSize === 0xffffffff) { compressedSize = Number(this.view.getBigUint64(r, true)); r += 8; }
            if (localHeaderOffset === 0xffffffff) { localHeaderOffset = Number(this.view.getBigUint64(r, true)); }
            break;
          }
          q += 4 + len;
        }
      }

      this.entries.set(
        name,
        new ZipEntry(this, {
          name,
          method,
          crc32,
          compressedSize,
          size,
          localHeaderOffset,
          date: dosDate(modDate, modTime),
        })
      );
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  async _readEntry(entry) {
    const p = entry.localHeaderOffset;
    if (this.view.getUint32(p, true) !== 0x04034b50) {
      throw new Error(`Corrupt local header for "${entry.name}".`);
    }
    const nameLen = this.view.getUint16(p + 26, true);
    const extraLen = this.view.getUint16(p + 28, true);
    const start = p + 30 + nameLen + extraLen;
    const raw = this.bytes.subarray(start, start + entry.compressedSize);

    if (entry.method === 0) return raw.slice();
    if (entry.method !== 8) {
      throw new Error(`Unsupported compression method ${entry.method} for "${entry.name}".`);
    }
    return inflateRaw(raw);
  }
}

/** Read a ZIP from an ArrayBuffer / Uint8Array / Blob / File. */
export async function readZip(input) {
  let buffer;
  if (input instanceof ArrayBuffer) buffer = input;
  else if (ArrayBuffer.isView(input)) buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  else if (typeof input.arrayBuffer === 'function') buffer = await input.arrayBuffer();
  else throw new Error('readZip expects an ArrayBuffer, TypedArray, Blob or File.');

  const archive = new ZipArchive(buffer);
  archive._readCentralDirectory();
  return archive;
}

/** True when the bytes start with a local file header — used to spot nested zips. */
export function looksLikeZip(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7);
}

async function inflateRaw(raw) {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const chunks = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

function dosDate(date, time) {
  if (!date) return null;
  return new Date(
    1980 + ((date >> 9) & 0x7f),
    ((date >> 5) & 0x0f) - 1,
    date & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2
  );
}
