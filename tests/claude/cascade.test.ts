import { describe, expect, it, vi } from 'vitest';
import { createCascadeExtractor } from '../../src/claude/cascade.ts';
import { ExtractionError, type Extraction, type ExtractInvoice, type InvoiceFile } from '../../src/claude/extractor.ts';
import type { Invoice } from '../../src/invoice/schema.ts';
import { PDF_BYTES, sampleInvoice, sampleOlcum } from '../helpers.ts';

const file: InvoiceFile = { buffer: PDF_BYTES, type: { mime: 'application/pdf', ext: 'pdf' } };

/** Passes the checks: 2 × 500 = 1000, 1000 + 200 = 1200. */
const good = (): Invoice => sampleInvoice({ araToplam: 1000, kdvToplam: 200, genelToplam: 1200 });
/** Fails the checks: the grand total does not add up. */
const bad = (): Invoice => sampleInvoice({ araToplam: 1000, kdvToplam: 200, genelToplam: 120000 });

const reads = (model: string, sonuc: Invoice, sureMs: number, usd: number | null): Extraction => ({
  sonuc,
  olcum: sampleOlcum({ model, sureMs, apiSureMs: sureMs - 1000, tur: 3, ciktiToken: 500, apiEsdegeriUsd: usd }),
});

const step = (model: string, impl: () => Promise<Extraction>) => ({ model, extract: vi.fn<ExtractInvoice>(impl) });

describe('cascade', () => {
  it('keeps the first read when it passes the checks and never runs the next model', async () => {
    const haiku = step('haiku', async () => reads('claude-haiku-5-5', good(), 3000, 0.0006));
    const opus = step('opus', async () => reads('claude-opus-5-5', good(), 9000, 0.03));
    const { sonuc, olcum } = await createCascadeExtractor([haiku, opus], 2)(file);

    expect(sonuc).toEqual(good());
    expect(opus.extract).not.toHaveBeenCalled();
    expect(olcum).toMatchObject({ model: 'claude-haiku-5-5', sureMs: 3000, apiEsdegeriUsd: 0.0006, effort: 'low' });
    expect(olcum.adimlar).toEqual([expect.objectContaining({ model: 'claude-haiku-5-5', sorunlar: [], hata: null, kullanildi: true })]);
  });

  it('reads again with the next model when the checks find a problem, and adds up the measurements', async () => {
    const haiku = step('haiku', async () => reads('claude-haiku-5-5', bad(), 3000, 0.0006));
    const opus = step('opus', async () => reads('claude-opus-5-5', good(), 9000, 0.03));
    const { sonuc, olcum } = await createCascadeExtractor([haiku, opus], 2)(file);

    expect(sonuc).toEqual(good());
    expect(opus.extract).toHaveBeenCalledWith(file);
    expect(olcum).toMatchObject({
      model: 'claude-opus-5-5',
      sureMs: 12000,
      apiSureMs: 10000,
      tur: 6,
      ciktiToken: 1000,
      apiEsdegeriUsd: 0.0306,
    });
    expect(olcum.adimlar?.map((a) => [a.model, a.sorunlar, a.kullanildi])).toEqual([
      ['claude-haiku-5-5', ['Ara toplam ile KDV genel toplamı tutmuyor.'], false],
      ['claude-opus-5-5', [], true],
    ]);
  });

  it('reports each model as it starts, once, for the live monitor', async () => {
    const onModel = vi.fn();
    const haiku = step('haiku', async () => {
      expect(onModel).toHaveBeenLastCalledWith('haiku');
      return reads('claude-haiku-5-5', bad(), 3000, 0.0006);
    });
    const opus = step('opus', async () => reads('claude-opus-5-5', good(), 9000, 0.03));
    await createCascadeExtractor([haiku, opus], 2)(file, { onModel });
    expect(onModel.mock.calls).toEqual([['haiku'], ['opus']]);
    // The steps get no hooks, so a model is never reported twice.
    expect(haiku.extract).toHaveBeenCalledWith(file);
  });

  it("keeps the last model's read even when it has problems", async () => {
    const haiku = step('haiku', async () => reads('claude-haiku-5-5', bad(), 3000, 0.0006));
    const opus = step('opus', async () => reads('claude-opus-5-5', bad(), 9000, 0.03));
    const { olcum } = await createCascadeExtractor([haiku, opus], 2)(file);
    expect(olcum.model).toBe('claude-opus-5-5');
    expect(olcum.adimlar?.map((a) => [a.sorunlar.length, a.kullanildi])).toEqual([
      [1, false],
      [1, true],
    ]);
  });

  it('moves on when the first model cannot read the file', async () => {
    const haiku = step('haiku', async () => {
      throw new ExtractionError('invalid_output', 'Claude çıktısı şemaya uymuyor.');
    });
    const opus = step('opus', async () => reads('claude-opus-5-5', good(), 9000, 0.03));
    const { olcum } = await createCascadeExtractor([haiku, opus], 2)(file);
    expect(olcum.adimlar?.map((a) => [a.model, a.hata, a.kullanildi])).toEqual([
      ['haiku', 'Claude çıktısı şemaya uymuyor.', false],
      ['claude-opus-5-5', null, true],
    ]);
    expect(olcum.apiEsdegeriUsd).toBe(0.03);
  });

  it('keeps the earlier read when the next model fails', async () => {
    const haiku = step('haiku', async () => reads('claude-haiku-5-5', bad(), 3000, 0.0006));
    const opus = step('opus', async () => {
      throw new ExtractionError('claude_limit', 'Kullanım limiti doldu.');
    });
    const { sonuc, olcum } = await createCascadeExtractor([haiku, opus], 2)(file);
    expect(sonuc).toEqual(bad());
    expect(olcum.adimlar?.map((a) => [a.model, a.hata, a.kullanildi])).toEqual([
      ['claude-haiku-5-5', null, true],
      ['opus', 'Kullanım limiti doldu.', false],
    ]);
  });

  it('does not show internal details of unexpected errors', async () => {
    const haiku = step('haiku', async () => {
      throw new Error('C:\\gizli\\yol patladı');
    });
    const opus = step('opus', async () => reads('claude-opus-5-5', good(), 9000, 0.03));
    const { olcum } = await createCascadeExtractor([haiku, opus], 2)(file);
    expect(olcum.adimlar?.[0]?.hata).toBe('Beklenmeyen bir hata oluştu.');
  });

  it.each(['claude_auth', 'claude_limit'] as const)('stops at once on %s from the first model', async (code) => {
    const haiku = step('haiku', async () => {
      throw new ExtractionError(code, 'dur');
    });
    const opus = step('opus', async () => reads('claude-opus-5-5', good(), 9000, 0.03));
    await expect(createCascadeExtractor([haiku, opus], 2)(file)).rejects.toMatchObject({ code });
    expect(opus.extract).not.toHaveBeenCalled();
  });

  it("fails with the last model's error when no model could read the file", async () => {
    const haiku = step('haiku', async () => {
      throw new ExtractionError('invalid_output', 'bozuk');
    });
    const opus = step('opus', async () => {
      throw new ExtractionError('claude_timeout', 'yavaş');
    });
    await expect(createCascadeExtractor([haiku, opus], 2)(file)).rejects.toMatchObject({ code: 'claude_timeout' });
  });

  it('works with a single model', async () => {
    const opus = step('opus', async () => reads('claude-opus-5-5', bad(), 9000, 0.03));
    const { olcum } = await createCascadeExtractor([opus], 2)(file);
    expect(olcum.adimlar).toHaveLength(1);
    expect(olcum.adimlar?.[0]?.kullanildi).toBe(true);
  });

  it('runs at most maxConcurrent invoices at a time', async () => {
    let active = 0;
    let peak = 0;
    const slow = step('haiku', async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return reads('claude-haiku-5-5', bad(), 10, null);
    });
    const opus = step('opus', async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return reads('claude-opus-5-5', good(), 10, null);
    });
    const extract = createCascadeExtractor([slow, opus], 1);
    await Promise.all([extract(file), extract(file), extract(file)]);
    expect(peak).toBe(1);
  });

  it('refuses an empty model list', () => {
    expect(() => createCascadeExtractor([], 1)).toThrow();
  });
});
