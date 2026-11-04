// Type-mapping rules of contract §2.5 (T-m3) and small SQL helpers.
import { describe, expect, it } from 'vitest';
import {
  assertBigId,
  bigId,
  bigNum,
  keysetParams,
  pageTake,
  patchParams,
  rowVer,
  truncateChars,
  truncateUtf8,
  T,
} from '../../../packages/database/src/sql';
import { TEST_RESULTS_MAX_ROWS, selectKeptResults } from '../../../packages/database/src/repositories/test-runs';

describe('BIGINT mapping', () => {
  it('keeps BigId columns as strings', () => {
    expect(bigId({ Id: '9223372036854775807' }, 'Id')).toBe('9223372036854775807');
    expect(bigId({ Id: 42 }, 'Id')).toBe('42');
    expect(() => bigId({ Id: 'abc' }, 'Id')).toThrow(expect.objectContaining({ code: 'internal_error' }) as Error);
  });

  it('converts BIGINT counters with a checked Number()', () => {
    expect(bigNum({ N: '9007199254740991' }, 'N')).toBe(Number.MAX_SAFE_INTEGER);
    expect(bigNum({ N: '-5' }, 'N')).toBe(-5);
    expect(() => bigNum({ N: '9007199254740993' }, 'N')).toThrow(expect.objectContaining({ code: 'internal_error' }) as Error);
  });

  it('validates BigId inputs before binding them as sql.BigInt', () => {
    expect(assertBigId('1', 'id')).toBe('1');
    for (const bad of ['', '-1', '1.5', '9223372036854775808', '1e3', ' 1']) {
      expect(() => assertBigId(bad, 'id')).toThrow(expect.objectContaining({ code: 'validation_failed' }) as Error);
    }
  });
});

describe('ROWVERSION mapping', () => {
  it('maps an 8-byte buffer to base64url', () => {
    const buf = Buffer.from('0000000000000fa1', 'hex');
    expect(rowVer({ RowVer: buf })).toBe(buf.toString('base64url'));
    expect(() => rowVer({ RowVer: 'x' })).toThrow();
  });
});

describe('keyset pagination', () => {
  it('binds NULLs without a cursor and validates the cursor otherwise', () => {
    expect(keysetParams(undefined, 'guid').map(([n, , v]) => [n, v])).toEqual([
      ['afterCreatedAt', null],
      ['afterId', null],
    ]);
    const p = keysetParams({ createdAt: '2026-01-01T00:00:00.000Z', id: 'AAAAAAAA-0000-0000-0000-000000000001' }, 'guid');
    expect(p[1]?.[2]).toBe('aaaaaaaa-0000-0000-0000-000000000001');
    expect(() => keysetParams({ createdAt: 'nope', id: '1' }, 'bigint')).toThrow(
      expect.objectContaining({ code: 'invalid_cursor' }) as Error,
    );
    expect(() => keysetParams({ createdAt: '2026-01-01T00:00:00Z', id: 'x' }, 'guid')).toThrow(
      expect.objectContaining({ code: 'invalid_cursor' }) as Error,
    );
  });

  it('fetches limit + 1 rows and bounds the limit', () => {
    expect(pageTake(50)).toBe(51);
    expect(() => pageTake(0)).toThrow();
    expect(() => pageTake(1001)).toThrow();
  });
});

describe('patchParams', () => {
  it('emits @set_x flags so absent fields keep their column value', () => {
    const patch: { name?: string; description?: string | null } = { name: 'n', description: undefined };
    const params = patchParams(patch, [
      ['name', T.nvarchar(10)],
      ['description', T.nvarchar(10)],
    ]);
    expect(params.map(([n, , v]) => [n, v])).toEqual([
      ['set_name', true],
      ['name', 'n'],
      ['set_description', false],
      ['description', null],
    ]);
  });
});

describe('truncation', () => {
  it('never splits surrogate pairs or UTF-8 code points', () => {
    expect(truncateChars('ab😀', 3)).toBe('ab');
    expect(truncateChars('abc', 5)).toBe('abc');
    expect(truncateUtf8('aé😀', 3)).toBe('aé');
    expect(Buffer.byteLength(truncateUtf8('é'.repeat(100), 51))).toBe(50);
  });
});

describe('selectKeptResults', () => {
  it('keeps at most 5000 rows, failures first, in input order', () => {
    const rows = Array.from({ length: TEST_RESULTS_MAX_ROWS + 10 }, (_, i) => ({
      i,
      status: i >= TEST_RESULTS_MAX_ROWS ? 'failed' : 'passed',
    }));
    const kept = selectKeptResults(rows);
    expect(kept).toHaveLength(TEST_RESULTS_MAX_ROWS);
    expect(kept.filter((r) => r.status === 'failed')).toHaveLength(10);
    expect(kept.map((r) => r.i)).toEqual([...kept.map((r) => r.i)].sort((a, b) => a - b));
  });
});
