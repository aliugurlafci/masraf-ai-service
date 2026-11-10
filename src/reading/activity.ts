import { randomBytes } from 'node:crypto';
import { cleanFileName } from '../invoice/storage.ts';
import { toItemError, type ItemError } from './batch-queue.ts';
import type { ReadHooks, ReadInput, ReadInvoice, ReadResult } from './reader.ts';

/**
 * Who sent the file: the web panel (it tags its requests), any other API client, or the server itself
 * (arka_plan: files of saved forms read again after a restart, or read again on request).
 */
export type Kaynak = 'panel' | 'api' | 'arka_plan';
export type ActivityState = 'sirada' | 'okunuyor' | 'bitti' | 'hata';

/** The signed-in user who sent the file. */
export interface Sender {
  readonly id: number;
  readonly adSoyad: string;
}

export interface ActivitySummary {
  readonly faturaNo: string | null;
  readonly faturaTarihi: string | null;
  readonly saticiUnvan: string | null;
  readonly genelToplam: number | null;
  readonly paraBirimi: string | null;
  readonly kalemSayisi: number;
}

/** One file the server was asked to read, from arrival to result. */
export interface ActivityView {
  readonly id: string;
  readonly dosyaAdi: string;
  readonly boyut: number;
  readonly kaynak: Kaynak;
  /** The panel's own request tag, so it can match the row to the file it sent. */
  readonly etiket: string | null;
  /** Who sent the file; null for reads made before sign-in existed (tests, tools). */
  readonly kullanici: Sender | null;
  /** Set for files sent in a multi-file upload. */
  readonly kuyrukId: string | null;
  readonly sira: number | null;
  readonly durum: ActivityState;
  /** While `sirada`: its place among the files waiting for Claude (1 = next); null otherwise. */
  readonly kuyrukSirasi: number | null;
  /** While `sirada`: files read before it (being read now or waiting ahead); null otherwise. */
  readonly onundeki: number | null;
  /** Model reading the file now; once done, the model whose result was kept. */
  readonly model: string | null;
  /** Every model that read the file in this request, in order. */
  readonly modeller: readonly string[];
  /** The stored result of an identical file was returned; Claude did not run. */
  readonly onbellek: boolean;
  readonly kayitId: string | null;
  readonly hata: ItemError | null;
  readonly ozet: ActivitySummary | null;
  /** Paid-API equivalent of this request's Claude runs; null when Claude did not run. */
  readonly apiEsdegeriUsd: number | null;
  readonly alinma: string;
  /** When Claude started, after the file waited for a free slot. */
  readonly baslama: string | null;
  readonly bitis: string | null;
}

export interface LiveStats {
  /** Counts below are since this moment (the server start). */
  readonly baslangic: string;
  readonly esZamanli: number;
  readonly sirada: number;
  readonly okunuyor: number;
  readonly bitti: number;
  /** Part of `bitti` answered from the stored records. */
  readonly kayittan: number;
  readonly hata: number;
  readonly apiEsdegeriUsd: number;
}

export interface LiveSnapshot {
  readonly istatistik: LiveStats;
  /** Newest first. */
  readonly etkinlikler: readonly ActivityView[];
}

export interface LiveEvent {
  readonly etkinlik: ActivityView;
  readonly istatistik: LiveStats;
}

export interface TrackMeta {
  readonly kaynak: Kaynak;
  readonly etiket?: string | null;
  readonly kullanici?: Sender | null;
  readonly kuyrukId?: string | null;
  readonly sira?: number | null;
}

export interface RejectedMeta extends TrackMeta {
  readonly dosyaAdi: string;
  readonly boyut: number;
}

export type TrackedRead = (input: ReadInput, meta: TrackMeta, hooks?: ReadHooks) => Promise<ReadResult>;

export interface ActivityLog {
  /** Wraps the reader so every read, single or multi-file, panel or API, shows up here. */
  track(read: ReadInvoice): TrackedRead;
  /** Records a file the server refused before reading it (wrong type, too large). */
  rejected(meta: RejectedMeta, hata: ItemError): void;
  /** Every activity, or only those isible lets through; the counters always cover everything. */
  snapshot(visible?: (a: ActivityView) => boolean): LiveSnapshot;
  /** Calls the listener on every change; returns the function that stops it. */
  subscribe(listener: (event: LiveEvent) => void): () => void;
}

export interface ActivityLogOptions {
  readonly esZamanli: number;
  /** Finished activities kept for the panel; unfinished ones are never dropped. */
  readonly keep?: number;
  readonly now?: () => Date;
}

type Activity = { -readonly [K in keyof ActivityView]: ActivityView[K] } & { modeller: string[] };

const isFinished = (a: Activity): boolean => a.durum === 'bitti' || a.durum === 'hata';

/** In-memory log of reads since the server started; the panel's live monitor shows it. */
export function createActivityLog(opts: ActivityLogOptions): ActivityLog {
  const now = opts.now ?? (() => new Date());
  const keep = opts.keep ?? 300;
  const started = now().toISOString();
  const activities: Activity[] = [];
  const listeners = new Set<(event: LiveEvent) => void>();
  const totals = { bitti: 0, kayittan: 0, hata: 0, apiEsdegeriUsd: 0 };

  const stats = (): LiveStats => {
    let sirada = 0;
    let okunuyor = 0;
    for (const a of activities) {
      if (a.durum === 'sirada') sirada++;
      else if (a.durum === 'okunuyor') okunuyor++;
    }
    return {
      baslangic: started,
      esZamanli: opts.esZamanli,
      sirada,
      okunuyor,
      bitti: totals.bitti,
      kayittan: totals.kayittan,
      hata: totals.hata,
      apiEsdegeriUsd: Math.round(totals.apiEsdegeriUsd * 1e6) / 1e6,
    };
  };

  const view = (a: Activity): ActivityView => ({ ...a, modeller: [...a.modeller], kullanici: a.kullanici === null ? null : { ...a.kullanici } });

  const emit = (a: Activity): void => {
    if (listeners.size === 0) return;
    const event: LiveEvent = { etkinlik: view(a), istatistik: stats() };
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A broken viewer (closed stream) must never break a read.
      }
    }
  };

  const prune = (): void => {
    let finished = activities.filter(isFinished).length;
    for (let i = 0; i < activities.length && finished > keep; ) {
      const a = activities[i];
      if (a !== undefined && isFinished(a)) {
        activities.splice(i, 1);
        finished--;
      } else {
        i++;
      }
    }
  };

  const begin = (meta: RejectedMeta): Activity => {
    const a: Activity = {
      id: randomBytes(6).toString('hex'),
      dosyaAdi: cleanFileName(meta.dosyaAdi),
      boyut: meta.boyut,
      kaynak: meta.kaynak,
      etiket: meta.etiket ?? null,
      kullanici: meta.kullanici ?? null,
      kuyrukId: meta.kuyrukId ?? null,
      sira: meta.sira ?? null,
      durum: 'sirada',
      kuyrukSirasi: null,
      onundeki: null,
      model: null,
      modeller: [],
      onbellek: false,
      kayitId: null,
      hata: null,
      ozet: null,
      apiEsdegeriUsd: null,
      alinma: now().toISOString(),
      baslama: null,
      bitis: null,
    };
    activities.push(a);
    prune();
    return a;
  };

  const unplace = (a: Activity): void => {
    a.kuyrukSirasi = null;
    a.onundeki = null;
  };

  const done = (a: Activity, { record, reused }: ReadResult): void => {
    const f = record.sonuc.fatura;
    a.durum = 'bitti';
    unplace(a);
    a.bitis = now().toISOString();
    a.onbellek = reused;
    a.kayitId = record.id;
    a.ozet = {
      faturaNo: f.faturaNo,
      faturaTarihi: f.faturaTarihi,
      saticiUnvan: f.saticiUnvan,
      genelToplam: f.genelToplam,
      paraBirimi: f.paraBirimi,
      kalemSayisi: record.sonuc.kalemler.length,
    };
    a.model = record.olcum?.model ?? a.model;
    if (!reused) {
      const steps = record.olcum?.adimlar?.map((s) => s.model);
      if (steps !== undefined && steps.length > 0) a.modeller = steps;
      a.apiEsdegeriUsd = record.olcum?.apiEsdegeriUsd ?? null;
      totals.apiEsdegeriUsd += a.apiEsdegeriUsd ?? 0;
    }
    totals.bitti++;
    if (reused) totals.kayittan++;
    prune();
    emit(a);
  };

  const failed = (a: Activity, err: unknown): void => {
    a.durum = 'hata';
    unplace(a);
    a.bitis = now().toISOString();
    a.hata = toItemError(err);
    totals.hata++;
    prune();
    emit(a);
  };

  return {
    track(read) {
      return (input, meta, hooks = {}) => {
        const a = begin({ ...meta, dosyaAdi: input.name, boyut: input.buffer.length });
        emit(a);
        const result = read(input, {
          onQueued: () => hooks.onQueued?.(),
          onPosition: (place) => {
            a.kuyrukSirasi = place.kuyrukSirasi;
            a.onundeki = place.onundeki;
            emit(a);
            hooks.onPosition?.(place);
          },
          onStart: () => {
            a.durum = 'okunuyor';
            unplace(a);
            a.baslama = now().toISOString();
            emit(a);
            hooks.onStart?.();
          },
          onModel: (model) => {
            a.model = model;
            a.modeller.push(model);
            emit(a);
            hooks.onModel?.(model);
          },
        });
        result.then(
          (r) => done(a, r),
          (err: unknown) => failed(a, err),
        );
        return result;
      };
    },

    rejected(meta, hata) {
      const a = begin(meta);
      a.durum = 'hata';
      a.hata = hata;
      a.bitis = a.alinma;
      totals.hata++;
      prune();
      emit(a);
    },

    snapshot(visible) {
      const all = activities.map(view).reverse();
      return { istatistik: stats(), etkinlikler: visible === undefined ? all : all.filter(visible) };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
