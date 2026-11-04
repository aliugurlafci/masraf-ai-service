import { describe, expect, it } from 'vitest';
import { ValidationError } from '@orc/shared';
import { branchNameFor, sanitizeGitArgs, worktreeRelPath } from '@orc/git-manager';

const TASK = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('branchNameFor', () => {
  it.each([
    [8, 'orc/task-0a1b2c3d-a3'],
    [12, 'orc/task-0a1b2c3d4e5f-a3'],
    [32, 'orc/task-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d-a3'],
  ] as const)('uses a %i-char short key', (len, expected) => {
    expect(branchNameFor(TASK, 3, len)).toBe(expected);
  });

  it.each([
    ['upper-case GUID', TASK.toUpperCase(), 1],
    ['not a GUID', 'task-1', 1],
    ['attempt 0', TASK, 0],
    ['fractional attempt', TASK, 1.5],
    ['negative attempt', TASK, -2],
  ])('rejects %s', (_n, id, attempt) => {
    expect(() => branchNameFor(id, attempt, 8)).toThrow(ValidationError);
  });

  it('rejects an unsupported key length', () => {
    expect(() => branchNameFor(TASK, 1, 16 as 8)).toThrow(ValidationError);
  });
});

describe('worktreeRelPath', () => {
  it('is <projectId>/<taskId>/a<n> with forward slashes', () => {
    expect(worktreeRelPath(PROJECT, TASK, 2)).toBe(`${PROJECT}/${TASK}/a2`);
  });

  it.each([
    ['traversal project id', '../etc', TASK],
    ['traversal task id', PROJECT, '..'],
    ['absolute task id', PROJECT, '/tmp/x'],
  ])('rejects %s', (_n, p, t) => {
    expect(() => worktreeRelPath(p, t, 1)).toThrow(ValidationError);
  });
});

describe('sanitizeGitArgs', () => {
  it('tokenizes POSIX roots anywhere inside an argument', () => {
    const out = sanitizeGitArgs(
      [
        '-c',
        'safe.directory=/srv/ws/.repos/p.git',
        '--git-dir=/srv/ws/.repos/p.git',
        '--work-tree=/srv/ws/p/t/a1',
        'remote.origin.url',
        '/srv/projects/repo/.git',
        '/srv/ws',
      ],
      { projectsRoot: '/srv/projects', workspacesRoot: '/srv/ws/' },
    );
    expect(out).toEqual([
      '-c',
      'safe.directory=<WORKSPACES_ROOT>/.repos/p.git',
      '--git-dir=<WORKSPACES_ROOT>/.repos/p.git',
      '--work-tree=<WORKSPACES_ROOT>/p/t/a1',
      'remote.origin.url',
      '<PROJECTS_ROOT>/repo/.git',
      '<WORKSPACES_ROOT>',
    ]);
  });

  it('does not tokenize a sibling directory sharing the prefix', () => {
    expect(
      sanitizeGitArgs(['/srv/ws-other/x'], { projectsRoot: '/p', workspacesRoot: '/srv/ws' }),
    ).toEqual(['/srv/ws-other/x']);
  });

  it('handles Windows roots in native and forward-slash spellings, case-insensitively', () => {
    const roots = { projectsRoot: 'C:\\Data\\Projects', workspacesRoot: 'C:\\Data\\WS' };
    expect(
      sanitizeGitArgs(
        ['--git-dir=C:/Data/WS/.repos/p.git', 'c:\\data\\ws\\p\\a1', 'C:/Data/Projects/r/.git'],
        roots,
      ),
    ).toEqual([
      '--git-dir=<WORKSPACES_ROOT>/.repos/p.git',
      '<WORKSPACES_ROOT>\\p\\a1',
      '<PROJECTS_ROOT>/r/.git',
    ]);
  });

  it('prefers the longest root when one root contains the other', () => {
    expect(
      sanitizeGitArgs(['/data/projects/r', '/data/x'], {
        projectsRoot: '/data/projects',
        workspacesRoot: '/data',
      }),
    ).toEqual(['<PROJECTS_ROOT>/r', '<WORKSPACES_ROOT>/x']);
  });

  it('truncates each argument to 512 chars without splitting a surrogate pair', () => {
    const long = 'x'.repeat(600);
    expect(sanitizeGitArgs([long], { projectsRoot: '/p', workspacesRoot: '/w' })[0]).toHaveLength(512);
    const emoji = `${'y'.repeat(511)}\u{1F600}tail`;
    const out = sanitizeGitArgs([emoji], { projectsRoot: '/p', workspacesRoot: '/w' })[0] as string;
    expect(out).toBe('y'.repeat(511));
  });
});
