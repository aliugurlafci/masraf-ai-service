import { createSemaphore, ExtractionError, type Extraction, type ExtractInvoice } from './extractor.ts';
import { findProblems } from '../invoice/checks.ts';
import type { ClaudeOlcum, OkumaAdimi } from './olcum.ts';

export interface CascadeStep {
  /** Model as configured (e.g. "haiku"); the run itself reports the full id. */
  readonly model: string;
  readonly extract: ExtractInvoice;
}

const sum = (values: ReadonlyArray<number | null>): number | null => {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
};

function stepOf(o: ClaudeOlcum, sorunlar: string[]): OkumaAdimi {
  return {
    sureMs: o.sureMs,
    apiSureMs: o.apiSureMs,
    tur: o.tur,
    girdiToken: o.girdiToken,
    onbellektenToken: o.onbellektenToken,
    onbellegeToken: o.onbellegeToken,
    ciktiToken: o.ciktiToken,
    apiEsdegeriUsd: o.apiEsdegeriUsd,
    model: o.model,
    sorunlar,
    hata: null,
    kullanildi: false,
  };
}

function failedStep(model: string, sureMs: number, err: unknown): OkumaAdimi {
  return {
    sureMs,
    apiSureMs: null,
    tur: null,
    girdiToken: null,
    onbellektenToken: null,
    onbellegeToken: null,
    ciktiToken: null,
    apiEsdegeriUsd: null,
    model,
    sorunlar: [],
    // ExtractionError messages are Turkish and have the token masked; anything else may hold internals.
    hata: err instanceof ExtractionError ? err.message : 'Beklenmeyen bir hata oluştu.',
    kullanildi: false,
  };
}

const stopsCascade = (err: unknown): boolean =>
  err instanceof ExtractionError && (err.code === 'claude_auth' || err.code === 'claude_limit');

/**
 * Reads with the first (cheapest) model and goes on to the next one only when the token-free checks
 * find a problem or the read fails. The last model's read is kept even with problems; the panel shows
 * them. If a later model fails, the earlier read is kept instead of losing the invoice.
 */
export function createCascadeExtractor(steps: readonly CascadeStep[], maxConcurrent: number): ExtractInvoice {
  if (steps.length === 0) throw new Error('A cascade needs at least one model.');
  // Limits whole invoices, so a cascade never runs more CLI processes than invoices allowed at once.
  const limit = createSemaphore(maxConcurrent);

  return (file, hooks) =>
    limit(async () => {
      const runs: OkumaAdimi[] = [];
      let kept: Extraction | null = null;
      let keptAt = -1;

      for (const [i, step] of steps.entries()) {
        const started = Date.now();
        let read: Extraction;
        try {
          // The steps get no hooks: the cascade itself reports each model, once.
          hooks?.onModel?.(step.model);
          read = await step.extract(file);
        } catch (err) {
          if (kept === null && (i === steps.length - 1 || stopsCascade(err))) throw err;
          runs.push(failedStep(step.model, Date.now() - started, err));
          if (kept !== null) break;
          continue;
        }
        const sorunlar = findProblems(read.sonuc);
        runs.push(stepOf(read.olcum, sorunlar));
        kept = read;
        keptAt = runs.length - 1;
        if (sorunlar.length === 0) break;
      }

      // The last step either returns a read or throws, so a read is always kept here.
      if (kept === null) throw new Error('Cascade ended without a read.');
      const adimlar = runs.map((a, i) => (i === keptAt ? { ...a, kullanildi: true } : a));
      const usd = sum(adimlar.map((a) => a.apiEsdegeriUsd));
      const olcum: ClaudeOlcum = {
        sureMs: adimlar.reduce((acc, a) => acc + a.sureMs, 0),
        apiSureMs: sum(adimlar.map((a) => a.apiSureMs)),
        tur: sum(adimlar.map((a) => a.tur)),
        girdiToken: sum(adimlar.map((a) => a.girdiToken)),
        onbellektenToken: sum(adimlar.map((a) => a.onbellektenToken)),
        onbellegeToken: sum(adimlar.map((a) => a.onbellegeToken)),
        ciktiToken: sum(adimlar.map((a) => a.ciktiToken)),
        apiEsdegeriUsd: usd === null ? null : Math.round(usd * 1e6) / 1e6,
        model: kept.olcum.model,
        effort: kept.olcum.effort,
        adimlar,
      };
      return { sonuc: kept.sonuc, olcum };
    });
}
