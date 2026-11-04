// Pure helpers of @orc/task-manager: job ids (§6.1), Redis options per role (§2.9), cursors (§9.4), F3 redaction inputs.
import { describe, expect, it } from 'vitest';
import { OrcError, encodeCursor } from '@orc/shared';
import {
  actorOf,
  continueTarget,
  createRedisFactory,
  keysetFromCursor,
  keysetPage,
  projectJobId,
  redisOptionsFor,
  safeJobId,
  taskStreamKey,
  controlChannelName,
} from '@orc/task-manager';
import { makeWorkspace, silentLogger, viewerFor } from '../../helpers/task-manager/fakes';

const CFG = { host: '127.0.0.1', port: 6379, password: 'pw-123456789', db: 0, prefix: 'orc' };

describe('task-manager helpers', () => {
  it('job ids use only [A-Za-z0-9-] and are never integer-like', () => {
    expect(safeJobId('dlq-repeat:abc:1')).toBe('dlq-repeat-abc-1');
    expect(safeJobId('12345')).toBe('j-12345');
    const projectId = '0b6f0000-0000-4000-8000-000000000001';
    expect(
      projectJobId({ v: 1, kind: 'sync', projectId, requestedByUserId: null, correlationId: null }),
    ).toBe(`sync-${projectId}`);
    expect(
      projectJobId({
        v: 1,
        kind: 'index',
        projectId,
        operationId: projectId,
        mode: 'full',
        requestedByUserId: null,
        correlationId: null,
      }),
    ).toBe(`index-${projectId}`);
  });

  it('redis options: blocking roles get maxRetriesPerRequest null, all get orc:<name> and ready check', () => {
    for (const role of ['queue', 'worker', 'subscriber', 'blocking'] as const) {
      expect(redisOptionsFor(CFG, role, 'x')).toMatchObject({
        maxRetriesPerRequest: null,
        connectionName: 'orc:x',
        enableReadyCheck: true,
        lazyConnect: false,
      });
    }
    expect(redisOptionsFor(CFG, 'command', 'api').maxRetriesPerRequest).toBeTypeOf('number');
    expect(redisOptionsFor({ ...CFG, password: null }, 'command', 'api')).not.toHaveProperty(
      'password',
    );
    expect(() =>
      createRedisFactory({ ...CFG, prefix: 'Bad Prefix' }, { logger: silentLogger() }),
    ).toThrow(OrcError);
  });

  it('keys and channels follow §7', () => {
    expect(taskStreamKey('orc', 'abc')).toBe('orc:task:abc:events');
    expect(controlChannelName('orc')).toBe('orc:control');
  });

  it('keyset cursors round-trip and reject filter mismatches / garbage', () => {
    const rows = [
      { id: 'b', createdAt: '2026-11-03T10:00:00.000Z' },
      { id: 'a', createdAt: '2026-11-03T09:00:00.000Z' },
    ];
    const page = keysetPage(rows, 1, { status: null }, (r) => r.id);
    expect(page.items).toEqual(['b']);
    expect(page.nextCursor).not.toBeNull();
    expect(keysetFromCursor(page.nextCursor ?? undefined, { status: null })).toEqual({
      id: 'b',
      createdAt: rows[0]?.createdAt,
    });
    expect(() => keysetFromCursor(page.nextCursor ?? undefined, { status: 'ready' })).toThrow(
      expect.objectContaining({ code: 'invalid_cursor' }),
    );
    expect(() => keysetFromCursor(encodeCursor({ k: [1], f: 'x' }), {})).toThrow(OrcError);
    expect(keysetPage(rows, 5, {}, (r) => r.id).nextCursor).toBeNull();
  });

  it('actors: session => user actor, PAT => token actor', () => {
    const v = viewerFor('operator');
    expect(actorOf(v)).toEqual({ type: 'user', userId: v.userId, label: 'operator-user' });
    const t = viewerFor('admin', { tokenId: '0b6f0000-0000-4000-8000-000000000009' });
    expect(actorOf(t)).toMatchObject({ type: 'token', tokenId: t.tokenId });
  });

  it('continue target: ready/retained reuse, kept branch => new worktree, otherwise impossible', () => {
    const retained = makeWorkspace({ status: 'retained' });
    expect(continueTarget(retained)).toEqual({ workspaceId: retained.id });
    expect(continueTarget(makeWorkspace({ status: 'removed' }))).toEqual({ workspaceId: null });
    expect(
      continueTarget(
        makeWorkspace({ status: 'removed', branchDeletedAt: '2026-11-03T10:00:00.000Z' }),
      ),
    ).toBeNull();
    expect(continueTarget(null)).toBeNull();
  });
});
