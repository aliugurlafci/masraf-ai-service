// `orc-db seed` (contract §4.4): runs seed/seed.sql (idempotent MERGE of Teams and Agents) as orc_migrator.
import { readFile } from 'node:fs/promises';
import { OrcError } from '@orc/shared';
import type { Logger } from '@orc/logger';
import { mapSqlError } from '../errors.js';
import { sql } from '../sql.js';
import type { Row } from '../sql.js';

export const SEED_MODEL_MAX_LENGTH = 100;

export interface SeedReport {
  teams: number;
  agents: number;
}

/** Validates the CLAUDE_DEFAULT_MODEL value bound as @DefaultModel. */
export function assertSeedModel(model: string | null | undefined): string {
  if (typeof model !== 'string' || model.trim() === '' || model.length > SEED_MODEL_MAX_LENGTH) {
    throw new OrcError('config_invalid', 'CLAUDE_DEFAULT_MODEL is required for seed (1..100 characters)');
  }
  return model.trim();
}

export async function readSeedFile(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
}

/** Runs the seed batch on one transaction; @DefaultModel is the only bound input. */
export async function runSeed(
  pool: sql.ConnectionPool,
  input: { sqlText: string; defaultModel: string },
  deps: { logger: Logger },
): Promise<SeedReport> {
  const model = assertSeedModel(input.defaultModel);
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
  } catch (err) {
    throw mapSqlError(err);
  }
  try {
    const req = new sql.Request(tx);
    req.input('DefaultModel', sql.NVarChar(SEED_MODEL_MAX_LENGTH), model);
    const result = await req.query<Row>(input.sqlText);
    const sets = (result.recordsets as unknown as Row[][] | undefined) ?? [];
    const summary = sets[sets.length - 1]?.[0];
    const teams = summary?.['Teams'];
    const agents = summary?.['Agents'];
    if (typeof teams !== 'number' || typeof agents !== 'number') {
      throw new OrcError('internal_error', 'seed.sql did not return its summary row');
    }
    await tx.commit();
    deps.logger.info({ teams, agents }, 'seed applied');
    return { teams, agents };
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // XACT_ABORT already rolled the transaction back.
    }
    throw mapSqlError(err);
  }
}
