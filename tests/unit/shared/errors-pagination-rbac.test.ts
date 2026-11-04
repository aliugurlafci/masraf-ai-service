import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConflictError,
  ERROR_CATALOG,
  ERROR_CODES,
  GUID_REGEX,
  NotFoundError,
  OrcError,
  PERMISSIONS,
  PreconditionFailedError,
  ROLES,
  ROLE_PERMISSIONS,
  ValidationError,
  cryptoIdGenerator,
  decodeCursor,
  encodeCursor,
  filterHash,
  hasPermission,
  isOrcError,
  problemTypeUri,
  shortKey,
  systemClock,
  toIso,
} from '@orc/shared';

describe('error catalogue', () => {
  it('has an entry for every code, codes are unique and internal codes map to 500', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(Object.keys(ERROR_CATALOG).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      expect(ERROR_CATALOG[code].code).toBe(code);
      expect(ERROR_CATALOG[code].title.length).toBeGreaterThan(0);
    }
    for (const code of [
      'config_invalid',
      'db_name_guard',
      'path_escape',
      'git_failed',
      'junit_invalid',
    ] as const) {
      expect(ERROR_CATALOG[code].status).toBe(500);
    }
    expect(ERROR_CATALOG.validation_failed.status).toBe(400);
    expect(ERROR_CATALOG.precondition_required.status).toBe(428);
    expect(ERROR_CATALOG.mcp_disabled.status).toBe(503);
    expect(problemTypeUri('not_found')).toBe('/api/v1/problems/not_found');
  });

  it('OrcError takes status/title from the catalogue and exposes only < 500 by default', () => {
    const e = new OrcError('project_not_ready');
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(409);
    expect(e.message).toBe('Project is not ready');
    expect(e.expose).toBe(true);
    expect(e.name).toBe('OrcError');
    const internal = new OrcError('db_unavailable', 'db down', {
      cause: new Error('x'),
      details: { a: 1 },
    });
    expect(internal.expose).toBe(false);
    expect(internal.cause).toBeInstanceOf(Error);
    expect(internal.details).toEqual({ a: 1 });
    expect(Object.isFrozen(internal.details)).toBe(true);
    expect(new OrcError('internal_error', 'x', { expose: true }).expose).toBe(true);
    expect(isOrcError(internal)).toBe(true);
    expect(isOrcError(new Error('x'))).toBe(false);
  });

  it('subclasses carry fixed codes', () => {
    expect(new NotFoundError().code).toBe('not_found');
    expect(new ConflictError().code).toBe('conflict');
    expect(new PreconditionFailedError().status).toBe(412);
  });

  it('ValidationError.fromZod prefixes paths with the source', () => {
    const r = z
      .object({ agentId: z.string(), items: z.array(z.number()) })
      .safeParse({ items: [1, 'x'] });
    expect(r.success).toBe(false);
    if (r.success) return;
    const e = ValidationError.fromZod(r.error, 'body');
    expect(e.code).toBe('validation_failed');
    expect(e.status).toBe(400);
    expect(e.issues.map((i) => i.path).sort()).toEqual(['body.agentId', 'body.items.1']);
    expect(e.issues.every((i) => i.code === 'invalid_type')).toBe(true);
    const root = ValidationError.fromZod(z.string().safeParse(1).error as z.ZodError, 'env');
    expect(root.issues[0]?.path).toBe('env');
  });
});

describe('cursor pagination', () => {
  it('round-trips cursors', () => {
    const c = { k: ['2026-11-02T10:00:00.000Z', 'ab', 3], f: filterHash({ status: ['queued'] }) };
    const s = encodeCursor(c);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(s)).toEqual(c);
    const unicode = { k: ['çğ\u{1F600}'], f: '00000000' };
    expect(decodeCursor(encodeCursor(unicode))).toEqual(unicode);
  });

  it.each([
    '',
    '!!!',
    'a',
    'x'.repeat(513),
    encodeCursor({ k: [], f: 'nothex!!' }),
    Buffer.from('{"k":"notarray","f":"00000000"}').toString('base64url'),
    Buffer.from('{"k":[],"f":"00000000","x":1}').toString('base64url'),
    Buffer.from('not json').toString('base64url'),
    Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url'),
  ])('rejects malformed cursor %#', (s) => {
    try {
      decodeCursor(s);
      expect.unreachable();
    } catch (e) {
      expect(isOrcError(e) && e.code).toBe('invalid_cursor');
    }
  });

  it('filterHash is canonical (key order, undefined members) and 8 hex chars', () => {
    const a = filterHash({ b: 1, a: { y: [1, 2], x: 'z' }, u: undefined });
    const b = filterHash({ a: { x: 'z', y: [1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(filterHash({ b: 2 })).not.toBe(filterHash({ b: 1 }));
    // FNV-1a 32-bit of the canonical JSON ("{}" and '{"a":1}'); reference: FNV-1a("a") = e40c292c
    expect(filterHash({})).toBe('5465b825');
    expect(filterHash({ a: 1 })).toBe('8b9e4511');
  });
});

describe('primitives', () => {
  it('shortKey returns hyphen-less lower-case prefixes', () => {
    const id = '0B6F1C2E-3D4A-4B5C-8D9E-0F1A2B3C4D5E';
    expect(shortKey(id, 8)).toBe('0b6f1c2e');
    expect(shortKey(id, 12)).toBe('0b6f1c2e3d4a');
    expect(shortKey(id, 32)).toBe('0b6f1c2e3d4a4b5c8d9e0f1a2b3c4d5e');
    expect(() => shortKey('nope', 8)).toThrow();
  });

  it('id generator and clock', () => {
    expect(cryptoIdGenerator.uuid()).toMatch(GUID_REGEX);
    expect(cryptoIdGenerator.token()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cryptoIdGenerator.token(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(cryptoIdGenerator.token(1)).toHaveLength(2);
    expect(() => cryptoIdGenerator.token(0)).toThrow(RangeError);
    expect(Math.abs(systemClock.nowMs() - systemClock.now().getTime())).toBeLessThan(1000);
    expect(toIso(new Date(Date.UTC(2026, 10, 2, 10)))).toBe('2026-11-02T10:00:00.000Z');
  });
});

describe('RBAC', () => {
  it('admin has every permission', () => {
    for (const p of PERMISSIONS) expect(hasPermission('admin', p)).toBe(true);
  });

  it('operator and auditor match contract §15.1', () => {
    expect([...ROLE_PERMISSIONS.operator].sort()).toEqual(
      [
        'task:create',
        'task:read:own',
        'task:cancel:own',
        'task:retry:own',
        'project:read',
        'agent:read',
        'team:read',
        'token:manage:own',
        'system:read',
      ].sort(),
    );
    expect([...ROLE_PERMISSIONS.auditor].sort()).toEqual(
      [
        'task:read:own',
        'task:read:any',
        'project:read',
        'agent:read',
        'team:read',
        'token:manage:own',
        'system:read',
        'audit:read',
      ].sort(),
    );
    expect(hasPermission('auditor', 'task:cancel:any')).toBe(false);
    expect(hasPermission('operator', 'audit:read')).toBe(false);
    for (const r of ROLES) for (const p of ROLE_PERMISSIONS[r]) expect(PERMISSIONS).toContain(p);
  });
});
