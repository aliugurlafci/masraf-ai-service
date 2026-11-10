// What every write of a definition list does inside its transaction (docs/onay-sistemi.md, section 6,
// "Tanım listeleri"): take the list's lock, and delete the rules whose condition value goes away.
import { execute, p, queryOne, type Executor, type Param } from '../db/sql.ts';

/**
 * Serialises the writes of one definition list (an import, an edit, a delete) until the transaction ends,
 * so an import never overwrites a change made after it read the list.
 */
export async function lockList(tx: Executor, resource: string): Promise<void> {
  const row = await queryOne<{ rc: number }>(
    tx,
    `DECLARE @rc INT;
     EXEC @rc = sp_getapplock @Resource = @r, @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = 15000;
     SELECT @rc AS rc;`,
    { r: p.str(`masraf_tanim_${resource}`, 255) },
  );
  if (row === null || row.rc < 0) throw new Error(`tanım listesi kilitlenemedi: ${resource} (${row?.rc ?? '?'})`);
}

/** At most this many values per statement (SQL Server takes 2100 parameters). */
const CHUNK = 2000;

/**
 * Deletes the rules whose condition is one of these values (the condition field by key, or by id for a
 * 'liste' field); their targets go with them. Returns how many rules were deleted.
 */
export async function deleteRulesOf(tx: Executor, field: string | number, valueIds: readonly number[]): Promise<number> {
  let deleted = 0;
  for (let start = 0; start < valueIds.length; start += CHUNK) {
    const chunk = valueIds.slice(start, start + CHUNK);
    const params: Record<string, Param> = Object.fromEntries(chunk.map((v, i) => [`v${i}`, p.int(v)]));
    params.f = typeof field === 'number' ? p.int(field) : p.ascii(field, 40);
    const condition = typeof field === 'number' ? 'kosul_alan_id = @f' : 'kosul_alan_id = (SELECT id FROM dbo.alan_tanimlari WHERE anahtar = @f)';
    deleted += await execute(tx, `DELETE FROM dbo.alan_kurallari WHERE ${condition} AND kosul_deger_id IN (${chunk.map((_, i) => `@v${i}`).join(', ')})`, params);
  }
  return deleted;
}
