import { z } from 'zod';

const RunFields = {
  /** Whole extraction measured by the server: CLI start to result. */
  sureMs: z.number(),
  /** Time spent in the model API (part of sureMs). */
  apiSureMs: z.number().nullable(),
  /** Model turns (reading the file, answering). */
  tur: z.number().nullable(),
  girdiToken: z.number().nullable(),
  onbellektenToken: z.number().nullable(),
  onbellegeToken: z.number().nullable(),
  ciktiToken: z.number().nullable(),
  /** What the run would have cost through the paid API; not charged to the subscription. */
  apiEsdegeriUsd: z.number().nullable(),
  model: z.string(),
};

/** One model's read in a cascade. */
export const OkumaAdimiSchema = z
  .object({
    ...RunFields,
    /** What the token-free checks found in this read; empty means it passed. */
    sorunlar: z.array(z.string()),
    /** Why the model could not read the file; null when it did. */
    hata: z.string().nullable(),
    /** True for the read whose result was returned. */
    kullanildi: z.boolean(),
  })
  .strict();

export type OkumaAdimi = z.infer<typeof OkumaAdimiSchema>;

/**
 * Measurements of the Claude run(s) that produced an invoice. Stored with the record and returned by the API.
 * With a cascade the top-level numbers are the sums of all steps and `model` is the one whose result was kept.
 */
export const ClaudeOlcumSchema = z
  .object({
    ...RunFields,
    effort: z.string().nullable(),
    /** Every model that read the file, in order. Missing on records saved before cascades. */
    adimlar: z.array(OkumaAdimiSchema).optional(),
  })
  .strict();

export type ClaudeOlcum = z.infer<typeof ClaudeOlcumSchema>;

/** The `olcum` field of API responses. */
export interface YanitOlcum {
  /** "claude": this request ran Claude; "kayit": the stored result was returned. */
  readonly kaynak: 'claude' | 'kayit';
  /** Time this request took on the server. */
  readonly istekSuresiMs: number;
  /** Measurements of the Claude run that produced the invoice; null for records saved before measuring. */
  readonly okuma: ClaudeOlcum | null;
}
