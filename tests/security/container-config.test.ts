// Requirements §15 "worker non-root", "Docker socket not mounted", "SSH dir not mounted" and §5.8
// (read-only root filesystem, least privilege, network egress restriction): static checks of every
// compose file and the Dockerfiles (contract §18.5 container-config row, §19, ADR-0024). The dynamic
// counterpart (`exec worker id -u` = 1000, runner child uids) runs in `npm run test:compose`.
import { describe, expect, it } from 'vitest';
import {
  composeFiles,
  effectiveUser,
  isNonRootUser,
  loadCompose,
  parseDockerfile,
  readRepoFile,
  requireService,
} from '../helpers/security/deployment';
import type { ComposeService } from '../helpers/security/deployment';

const PROD = loadCompose('docker-compose.yml');
const ALL = composeFiles().map((f) => loadCompose(f));

/** ADR-0024: the runner launcher is the single root container, with exactly these capabilities. */
const RUNNER_CAPS = ['SETUID', 'SETGID', 'CHOWN', 'FOWNER', 'DAC_READ_SEARCH', 'KILL'];
/** Capabilities a service may add back after `cap_drop: [ALL]`. */
const CAP_ADD_ALLOWED: Record<string, readonly string[]> = {
  // sqlservr carries the file capability cap_net_bind_service (exec fails without it).
  mssql: ['NET_BIND_SERVICE'],
  runner: RUNNER_CAPS,
};
/** Third-party images that need a writable root filesystem (state lives in named volumes). */
const WRITABLE_ROOTFS = new Set(['mssql']);

/** Contract §19 secrets column (the sa password only in mssql and db-bootstrap; none for runner). */
const SECRETS: Record<string, readonly string[]> = {
  mssql: ['mssql_sa_password', 'mssql_tls_cert', 'mssql_tls_key'],
  redis: ['redis_password'],
  'db-bootstrap': [
    'mssql_sa_password',
    'db_migrator_password',
    'db_api_password',
    'db_worker_password',
    'db_backup_password',
    'db_ca_cert',
  ],
  migrator: ['db_migrator_password', 'db_ca_cert'],
  api: ['db_api_password', 'redis_password', 'db_ca_cert'],
  worker: ['db_worker_password', 'redis_password', 'anthropic_api_key', 'claude_oauth_token', 'egress_proxy_token', 'db_ca_cert'],
  runner: [],
  'egress-proxy': ['egress_proxy_token'],
  web: ['web_tls_cert', 'web_tls_key'],
  'db-cli': ['db_migrator_password', 'db_ca_cert'],
};

/** Contract §19 networks column. */
const NETWORKS: Record<string, readonly string[]> = {
  mssql: ['backend'],
  redis: ['backend'],
  'db-bootstrap': ['backend'],
  migrator: ['backend'],
  api: ['backend', 'frontend'],
  worker: ['backend'],
  runner: ['sandbox'],
  'egress-proxy': ['sandbox', 'egress'],
  web: ['edge', 'frontend'],
  'db-cli': ['backend'],
};

function dockerUser(s: ComposeService): string | null {
  if (s.build === null) return null;
  return effectiveUser(parseDockerfile(readRepoFile(s.build.dockerfile)), s.build.target);
}

/** Runtime user: compose `user:` overrides the image's USER. */
function runtimeUser(s: ComposeService): string | null {
  return s.user ?? dockerUser(s);
}

describe('compose files: nothing dangerous is mounted or shared with the host (every file)', () => {
  it('finds the compose files', () => {
    expect(ALL.map((c) => c.file)).toEqual(expect.arrayContaining(['docker-compose.yml', 'docker-compose.test.yml']));
  });

  for (const c of ALL) {
    describe(c.file, () => {
      it('mounts no Docker socket, no ~/.ssh, no host root, no /proc, /sys, /etc or /var/run', () => {
        for (const s of c.services.values()) {
          for (const v of s.volumes) {
            const where = `${c.file}:${s.name}: ${v.source}:${v.target}`;
            expect(`${v.source} ${v.target}`, where).not.toMatch(/docker\.sock|containerd\.sock|podman\.sock/i);
            expect(`${v.source} ${v.target}`, where).not.toMatch(/(^|[/\\ ])\.ssh([/\\ ]|$)/);
            if (v.kind === 'bind') {
              expect(v.source, where).not.toMatch(/^(\/|\/+\.?|~|~\/?|\$HOME\/?|[A-Za-z]:[\\/]?)$/);
              expect(v.source, where).not.toMatch(/^~|^\$HOME|^\/(proc|sys|etc|var\/run|run|root|home|dev)(\/|$)/);
            }
          }
          const tmpfsAndRaw = JSON.stringify(s.raw);
          expect(tmpfsAndRaw, `${c.file}:${s.name}`).not.toMatch(/docker\.sock/);
        }
      });

      it('runs nothing privileged and shares no host namespace or device', () => {
        for (const s of c.services.values()) {
          const where = `${c.file}:${s.name}`;
          expect(s.privileged, where).toBe(false);
          expect(s.networkMode, where).not.toBe('host');
          expect(s.pid, where).not.toBe('host');
          expect(s.ipc, where).not.toBe('host');
          expect(s.devices, where).toEqual([]);
          expect(s.raw['userns_mode'], where).toBeUndefined();
          for (const opt of s.securityOpt) expect(opt, where).not.toMatch(/unconfined|label[:=]disable/);
        }
      });

      it('publishes host ports on loopback only, unless the production web port binding is configured', () => {
        for (const s of c.services.values()) {
          for (const p of s.ports) {
            expect(p, `${c.file}:${s.name}`).toMatch(/^127\.0\.0\.1:/);
          }
        }
      });
    });
  }
});

describe('docker-compose.yml: least-privilege containers (§19, ADR-0024)', () => {
  const services = [...PROD.services.values()];

  it('defines exactly the expected services', () => {
    expect(services.map((s) => s.name).sort()).toEqual(Object.keys(SECRETS).sort());
  });

  it('every service drops ALL capabilities and sets no-new-privileges', () => {
    for (const s of services) {
      expect(s.capDrop, s.name).toEqual(['ALL']);
      expect(s.securityOpt, s.name).toContain('no-new-privileges:true');
    }
  });

  it('adds capabilities back only where ratified (runner: exactly the six launcher caps)', () => {
    for (const s of services) {
      expect([...s.capAdd].sort(), s.name).toEqual([...(CAP_ADD_ALLOWED[s.name] ?? [])].sort());
    }
    expect(requireService(PROD, 'runner').capAdd).toEqual(RUNNER_CAPS);
  });

  it('every repository-built service has a read-only root filesystem with a bounded /tmp tmpfs', () => {
    for (const s of services) {
      if (WRITABLE_ROOTFS.has(s.name)) continue;
      expect(s.readOnly, s.name).toBe(true);
      expect(s.raw['init'], s.name).toBe(true);
      expect(s.tmpfs.some((t) => /^\/tmp:size=\d+[kmg]$/.test(t)), `${s.name} tmpfs ${s.tmpfs.join(',')}`).toBe(true);
    }
  });

  it('runs every container as a non-root user; the runner launcher is the single ratified root exception', () => {
    for (const s of services) {
      const user = runtimeUser(s);
      if (s.name === 'runner') {
        expect(s.user).toBe('0:0');
        continue;
      }
      expect(isNonRootUser(user), `${s.name} runs as ${String(user)}`).toBe(true);
    }
    expect(runtimeUser(requireService(PROD, 'worker'))).toBe('1000:1000');
    expect(runtimeUser(requireService(PROD, 'api'))).toBe('1000:1000');
  });

  it('every app image stage switches to a non-root USER (USER node / 101 / mssql)', () => {
    const app = parseDockerfile(readRepoFile('docker/Dockerfile'));
    for (const target of ['api', 'worker', 'egress-proxy', 'db-cli']) {
      expect(effectiveUser(app, target), target).toBe('node');
    }
    expect(effectiveUser(app, 'web')).toBe('101');
    expect(effectiveUser(parseDockerfile(readRepoFile('docker/mssql/Dockerfile')), null)).toBe('mssql');
    // Every service built from the repository uses one of these stages.
    for (const s of services) {
      if (s.build === null) continue;
      expect(isNonRootUser(dockerUser(s)), `${s.name} image USER`).toBe(true);
    }
  });

  it('mounts compose secrets only where §19 allows them; the sa password only in mssql and db-bootstrap', () => {
    for (const s of services) {
      expect([...s.secrets].sort(), s.name).toEqual([...(SECRETS[s.name] ?? [])].sort());
    }
    const sa = services.filter((s) => s.secrets.includes('mssql_sa_password')).map((s) => s.name);
    expect(sa.sort()).toEqual(['db-bootstrap', 'mssql']);
    const oauth = services.filter((s) => s.secrets.includes('claude_oauth_token')).map((s) => s.name);
    expect(oauth).toEqual(['worker']);
    const apiKey = services.filter((s) => s.secrets.includes('anthropic_api_key')).map((s) => s.name);
    expect(apiKey).toEqual(['worker']);
    // Secrets are files, never values in the compose environment.
    for (const s of services) {
      for (const [k, v] of Object.entries(s.environment)) {
        if (/PASSWORD|TOKEN|SECRET|API_KEY/i.test(k) && !k.endsWith('_FILE')) {
          expect(v, `${s.name}.${k}`).toMatch(/^$|^\$\{/);
        }
      }
    }
  });

  it('wires networks as §19: only egress-proxy reaches egress, only web the edge; internal networks stay internal', () => {
    for (const s of services) {
      expect([...s.networks].sort(), s.name).toEqual([...(NETWORKS[s.name] ?? [])].sort());
    }
    for (const net of ['backend', 'frontend', 'sandbox']) {
      const def = PROD.networks[net];
      expect(def && typeof def === 'object' && !Array.isArray(def) ? def['internal'] : undefined, net).toBe(true);
    }
    for (const name of ['worker', 'api']) {
      const s = requireService(PROD, name);
      expect(s.networks, name).not.toContain('egress');
      expect(s.networks, name).not.toContain('sandbox');
    }
    expect(requireService(PROD, 'runner').networks).not.toContain('backend');
  });

  it('mounts the projects directory read-only and only into the worker', () => {
    const projectMounts = services.flatMap((s) =>
      s.volumes.filter((v) => v.target === '/var/lib/orc/projects' || /(^|\/)projects$/.test(v.source)).map((v) => ({ s: s.name, v })),
    );
    expect(projectMounts.map((m) => m.s)).toEqual(['worker']);
    expect(projectMounts[0]?.v).toMatchObject({ kind: 'bind', readOnly: true, target: '/var/lib/orc/projects' });
    expect(requireService(PROD, 'worker').environment['PROJECTS_ROOT']).toBe('/var/lib/orc/projects');
  });

  it('host bind mounts are limited to the read-only projects dir and the read-only mssql.conf', () => {
    const binds = services.flatMap((s) => s.volumes.filter((v) => v.kind === 'bind').map((v) => ({ s: s.name, ...v })));
    expect(binds.map((b) => `${b.s}:${b.source}:${b.readOnly ? 'ro' : 'rw'}`).sort()).toEqual([
      'mssql:./docker/mssql/mssql.conf:ro',
      'worker:./projects:ro',
    ]);
  });

  it('bounds every long-running container (mem_limit, cpus, pids_limit except mssql)', () => {
    for (const s of services) {
      expect(s.raw['mem_limit'], s.name).toBeDefined();
      expect(s.raw['cpus'], s.name).toBeDefined();
      if (s.name !== 'mssql') expect(s.raw['pids_limit'], s.name).toBeDefined();
    }
  });

  it('only web publishes ports (loopback by default)', () => {
    for (const s of services) {
      if (s.name === 'web') {
        expect(s.ports).toEqual(['127.0.0.1:8443:8443', '127.0.0.1:8088:8080']);
      } else {
        expect(s.ports, s.name).toEqual([]);
      }
    }
  });

  it('the worker runs untrusted code only through the runner (SANDBOX_MODE=runner, non-bare Claude, oauth)', () => {
    const env = requireService(PROD, 'worker').environment;
    expect(env['SANDBOX_MODE']).toBe('runner');
    expect(env).not.toHaveProperty('CLAUDE_BARE');
    expect(env['CLAUDE_AUTH_MODE']).toMatch(/oauth/);
    expect(env['NODE_ENV']).toBe('production');
  });
});

describe('Dockerfile: nested production dependencies reach the image (cookie 2.x regression)', () => {
  // npm keeps a version conflicting with the hoisted one under <workspace>/node_modules. The image
  // copies only /app/node_modules by default, so dist/main.js would silently resolve the hoisted
  // (wrong) major. Each such entry must be copied into the image that runs that app.
  const lock = JSON.parse(readRepoFile('package-lock.json')) as {
    packages: Record<string, { dev?: boolean }>;
  };
  const nested = Object.entries(lock.packages)
    .filter(([key, meta]) => meta.dev !== true && /^(apps|packages)\/[^/]+\/node_modules\//.test(key))
    .map(([key]) => /^((?:apps|packages)\/[^/]+)\/node_modules\//.exec(key)?.[1] ?? key);
  const owners = [...new Set(nested)];
  /** Workspace -> [prod-deps stage, image stage]; the runner dist is shipped inside the worker image. */
  const IMAGES: Record<string, readonly [string, string]> = {
    'apps/api': ['prod-deps-api', 'api'],
    'apps/worker': ['prod-deps-worker', 'worker'],
    'apps/egress-proxy': ['prod-deps-egress-proxy', 'egress-proxy'],
  };
  const stages = parseDockerfile(readRepoFile('docker/Dockerfile'));

  it('no packages/* workspace has nested production dependencies (bundled into apps by tsup)', () => {
    const pkgOwners = owners.filter((o) => o.startsWith('packages/'));
    expect(
      pkgOwners,
      `${pkgOwners.join(', ')} has nested prod node_modules; packages/* are bundled into the app and ` +
        'cannot resolve them from the app directory. Align the version with the hoisted one or move the dependency to the app.',
    ).toEqual([]);
  });

  it('no apps/runner nested production dependencies (its dist is copied into apps/worker)', () => {
    expect(owners.filter((o) => o === 'apps/runner')).toEqual([]);
  });

  it.each(owners.filter((o) => o.startsWith('apps/') && o !== 'apps/runner'))(
    '%s nested node_modules is created in prod-deps and copied into the image',
    (ws) => {
      const target = IMAGES[ws];
      expect(target, `${ws} has nested prod dependencies but no image mapping in this test`).toBeDefined();
      const [depsStage, imageStage] = target as readonly [string, string];
      const deps = stages.find((s) => s.name === depsStage);
      const image = stages.find((s) => s.name === imageStage);
      expect(deps?.instructions.some((i) => i.op === 'RUN' && i.args.includes(`mkdir -p ${ws}/node_modules`))).toBe(true);
      expect(
        image?.instructions.some(
          (i) => i.op === 'COPY' && i.args.includes(`--from=${depsStage}`) && i.args.includes(`/app/${ws}/node_modules`),
        ),
        `${imageStage} image must COPY --from=${depsStage} /app/${ws}/node_modules`,
      ).toBe(true);
    },
  );
});
