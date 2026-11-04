// `orc-db purge-audit --before <ISO date> [--dry-run]` (contract §4.3, F12). Runs as orc_migrator; AuditLogs
// are otherwise append-only (UPDATE/DELETE denied to the app roles).
import { OrcError } from '@orc/shared';
import type { Logger } from '@orc/logger';
import { mapSqlError } from '../errors.js';
import { T, sql } from '../sql.js';
import type { Param, Row } from '../sql.js';
import type { Database } from '../types.js';

export const AUDIT_PURGE_MIN_AGE_DAYS = 365;
export const AUDIT_PURGE_BATCH_SIZE = 5000;
const DAY_MS = 86_400_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

const COUNT_SQL = 'SELECT COUNT_BIG(*) AS N FROM orc.AuditLogs WHERE OccurredAt < @before;';
const DELETE_SQL = 'DELETE TOP (@batch) FROM orc.AuditLogs WHERE OccurredAt < @before;';
const DB_NOW_SQL = 'SELECT SYSUTCDATETIME() AS NowUtc;';

/** Parses `--before`; date-only and zone-less values are UTC. Refuses dates later than now - 365 days. */
export function parsePurgeBefore(value: string, now: Date): Date {
  const text = value.trim();
  if (!ISO_DATE.test(text)) throw new OrcError('validation_failed', '--before must be an ISO 8601 date or date-time');
  const zoned = /T/.test(text) && !/(Z|[+-]\d{2}:\d{2})$/.test(text) ? `${text}Z` : text;
  const before = new Date(zoned);
  if (Number.isNaN(before.getTime())) throw new OrcError('validation_failed', '--before is not a valid date');
  const limit = new Date(now.getTime() - AUDIT_PURGE_MIN_AGE_DAYS * DAY_MS);
  if (before.getTime() > limit.getTime()) {
    throw new OrcError(
      'validation_failed',
      `--before must not be later than now - ${AUDIT_PURGE_MIN_AGE_DAYS} days (${limit.toISOString()})`,
    );
  }
  return before;
}

export interface PurgeAuditReport {
  before: string;
  dryRun: boolean;
  /** Rows deleted, or rows that would be deleted with --dry-run. */
  deleted: number;
}

async function query(db: Database, text: string, params: readonly Param[] = []): Promise<{ rows: Row[]; rowsAffected: number }> {
  const req = new sql.Request(db.pool);
  for (const [name, type, value] of params) req.input(name, type, value);
  try {
    const result = await req.query<Row>(text);
    return { rows: result.recordset ?? [], rowsAffected: result.rowsAffected.reduce((a, b) => a + b, 0) };
  } catch (err) {
    throw mapSqlError(err);
  }
}

function countOf(rows: readonly Readonly<Record<string, unknown>>[]): number {
  const v = rows[0]?.['N'];
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isSafeInteger(n)) throw new OrcError('internal_error', 'Unexpected COUNT_BIG result');
  return n;
}

export async function purgeAuditLogs(
  db: Database,
  opts: { before: string; dryRun: boolean; logger: Logger; now?: Date; batchSize?: number },
): Promise<PurgeAuditReport> {
  const dbNow = (await query(db, DB_NOW_SQL)).rows[0]?.['NowUtc'];
  const now = opts.now ?? (dbNow instanceof Date ? dbNow : new Date());
  const before = parsePurgeBefore(opts.before, now);
  const batch = opts.batchSize ?? AUDIT_PURGE_BATCH_SIZE;
  if (!Number.isInteger(batch) || batch < 1 || batch > AUDIT_PURGE_BATCH_SIZE) {
    throw new OrcError('validation_failed', `batch size must be 1..${AUDIT_PURGE_BATCH_SIZE}`);
  }

  if (opts.dryRun) {
    const n = countOf((await query(db, COUNT_SQL, [['before', T.dt, before]])).rows);
    opts.logger.info({ before: before.toISOString(), wouldDelete: n }, 'audit purge dry run');
    return { before: before.toISOString(), dryRun: true, deleted: n };
  }

  let deleted = 0;
  for (;;) {
    const { rowsAffected } = await query(db, DELETE_SQL, [
      ['batch', T.int, batch],
      ['before', T.dt, before],
    ]);
    deleted += rowsAffected;
    if (rowsAffected < batch) break;
  }
  await db.repos.audit.insert({
    action: 'maintenance.audit_purged',
    actor: { type: 'system', label: 'orc-db purge-audit' },
    entityType: 'system',
    entityId: null,
    outcome: 'success',
    detail: { before: before.toISOString(), deleted },
  });
  opts.logger.info({ before: before.toISOString(), deleted }, 'audit logs purged');
  return { before: before.toISOString(), dryRun: false, deleted };
}

