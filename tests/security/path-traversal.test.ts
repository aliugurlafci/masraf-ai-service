// Requirements §15 "path traversal" (contract §2.3 paths, §11.1, §18.5): `../`, absolute, NUL and
// symlink/junction escapes for the path primitives, repository paths, JUnit report paths, worktree
// removal and the API path/query parameters.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PathEscapeError,
  normalizeRepoRelativePath,
  normalizeWorktreeRelativePath,
  realpathWithin,
  resolveWithin,
} from '@orc/security';
import { OrcError } from '@orc/shared';
import type { GitManager } from '@orc/git-manager';
import type { UserRecord } from '@orc/database';
import { IS_WIN32, hashTree, makeTempDir, removeTempDir } from '../helpers/git/fixtures';
import { createWorld, linkDir } from '../helpers/git/world';
import type { World } from '../helpers/git/world';
import { resetDb } from '../helpers/database/db';
import { uniq } from '../helpers/database/fixtures';
import { cleanupPrefix } from '../helpers/task-manager/redis';
import { call, createApiHarness, createLoginUser, login, problemOf } from '../helpers/api/harness';
import type { ApiHarness, SessionAuth } from '../helpers/api/harness';

describe('resolveWithin / realpathWithin', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeAll(() => {
    base = makeTempDir('orc-sec-path-');
    root = path.join(base, 'root');
    outside = path.join(base, 'outside');
    mkdirSync(path.join(root, 'inner', 'deep'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n');
    writeFileSync(path.join(root, 'inner', 'ok.txt'), 'ok\n');
    linkDir(outside, path.join(root, 'escape-link'));
    linkDir(path.join(root, 'inner'), path.join(root, 'inner-link'));
    // A sibling whose name starts with the root's name must not count as "inside".
    mkdirSync(`${root}-evil`, { recursive: true });
  });

  afterAll(() => {
    removeTempDir(base);
  });

  it('resolves ordinary relative paths inside the root', () => {
    expect(resolveWithin(root, 'inner', 'ok.txt')).toBe(path.join(root, 'inner', 'ok.txt'));
    expect(resolveWithin(root, 'inner/../inner/ok.txt')).toBe(path.join(root, 'inner', 'ok.txt'));
  });

  it.each([
    ['parent escape', ['..', 'outside']],
    ['nested parent escape', ['inner/../../outside/secret.txt']],
    ['backslash parent escape', ['inner\\..\\..\\outside']],
    ['absolute posix path', ['/etc/passwd']],
    ['absolute segment later', ['inner', '/etc/passwd']],
    ['NUL byte', ['inner\0/../../x']],
    ['sibling with the root as prefix', [`../${'root'}-evil`]],
    ['drive-qualified path', ['C:\\Windows\\win.ini']],
    ['UNC path', ['\\\\server\\share\\x']],
    ['encoded traversal stays literal and harmless', ['%2e%2e/%2e%2e/x']],
  ])('%s', (name, segments) => {
    if (name.startsWith('encoded')) {
      // Percent escapes are not decoded: the result is a literal child of the root.
      expect(resolveWithin(root, ...segments).startsWith(root)).toBe(true);
      return;
    }
    if ((name.startsWith('backslash') || name.startsWith('drive') || name.startsWith('UNC')) && !IS_WIN32) {
      // On POSIX a backslash is an ordinary file-name character: the result stays inside the root.
      expect(resolveWithin(root, ...segments).startsWith(root + path.sep)).toBe(true);
      return;
    }
    expect(() => resolveWithin(root, ...segments)).toThrow(PathEscapeError);
  });

  it('realpathWithin accepts links that stay inside and rejects symlink/junction escapes', async () => {
    await expect(realpathWithin(root, 'inner-link', 'ok.txt')).resolves.toMatch(/ok\.txt$/);
    await expect(realpathWithin(root, 'escape-link')).rejects.toBeInstanceOf(PathEscapeError);
    await expect(realpathWithin(root, 'escape-link', 'secret.txt')).rejects.toBeInstanceOf(PathEscapeError);
    await expect(realpathWithin(root, '..', 'outside')).rejects.toBeInstanceOf(PathEscapeError);
  });

  it('is case-insensitive about the root on win32 (no bypass through letter case)', () => {
    if (!IS_WIN32) return;
    expect(() => resolveWithin(root.toUpperCase(), '..', 'outside')).toThrow(PathEscapeError);
    expect(resolveWithin(root.toLowerCase(), 'inner').toLowerCase()).toBe(path.join(root, 'inner').toLowerCase());
  });
});

describe('repository-relative and worktree-relative paths', () => {
  it.each([
    '../outside',
    'acme/../../outside',
    '/etc',
    '/acme/app',
    'C:/repos/app',
    'C:\\repos\\app',
    'acme\\app',
    'acme//app',
    'acme/./app',
    '.git',
    'acme/.ssh',
    '-acme',
    'acme/app\0',
    '',
    'a'.repeat(256),
  ])('repoPath %j is rejected', (p) => {
    expect(() => normalizeRepoRelativePath(p)).toThrow(OrcError);
  });

  it('accepts and normalizes a valid repoPath', () => {
    expect(normalizeRepoRelativePath('acme/app')).toBe('acme/app');
  });

  it.each(['../junit.xml', 'reports/../../x.xml', '/tmp/junit.xml', 'C:\\junit.xml', 'reports/\0.xml', 'r/'.repeat(201)])(
    'JUnit report path %j is rejected',
    (p) => {
      expect(() => normalizeWorktreeRelativePath(p)).toThrow(OrcError);
    },
  );

  it('accepts a JUnit path inside the worktree', () => {
    expect(normalizeWorktreeRelativePath('reports/junit.xml')).toBe('reports/junit.xml');
  });
});

describe('git-manager: source repositories and worktree removal stay confined (real git)', () => {
  let w: World;
  let gm: GitManager;
  let outsideRepo: string;

  beforeAll(() => {
    w = createWorld();
    w.repo('acme/app', { 'README.md': '# app\n' });
    // A real repository outside PROJECTS_ROOT, reachable only through a junction/symlink inside it.
    outsideRepo = path.join(w.root, 'outside-repo');
    w.repo('../outside-repo', { 'SECRET.md': 'outside\n' });
    mkdirSync(path.join(w.pr, 'evil'), { recursive: true });
    linkDir(outsideRepo, path.join(w.pr, 'evil', 'linked'));
    gm = w.manager();
  });

  afterAll(() => {
    w?.dispose();
  });

  it.each(['../outside-repo', 'acme/../../outside-repo', '/etc', 'acme/app/../../../x'])(
    'validateSource(%j) is rejected',
    async (repoPath) => {
      await expect(gm.validateSource(repoPath, w.ctx)).rejects.toBeInstanceOf(OrcError);
    },
  );

  it('validateSource rejects an absolute path to the outside repository', async () => {
    await expect(gm.validateSource(outsideRepo, w.ctx)).rejects.toBeInstanceOf(OrcError);
  });

  it('validateSource rejects a link inside PROJECTS_ROOT that resolves outside it', async () => {
    await expect(gm.validateSource('evil/linked', w.ctx)).rejects.toBeInstanceOf(OrcError);
    await expect(gm.syncMirror(w.projectId, 'evil/linked', w.ctx)).rejects.toBeInstanceOf(OrcError);
    expect(existsSync(path.join(w.ws, '.repos', `${w.projectId}.git`, 'SECRET.md'))).toBe(false);
  });

  it('removeWorktree refuses relPaths outside the project workspace and deletes nothing', async () => {
    const victim = path.join(w.ws, 'victim');
    mkdirSync(victim, { recursive: true });
    writeFileSync(path.join(victim, 'keep.txt'), 'keep\n');
    const before = hashTree(w.root);
    for (const relPath of [
      '../victim',
      `${w.projectId}/../victim`,
      'victim',
      '/etc',
      `${w.projectId}/7d0c6c1e-1f2a-4b3c-8d4e-5f6a7b8c9d01/a1/../../../../victim`,
      `5e1f0a2b-3c4d-4e5f-8a6b-000000000000/7d0c6c1e-1f2a-4b3c-8d4e-5f6a7b8c9d01/a1`,
      '.repos',
      '.orc',
    ]) {
      await expect(gm.removeWorktree({ projectId: w.projectId, relPath }, w.ctx), relPath).rejects.toBeInstanceOf(OrcError);
    }
    expect(existsSync(path.join(victim, 'keep.txt'))).toBe(true);
    expect(hashTree(w.root)).toEqual(before);
  });
});

describe('API: path parameters and repository paths', () => {
  let h: ApiHarness;
  let admin: UserRecord;
  let operator: UserRecord;
  let sAdmin: SessionAuth;
  let sOperator: SessionAuth;

  beforeAll(async () => {
    h = await createApiHarness();
    admin = await createLoginUser(h.db, { role: 'admin' });
    operator = await createLoginUser(h.db, { role: 'operator' });
    [sAdmin, sOperator] = await Promise.all([login(h.app, admin.username), login(h.app, operator.username)]);
  });

  afterAll(async () => {
    await h.close();
    expect(await cleanupPrefix(h.prefix)).toBe(0);
    await resetDb();
  });

  it.each(['../outside', 'acme/../../etc', '/etc/passwd', 'C:\\Windows', 'acme/.git', 'acme\\app'])(
    'POST /projects rejects repoPath %j (400, nothing stored)',
    async (repoPath) => {
      const name = uniq('Proj');
      const res = await call(h.app, 'post', '/api/v1/projects', sAdmin).send({ name, repoPath });
      expect(res.status).toBe(400);
      expect(problemOf(res).code).toBe('validation_failed');
      const list = await call(h.app, 'get', `/api/v1/projects?limit=100`, sAdmin);
      expect(JSON.stringify(list.body)).not.toContain(name);
    },
  );

  it.each(['../../junit.xml', '/tmp/junit.xml', 'reports/../../../x'])(
    'POST /projects rejects junitReportPath %j',
    async (junitReportPath) => {
      const res = await call(h.app, 'post', '/api/v1/projects', sAdmin).send({
        name: uniq('Proj'),
        repoPath: `acme/${uniq('repo')}`,
        junitReportPath,
      });
      expect(res.status).toBe(400);
    },
  );

  it.each([
    '/api/v1/tasks/..%2F..%2Fetc%2Fpasswd',
    '/api/v1/tasks/%2e%2e',
    '/api/v1/tasks/..%5C..%5Cwindows',
    '/api/v1/projects/..%2Fusers',
    '/api/v1/tasks/00000000-0000-4000-8000-000000000000%00/logs',
  ])('GET %s is rejected as an invalid id (400), never resolved as a path', async (url) => {
    const res = await call(h.app, 'get', url, sOperator);
    expect([400, 404]).toContain(res.status);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(JSON.stringify(res.body)).not.toMatch(/root:x:0|\[fonts\]/);
  });
});
