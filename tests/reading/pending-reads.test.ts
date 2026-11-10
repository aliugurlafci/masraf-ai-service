import { describe, expect, it, vi } from 'vitest';
import { ExtractionError } from '../../src/claude/extractor.ts';
import type { ReadOutcome, WaitingFile } from '../../src/expenses/forms.ts';
import { createPendingReads, type PendingReadsDeps } from '../../src/reading/pending-reads.ts';
import type { ReadInput, ReadResult } from '../../src/reading/reader.ts';
import { PDF_BYTES, PNG_BYTES, sampleInvoice } from '../helpers.ts';

/** A waiting file with the bytes the fake database holds for it. */
type Row = WaitingFile & { readonly icerik: Buffer };

const waitingFile = (id: number, icerik: Buffer = PDF_BYTES): Row => ({
  id,
  formId: 40,
  kullanici: { id: 7, adSoyad: 'Ayşe Yılmaz' },
  dosyaAdi: `fatura-${id}.pdf`,
  dosyaOzeti: 'a'.repeat(64),
  mime: 'application/pdf',
  icerik,
});

const resultFor = (id: number): ReadResult => ({
  record: { id: `20261109-120000-0000000${id}`, dosyaAdi: `fatura-${id}.pdf`, olusturulma: '2026-11-09T12:00:00.000Z', sonuc: sampleInvoice() },
  reused: false,
});

/**
 * Plain fakes: a table of waiting files, reads that answer at once unless held, and recorded outcomes.
 * By default no read runs to join, every file may be loaded at once and a failure is not retried.
 */
function setup(table: Row[] = [waitingFile(1), waitingFile(2)], options: Partial<Pick<PendingReadsDeps, 'limit' | 'retryMs' | 'attempts'>> = {}) {
  const settled: Array<[number, ReadOutcome]> = [];
  const logs: string[] = [];
  const held = new Map<number, () => void>();
  let hold = false;
  const files = vi.fn<PendingReadsDeps['files']>(async (ids) => table.filter((f) => ids === undefined || ids.includes(f.id)));
  const content = vi.fn<PendingReadsDeps['content']>(async (id) => table.find((f) => f.id === id)?.icerik ?? null);
  const running = vi.fn<PendingReadsDeps['running']>(() => null);
  const read = vi.fn<PendingReadsDeps['read']>(async (file) => {
    if (hold) await new Promise<void>((resolve) => held.set(file.id, resolve));
    return resultFor(file.id);
  });
  const settle = vi.fn<PendingReadsDeps['settle']>(async (id, outcome) => {
    settled.push([id, outcome]);
  });
  const deps: PendingReadsDeps = { files, content, running, read, settle, log: (line) => logs.push(line), limit: 10, attempts: 1, ...options };
  return {
    deps,
    files,
    content,
    running,
    read,
    settle,
    settled,
    logs,
    held,
    holdReads: () => (hold = true),
    readIds: () => read.mock.calls.map(([f]) => f.id),
  };
}

describe('pending reads', () => {
  it('reads a waiting file through the reader and settles it with the record id', async () => {
    const t = setup();
    const worker = createPendingReads(t.deps);
    worker.start([1]);
    await worker.idle();

    expect(t.files).toHaveBeenCalledWith([1]);
    expect(t.read).toHaveBeenCalledTimes(1);
    const [file, input] = t.read.mock.calls[0] ?? [];
    expect(file?.id).toBe(1);
    expect(input).toEqual<ReadInput>({
      buffer: PDF_BYTES,
      type: { mime: 'application/pdf', ext: 'pdf' },
      name: 'fatura-1.pdf',
      force: false,
      kullaniciId: 7,
    });
    expect(t.settled).toEqual([[1, { kayitId: resultFor(1).record.id }]]);
    expect(t.logs).toEqual([]);
  });

  it('detects the file type from the stored bytes', async () => {
    const t = setup([waitingFile(3, PNG_BYTES)]);
    const worker = createPendingReads(t.deps);
    worker.start([3]);
    await worker.idle();
    expect(t.read.mock.calls[0]?.[1].type).toEqual({ mime: 'image/png', ext: 'png' });
  });

  it('reads a file once when it is started twice', async () => {
    const t = setup();
    t.holdReads();
    const worker = createPendingReads(t.deps);
    worker.start([1]);
    worker.start([1]);
    await vi.waitFor(() => expect(t.held.size).toBe(1));
    worker.start([1]);
    // The second and third starts were dropped before loading anything.
    expect(t.files).toHaveBeenCalledTimes(1);

    t.held.get(1)?.();
    await worker.idle();
    expect(t.readIds()).toEqual([1]);
    expect(t.settled).toHaveLength(1);
  });

  it('reads only the unclaimed ids of a start', async () => {
    const t = setup();
    t.holdReads();
    const worker = createPendingReads(t.deps);
    worker.start([1]);
    worker.start([1, 2]);
    expect(t.files).toHaveBeenNthCalledWith(2, [2]);
    await vi.waitFor(() => expect(t.held.size).toBe(2));
    for (const release of t.held.values()) release();
    await worker.idle();
    expect(t.readIds().sort()).toEqual([1, 2]);
  });

  it('loads every waiting file when started without ids and skips the ones already being read', async () => {
    const t = setup([waitingFile(1), waitingFile(2), waitingFile(3)]);
    t.holdReads();
    const worker = createPendingReads(t.deps);
    worker.start([1]);
    await vi.waitFor(() => expect(t.held.size).toBe(1));
    worker.start();
    await vi.waitFor(() => expect(t.held.size).toBe(3));
    expect(t.files).toHaveBeenLastCalledWith(undefined);

    // Files read by the full start are claimed too.
    worker.start([2]);
    worker.start([3]);
    expect(t.files).toHaveBeenCalledTimes(2);

    for (const release of t.held.values()) release();
    await worker.idle();
    expect(t.readIds()).toEqual([1, 2, 3]);
    expect(t.settled.map(([id]) => id).sort()).toEqual([1, 2, 3]);
  });

  it('skips a file that a start with ids claimed while a full start was loading', async () => {
    const t = setup();
    let loaded = (): void => {};
    t.files.mockImplementationOnce(
      () => new Promise<WaitingFile[]>((resolve) => (loaded = () => resolve([waitingFile(1), waitingFile(2)]))),
    );
    t.holdReads();
    const worker = createPendingReads(t.deps);
    worker.start();
    worker.start([1]);
    await vi.waitFor(() => expect(t.held.size).toBe(1));
    loaded();
    await vi.waitFor(() => expect(t.held.size).toBe(2));
    for (const release of t.held.values()) release();
    await worker.idle();
    expect(t.readIds()).toEqual([1, 2]);
    expect(t.settled.map(([id]) => id).sort()).toEqual([1, 2]);
  });

  it('does not read again a file settled while a full start was loading', async () => {
    const t = setup();
    let loaded = (): void => {};
    t.files.mockImplementationOnce(
      () => new Promise<WaitingFile[]>((resolve) => (loaded = () => resolve([waitingFile(1), waitingFile(2)]))),
    );
    const worker = createPendingReads(t.deps);
    worker.start();
    worker.start([1]);
    // File 1 is read and settled before the full list, loaded earlier, arrives.
    await vi.waitFor(() => expect(t.settled.map(([id]) => id)).toEqual([1]));
    loaded();
    await worker.idle();
    expect(t.readIds()).toEqual([1, 2]);
    expect(t.settled.map(([id]) => id)).toEqual([1, 2]);
    // Once no full load runs, a file can be started again.
    worker.start([1]);
    await worker.idle();
    expect(t.readIds()).toEqual([1, 2, 1]);
  });

  it('keeps the error code and message of a failed Claude read, without logging it', async () => {
    const t = setup();
    t.read.mockRejectedValueOnce(new ExtractionError('claude_limit', 'Claude abonelik kullanım limitine ulaşıldı.'));
    const worker = createPendingReads(t.deps);
    worker.start([1]);
    await worker.idle();
    expect(t.settled).toEqual([[1, { hata: { kod: 'claude_limit', mesaj: 'Claude abonelik kullanım limitine ulaşıldı.' } }]]);
    expect(t.logs).toEqual([]);
  });

  it('hides an unexpected error behind sunucu_hatasi and logs it', async () => {
    const t = setup();
    t.read.mockRejectedValueOnce(new Error('C:\\gizli\\yol'));
    const worker = createPendingReads(t.deps);
    worker.start([2]);
    await worker.idle();
    expect(t.settled).toEqual([[2, { hata: { kod: 'sunucu_hatasi', mesaj: 'Beklenmeyen bir hata oluştu.' } }]]);
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0]).toContain('id=2');
    expect(t.logs[0]).toContain('C:\\gizli\\yol');
  });

  it('settles a file of an unknown type as unsupported without reading it', async () => {
    const t = setup([waitingFile(4, Buffer.from('düz metin, fatura değil'))]);
    const worker = createPendingReads(t.deps);
    worker.start([4]);
    await worker.idle();
    expect(t.read).not.toHaveBeenCalled();
    expect(t.settled).toEqual([[4, { hata: { kod: 'desteklenmeyen_dosya', mesaj: expect.any(String) } }]]);
  });

  it('logs a settle that fails, does not reject, and lets the file be read again', async () => {
    const t = setup();
    t.settle.mockRejectedValueOnce(new Error('bağlantı koptu'));
    const worker = createPendingReads(t.deps);
    worker.start([1]);
    await expect(worker.idle()).resolves.toBeUndefined();
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0]).toContain('id=1');
    expect(t.logs[0]).toContain('bağlantı koptu');

    worker.start([1]);
    await worker.idle();
    expect(t.readIds()).toEqual([1, 1]);
    expect(t.settled).toEqual([[1, { kayitId: resultFor(1).record.id }]]);
  });

  it('releases ids that are no longer waiting, while the others are still being read', async () => {
    const t = setup([waitingFile(1)]);
    t.holdReads();
    const worker = createPendingReads(t.deps);
    worker.start([1, 9]);
    await vi.waitFor(() => expect(t.held.size).toBe(1));

    // File 9 was not returned, so a later start may claim it again.
    worker.start([9]);
    expect(t.files).toHaveBeenLastCalledWith([9]);
    expect(t.files).toHaveBeenCalledTimes(2);

    t.held.get(1)?.();
    await worker.idle();
    expect(t.readIds()).toEqual([1]);
  });

  it('logs a failed load and releases the claimed ids', async () => {
    const t = setup();
    t.files.mockRejectedValueOnce(new Error('veritabanı yok'));
    const worker = createPendingReads(t.deps);
    worker.start([1, 2]);
    await worker.idle();
    expect(t.read).not.toHaveBeenCalled();
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0]).toContain('veritabanı yok');

    worker.start([1, 2]);
    await worker.idle();
    expect(t.readIds()).toEqual([1, 2]);
  });

  it('logs a failed full load without claiming anything', async () => {
    const t = setup();
    t.files.mockRejectedValueOnce(new Error('veritabanı yok'));
    const worker = createPendingReads(t.deps);
    worker.start();
    await worker.idle();
    expect(t.logs).toHaveLength(1);
    worker.start();
    await worker.idle();
    expect(t.readIds()).toEqual([1, 2]);
  });

  it('does nothing for an empty list of ids', async () => {
    const t = setup();
    const worker = createPendingReads(t.deps);
    worker.start([]);
    await worker.idle();
    expect(t.files).not.toHaveBeenCalled();
  });

  it('joins a running read with the bytes it holds, without loading them', async () => {
    const t = setup();
    const bytes = Buffer.concat([PDF_BYTES, Buffer.from('% yüklenen')]);
    t.running.mockImplementation((file) => (file.id === 1 ? bytes : null));
    const worker = createPendingReads(t.deps);
    worker.start([1, 2]);
    await worker.idle();
    expect(t.running).toHaveBeenCalledWith(expect.objectContaining({ id: 1, dosyaOzeti: 'a'.repeat(64) }));
    expect(t.content.mock.calls.map(([id]) => id)).toEqual([2]);
    expect(t.read.mock.calls.find(([f]) => f.id === 1)?.[1].buffer).toBe(bytes);
    expect(t.settled.map(([id]) => id).sort()).toEqual([1, 2]);
  });

  it('loads and queues at most `limit` files at once; joined reads do not count', async () => {
    const t = setup([waitingFile(1), waitingFile(2), waitingFile(3), waitingFile(4)], { limit: 1 });
    t.running.mockImplementation((file) => (file.id === 4 ? PDF_BYTES : null));
    t.holdReads();
    const worker = createPendingReads(t.deps);
    worker.start();
    // File 4 joins its running read; of the others one is loaded and read at a time.
    await vi.waitFor(() => expect([...t.held.keys()].sort()).toEqual([1, 4]));
    expect(t.content).toHaveBeenCalledTimes(1);
    t.held.get(1)?.();
    await vi.waitFor(() => expect(t.held.has(2)).toBe(true));
    expect(t.content).toHaveBeenCalledTimes(2);
    expect(t.held.has(3)).toBe(false);
    t.held.get(2)?.();
    await vi.waitFor(() => expect(t.held.has(3)).toBe(true));
    for (const release of t.held.values()) release();
    await worker.idle();
    expect(t.settled.map(([id]) => id).sort()).toEqual([1, 2, 3, 4]);
  });

  it('drops a file that no longer waits when its bytes are loaded, without settling it', async () => {
    const t = setup();
    t.content.mockResolvedValueOnce(null);
    const worker = createPendingReads(t.deps);
    worker.start([1]);
    await worker.idle();
    expect(t.read).not.toHaveBeenCalled();
    expect(t.settled).toEqual([]);
    expect(t.logs).toEqual([]);
  });

  it('tries a file again after a delay when its result could not be stored, and gives up after the last attempt', async () => {
    const t = setup([waitingFile(1)], { attempts: 3, retryMs: 1 });
    t.settle.mockRejectedValueOnce(new Error('bağlantı koptu'));
    const worker = createPendingReads(t.deps);
    worker.start([1]);
    await vi.waitFor(() => expect(t.settled).toEqual([[1, { kayitId: resultFor(1).record.id }]]));
    expect(t.readIds()).toEqual([1, 1]);
    expect(t.logs).toEqual([expect.stringContaining('sn sonra yeniden denenecek')]);

    // Failing every time: three attempts, then it waits for the next start-up or "Yeniden oku".
    t.settle.mockRejectedValue(new Error('veritabanı yok'));
    worker.start([1]);
    await vi.waitFor(() => expect(t.logs).toHaveLength(4));
    expect(t.logs[3]).toContain('"Yeniden oku"');
    await new Promise((r) => setTimeout(r, 20));
    expect(t.readIds()).toHaveLength(5);
  });

  it('tries the files of a failed load again', async () => {
    const t = setup(undefined, { attempts: 2, retryMs: 1 });
    t.files.mockRejectedValueOnce(new Error('veritabanı yok'));
    const worker = createPendingReads(t.deps);
    worker.start([1, 2]);
    await vi.waitFor(() => expect(t.settled.map(([id]) => id).sort()).toEqual([1, 2]));
    expect(t.logs).toEqual([expect.stringContaining('yeniden denenecek')]);
  });

  it('waits in idle() for reads started while it waits', async () => {
    const t = setup();
    t.holdReads();
    const worker = createPendingReads(t.deps);
    worker.start([1]);
    let idle = false;
    const waiting = worker.idle().then(() => (idle = true));
    await vi.waitFor(() => expect(t.held.size).toBe(1));
    worker.start([2]);
    t.held.get(1)?.();
    await vi.waitFor(() => expect(t.held.size).toBe(2));
    await new Promise((r) => setTimeout(r, 5));
    expect(idle).toBe(false);
    t.held.get(2)?.();
    await waiting;
    expect(t.settled.map(([id]) => id)).toEqual([1, 2]);
  });
});
