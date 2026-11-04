// Lease state files `<RUNNER_STATE_DIR>/leases/<id>.json` (contract §10.11 item 3). Written before
// the handoff so a crashed runner can reclaim partially handed-off paths at its next start.
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GUID_REGEX } from '@orc/shared';
import { z } from 'zod';
import { LEASE_KEY_REGEX, WORKER_ID_REGEX } from './protocol';

export const LeaseStateSchema = z.strictObject({
  v: z.literal(1),
  id: z.string().regex(GUID_REGEX),
  key: z.string().regex(LEASE_KEY_REGEX),
  attemptId: z.string().regex(GUID_REGEX).nullable(),
  workerId: z.string().regex(WORKER_ID_REGEX),
  uid: z.int().min(0),
  gid: z.int().min(0),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(16),
  acquiredAt: z.iso.datetime(),
});
export type LeaseState = z.infer<typeof LeaseStateSchema>;

export interface StoredLeaseState {
  id: string;
  /** null when the file is unreadable or invalid. */
  state: LeaseState | null;
}

export interface LeaseStateStore {
  write(state: LeaseState): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<StoredLeaseState[]>;
}

const FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

/** Files are written atomically (tmp + rename, mode 0600) in a 0700 directory. */
export function createFileLeaseStateStore(stateDir: string): LeaseStateStore {
  const dir = path.join(stateDir, 'leases');
  const ensure = (): Promise<string | undefined> => mkdir(dir, { recursive: true, mode: 0o700 });
  const fileOf = (id: string): string => {
    if (!GUID_REGEX.test(id)) throw new Error('Invalid lease id');
    return path.join(dir, `${id}.json`);
  };
  return {
    async write(state) {
      await ensure();
      const target = fileOf(state.id);
      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(LeaseStateSchema.parse(state))}\n`, {
        mode: 0o600,
        flag: 'w',
      });
      await rename(tmp, target);
    },
    async remove(id) {
      try {
        await unlink(fileOf(id));
      } catch (e) {
        if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e;
      }
    },
    async list() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (e) {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return [];
        throw e;
      }
      const out: StoredLeaseState[] = [];
      for (const name of names.sort()) {
        if (name.endsWith('.tmp')) {
          await unlink(path.join(dir, name)).catch(() => undefined);
          continue;
        }
        const m = FILE_RE.exec(name);
        if (!m?.[1]) continue;
        let state: LeaseState | null = null;
        try {
          const parsed = LeaseStateSchema.safeParse(
            JSON.parse(await readFile(path.join(dir, name), 'utf8')),
          );
          if (parsed.success && parsed.data.id === m[1]) state = parsed.data;
        } catch {
          state = null;
        }
        out.push({ id: m[1], state });
      }
      return out;
    },
  };
}

/** In-memory store (tests, hosts without a state directory). */
export function createMemoryLeaseStateStore(): LeaseStateStore & {
  readonly entries: Map<string, LeaseState>;
} {
  const entries = new Map<string, LeaseState>();
  return {
    entries,
    write(state) {
      entries.set(state.id, LeaseStateSchema.parse(state));
      return Promise.resolve();
    },
    remove(id) {
      entries.delete(id);
      return Promise.resolve();
    },
    list() {
      return Promise.resolve([...entries.values()].map((s) => ({ id: s.id, state: s })));
    },
  };
}
