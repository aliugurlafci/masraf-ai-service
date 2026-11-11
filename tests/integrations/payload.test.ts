// The body rules of the integrations (docs/onay-sistemi.md, section 9, "Gövde", "Kaynak alanlar" and
// "Kurallar"). Pure: no database.
import { describe, expect, it } from 'vitest';
import type { FieldDef } from '../../src/expenses/field-rules.ts';
import {
  buildCatalog,
  checkMapping,
  contentTypeOf,
  formatDate,
  mappingProblems,
  nameProblem,
  renderBody,
  sampleData,
  xmlText,
  type AlanEslemesi,
  type BodySettings,
  type PayloadData,
} from '../../src/integrations/payload.ts';

const def = (id: number, anahtar: string, ad: string, tur: FieldDef['tur'], aktif = true, duzey: FieldDef['duzey'] = 'fis'): FieldDef => ({
  id,
  anahtar,
  ad,
  duzey,
  tur,
  zorunlu: false,
  aktif,
  sira: id,
});

const FIELDS: FieldDef[] = [
  def(1, 'kategori', 'Kategori', 'kategori', true, 'form'),
  def(2, 'masrafMerkezi', 'Masraf Merkezi', 'masraf_merkezi', true, 'form'),
  def(3, 'faturaNo', 'Fatura No', 'fatura'),
  def(4, 'projeKodu', 'Proje Kodu', 'liste'),
  def(5, 'not', 'Not', 'uzun_metin'),
  def(6, 'km', 'Kilometre', 'sayi'),
  def(7, 'donus', 'Dönüş Tarihi', 'tarih', false),
];
const catalog = buildCatalog(FIELDS);

const JSON_SETTINGS: BodySettings = { bicim: 'json', kok: null, xmlAdAlani: null, fisListesi: 'FISLER', fisOgesi: 'FIS', tarihBicimi: 'YYYY-AA-GG' };
const XML_SETTINGS: BodySettings = { ...JSON_SETTINGS, bicim: 'xml', kok: 'MT_Masraf' };

const DATA: PayloadData = {
  form: { 'form.tutar': 2193.39, 'form.no': 1001, 'form.baslik': 'Müşteri & "yemek" <İzmir>', 'form.masrafTarihi': '2026-11-05', 'form.kur': null, 'form.yerelTutar': 1800 },
  fisler: [
    { 'fis.faturaNo': 'A-1', 'fis.genelToplam': 1800, 'fis.faturaTarihi': '2026-11-05', 'fis.alan.projeKodu': 'P34', 'fis.alan.km': 12.5 },
    { 'fis.faturaNo': null, 'fis.genelToplam': 393.39, 'fis.faturaTarihi': null, 'fis.alan.projeKodu': null, 'fis.alan.km': null },
  ],
};

const rows = (...pairs: Array<[string, string, string?]>): AlanEslemesi[] =>
  pairs.map(([kaynak, alias, deger]) => (deger === undefined ? { kaynak, alias } : { kaynak, alias, deger }));

describe('integration sources', () => {
  it('lists the form sources, the invoice sources and every receipt field, inactive ones marked', () => {
    expect(catalog.form.map((k) => k.anahtar)).toContain('form.tutar');
    expect(catalog.form.find((k) => k.anahtar === 'form.tutar')).toEqual({ anahtar: 'form.tutar', ad: 'Tutar', tur: 'tutar', aktif: true });
    const fis = catalog.fis.map((k) => k.anahtar);
    expect(fis.slice(0, 13)).toEqual([
      'fis.sira',
      'fis.kimlik',
      'fis.dosyaAdi',
      'fis.faturaNo',
      'fis.faturaTarihi',
      'fis.saticiUnvan',
      'fis.saticiVergiNo',
      'fis.aliciUnvan',
      'fis.aliciVergiNo',
      'fis.paraBirimi',
      'fis.araToplam',
      'fis.kdvToplam',
      'fis.genelToplam',
    ]);
    // A list field gives its code and, separately, its option's name; form and invoice header fields are not receipt fields.
    expect(catalog.fis.filter((k) => k.anahtar.startsWith('fis.alan.'))).toEqual([
      { anahtar: 'fis.alan.projeKodu', ad: 'Proje Kodu', tur: 'metin', aktif: true },
      { anahtar: 'fis.alan.projeKodu.ad', ad: 'Proje Kodu (açıklama)', tur: 'metin', aktif: true },
      { anahtar: 'fis.alan.not', ad: 'Not', tur: 'metin', aktif: true },
      { anahtar: 'fis.alan.km', ad: 'Kilometre', tur: 'sayi', aktif: true },
      { anahtar: 'fis.alan.donus', ad: 'Dönüş Tarihi', tur: 'tarih', aktif: false },
    ]);
    expect(fis.at(-1)).toBe('fis.sabit');
    expect(catalog.form.at(-1)?.anahtar).toBe('form.sabit');
  });

  it('names a mapping row whose receipt field was deleted', () => {
    expect(mappingProblems(rows(['form.tutar', 'TTR'], ['fis.alan.etiket', 'ETK']), catalog)).toEqual(['2. satır (fis.alan.etiket): bu alan silinmiş.']);
    expect(mappingProblems(rows(['fis.alan.donus', 'DON']), catalog)).toEqual([]);
  });
});

describe('integration names and mapping checks', () => {
  it('takes names that are valid both as JSON keys and as XML elements', () => {
    for (const ok of ['TTR', '_x', 'BELNR_1', 'ns.a-b', 'a'.repeat(60)]) expect(nameProblem(ok)).toBeNull();
    expect(nameProblem('')).toBe('Ad boş olamaz.');
    expect(nameProblem('a'.repeat(61))).toBe('Ad en fazla 60 karakter olabilir.');
    for (const bad of ['1TTR', 'TUTAR BİLGİ', 'a:b', '-a', 'Şirket']) expect(nameProblem(bad)).toMatch(/harf ya da _ ile başlamalı/);
    expect(nameProblem('xmlData')).toBe('Ad "xml" ile başlayamaz.');
    expect(nameProblem('XML_TTR')).toBe('Ad "xml" ile başlayamaz.');
  });

  it('accepts a valid mapping', () => {
    const input = { ...JSON_SETTINGS, alanlar: rows(['form.tutar', 'TTR'], ['form.sabit', 'BUKRS', '1000'], ['fis.faturaNo', 'BELNR'], ['fis.genelToplam', 'TTR']) };
    // The same alias may be used once at each level.
    expect(checkMapping(input, catalog)).toEqual({});
  });

  it('reports every problem by its request path', () => {
    const input = {
      ...XML_SETTINGS,
      kok: null,
      fisListesi: 'FIS LISTESI',
      xmlAdAlani: 'urn:a b',
      alanlar: rows(
        ['form.tutar', 'TTR'],
        ['form.yerelTutar', 'ttr'],
        ['form.yok', 'YOK'],
        ['form.sabit', 'SABIT'],
        ['form.baslik', 'BASLIK', 'x'],
        ['fis.faturaNo', '1NO'],
        ['form.no', 'FISLER2'],
      ),
    };
    expect(checkMapping(input, catalog)).toEqual({
      kok: 'XML gövdede kök öğe adı zorunludur.',
      fisListesi: 'Fiş listesi adı harf ya da _ ile başlamalı; yalnızca İngilizce harf, rakam, _, - ve . içermeli.',
      xmlAdAlani: 'Ad alanı boşluk, tırnak, <, > ya da & içeremez.',
      'alanlar.1.alias': 'Bu ad 1. satırda da kullanılıyor.',
      'alanlar.2.kaynak': 'Bu kaynak alan yok.',
      'alanlar.3.deger': 'Sabit değer girilmelidir.',
      'alanlar.4.deger': 'Değer yalnızca sabit değer satırında girilir.',
      'alanlar.5.alias': 'Ad harf ya da _ ile başlamalı; yalnızca İngilizce harf, rakam, _, - ve . içermeli.',
    });
    // A form-level alias may not be the receipt list's name.
    expect(checkMapping({ ...JSON_SETTINGS, alanlar: rows(['form.no', 'fisler']) }, catalog)).toEqual({ 'alanlar.0.alias': 'Bu ad fiş listesinin adıyla aynı.' });
    expect(checkMapping({ ...JSON_SETTINGS, alanlar: [] }, catalog)).toEqual({ alanlar: 'En az bir alan seçilmelidir.' });
    expect(checkMapping({ ...JSON_SETTINGS, alanlar: rows(['form.sabit', 'A', 'x'.repeat(201)]) }, catalog)).toEqual({
      'alanlar.0.deger': 'Sabit değer en fazla 200 karakter olabilir.',
    });
    // The root is optional in JSON but must follow the rule when given.
    expect(checkMapping({ ...JSON_SETTINGS, kok: 'xml', alanlar: rows(['form.no', 'NO']) }, catalog)).toEqual({ kok: 'Kök adı "xml" ile başlayamaz.' });
  });
});

describe('integration body', () => {
  it("writes the user's example: Tutar as TTR in JSON", () => {
    expect(renderBody(JSON_SETTINGS, rows(['form.tutar', 'TTR']), catalog, DATA)).toBe('{\n  "TTR": 2193.39\n}');
    expect(JSON.parse(renderBody(JSON_SETTINGS, rows(['form.tutar', 'TTR']), catalog, DATA))).toEqual({ TTR: 2193.39 });
  });

  it('writes form fields in mapping order, then the receipt list, with constants, numbers, dates and nulls', () => {
    const alanlar = rows(
      ['fis.faturaNo', 'BELNR'],
      ['form.no', 'NO'],
      ['form.sabit', 'BUKRS', '1000'],
      ['form.masrafTarihi', 'BLDAT'],
      ['form.kur', 'KURS'],
      ['fis.genelToplam', 'WRBTR'],
      ['fis.faturaTarihi', 'FDAT'],
      ['fis.alan.km', 'KM'],
      ['fis.sabit', 'SHKZG', 'S'],
      ['form.yerelTutar', 'YEREL'],
    );
    const body = renderBody({ ...JSON_SETTINGS, tarihBicimi: 'YYYYAAGG' }, alanlar, catalog, DATA);
    expect(Object.keys(JSON.parse(body))).toEqual(['NO', 'BUKRS', 'BLDAT', 'KURS', 'YEREL', 'FISLER']);
    expect(JSON.parse(body)).toEqual({
      NO: 1001,
      BUKRS: '1000',
      BLDAT: '20261105',
      KURS: null,
      YEREL: 1800,
      FISLER: [
        { BELNR: 'A-1', WRBTR: 1800, FDAT: '20261105', KM: 12.5, SHKZG: 'S' },
        { BELNR: null, WRBTR: 393.39, FDAT: null, KM: null, SHKZG: 'S' },
      ],
    });
  });

  it('wraps the JSON body in the root when one is given, and writes an empty list for a form without invoices', () => {
    const body = renderBody({ ...JSON_SETTINGS, kok: 'MASRAF' }, rows(['form.no', 'NO'], ['fis.faturaNo', 'BELNR']), catalog, { form: DATA.form, fisler: [] });
    expect(JSON.parse(body)).toEqual({ MASRAF: { NO: 1001, FISLER: [] } });
    // No receipt-level row: no list at all.
    expect(JSON.parse(renderBody(JSON_SETTINGS, rows(['form.no', 'NO']), catalog, DATA))).toEqual({ NO: 1001 });
  });

  it('writes XML with the SAP PI namespace prefix on the root only, amounts with two decimals and escaped text', () => {
    const alanlar = rows(['form.tutar', 'TTR'], ['form.yerelTutar', 'YEREL'], ['form.baslik', 'BASLIK'], ['form.kur', 'KURS'], ['fis.faturaNo', 'BELNR'], ['fis.genelToplam', 'WRBTR'], ['fis.alan.km', 'KM']);
    const body = renderBody({ ...XML_SETTINGS, xmlAdAlani: 'urn:firma:masraf', tarihBicimi: 'GG.AA.YYYY' }, alanlar, catalog, DATA);
    expect(body).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<ns0:MT_Masraf xmlns:ns0="urn:firma:masraf">',
        '  <TTR>2193.39</TTR>',
        '  <YEREL>1800.00</YEREL>',
        '  <BASLIK>Müşteri &amp; &quot;yemek&quot; &lt;İzmir&gt;</BASLIK>',
        '  <KURS/>',
        '  <FISLER>',
        '    <FIS>',
        '      <BELNR>A-1</BELNR>',
        '      <WRBTR>1800.00</WRBTR>',
        '      <KM>12.5</KM>',
        '    </FIS>',
        '    <FIS>',
        '      <BELNR/>',
        '      <WRBTR>393.39</WRBTR>',
        '      <KM/>',
        '    </FIS>',
        '  </FISLER>',
        '</ns0:MT_Masraf>',
      ].join('\n'),
    );
    const plain = renderBody(XML_SETTINGS, rows(['form.no', 'NO'], ['fis.faturaNo', 'BELNR']), catalog, { form: DATA.form, fisler: [] });
    expect(plain).toBe(['<?xml version="1.0" encoding="UTF-8"?>', '<MT_Masraf>', '  <NO>1001</NO>', '  <FISLER/>', '</MT_Masraf>'].join('\n'));
  });

  it('drops characters XML cannot hold and rounds amounts to the cent', () => {
    expect(xmlText("a\u0001b\u0000c'￾")).toBe('abc&apos;');
    expect(xmlText('satır\nsonu\ttab')).toBe('satır\nsonu\ttab');
    const body = renderBody(XML_SETTINGS, rows(['form.tutar', 'T']), catalog, { form: { 'form.tutar': 10.005 }, fisler: [] });
    expect(body).toContain('<T>10.01</T>');
    expect(JSON.parse(renderBody(JSON_SETTINGS, rows(['form.tutar', 'T']), catalog, { form: { 'form.tutar': 0.1 + 0.2 }, fisler: [] }))).toEqual({ T: 0.3 });
  });

  it('formats dates three ways and leaves anything else as it is', () => {
    expect(formatDate('2026-11-05', 'YYYY-AA-GG')).toBe('2026-11-05');
    expect(formatDate('2026-11-05', 'YYYYAAGG')).toBe('20261105');
    expect(formatDate('2026-11-05', 'GG.AA.YYYY')).toBe('05.11.2026');
    expect(formatDate('dün', 'YYYYAAGG')).toBe('dün');
  });

  it('sends the content type of its format', () => {
    expect(contentTypeOf('json')).toBe('application/json; charset=utf-8');
    expect(contentTypeOf('xml')).toBe('application/xml; charset=utf-8');
  });

  it('has a sample value for every source, so a new mapping can be previewed', () => {
    const sample = sampleData(catalog);
    for (const k of catalog.form) if (k.anahtar !== 'form.sabit') expect(k.anahtar in sample.form).toBe(true);
    expect(sample.fisler).toHaveLength(2);
    for (const invoice of sample.fisler) for (const k of catalog.fis) if (k.anahtar !== 'fis.sabit') expect(k.anahtar in invoice).toBe(true);
    expect(sample.form['form.tutar']).toBe(2193.39);
    expect(sample.fisler[0]?.['fis.alan.projeKodu.ad']).toBe('Örnek Proje Kodu');
  });
});
