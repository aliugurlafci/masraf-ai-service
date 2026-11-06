import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ExtractionError, type ExtractInvoice } from '../../src/claude/extractor.ts';
import {
  collectFiles,
  compareModels,
  flatten,
  formatReport,
  summarize,
  totalsAgree,
  type Attempt,
  type InputFile,
} from '../../src/tools/compare-models.ts';
import type { Invoice } from '../../src/invoice/schema.ts';
import { PDF_BYTES, PNG_BYTES, sampleInvoice, sampleOlcum } from '../helpers.ts';

const MODELS = ['haiku', 'sonnet', 'opus'];

const ok = (model: string, sonuc: Invoice, sureMs = 1000, apiEsdegeriUsd: number | null = 0.01, okumaSayisi = 1): Attempt => ({
  model,
  surum: `claude-${model}-5-5`,
  sureMs,
  sonuc,
  hata: null,
  apiEsdegeriUsd,
  okumaSayisi,
});

const failed = (model: string, hata: string, sureMs = 5): Attempt => ({
  model,
  surum: null,
  sureMs,
  sonuc: null,
  hata,
  apiEsdegeriUsd: null,
  okumaSayisi: 0,
});

const pdf: InputFile = { name: 'a.pdf', buffer: PDF_BYTES, type: { mime: 'application/pdf', ext: 'pdf' } };

describe('flatten', () => {
  it('ignores spacing, punctuation and case, and compares amounts to the cent', () => {
    const a = sampleInvoice({ saticiUnvan: 'TAB.PİLİÇ  CİĞER', genelToplam: 942.599 });
    const b = sampleInvoice({ saticiUnvan: 'Tab Piliç Ciğer', genelToplam: 942.6 });
    const fa = flatten(a);
    const fb = flatten(b);
    expect(fa.get('fatura.saticiUnvan')?.key).toBe(fb.get('fatura.saticiUnvan')?.key);
    expect(fa.get('fatura.genelToplam')?.key).toBe(fb.get('fatura.genelToplam')?.key);
    expect(fa.get('kalemler[0].tutar')?.shown).toBe('1000');
    expect(fa.get('kalemSayisi')?.key).toBe('1.00');
  });
});

describe('totalsAgree', () => {
  it('accepts consistent totals and flags a misread grand total', () => {
    expect(totalsAgree(sampleInvoice())).toBe(false); // the sample's lines (1000) do not add up to 1500
    const consistent = sampleInvoice({ araToplam: 1000, kdvToplam: 200, genelToplam: 1200 });
    expect(totalsAgree(consistent)).toBe(true);
    expect(totalsAgree({ ...consistent, fatura: { ...consistent.fatura, genelToplam: 120000 } })).toBe(false);
  });
});

describe('summarize', () => {
  const right = sampleInvoice({ araToplam: 1000, kdvToplam: 200, genelToplam: 1200 });
  const wrong = sampleInvoice({ araToplam: 1000, kdvToplam: 200, genelToplam: 120000 });

  it('scores each model by agreement with the majority and lists the differences', () => {
    const { ozet, farklar } = summarize(
      [{ dosya: 'a.pdf', denemeler: [ok('haiku', wrong, 3000), ok('sonnet', right, 6000), ok('opus', right, 9000)] }],
      MODELS,
    );
    const fields = flatten(right).size;
    expect(ozet.map((s) => [s.model, s.uyusanAlan, s.toplamAlan, s.tutmayanToplam, s.medyanSureMs])).toEqual([
      ['haiku', fields - 1, fields, 1, 3000],
      ['sonnet', fields, fields, 0, 6000],
      ['opus', fields, fields, 0, 9000],
    ]);
    expect(ozet[0]?.surum).toBe('claude-haiku-5-5');
    expect(farklar).toEqual([
      {
        dosya: 'a.pdf',
        alan: 'fatura.genelToplam',
        degerler: new Map([
          ['haiku', '120000'],
          ['sonnet', '1200'],
          ['opus', '1200'],
        ]),
      },
    ]);
  });

  it('counts failed reads and gives no credit without a majority', () => {
    const { ozet, farklar } = summarize(
      [
        {
          dosya: 'b.pdf',
          denemeler: [ok('haiku', wrong), ok('sonnet', right), failed('opus', 'claude_timeout', 180000)],
        },
      ],
      MODELS,
    );
    const [haiku, sonnet, opus] = ozet;
    expect(opus).toMatchObject({ okunan: 0, hata: 1, medyanSureMs: null, toplamAlan: 0 });
    // Two reads that disagree: neither value is the majority.
    expect(haiku?.uyusanAlan).toBe((haiku?.toplamAlan ?? 0) - 1);
    expect(sonnet?.uyusanAlan).toBe((sonnet?.toplamAlan ?? 0) - 1);
    expect(farklar.map((d) => d.alan)).toEqual(['fatura.genelToplam']);
  });

  it('adds up the API cost and counts cascade reads that needed another model', () => {
    const { ozet } = summarize(
      [
        { dosya: 'a.pdf', denemeler: [ok('haiku>opus', right, 3000, 0.001, 1), ok('opus', right, 9000, 0.03)] },
        { dosya: 'b.pdf', denemeler: [ok('haiku>opus', right, 12000, 0.031, 2), ok('opus', right, 9000, null)] },
      ],
      ['haiku>opus', 'opus'],
    );
    expect(ozet.map((s) => [s.model, s.apiEsdegeriUsd, s.yenidenOkunan])).toEqual([
      ['haiku>opus', 0.032, 1],
      ['opus', 0.03, 0],
    ]);
  });

  it('compares lines by position and marks a line only some models saw', () => {
    const extra: Invoice = { ...right, kalemler: [...right.kalemler, { ...right.kalemler[0]!, aciklama: 'Fazla' }] };
    const { farklar } = summarize(
      [{ dosya: 'c.pdf', denemeler: [ok('haiku', extra), ok('sonnet', right), ok('opus', right)] }],
      MODELS,
    );
    expect(farklar.map((d) => d.alan)).toContain('kalemSayisi');
    expect(farklar.find((d) => d.alan === 'kalemler[1].aciklama')?.degerler.get('sonnet')).toBe('(yok)');
  });
});

describe('formatReport', () => {
  it('prints the table and the differing fields', () => {
    const right = sampleInvoice({ araToplam: 1000, kdvToplam: 200, genelToplam: 1200 });
    const report = formatReport(
      [{ dosya: 'a.pdf', denemeler: [ok('haiku', { ...right, fatura: { ...right.fatura, faturaNo: 'X1' } }), ok('sonnet', right), ok('opus', right)] }],
      MODELS,
      'low',
    );
    expect(report).toContain('Effort: low, dosya: 1');
    expect(report).toMatch(/haiku \(claude-haiku-5-5\)\s+1\s+0\s+1,0 sn/);
    expect(report).toMatch(/API karşılığı\s+Yeniden okunan/);
    expect(report).toMatch(/opus \(claude-opus-5-5\).*\$0,0100\s+0$/m);
    expect(report).toContain('fatura.faturaNo: haiku=X1, sonnet=ABC2026000000123, opus=ABC2026000000123');
  });

  it('says so when every model agrees', () => {
    const r = sampleInvoice();
    expect(formatReport([{ dosya: 'a.pdf', denemeler: [ok('haiku', r), ok('sonnet', r)] }], ['haiku', 'sonnet'], 'low')).toContain(
      'Bütün modeller bütün alanları aynı okudu.',
    );
  });

  it('lists failed reads and does not claim agreement when a read failed', () => {
    const report = formatReport(
      [
        {
          dosya: 'a.pdf',
          denemeler: [ok('haiku', sampleInvoice()), failed('sonnet', 'claude_failed')],
        },
      ],
      ['haiku', 'sonnet'],
      'low',
    );
    expect(report).toContain('Okunamayanlar:\n  a.pdf: sonnet (claude_failed)');
    expect(report).not.toContain('aynı okudu');
  });
});

describe('compareModels', () => {
  const extractor = (sureMs: number) =>
    vi.fn<ExtractInvoice>(async () => ({ sonuc: sampleInvoice(), olcum: sampleOlcum({ sureMs }) }));

  it('reads every file with every model and keeps going after a failed read', async () => {
    const haiku = extractor(3000);
    const sonnet = vi.fn<ExtractInvoice>(async () => {
      throw new ExtractionError('invalid_output', 'bozuk');
    });
    const log = vi.fn();
    const runs = await compareModels(
      [pdf, { ...pdf, name: 'b.pdf' }],
      new Map([
        ['haiku', haiku],
        ['sonnet', sonnet],
      ]),
      log,
    );
    expect(haiku).toHaveBeenCalledTimes(2);
    expect(sonnet).toHaveBeenCalledTimes(2);
    expect(runs.map((r) => r.denemeler.map((a) => [a.model, a.hata]))).toEqual([
      [
        ['haiku', null],
        ['sonnet', 'invalid_output'],
      ],
      // The order rotates per file.
      [
        ['sonnet', 'invalid_output'],
        ['haiku', null],
      ],
    ]);
    expect(runs[0]?.denemeler[0]?.sureMs).toBe(3000);
    expect(log).toHaveBeenCalledTimes(4);
    expect(log.mock.calls[0]?.[0]).toMatch(/^\[1\/4\] haiku\s+a\.pdf {2}3,0 sn$/);
    expect(log.mock.calls[1]?.[0]).toMatch(/sonnet\s+a\.pdf {2}invalid_output: bozuk$/);
  });

  it('records a cascade entry without a single version and with its number of reads', async () => {
    const steps = [sampleOlcum({ model: 'claude-haiku-5-5' }), sampleOlcum({ model: 'claude-opus-5-5' })].map((o, i) => ({
      ...o,
      sorunlar: i === 0 ? ['Kalemlerin toplamı ara toplamı tutmuyor.'] : [],
      hata: null,
      kullanildi: i === 1,
    }));
    const cascade = vi.fn<ExtractInvoice>(async () => ({
      sonuc: sampleInvoice(),
      olcum: sampleOlcum({ model: 'claude-opus-5-5', sureMs: 20000, apiEsdegeriUsd: 0.04, adimlar: steps }),
    }));
    const log = vi.fn();
    const [run] = await compareModels([pdf], new Map([['haiku>opus', cascade]]), log);
    expect(run?.denemeler[0]).toMatchObject({ model: 'haiku>opus', surum: null, okumaSayisi: 2, apiEsdegeriUsd: 0.04 });
    expect(log.mock.calls[0]?.[0]).toContain('20,0 sn (2 okuma, sonuç: claude-opus-5-5)');
  });

  it.each(['claude_auth', 'claude_limit'] as const)('stops on %s', async (code) => {
    const failing = vi.fn<ExtractInvoice>(async () => {
      throw new ExtractionError(code, 'dur');
    });
    const other = extractor(1000);
    await expect(
      compareModels(
        [pdf, pdf],
        new Map([
          ['haiku', failing],
          ['sonnet', other],
        ]),
      ),
    ).rejects.toMatchObject({ code });
    expect(other).not.toHaveBeenCalled();
  });
});

describe('collectFiles', () => {
  it('takes PDFs and images from a folder and skips everything else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fatura-karsilastir-'));
    try {
      await writeFile(join(dir, 'b.png'), PNG_BYTES);
      await writeFile(join(dir, 'a.pdf'), PDF_BYTES);
      await writeFile(join(dir, 'not.txt'), 'merhaba');
      await writeFile(join(dir, 'big.pdf'), Buffer.concat([PDF_BYTES, Buffer.alloc(2048)]));
      const log = vi.fn();
      const files = await collectFiles([dir], 1024, log);
      expect(files.map((f) => [f.name, f.type.ext])).toEqual([
        ['a.pdf', 'pdf'],
        ['b.png', 'png'],
      ]);
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
