// Background reads of the files a saved form waits for (bekleyen_faturalar, docs/onay-sistemi.md section 3).
// The files go through the same reader as uploads, so they take their turn in the same queue and a file
// whose read is already running is joined, not read twice. The outcome is handed back to the form service.
// Memory: a joined read reuses the bytes the reader already holds; other files are loaded from the
// database one by one, at most `limit` at a time, right before they are queued.
import { createSemaphore, ExtractionError } from '../claude/extractor.ts';
import type { ReadOutcome, WaitingFile } from '../expenses/forms.ts';
import { detectFileType } from '../invoice/file-type.ts';
import { toItemError } from './batch-queue.ts';
import type { ReadInput, ReadResult } from './reader.ts';

export interface PendingReadsDeps {
  /** Waiting files with these ids, or every waiting one; without their bytes. */
  readonly files: (ids?: readonly number[]) => Promise<WaitingFile[]>;
  /** The bytes of a waiting file; null once it no longer waits. */
  readonly content: (id: number) => Promise<Buffer | null>;
  /** The bytes of a read of this file that already runs for its sender; null when none runs. */
  readonly running: (file: WaitingFile) => Buffer | null;
  readonly read: (file: WaitingFile, input: ReadInput) => Promise<ReadResult>;
  readonly settle: (id: number, outcome: ReadOutcome) => Promise<void>;
  readonly log: (line: string) => void;
  /** Files loaded from the database and queued at once (joined reads aside). Default 2. */
  readonly limit?: number;
  /** Delay before a file whose read could not be loaded or stored is tried again, times the attempt. Default 30 s. */
  readonly retryMs?: number;
  /** Attempts per file before it waits for the next start-up or "Yeniden oku". Default 5. */
  readonly attempts?: number;
}

export interface PendingReads {
  /** Starts reading these waiting files (every waiting one when omitted); files already being read here are skipped. */
  start(ids?: readonly number[]): void;
  /** Resolves once nothing started here is running (a retry waiting for its delay does not count). */
  idle(): Promise<void>;
}

const UNSUPPORTED = { kod: 'desteklenmeyen_dosya', mesaj: 'Yalnızca PDF, PNG, JPEG, WEBP veya GIF fatura dosyası kabul edilir.' };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createPendingReads(deps: PendingReadsDeps): PendingReads {
  const retryMs = deps.retryMs ?? 30_000;
  const attempts = deps.attempts ?? 5;
  const slot = createSemaphore(deps.limit ?? 2);
  /** Waiting files read here now, by id. */
  const busy = new Set<number>();
  const running = new Set<Promise<void>>();
  /** Files settled while a full load ran: its list, read before, may still show them as waiting. */
  const settledDuringLoad = new Set<number>();
  let fullLoads = 0;
  /** Failed attempts so far, by file id. */
  const tries = new Map<number, number>();

  /** Schedules another attempt for these files; returns what the log line says about it. */
  const retryLater = (ids: readonly number[]): string => {
    const n = Math.max(0, ...ids.map((id) => tries.get(id) ?? 0)) + 1;
    if (n >= attempts) {
      for (const id of ids) tries.delete(id);
      return 'sunucu yeniden başlayınca ya da "Yeniden oku" ile yeniden denenecek';
    }
    for (const id of ids) tries.set(id, n);
    setTimeout(() => api.start(ids), retryMs * n).unref();
    return `${Math.ceil((retryMs * n) / 1000)} sn sonra yeniden denenecek`;
  };

  const outcomeOf = async (file: WaitingFile, bytes: Buffer): Promise<ReadOutcome> => {
    // Stored files were checked when they arrived; this only guards against a damaged row.
    const type = detectFileType(bytes);
    if (type === null) return { hata: UNSUPPORTED };
    try {
      const { record } = await deps.read(file, { buffer: bytes, type, name: file.dosyaAdi, force: false, kullaniciId: file.kullanici.id });
      return { kayitId: record.id };
    } catch (err) {
      if (!(err instanceof ExtractionError)) deps.log(`hata bekleyen_okuma id=${file.id}: ${message(err)}`);
      return { hata: toItemError(err) };
    }
  };

  /** Reads the file: a running read is joined with its bytes, else the bytes are loaded in turn. Null when the file no longer waits. */
  const readFile = (file: WaitingFile): Promise<ReadOutcome | null> => {
    const bytes = deps.running(file);
    if (bytes !== null) return outcomeOf(file, bytes);
    return slot(async () => {
      const stored = await deps.content(file.id);
      return stored === null ? null : outcomeOf(file, stored);
    });
  };

  const one = async (file: WaitingFile): Promise<void> => {
    let failure: unknown = null;
    try {
      const outcome = await readFile(file);
      if (outcome !== null) await deps.settle(file.id, outcome);
      tries.delete(file.id);
    } catch (err) {
      // The row stays waiting.
      failure = err;
    } finally {
      busy.delete(file.id);
      if (fullLoads > 0) settledDuringLoad.add(file.id);
    }
    if (failure !== null) deps.log(`hata bekleyen_sonuc id=${file.id}: ${message(failure)}; ${retryLater([file.id])}`);
  };

  const run = async (ids: readonly number[] | undefined): Promise<void> => {
    const full = ids === undefined;
    if (full) fullLoads += 1;
    let files: WaitingFile[] = [];
    let failure: unknown = null;
    try {
      files = await deps.files(ids);
    } catch (err) {
      failure = err;
      for (const id of ids ?? []) busy.delete(id);
    }
    if (full) fullLoads -= 1;
    const mine = full ? files.filter((f) => !busy.has(f.id) && !settledDuringLoad.has(f.id)) : files;
    if (fullLoads === 0) settledDuringLoad.clear();
    if (failure !== null) {
      deps.log(`hata bekleyen_okuma: ${message(failure)}${ids === undefined ? '' : `; ${retryLater(ids)}`}`);
      return;
    }
    for (const f of mine) busy.add(f.id);
    // Ids claimed below that are no longer waiting (settled or taken off the form meanwhile).
    for (const id of ids ?? []) if (!files.some((f) => f.id === id)) busy.delete(id);
    await Promise.all(mine.map(one));
  };

  const api: PendingReads = {
    start(ids) {
      // Claimed before the rows are loaded, so two starts for the same file read it once.
      const claim = ids?.filter((id) => !busy.has(id));
      if (claim !== undefined) {
        if (claim.length === 0) return;
        for (const id of claim) busy.add(id);
      }
      const task = run(claim);
      running.add(task);
      void task.finally(() => running.delete(task));
    },
    async idle() {
      while (running.size > 0) await Promise.all(running);
    },
  };
  return api;
}
