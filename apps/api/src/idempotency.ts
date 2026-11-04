// Idempotency-Key handling for POST /tasks and POST /projects (contract §9.3).
import type { Request, Response } from 'express';
import { OrcError } from '@orc/shared';
import { sha256 } from '@orc/security';
import type { IdempotencyRecord } from '@orc/database';
import { problemBody, toPublicProblem } from './problem.js';
import type { AppDeps, Viewer } from './types.js';

export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_.:-]{8,255}$/;
export const IDEMPOTENCY_LOCK_SECONDS = 60;
const REPLAYED_HEADERS = ['Content-Type', 'Location', 'ETag'] as const;

/** JSON with object keys sorted recursively and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function replay(res: Response, record: IdempotencyRecord): void {
  res.status(record.responseStatus ?? 200);
  const headers = record.responseHeaders ?? {};
  for (const name of REPLAYED_HEADERS) {
    const value = headers[name];
    if (value !== undefined) res.setHeader(name, value);
  }
  res.setHeader('Idempotent-Replayed', 'true');
  res.send(record.responseBody ?? '');
}

/**
 * Runs `process` under the request's Idempotency-Key (if any). `process` receives the idempotency record id to hand
 * to the service, which completes the record in the same transaction as the resource insert. 4xx failures are stored
 * as the completed response; 5xx/unhandled failures release the key.
 */
export async function withIdempotency(
  deps: AppDeps,
  req: Request,
  res: Response,
  viewer: Viewer,
  scope: string,
  process: (idem: { id: string } | undefined) => Promise<void>,
): Promise<void> {
  const key = req.get('idempotency-key');
  if (key === undefined) {
    await process(undefined);
    return;
  }
  if (!IDEMPOTENCY_KEY_REGEX.test(key)) {
    throw new OrcError('idempotency_key_invalid', 'Idempotency-Key must match ^[A-Za-z0-9_.:-]{8,255}$');
  }
  const repos = deps.db.repos;
  const requestHash = sha256(canonicalJson({ params: req.params, body: req.body as unknown }));
  const begun = await repos.idempotency.tryBegin({
    userId: viewer.userId,
    scope,
    keyValue: key,
    requestHash,
    lockSeconds: IDEMPOTENCY_LOCK_SECONDS,
    ttlSeconds: deps.config.idempotencyTtlSeconds,
  });
  let id: string;
  if (begun.kind === 'existing') {
    const record = begun.record;
    if (!record.requestHash.equals(requestHash)) {
      throw new OrcError('idempotency_key_mismatch', 'Idempotency-Key was used with a different request');
    }
    if (record.status === 'completed') {
      replay(res, record);
      return;
    }
    if (!(await repos.idempotency.takeOver(record.id, IDEMPOTENCY_LOCK_SECONDS))) {
      throw new OrcError('idempotency_key_in_use', 'A request with this Idempotency-Key is in progress', {
        details: { retryAfterSeconds: 1 },
      });
    }
    id = record.id;
  } else {
    id = begun.id;
  }
  try {
    await process({ id });
  } catch (err) {
    const p = toPublicProblem(err);
    try {
      if (p.status < 500) {
        const headers: Record<string, string> = { 'Content-Type': 'application/problem+json; charset=utf-8' };
        await repos.idempotency.complete(id, {
          status: p.status,
          headers,
          body: JSON.stringify(problemBody(req, res, p)),
          resourceId: null,
        });
      } else {
        await repos.idempotency.release(id);
      }
    } catch (storeErr) {
      deps.logger.warn({ err: storeErr, idempotencyId: id }, 'idempotency record finalisation failed');
    }
    throw err;
  }
}
