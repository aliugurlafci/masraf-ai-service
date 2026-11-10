// The dependency-free .xlsx reader and writer (src/excel/xlsx.ts). Workbooks are built in the test, either
// with the writer or part by part with writeZip, so every cell type and every refusal can be checked.
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { numberText, readXlsx, sheetName, writeXlsx, writeZip, zipPart, type ZipFile } from '../../src/excel/xlsx.ts';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

const file = (name: string, text: string): ZipFile => ({ name, data: Buffer.from(text, 'utf8') });
const sheetXml = (rows: string, prefix = ''): string =>
  prefix === ''
    ? `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${NS}"><sheetData>${rows}</sheetData></worksheet>`
    : `<?xml version="1.0" encoding="UTF-8"?><${prefix}:worksheet xmlns:${prefix}="${NS}"><${prefix}:sheetData>${rows}</${prefix}:sheetData></${prefix}:worksheet>`;

interface BookParts {
  readonly sheet: string;
  readonly shared?: string;
  /** Target of the first sheet in xl/_rels/workbook.xml.rels. */
  readonly target?: string;
  /** Where the first sheet is stored, when the target does not say it plainly. */
  readonly part?: string;
  readonly extra?: readonly ZipFile[];
}

/** A workbook made part by part: the first sheet's XML and, optionally, the shared strings' <si> items. */
function book(parts: BookParts): Buffer {
  const target = parts.target ?? 'worksheets/sheet1.xml';
  const sheetPart = parts.part ?? `xl/${target}`;
  return writeZip([
    file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    file('_rels/.rels', `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    file('xl/workbook.xml', `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="Veri" sheetId="1" r:id="rId7"/><sheet name="Diğer" sheetId="2" r:id="rId8"/></sheets></workbook>`),
    file(
      'xl/_rels/workbook.xml.rels',
      `<Relationships xmlns="${PKG}"><Relationship Id="rId8" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId7" Type="${REL}/worksheet" Target="${target}"/>` +
        (parts.shared === undefined ? '' : `<Relationship Id="rId9" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`) +
        '</Relationships>',
    ),
    file(sheetPart, parts.sheet),
    ...(target === 'worksheets/sheet1.xml' ? [] : [file('xl/worksheets/sheet1.xml', sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>ikinci sayfa</t></is></c></row>'))]),
    ...(parts.shared === undefined ? [] : [file('xl/sharedStrings.xml', `<sst xmlns="${NS}">${parts.shared}</sst>`)]),
    ...(parts.extra ?? []),
  ]);
}

const cells = (buf: Buffer, options?: Parameters<typeof readXlsx>[1]) => readXlsx(buf, options).map((r) => r.hucreler);

const rejects = (fn: () => unknown, message?: RegExp | string): void => {
  let error: unknown = null;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  expect(error).toMatchObject({ status: 400, code: 'gecersiz_dosya' });
  if (message !== undefined) expect((error as Error).message).toMatch(message);
};

/** Offset of the central directory record of `name` in a ZIP made by writeZip. */
function centralRecord(zip: Buffer, name: string): number {
  const at = zip.lastIndexOf(Buffer.from(name, 'utf8'));
  expect(zip.readUInt32LE(at - 46)).toBe(0x02014b50);
  return at - 46;
}

describe('writing and reading back', () => {
  it('keeps Turkish text, XML special characters, spaces and literal escapes', () => {
    const rows = [
      ['İĞÜŞÖÇ ığüşöç', 'Şenpiliç Gıda Sanayi A.Ş.'],
      ['<b>&amp;</b> "tırnak" \'kesme\'', '  baştaki ve sondaki boşluk  '],
      ['_x0041_ olduğu gibi kalır', 'satır\nsonu'],
      ['=1+2', '@SUM(A1)'],
      ['😀 emoji', 'Kodu: 0012'],
    ];
    const xlsx = writeXlsx({ name: 'Liste', header: ['Kod', 'Açıklama'], rows });
    expect(readXlsx(xlsx)).toEqual([
      { satir: 1, hucreler: ['Kod', 'Açıklama'] },
      ...rows.map((hucreler, i) => ({ satir: i + 2, hucreler })),
    ]);
  });

  it('writes text cells only, with a bold header and the text format as the columns default', () => {
    const xlsx = writeXlsx({ name: 'Liste', header: ['Kod', 'Ad'], rows: [['=HYPERLINK("x")', '11033106']] });
    const sheet = zipPart(xlsx, 'xl/worksheets/sheet1.xml')?.toString('utf8') ?? '';
    expect(sheet).not.toContain('<f>');
    expect(sheet).toMatch(/<c r="A1" t="s" s="1">/);
    expect(sheet).toMatch(/<c r="A2" t="s" s="2">/);
    expect(sheet).toContain('style="2"');
    expect(sheet).toContain('state="frozen"');
    const styles = zipPart(xlsx, 'xl/styles.xml')?.toString('utf8') ?? '';
    expect(styles).toContain('<b/>');
    expect(styles).toContain('numFmtId="49"');
    const types = zipPart(xlsx, '[Content_Types].xml')?.toString('utf8') ?? '';
    for (const part of ['/xl/workbook.xml', '/xl/worksheets/sheet1.xml', '/xl/styles.xml', '/xl/sharedStrings.xml']) expect(types).toContain(`PartName="${part}"`);
    expect(zipPart(xlsx, '_rels/.rels')?.toString('utf8')).toContain('Target="xl/workbook.xml"');
    expect(zipPart(xlsx, 'xl/_rels/workbook.xml.rels')?.toString('utf8')).toContain('Target="sharedStrings.xml"');
  });

  it('shares repeated strings and leaves empty cells out', () => {
    const xlsx = writeXlsx({ name: 'Liste', header: ['Kod', 'Ad', 'Aktif'], rows: [['A', '', 'Evet'], ['B', '', 'Evet'], ['C', 'Üç', 'Hayır']] });
    const sst = zipPart(xlsx, 'xl/sharedStrings.xml')?.toString('utf8') ?? '';
    expect(sst.match(/<si>/g)).toHaveLength(9);
    expect(sst).toContain('count="10"');
    expect(cells(xlsx)).toEqual([
      ['Kod', 'Ad', 'Aktif'],
      ['A', '', 'Evet'],
      ['B', '', 'Evet'],
      ['C', 'Üç', 'Hayır'],
    ]);
  });

  it('cleans the sheet name the way Excel requires', () => {
    expect(sheetName('Masraf Merkezleri')).toBe('Masraf Merkezleri');
    expect(sheetName("'a/b\\c:d*e?f[g]h'")).toBe('a b c d e f g h');
    expect(sheetName('Çok uzun bir alan adı: otuz bir karakteri geçer')).toHaveLength(31);
    expect(sheetName(' [] ')).toBe('Sayfa1');
    const xlsx = writeXlsx({ name: 'Proje/Kodu: [2026] çok uzun bir sayfa adı', header: ['Kod'], rows: [] });
    const workbook = zipPart(xlsx, 'xl/workbook.xml')?.toString('utf8') ?? '';
    const name = /<sheet name="([^"]*)"/.exec(workbook)?.[1] ?? '';
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[[\]:*?/\\]/);
  });

  it('reads an empty list as its header row only', () => {
    expect(readXlsx(writeXlsx({ name: 'Boş', header: ['Kod', 'Açıklama', 'Aktif'], rows: [] }))).toEqual([{ satir: 1, hucreler: ['Kod', 'Açıklama', 'Aktif'] }]);
  });
});

describe('reading workbooks made by other programs', () => {
  it('joins rich-text runs and leaves out phonetic hints', () => {
    const shared =
      '<si><r><rPr><b/></rPr><t>Kalın</t></r><r><t xml:space="preserve"> metin</t></r><rPh sb="0" eb="1"><t>ふりがな</t></rPh><phoneticPr fontId="1"/></si>' +
      '<si><t>satır_x000D_sonu</t></si><si><t/></si><si><t>&#x15F;&#351;&amp;&lt;</t></si>';
    const xlsx = book({
      shared,
      sheet: sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>'),
    });
    expect(cells(xlsx)).toEqual([['Kalın metin', 'satır\rsonu', '', 'şş&<']]);
  });

  it('reads inline strings, formula strings, booleans, errors and numbers as text', () => {
    const xlsx = book({
      sheet: sheetXml(
        '<row r="1">' +
          '<c r="A1" t="inlineStr"><is><r><t>Satır</t></r><r><t xml:space="preserve"> içi</t></r><rPh><t>x</t></rPh></is></c>' +
          '<c r="B1" t="str"><f>A1&amp;"!"</f><v>Satır içi!</v></c>' +
          '<c r="C1" t="b"><v>1</v></c><c r="D1" t="b"><v>0</v></c>' +
          '<c r="E1" t="e"><v>#N/A</v></c>' +
          '<c r="F1"><v>11033106</v></c><c r="G1" t="n"><v>1.1033106E7</v></c><c r="H1"><v>0.30000000000000004</v></c>' +
          '<c r="I1"><v>1.5E-7</v></c><c r="J1"><v>-20</v></c><c r="K1"><f>1+1</f><v>2</v></c>' +
          '</row>',
      ),
    });
    expect(cells(xlsx)).toEqual([['Satır içi', 'Satır içi!', 'TRUE', 'FALSE', '#N/A', '11033106', '11033106', '0.3', '0.00000015', '-20', '2']]);
  });

  it('turns numbers into the text a General cell shows', () => {
    expect(numberText('11033106')).toBe('11033106');
    expect(numberText('1.1033106E7')).toBe('11033106');
    expect(numberText('1E+21')).toBe('1000000000000000000000');
    expect(numberText('20')).toBe('20');
    expect(numberText('0.1')).toBe('0.1');
    expect(numberText('2.5000000000000001E-2')).toBe('0.025');
    expect(numberText(' 7 ')).toBe('7');
    expect(numberText('abc')).toBe('abc');
  });

  it('places cells without references after the previous one and keeps the row numbers', () => {
    const xlsx = book({
      sheet: sheetXml(
        '<row><c t="inlineStr"><is><t>Kod</t></is></c><c t="inlineStr"><is><t>Ad</t></is></c></row>' +
          '<row r="2"/>' +
          '<row r="3" spans="1:4"><c r="A3" t="inlineStr"><is><t>a</t></is></c><c r="D3" t="inlineStr"><is><t>d</t></is></c><c t="inlineStr"><is><t>e</t></is></c></row>' +
          '<row r="5"><c r="B5" s="3"/><c r="C5" t="inlineStr"><is><t>  </t></is></c></row>' +
          '<row><c r="B6"><v>6</v></c></row>',
      ),
    });
    expect(readXlsx(xlsx)).toEqual([
      { satir: 1, hucreler: ['Kod', 'Ad'] },
      { satir: 3, hucreler: ['a', '', '', 'd', 'e'] },
      { satir: 6, hucreler: ['', '6'] },
    ]);
  });

  it('finds the first sheet through the workbook relationships, not by its file name', () => {
    const data = book({ target: 'worksheets/veri.xml', sheet: sheetXml('<x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>ilk sayfa</x:t></x:is></x:c></x:row>', 'x') });
    expect(cells(data)).toEqual([['ilk sayfa']]);
    const absolute = book({ target: '/xl/sayfalar/../worksheets/mutlak.xml', part: 'xl/worksheets/mutlak.xml', sheet: sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>mutlak yol</t></is></c></row>') });
    expect(cells(absolute)).toEqual([['mutlak yol']]);
  });

  it('accepts comments, processing instructions and CDATA', () => {
    const xlsx = book({
      sheet: sheetXml('<!-- yorum --><?pi x?><row r="1"><c r="A1" t="inlineStr"><is><t><![CDATA[<ham> & metin]]></t></is></c></row>'),
    });
    expect(cells(xlsx)).toEqual([['<ham> & metin']]);
  });
});

describe('refusing files that are not plain .xlsx', () => {
  it('refuses text, CSV and empty files', () => {
    rejects(() => readXlsx(Buffer.from('Kod;Açıklama\n1;bir\n', 'utf8')), /Excel/);
    rejects(() => readXlsx(Buffer.alloc(0)));
    rejects(() => readXlsx(Buffer.from('PK\x03\x04 kırpılmış', 'latin1')));
  });

  it('refuses old .xls files and password-protected workbooks', () => {
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
    rejects(() => readXlsx(ole), 'Yalnızca .xlsx (Excel 2007 ve sonrası) dosyaları içe aktarılabilir.');
    const encrypted = Buffer.concat([ole, Buffer.from('EncryptedPackage', 'utf16le'), Buffer.alloc(64)]);
    rejects(() => readXlsx(encrypted), /parola/);
  });

  it('refuses a ZIP that is not a workbook, and a workbook without its sheet', () => {
    rejects(() => readXlsx(writeZip([file('word/document.xml', '<w:document/>')])), /çalışma kitabı değil/);
    rejects(() => readXlsx(book({ target: 'worksheets/yok.xml', part: 'xl/worksheets/baska.xml', sheet: sheetXml('') })), /sayfa bulunamadı/);
    rejects(() => readXlsx(writeZip([file('_rels/.rels', `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`), file('xl/workbook.xml', `<workbook xmlns="${NS}"><sheets/></workbook>`)])), /sayfa bulunamadı/);
  });

  it('refuses a truncated or altered file', () => {
    const xlsx = writeXlsx({ name: 'Liste', header: ['Kod'], rows: [['A']] });
    rejects(() => readXlsx(xlsx.subarray(0, xlsx.length - 30)));
    const altered = Buffer.from(xlsx);
    const at = centralRecord(altered, 'xl/worksheets/sheet1.xml');
    altered.writeUInt32LE((altered.readUInt32LE(at + 16) ^ 1) >>> 0, at + 16); // CRC
    rejects(() => readXlsx(altered), /bozuk/);
  });

  it('refuses a DOCTYPE, so no entity can be defined', () => {
    const bomb = book({
      sheet: `<?xml version="1.0"?><!DOCTYPE lol [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&b;</t></is></c></row></sheetData></worksheet>`,
    });
    rejects(() => readXlsx(bomb), /bozuk/);
  });

  it('refuses ZIP64, encrypted parts and unknown compression', () => {
    const xlsx = writeXlsx({ name: 'Liste', header: ['Kod'], rows: [['A']] });
    const zip64 = Buffer.from(xlsx);
    zip64.writeUInt16LE(0xffff, zip64.length - 22 + 10);
    rejects(() => readXlsx(zip64), /ZIP64/);
    const encrypted = Buffer.from(xlsx);
    const at = centralRecord(encrypted, 'xl/worksheets/sheet1.xml');
    encrypted.writeUInt16LE(encrypted.readUInt16LE(at + 8) | 1, at + 8);
    rejects(() => readXlsx(encrypted), /parola/);
    const bzip = Buffer.from(xlsx);
    bzip.writeUInt16LE(12, centralRecord(bzip, 'xl/worksheets/sheet1.xml') + 10);
    rejects(() => readXlsx(bzip), /desteklenmeyen/);
  });

  it('refuses archives with too many parts', () => {
    const many = Array.from({ length: 2001 }, (_, i) => file(`x/${i}.xml`, '<a/>'));
    rejects(() => readXlsx(writeZip(many)), /çok fazla parça/);
    rejects(() => readXlsx(book({ sheet: sheetXml('') }), { maxEntries: 3 }), /çok fazla parça/);
  });

  it('refuses a part that inflates past the limit before inflating it (zip bomb)', () => {
    const rows = `<row r="1"><c r="A1" t="inlineStr"><is><t>${'a'.repeat(2 * 1024 * 1024)}</t></is></c></row>`;
    const big = book({ sheet: sheetXml(rows) });
    expect(big.length).toBeLessThan(64 * 1024);
    rejects(() => readXlsx(big, { maxBytes: 1024 * 1024 }), /çok büyük/);
    expect(cells(big, { maxBytes: 4 * 1024 * 1024 })[0]?.[0]).toHaveLength(2 * 1024 * 1024);
    // The default limit: a 70 MB sheet compresses to well under the 5 MB upload limit.
    const huge = writeZip([{ name: 'xl/workbook.xml', data: Buffer.alloc(70 * 1024 * 1024, 0x20) }]);
    expect(huge.length).toBeLessThan(5 * 1024 * 1024);
    rejects(() => readXlsx(huge), /çok büyük/);
  });

  it('refuses a part that inflates to more than its declared size', () => {
    const data = Buffer.alloc(8 * 1024 * 1024, 0x20);
    const lying = writeZip([{ name: 'xl/workbook.xml', data }]);
    // Declare 100 bytes: inflating stops there instead of producing 8 MB.
    lying.writeUInt32LE(100, centralRecord(lying, 'xl/workbook.xml') + 24);
    rejects(() => readXlsx(lying), /bozuk/);
    expect(deflateRawSync(data).length).toBeLessThan(lying.length);
  });

  it('takes at most the given number of data rows after the header', () => {
    const header = ['Kod'];
    const rows = (n: number) => Array.from({ length: n }, (_, i) => [`K${i}`]);
    expect(readXlsx(writeXlsx({ name: 'L', header, rows: rows(5) }), { maxDataRows: 5 })).toHaveLength(6);
    rejects(() => readXlsx(writeXlsx({ name: 'L', header, rows: rows(6) }), { maxDataRows: 5 }), 'Dosyada en fazla 5 veri satırı olabilir.');
    // Empty rows do not count.
    const sparse = book({ sheet: sheetXml(`${'<row/>'.repeat(50)}<row r="60"><c r="A60" t="inlineStr"><is><t>Kod</t></is></c></row>`) });
    expect(cells(sparse, { maxDataRows: 0 })).toEqual([['Kod']]);
  });

  it('refuses a value right of the column limit and ignores empty cells there', () => {
    // Every row is padded up to its last value, so one far-right cell per row would cost ~200 KB a row.
    const far = (ref: string) => book({ sheet: sheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>Kod</t></is></c><c r="${ref}1" t="inlineStr"><is><t>x</t></is></c></row>`) });
    expect(cells(far('IV'))[0]).toHaveLength(256);
    rejects(() => readXlsx(far('IW')), 'Dosyada en fazla 256 sütun olabilir.');
    rejects(() => readXlsx(far('XFD')), 'Dosyada en fazla 256 sütun olabilir.');
    expect(cells(far('D'), { maxColumns: 4 })[0]).toEqual(['Kod', '', '', 'x']);
    rejects(() => readXlsx(far('E'), { maxColumns: 4 }), 'Dosyada en fazla 4 sütun olabilir.');
    // A formatted but empty cell far right, as Excel leaves behind, is not a value.
    const styled = book({ sheet: sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>Kod</t></is></c><c r="XFC1"><v></v></c><c r="XFD1" s="3"/></row>') });
    expect(cells(styled)).toEqual([['Kod']]);
  });

  it('takes 20 000 data rows by default and refuses one more', () => {
    const header = ['Kod', 'Açıklama'];
    const rows = Array.from({ length: 20_001 }, (_, i) => [String(10_000_000 + i), `Açıklama ${i}`]);
    expect(readXlsx(writeXlsx({ name: 'L', header, rows: rows.slice(0, 20_000) }))).toHaveLength(20_001);
    rejects(() => readXlsx(writeXlsx({ name: 'L', header, rows })), 'Dosyada en fazla 20.000 veri satırı olabilir.');
  });
});
