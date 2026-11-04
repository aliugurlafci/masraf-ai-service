// Structural view of the Zod schemas exported by @orc/shared. The web app never imports zod
// directly (contract §1.2: @orc/web may import only @orc/shared and the React stack).

export interface Schema<T> {
  parse(data: unknown): T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Array of `item` (the API returns bare arrays for attempts, agents, teams, workers, ...). */
export function arrayOf<T>(item: Schema<T>): Schema<T[]> {
  return {
    parse(data: unknown): T[] {
      if (!Array.isArray(data)) {
        throw new TypeError('Expected an array');
      }
      return data.map((entry: unknown) => item.parse(entry));
    },
  };
}

export interface SyncProjectResponse {
  jobId: string;
  deduplicated: boolean;
}

/** `POST /projects/:id/sync` => 202 `{ jobId, deduplicated }` (§9.5; no named shared schema). */
export const SyncProjectResponseSchema: Schema<SyncProjectResponse> = {
  parse(data: unknown): SyncProjectResponse {
    if (!isRecord(data) || typeof data.jobId !== 'string' || typeof data.deduplicated !== 'boolean') {
      throw new TypeError('Expected { jobId: string, deduplicated: boolean }');
    }
    return { jobId: data.jobId, deduplicated: data.deduplicated };
  },
};
