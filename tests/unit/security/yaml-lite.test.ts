// The static deployment checks (tests/security) are only as good as their YAML reader: it must read
// the compose subset exactly and refuse anything it does not understand.
import { describe, expect, it } from 'vitest';
import { YamlLiteError, parseYaml } from '../../helpers/security/yaml-lite';
import { effectiveUser, isNonRootUser, parseDockerfile, resolveDefaults } from '../../helpers/security/deployment';

describe('yaml-lite', () => {
  it('reads block maps, sequences, scalars, flow collections and block scalars', () => {
    const doc = parseYaml(
      [
        '# comment',
        'name: orc',
        'svc:',
        '  user: "1000:1000"   # trailing comment',
        "  restart: 'no'",
        '  read_only: true',
        '  cpus: 0.5',
        '  pids: 64',
        '  cap_drop: [ALL]',
        "  security_opt: ['no-new-privileges:true']",
        '  flow: {a: 1, b: [x, "y z"]}',
        '  multi:',
        '    [',
        '      one,',
        '      two,',
        '    ]',
        '  volumes:',
        '    - data:/data',
        '    - ${DIR:-./p}:/srv:ro',
        '  script: |',
        '    line 1',
        '    # not a comment',
        '  folded: >-',
        '    a',
        '    b',
        '  items:',
        '  - k: v',
        '    n: 2',
        '  - plain',
        'empty:',
      ].join('\n'),
    );
    expect(doc).toEqual({
      name: 'orc',
      svc: {
        user: '1000:1000',
        restart: 'no',
        read_only: true,
        cpus: 0.5,
        pids: 64,
        cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'],
        flow: { a: 1, b: ['x', 'y z'] },
        multi: ['one', 'two'],
        volumes: ['data:/data', '${DIR:-./p}:/srv:ro'],
        script: 'line 1\n# not a comment\n',
        folded: 'a b',
        items: [{ k: 'v', n: 2 }, 'plain'],
      },
      empty: null,
    });
  });

  it('resolves anchors, aliases and merge keys (explicit keys win)', () => {
    const doc = parseYaml(
      [
        'x-a: &a',
        '  read_only: true',
        '  cap_drop: [ALL]',
        'x-b: &b',
        '  read_only: false',
        '  init: true',
        'x-c: &c',
        '  K: v',
        's1:',
        '  <<: *a',
        '  cap_drop: [NET_RAW]',
        's2:',
        '  <<: [*a, *b]',
        '  env:',
        '    <<: *c',
        '    L: w',
        '  copy: *c',
      ].join('\n'),
    );
    expect(doc).toMatchObject({
      s1: { read_only: true, cap_drop: ['NET_RAW'] },
      s2: { read_only: true, init: true, env: { K: 'v', L: 'w' }, copy: { K: 'v' } },
    });
  });

  it('accepts the compose !override / !reset tags and rejects unknown constructs', () => {
    expect(parseYaml('ports: !override\n  - "1:1"\nx: !reset []')).toEqual({ ports: ['1:1'], x: null });
    expect(() => parseYaml('a: !!binary x')).toThrow(YamlLiteError);
    expect(() => parseYaml('a: *missing')).toThrow(/unknown alias/);
    expect(() => parseYaml('a: 1\na: 2')).toThrow(/duplicate key/);
    expect(() => parseYaml('a:\n  b: 1\n    c: 2')).toThrow(/indentation/);
    expect(() => parseYaml("a: 'open")).toThrow(/quote/);
    expect(() => parseYaml('a: [1, 2')).toThrow(/flow/);
  });

  it('resolves ${VAR:-default} to its default for the static view', () => {
    expect(resolveDefaults('${ORC_PROJECTS_DIR:-./projects}:/var/lib/orc/projects:ro')).toBe(
      './projects:/var/lib/orc/projects:ro',
    );
    expect(resolveDefaults('${A}x${B-y}')).toBe('xy');
  });
});

describe('Dockerfile reader', () => {
  const text = [
    'ARG NODE_IMAGE=node:24',
    'FROM ${NODE_IMAGE} AS base',
    'RUN apt-get update \\',
    '  && apt-get install -y git',
    'FROM base AS app',
    'USER node',
    'FROM base AS tool',
    'FROM app AS derived',
    'FROM nginx AS web',
    'USER root',
    'RUN chown 101 /x',
    'USER 101',
  ].join('\n');
  const stages = parseDockerfile(text);

  it('follows stage inheritance to the effective USER', () => {
    expect(stages.map((s) => s.name)).toEqual(['base', 'app', 'tool', 'derived', 'web']);
    expect(effectiveUser(stages, 'app')).toBe('node');
    expect(effectiveUser(stages, 'derived')).toBe('node');
    expect(effectiveUser(stages, 'tool')).toBeNull();
    expect(effectiveUser(stages, 'web')).toBe('101');
    expect(effectiveUser(stages, null)).toBe('101');
    expect(() => effectiveUser(stages, 'nope')).toThrow(/not found/);
  });

  it('classifies root users', () => {
    for (const u of ['node', '1000:1000', '101', 'mssql']) expect(isNonRootUser(u), u).toBe(true);
    for (const u of [null, '0', '0:0', 'root', 'root:root', '']) expect(isNonRootUser(u), String(u)).toBe(false);
  });
});
