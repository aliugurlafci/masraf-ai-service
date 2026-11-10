// A small .xlsx reader and writer on node:zlib alone (docs/onay-sistemi.md, section 6, "Tanım listeleri").
// The reader returns the first sheet's cells as text; the writer makes a one-sheet workbook of text cells.
// Uploaded files are untrusted: the ZIP is checked before anything is inflated (no ZIP64, no encryption,
// only stored or deflated parts, a cap on the number of parts and on their inflated size), only the parts
// the sheet needs are inflated, and the XML is scanned without a DOCTYPE or entity definitions.
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { HttpError } from '../errors.ts';

/** A non-empty row of the sheet: its Excel row number (1-based) and its cells from column A on ('' = empty). */
export interface SheetRow {
  readonly satir: number;
  readonly hucreler: readonly string[];
}

export interface ReadOptions {
  /** Rows after the first non-empty one (the header). More is refused. Default 20 000. */
  readonly maxDataRows?: number;
  /** Inflated size of the parts read, together. Default 64 MB. */
  readonly maxBytes?: number;
  /** Parts in the ZIP. Default 2000. */
  readonly maxEntries?: number;
  /** Columns that may hold a value (A = 1). A value further right is refused, since every row is padded up to
   * its last value and one far-right cell per row would otherwise cost hundreds of KB of memory per row.
   * Empty (formatted) cells further right are ignored. Default 256. */
  readonly maxColumns?: number;
}

export interface SheetSpec {
  readonly name: string;
  readonly header: readonly string[];
  readonly rows: ReadonlyArray<readonly string[]>;
}

export interface ZipFile {
  readonly name: string;
  readonly data: Buffer;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const MB = 1024 * 1024;
const DEFAULTS = { maxDataRows: 20_000, maxBytes: 64 * MB, maxEntries: 2000, maxColumns: 256 } as const;
/** Excel's last column, XFD. */
const MAX_COLUMNS = 16_384;

const invalid = (message: string): HttpError => new HttpError(400, 'gecersiz_dosya', message);
const ONLY_XLSX = 'Yalnızca .xlsx (Excel 2007 ve sonrası) dosyaları içe aktarılabilir.';
const BROKEN = 'Excel dosyası bozuk ya da okunamıyor.';

// ---------------------------------------------------------------------------------------------------
// ZIP

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

interface Entry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly offset: number;
}

/** The central directory, by lower-case part name (OOXML part names are case-insensitive). */
function zipEntries(buf: Buffer, maxEntries: number): Map<string, Entry> {
  if (buf.length >= OLE_MAGIC.length && buf.subarray(0, OLE_MAGIC.length).equals(OLE_MAGIC)) {
    // An Office file that is not a ZIP: an .xls, or an .xlsx saved with a password (the package is then
    // stored encrypted in an OLE container, under a stream named EncryptedPackage).
    if (buf.includes(Buffer.from('EncryptedPackage', 'utf16le'))) {
      throw invalid('Dosya parolayla korunuyor. Parolayı kaldırıp .xlsx olarak yeniden kaydedin.');
    }
    throw invalid(ONLY_XLSX);
  }
  if (buf.length < 22 || buf.readUInt32LE(0) !== SIG_LOCAL) throw invalid(`Dosya bir Excel dosyası değil. ${ONLY_XLSX}`);

  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw invalid(BROKEN);
  const disk = buf.readUInt16LE(end + 4);
  const cdDisk = buf.readUInt16LE(end + 6);
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff || (end >= 20 && buf.readUInt32LE(end - 20) === SIG_ZIP64_LOCATOR)) {
    throw invalid('Dosya desteklenmeyen bir biçimde (ZIP64) sıkıştırılmış.');
  }
  if (disk !== 0 || cdDisk !== 0 || cdOffset + cdSize > end) throw invalid(BROKEN);
  if (count > maxEntries) throw invalid('Dosyada çok fazla parça var; bir Excel çalışma kitabı değil.');

  const entries = new Map<string, Entry>();
  let pos = cdOffset;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || buf.readUInt32LE(pos) !== SIG_CENTRAL) throw invalid(BROKEN);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const entry: Entry = {
      flags: buf.readUInt16LE(pos + 8),
      method: buf.readUInt16LE(pos + 10),
      crc: buf.readUInt32LE(pos + 16),
      compressedSize: buf.readUInt32LE(pos + 20),
      size: buf.readUInt32LE(pos + 24),
      offset: buf.readUInt32LE(pos + 42),
      name: buf.toString('utf8', pos + 46, pos + 46 + nameLength),
    };
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.offset === 0xffffffff) {
      throw invalid('Dosya desteklenmeyen bir biçimde (ZIP64) sıkıştırılmış.');
    }
    entries.set(entry.name.replace(/\\/g, '/').replace(/^\//, '').toLowerCase(), entry);
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Inflates the parts of one ZIP within a shared byte budget. */
function zipReader(buf: Buffer, entries: Map<string, Entry>, maxBytes: number): (name: string) => Buffer | null {
  let budget = maxBytes;
  return (name) => {
    const entry = entries.get(name.toLowerCase());
    if (entry === undefined) return null;
    if (entry.flags & 0x1) throw invalid('Dosya parolayla korunuyor. Parolayı kaldırıp .xlsx olarak yeniden kaydedin.');
    if (entry.method !== 0 && entry.method !== 8) throw invalid('Dosya desteklenmeyen bir biçimde sıkıştırılmış.');
    if (entry.size > budget) throw invalid('Dosyanın içeriği çok büyük.');
    const at = entry.offset;
    if (at + 30 > buf.length || buf.readUInt32LE(at) !== SIG_LOCAL) throw invalid(BROKEN);
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    if (start + entry.compressedSize > buf.length) throw invalid(BROKEN);
    const raw = buf.subarray(start, start + entry.compressedSize);
    let data: Buffer;
    if (entry.method === 0) {
      data = raw;
    } else {
      try {
        // The declared size is a cap, never trusted: a part that inflates to more is refused midway.
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
      } catch {
        throw invalid(BROKEN);
      }
    }
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw invalid(BROKEN);
    budget -= data.length;
    return data;
  };
}

/** One part of a ZIP, inflated under the same checks as an import; null when it is not there. */
export function zipPart(buf: Buffer, name: string, options: ReadOptions = {}): Buffer | null {
  const { maxBytes, maxEntries } = { ...DEFAULTS, ...options };
  return zipReader(buf, zipEntries(buf, maxEntries), maxBytes)(name);
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A ZIP of deflated files with UTF-8 names. */
export function writeZip(files: readonly ZipFile[], when = new Date()): Buffer {
  const { time, date } = dosTime(when);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = deflateRawSync(file.data);
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------------------------------------------------------------------------------------------------
// XML

interface XmlHandler {
  /** `name` is the local name (any namespace prefix dropped); `attrs` the raw attribute text. */
  open?(name: string, attrs: string, selfClosing: boolean): void;
  close?(name: string): void;
  text?(text: string): void;
}

const START_TAG = /<([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
const END_TAG = /<\/([A-Za-z_][\w.:-]*)\s*>/y;

const localName = (name: string): string => {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
};

const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const code = ref[1] === 'x' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref] ?? whole;
  });
}

/** A forward-only scan of an XML document. Refuses DOCTYPE, so no entity can be defined or expanded. */
function walkXml(xml: string, h: XmlHandler): void {
  let pos = 0;
  const n = xml.length;
  while (pos < n) {
    const lt = xml.indexOf('<', pos);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > pos && h.text !== undefined) h.text(decodeEntities(xml.slice(pos, textEnd)));
    if (lt < 0) return;
    if (xml.startsWith('<?', lt)) {
      const close = xml.indexOf('?>', lt + 2);
      if (close < 0) throw invalid(BROKEN);
      pos = close + 2;
    } else if (xml.startsWith('<!--', lt)) {
      const close = xml.indexOf('-->', lt + 4);
      if (close < 0) throw invalid(BROKEN);
      pos = close + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const close = xml.indexOf(']]>', lt + 9);
      if (close < 0) throw invalid(BROKEN);
      h.text?.(xml.slice(lt + 9, close));
      pos = close + 3;
    } else if (xml.startsWith('<!', lt)) {
      throw invalid(BROKEN);
    } else if (xml.startsWith('</', lt)) {
      END_TAG.lastIndex = lt;
      const m = END_TAG.exec(xml);
      if (m === null) throw invalid(BROKEN);
      h.close?.(localName(m[1] ?? ''));
      pos = END_TAG.lastIndex;
    } else {
      START_TAG.lastIndex = lt;
      const m = START_TAG.exec(xml);
      if (m === null) throw invalid(BROKEN);
      const name = localName(m[1] ?? '');
      const selfClosing = m[3] === '/';
      h.open?.(name, m[2] ?? '', selfClosing);
      if (selfClosing) h.close?.(name);
      pos = START_TAG.lastIndex;
    }
  }
}

/** Attributes by their full name ("r:id", "Target"). */
function attributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out.set(m[1] ?? '', decodeEntities(m[2] ?? m[3] ?? ''));
  return out;
}

/** OOXML escapes characters XML cannot carry as _xHHHH_ ("_x000D_"); _x005F_ is the underscore itself. */
const unescapeOoxml = (s: string): string =>
  s.includes('_x') ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))) : s;

const textOf = (data: Buffer | null): string | null => (data === null ? null : data.toString('utf8').replace(/^﻿/, ''));

// ---------------------------------------------------------------------------------------------------
// Reading

interface Relationship {
  readonly type: string;
  readonly target: string;
}

function relationships(xml: string | null): Map<string, Relationship> {
  const out = new Map<string, Relationship>();
  if (xml === null) return out;
  walkXml(xml, {
    open(name, raw) {
      if (name !== 'Relationship') return;
      const a = attributes(raw);
      const id = a.get('Id');
      if (id !== undefined && a.get('TargetMode') !== 'External') out.set(id, { type: a.get('Type') ?? '', target: a.get('Target') ?? '' });
    },
  });
  return out;
}

/** A relationship target as a part name: relative to the source part's folder unless it starts with "/". */
function resolvePart(sourceFolder: string, target: string): string {
  const parts = (target.startsWith('/') ? target.slice(1) : `${sourceFolder}${target}`).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

const folderOf = (part: string): string => part.slice(0, part.lastIndexOf('/') + 1);
const relsOf = (part: string): string => `${folderOf(part)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`;
const byType = (rels: Map<string, Relationship>, suffix: string): Relationship | undefined => [...rels.values()].find((r) => r.type.endsWith(suffix));

function readSharedStrings(xml: string | null): string[] {
  const out: string[] = [];
  if (xml === null) return out;
  let current: string[] | null = null;
  let phonetic = 0;
  let inText = false;
  walkXml(xml, {
    open(name, _raw, selfClosing) {
      if (name === 'si') current = [];
      else if (name === 'rPh') phonetic++;
      else if (name === 't' && current !== null && phonetic === 0 && !selfClosing) inText = true;
    },
    text(t) {
      if (inText) current?.push(t);
    },
    close(name) {
      if (name === 't') inText = false;
      else if (name === 'rPh') phonetic--;
      else if (name === 'si') {
        out.push(unescapeOoxml((current ?? []).join('')));
        current = null;
      }
    },
  });
  return out;
}

/** "AB12" -> 27 (0-based column); null when the reference has no valid column. */
function columnOf(ref: string): number | null {
  const m = /^\$?([A-Za-z]{1,3})\$?\d*$/.exec(ref);
  if (m === null) return null;
  let col = 0;
  for (const ch of (m[1] ?? '').toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1;
}

/** A number cell as the user sees it in a General cell: 11033106, not 1.1033106E7; at most 15 digits. */
export function numberText(value: string): string {
  const raw = value.trim();
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n)) return raw;
  const r = Number(n.toPrecision(15));
  if (Number.isInteger(r)) return Math.abs(r) < 1e21 ? String(r) : BigInt(r).toString();
  const s = String(r);
  // Only tiny fractions come out in exponent form here ("1.5e-7"); write them out in full.
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (m === null) return s;
  const digits = `${m[2] ?? ''}${m[3] ?? ''}`;
  const point = (m[2] ?? '').length + Number(m[4]);
  const plain =
    point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${m[1] ?? ''}${plain}`;
}

function cellText(type: string, value: string, inline: string, shared: readonly string[]): string {
  switch (type) {
    case 's': {
      const i = Number.parseInt(value.trim(), 10);
      return Number.isInteger(i) ? (shared[i] ?? '') : '';
    }
    case 'inlineStr':
      return unescapeOoxml(inline);
    case 'str':
      return unescapeOoxml(value);
    case 'b':
      return value.trim() === '1' ? 'TRUE' : value.trim() === '0' ? 'FALSE' : value.trim();
    case 'e':
    case 'd':
      return value.trim();
    default:
      return numberText(value);
  }
}

function readRows(xml: string, shared: readonly string[], maxDataRows: number, maxColumns: number): SheetRow[] {
  const rows: SheetRow[] = [];
  let inData = false;
  let rowNumber = 0;
  let cells: string[] | null = null;
  let col = -1;
  let cellType = 'n';
  let value = '';
  let inline = '';
  let inValue = false;
  let inInline = false;
  let inText = false;
  let phonetic = 0;
  walkXml(xml, {
    open(name, raw, selfClosing) {
      if (name === 'sheetData') inData = true;
      if (!inData) return;
      if (name === 'row') {
        const r = Number.parseInt(attributes(raw).get('r') ?? '', 10);
        rowNumber = Number.isInteger(r) && r > rowNumber ? r : rowNumber + 1;
        cells = [];
        col = -1;
      } else if (name === 'c' && cells !== null) {
        const a = attributes(raw);
        const ref = a.get('r');
        const at = ref === undefined ? null : columnOf(ref);
        col = at !== null && at > col ? at : col + 1;
        if (col >= MAX_COLUMNS) throw invalid(BROKEN);
        cellType = a.get('t') ?? 'n';
        value = '';
        inline = '';
        if (selfClosing) cellType = '';
      } else if (name === 'v') {
        inValue = !selfClosing;
      } else if (name === 'is') {
        inInline = !selfClosing;
      } else if (name === 'rPh') {
        phonetic++;
      } else if (name === 't' && inInline && phonetic === 0) {
        inText = !selfClosing;
      }
    },
    text(t) {
      if (inValue) value += t;
      else if (inText) inline += t;
    },
    close(name) {
      if (name === 'sheetData') inData = false;
      else if (name === 'v') inValue = false;
      else if (name === 't') inText = false;
      else if (name === 'is') inInline = false;
      else if (name === 'rPh') phonetic--;
      else if (name === 'c' && cells !== null) {
        if (cellType !== '') {
          const text = cellText(cellType, value, inline, shared);
          if (text !== '') {
            if (col >= maxColumns) throw invalid(`Dosyada en fazla ${maxColumns.toLocaleString('tr-TR')} sütun olabilir.`);
            while (cells.length < col) cells.push('');
            cells[col] = text;
          }
        }
      } else if (name === 'row' && cells !== null) {
        if (cells.some((c) => c.trim() !== '')) {
          if (rows.length > maxDataRows) throw invalid(`Dosyada en fazla ${maxDataRows.toLocaleString('tr-TR')} veri satırı olabilir.`);
          rows.push({ satir: rowNumber, hucreler: cells });
        }
        cells = null;
      }
    },
  });
  return rows;
}

/** The first sheet's non-empty rows. Errors are 400 gecersiz_dosya with a Turkish message. */
export function readXlsx(buf: Buffer, options: ReadOptions = {}): SheetRow[] {
  const { maxDataRows, maxBytes, maxEntries, maxColumns } = { ...DEFAULTS, ...options };
  const entries = zipEntries(buf, maxEntries);
  const read = zipReader(buf, entries, maxBytes);
  const main = byType(relationships(textOf(read('_rels/.rels'))), '/officeDocument');
  const workbookPart = main === undefined ? 'xl/workbook.xml' : resolvePart('', main.target);
  const workbook = textOf(read(workbookPart));
  if (workbook === null) throw invalid(`Dosya bir Excel çalışma kitabı değil. ${ONLY_XLSX}`);

  let sheetRel: string | null = null;
  walkXml(workbook, {
    open(name, raw) {
      if (name !== 'sheet' || sheetRel !== null) return;
      for (const [key, value] of attributes(raw)) if (key.includes(':') && localName(key) === 'id') sheetRel = value;
    },
  });
  const rels = relationships(textOf(read(relsOf(workbookPart))));
  const sheet = sheetRel === null ? undefined : rels.get(sheetRel);
  const sheetXml = sheet === undefined ? null : textOf(read(resolvePart(folderOf(workbookPart), sheet.target)));
  if (sheetXml === null) throw invalid('Çalışma kitabında sayfa bulunamadı.');
  const sharedRel = byType(rels, '/sharedStrings');
  const shared = sharedRel === undefined ? [] : readSharedStrings(textOf(read(resolvePart(folderOf(workbookPart), sharedRel.target))));
  return readRows(sheetXml, shared, maxDataRows, maxColumns);
}

// ---------------------------------------------------------------------------------------------------
// Writing

const escapeXml = (s: string): string =>
  s
    // Characters XML 1.0 cannot carry at all, and lone surrogates.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Keeps a literal "_x0041_" from being read back as "A". */
const escapeOoxml = (s: string): string => s.replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1');

/** Excel's rules for sheet names: at most 31 characters, none of []:*?/\, no apostrophe at either end. */
export function sheetName(name: string): string {
  const clean = name
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/[\u0000-\u001F]/g, '')
    .trim()
    .replace(/^'+|'+$/g, '')
    .slice(0, 31)
    .trim();
  return clean === '' ? 'Sayfa1' : clean;
}

function columnName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

// Style 1: bold header. Style 2: text ("@"), also the columns' default, so codes typed into the template
// later ("0012", "11033106") stay text.
const STYLES = `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** A one-sheet workbook: a bold header row and text cells (never formulas). */
export function writeXlsx(spec: SheetSpec, when = new Date()): Buffer {
  const strings = new Map<string, number>();
  let refs = 0;
  const index = (s: string): number => {
    refs++;
    let i = strings.get(s);
    if (i === undefined) {
      i = strings.size;
      strings.set(s, i);
    }
    return i;
  };
  const all = [spec.header, ...spec.rows];
  let width = 1;
  for (const r of all) width = Math.max(width, r.length);
  const widths = Array.from({ length: width }, () => 8);
  for (const r of all) r.forEach((v, c) => (widths[c] = Math.min(60, Math.max(widths[c] ?? 8, v.length + 2))));
  const rowXml = all.map((cells, r) => {
    const style = r === 0 ? 1 : 2;
    const out = cells
      .map((v, c) => (v === '' ? '' : `<c r="${columnName(c)}${r + 1}" t="s" s="${style}"><v>${index(v)}</v></c>`))
      .join('');
    return `<row r="${r + 1}">${out}</row>`;
  });
  const lastCell = `${columnName(width - 1)}${all.length}`;
  const sheet =
    `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><dimension ref="A1:${lastCell}"/>` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" style="2" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${rowXml.join('')}</sheetData></worksheet>`;
  const sst =
    `${XML_HEAD}<sst xmlns="${NS_MAIN}" count="${refs}" uniqueCount="${strings.size}">` +
    [...strings.keys()]
      .map((s) => {
        const text = escapeXml(escapeOoxml(s));
        return /^\s|\s$/.test(s) ? `<si><t xml:space="preserve">${text}</t></si>` : `<si><t>${text}</t></si>`;
      })
      .join('') +
    '</sst>';
  const workbook = `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView/></bookViews><sheets><sheet name="${escapeXml(sheetName(spec.name))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels =
    `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId3" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const rootRels = `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const ct = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  const contentTypes =
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/xl/workbook.xml" ContentType="${ct}.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${ct}.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="${ct}.styles+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="${ct}.sharedStrings+xml"/></Types>`;
  const file = (name: string, text: string): ZipFile => ({ name, data: Buffer.from(text, 'utf8') });
  return writeZip(
    [
      file('[Content_Types].xml', contentTypes),
      file('_rels/.rels', rootRels),
      file('xl/workbook.xml', workbook),
      file('xl/_rels/workbook.xml.rels', workbookRels),
      file('xl/worksheets/sheet1.xml', sheet),
      file('xl/styles.xml', STYLES),
      file('xl/sharedStrings.xml', sst),
    ],
    when,
  );
}
