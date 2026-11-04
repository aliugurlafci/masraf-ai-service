// orc-db commands against orchestrator_test (§4.2-§4.4, §16.5): bootstrap re-run, create-admin, backup,
// purge-audit, and the DB-name guard. Passwords only come from the environment or stdin.
import { Readable, Writable } from 'node:stream';
import type sql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SCRYPT_PARAMS, verifyPassword } from '@orc/security';
import type { Database } from '@orc/database';
import { runOrcDb } from '../../../packages/database/src/cli/run';
import { openDb, openPool, query, resetDb } from '../../helpers/database/db';
import { silentLogger, testEnv } from '../../helpers/database/env';
import { uniq } from '../../helpers/database/fixtures';

class Capture extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
}

const scrypt = { ...DEFAULT_SCRYPT_PARAMS, N: 16384 };
const DAY = 86_400_000;

async function cli(argv: string[], env: Record<string, string> = {}, stdin: string[] = []): Promise<{ code: number; out: string; err: string; json: Record<string, unknown> | null }> {
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await runOrcDb(argv, {
    env: { ...testEnv(), ...env },
    stdin: Readable.from(stdin),
    stdout,
    stderr,
    overrides: { scrypt, logger: silentLogger() },
  });
  let json: Record<string, unknown> | null;
  try {
    json = JSON.parse(stdout.text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { code, out: stdout.text, err: stderr.text, json };
}

describe('orc-db CLI', () => {
  let api: Database;
  let migrator: sql.ConnectionPool;

  beforeAll(async () => {
    api = await openDb('orc_api');
    migrator = await openPool('orc_migrator', 1);
  });

  afterAll(async () => {
    await api.close();
    await migrator.close();
    await resetDb();
  });

  it('bootstrap is idempotent (re-run rotates passwords and keeps memberships)', async () => {
    const r = await cli(['bootstrap']);
    expect(r.code, r.err).toBe(0);
    expect(r.json).toMatchObject({ command: 'bootstrap', ok: true, database: 'orchestrator_test' });
    const [row] = await query<{ InRole: number }>(migrator, "SELECT IS_ROLEMEMBER('orc_api_role', 'orc_api') AS InRole;");
    expect(row?.InRole).toBe(1);
    const again = await openDb('orc_api');
    await again.ping();
    await again.close();
  });

  it('bootstrap requires every login password', async () => {
    const r = await cli(['bootstrap'], { DB_BACKUP_PASSWORD: '' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/DB_BACKUP_PASSWORD/);
  });

  it('create-admin reads the password from ORC_ADMIN_PASSWORD, hashes it and audits', async () => {
    const username = uniq('admin');
    const password = 'Very-Long-Admin-Passphrase-1';
    const r = await cli(['create-admin', '--username', username, '--display-name', 'Root Admin'], { ORC_ADMIN_PASSWORD: password });
    expect(r.code, r.err).toBe(0);
    expect(r.out).not.toContain(password);
    expect(r.err).not.toContain(password);
    const user = await api.repos.users.findByUsername(username);
    expect(user).toMatchObject({ role: 'admin', isActive: true, displayName: 'Root Admin' });
    expect(user?.passwordHash).not.toContain(password);
    expect((await verifyPassword(password, user!.passwordHash)).ok).toBe(true);
    const audit = await api.repos.audit.list({ limit: 5, entityId: user!.id, action: 'user.created' });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain(password);

    const dup = await cli(['create-admin', '--username', username], { ORC_ADMIN_PASSWORD: password });
    expect(dup.code).toBe(1);
    expect(dup.err).toContain('conflict');
  });

  it('create-admin reads the password from stdin when no env value is set and enforces the policy', async () => {
    const username = uniq('admin');
    const env = { ...testEnv() } as Record<string, string>;
    delete env['ORC_ADMIN_PASSWORD'];
    const stdout = new Capture();
    const stderr = new Capture();
    const code = await runOrcDb(['create-admin', '--username', username], {
      env,
      stdin: Readable.from(['Stdin-Admin-Password-42\n']),
      stdout,
      stderr,
      overrides: { scrypt, logger: silentLogger() },
    });
    expect(code, stderr.text).toBe(0);
    expect((await verifyPassword('Stdin-Admin-Password-42', (await api.repos.users.findByUsername(username))!.passwordHash)).ok).toBe(true);

    const weak = await runOrcDb(['create-admin', '--username', uniq('admin')], {
      env,
      stdin: Readable.from(['short\n']),
      stdout: new Capture(),
      stderr: new Capture(),
      overrides: { scrypt, logger: silentLogger() },
    });
    expect(weak).toBe(1);
    const refused = await cli(['create-admin', '--username', 'x', '--password', 'Very-Long-Admin-Passphrase-1']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('never accepted on the command line');
  });

  it('backup runs as orc_backup (db_backupoperator) into BACKUP_DIR', async () => {
    const env = testEnv();
    const r = await cli(['backup'], { DB_USER: 'orc_backup', DB_PASSWORD: env['DB_BACKUP_PASSWORD'] ?? '', BACKUP_DIR: '/var/opt/mssql/data' });
    expect(r.code, r.err).toBe(0);
    expect(r.json?.['path']).toMatch(/^\/var\/opt\/mssql\/data\/orchestrator_test_\d{8}T\d{6}Z\.bak$/);
  });

  it('purge-audit refuses recent dates, supports --dry-run and deletes in batches with an audit row', async () => {
    for (let i = 0; i < 3; i += 1) {
      await api.repos.audit.insert({ action: 'auth.login', actor: { type: 'system', label: 'test' }, entityType: 'session', entityId: `old-${i}`, outcome: 'success' });
    }
    await api.repos.audit.insert({ action: 'auth.login', actor: { type: 'system', label: 'test' }, entityType: 'session', entityId: 'recent', outcome: 'success' });
    await query(migrator, "UPDATE orc.AuditLogs SET OccurredAt = DATEADD(DAY, -400, OccurredAt) WHERE EntityId LIKE 'old-%';");
    const before = new Date(Date.now() - 366 * DAY).toISOString();

    const tooRecent = await cli(['purge-audit', '--before', new Date(Date.now() - 300 * DAY).toISOString()]);
    expect(tooRecent.code).toBe(1);
    expect(tooRecent.err).toContain('365 days');

    const dry = await cli(['purge-audit', '--before', before, '--dry-run']);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.json).toMatchObject({ dryRun: true, deleted: 3 });
    expect(await api.repos.audit.list({ limit: 10, entityType: 'session' })).toHaveLength(4);

    const real = await cli(['purge-audit', '--before', before]);
    expect(real.code, real.err).toBe(0);
    expect(real.json).toMatchObject({ dryRun: false, deleted: 3 });
    expect((await api.repos.audit.list({ limit: 10, entityType: 'session' })).map((a) => a.entityId)).toEqual(['recent']);
    const purged = await api.repos.audit.list({ limit: 5, action: 'maintenance.audit_purged' });
    expect(purged).toHaveLength(1);
    expect(purged[0]).toMatchObject({ actorType: 'system', entityType: 'system', detail: { deleted: 3 } });
  });

  it('the DB-name guard refuses a non-_test database under NODE_ENV=test before connecting', async () => {
    const r = await cli(['migrate'], { DB_NAME: 'orchestrator' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('db_name_guard');
    await expect(openDb('orc_api', { database: 'orchestrator' })).rejects.toMatchObject({ code: 'db_name_guard' });
  });
});
