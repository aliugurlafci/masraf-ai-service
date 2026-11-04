// Static deployment model for tests/security: docker-compose files and Dockerfiles parsed from the
// repository (no Docker daemon, no rendering of secrets). Contract §10.11 item 9, §18.5, §19.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isYamlMap, parseYaml } from './yaml-lite';
import type { YamlMap, YamlValue } from './yaml-lite';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface ComposeService {
  readonly name: string;
  readonly raw: YamlMap;
  readonly user: string | null;
  readonly readOnly: boolean;
  readonly capDrop: string[];
  readonly capAdd: string[];
  readonly securityOpt: string[];
  readonly networks: string[];
  readonly secrets: string[];
  readonly volumes: VolumeMount[];
  readonly tmpfs: string[];
  readonly environment: Record<string, string>;
  readonly privileged: boolean;
  readonly networkMode: string | null;
  readonly pid: string | null;
  readonly ipc: string | null;
  readonly devices: string[];
  readonly ports: string[];
  readonly build: { dockerfile: string; target: string | null } | null;
  readonly image: string | null;
}

export interface VolumeMount {
  /** Named volume or host path (as written, `${VAR:-default}` resolved to its default). */
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
  readonly kind: 'volume' | 'bind';
}

export interface ComposeFile {
  readonly file: string;
  readonly services: Map<string, ComposeService>;
  readonly networks: YamlMap;
  readonly volumes: YamlMap;
  readonly secrets: YamlMap;
}

/** `${VAR:-default}` / `${VAR-default}` => default; `${VAR}` => '' (static view of the defaults). */
export function resolveDefaults(s: string): string {
  return s.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-([^}]*))?\}/g, (_m, def: string | undefined) => def ?? '');
}

/** A scalar as text; maps and sequences are not scalars (a misread structure must fail loudly). */
function str(v: YamlValue | undefined, fallback = ''): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'object') throw new Error(`expected a scalar, got ${JSON.stringify(v)}`);
  return String(v);
}

function optStr(v: YamlValue | undefined): string | null {
  return v === undefined || v === null ? null : str(v);
}

function strings(v: YamlValue | undefined): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map((x) => str(x));
  return [str(v)];
}

function namesOf(v: YamlValue | undefined): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) {
    return v.map((x) => (isYamlMap(x) ? str(x['source']) : str(x)));
  }
  if (isYamlMap(v)) return Object.keys(v);
  return [str(v)];
}

function parseVolume(v: YamlValue): VolumeMount {
  if (isYamlMap(v)) {
    const source = resolveDefaults(str(v['source']));
    return {
      source,
      target: str(v['target']),
      readOnly: v['read_only'] === true,
      kind: v['type'] === 'volume' ? 'volume' : 'bind',
    };
  }
  const text = resolveDefaults(str(v));
  // source:target[:mode]; a Windows drive letter (C:\...) would add a colon, which compose files here never use.
  const parts = text.split(':');
  const [source = '', target = '', mode = ''] = parts;
  const kind = /^[./~]|^\$|^[A-Za-z]:[\\/]/.test(source) || source.includes('/') ? 'bind' : 'volume';
  return { source, target, readOnly: mode.split(',').includes('ro'), kind };
}

function environmentOf(v: YamlValue | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (isYamlMap(v)) {
    for (const [k, val] of Object.entries(v)) out[k] = str(val);
  } else if (Array.isArray(v)) {
    for (const item of v) {
      const s = str(item);
      const eq = s.indexOf('=');
      if (eq > 0) out[s.slice(0, eq)] = s.slice(eq + 1);
      else out[s] = '';
    }
  }
  return out;
}

function service(name: string, raw: YamlMap): ComposeService {
  const build = isYamlMap(raw['build'])
    ? {
        dockerfile: str(raw['build']['dockerfile'], 'Dockerfile'),
        context: str(raw['build']['context'], '.'),
        target: optStr(raw['build']['target']),
      }
    : null;
  return {
    name,
    raw,
    user: optStr(raw['user']),
    readOnly: raw['read_only'] === true,
    capDrop: strings(raw['cap_drop']),
    capAdd: strings(raw['cap_add']),
    securityOpt: strings(raw['security_opt']),
    networks: namesOf(raw['networks']),
    secrets: namesOf(raw['secrets']),
    volumes: (Array.isArray(raw['volumes']) ? raw['volumes'] : []).map(parseVolume),
    tmpfs: strings(raw['tmpfs']),
    environment: environmentOf(raw['environment']),
    privileged: raw['privileged'] === true,
    networkMode: optStr(raw['network_mode']),
    pid: optStr(raw['pid']),
    ipc: optStr(raw['ipc']),
    devices: strings(raw['devices']),
    ports: strings(raw['ports']).map(resolveDefaults),
    build:
      build === null
        ? null
        : { dockerfile: path.posix.join(build.context.replace(/^\.\/?/, ''), build.dockerfile), target: build.target },
    image: optStr(raw['image']),
  };
}

export function loadCompose(file: string): ComposeFile {
  const doc = parseYaml(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
  if (!isYamlMap(doc) || !isYamlMap(doc['services'])) throw new Error(`${file}: no services`);
  const services = new Map<string, ComposeService>();
  for (const [name, raw] of Object.entries(doc['services'])) {
    if (!isYamlMap(raw)) throw new Error(`${file}: service ${name} is not a map`);
    services.set(name, service(name, raw));
  }
  const mapOr = (v: YamlValue | undefined): YamlMap => (isYamlMap(v) ? v : {});
  return {
    file,
    services,
    networks: mapOr(doc['networks']),
    volumes: mapOr(doc['volumes']),
    secrets: mapOr(doc['secrets']),
  };
}

/** Every docker-compose*.yml / compose*.yml at the repository root. */
export function composeFiles(): string[] {
  return readdirSync(REPO_ROOT)
    .filter((f) => /^(docker-)?compose(\.[A-Za-z0-9_-]+)*\.ya?ml$/.test(f))
    .sort();
}

export function requireService(c: ComposeFile, name: string): ComposeService {
  const s = c.services.get(name);
  if (s === undefined) throw new Error(`${c.file}: service ${name} missing`);
  return s;
}

// ---- Dockerfiles -------------------------------------------------------------------------------

export interface DockerStage {
  readonly name: string | null;
  readonly from: string;
  /** USER instructions of this stage, in order. */
  readonly users: string[];
  readonly instructions: { op: string; args: string }[];
}

/** Parses FROM/USER/... instructions (line continuations joined, comments dropped). */
export function parseDockerfile(text: string): DockerStage[] {
  const logical: string[] = [];
  let acc = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (acc === '' && (line.trim().startsWith('#') || line.trim() === '')) continue;
    if (line.endsWith('\\')) {
      acc += `${line.slice(0, -1)} `;
      continue;
    }
    logical.push(acc + line);
    acc = '';
  }
  if (acc !== '') logical.push(acc);
  const stages: { name: string | null; from: string; users: string[]; instructions: { op: string; args: string }[] }[] = [];
  for (const l of logical) {
    const m = /^\s*([A-Za-z]+)\s+(.*)$/.exec(l);
    if (!m) continue;
    const op = (m[1] ?? '').toUpperCase();
    const args = (m[2] ?? '').trim();
    if (op === 'FROM') {
      const fm = /^(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i.exec(args);
      stages.push({ name: fm?.[2] ?? null, from: fm?.[1] ?? args, users: [], instructions: [] });
      continue;
    }
    const stage = stages[stages.length - 1];
    if (stage === undefined) continue;
    stage.instructions.push({ op, args });
    if (op === 'USER') stage.users.push(args);
  }
  return stages;
}

/**
 * Effective USER of `target` (last stage when null): its own last USER, else inherited from the
 * stage it is built FROM, else null (base image default, which is root for node/debian images).
 */
export function effectiveUser(stages: readonly DockerStage[], target: string | null): string | null {
  const byName = new Map(stages.filter((s) => s.name !== null).map((s) => [s.name as string, s]));
  let stage = target === null ? stages[stages.length - 1] : byName.get(target);
  if (stage === undefined) throw new Error(`Dockerfile stage ${String(target)} not found`);
  const seen = new Set<DockerStage>();
  while (stage !== undefined && !seen.has(stage)) {
    seen.add(stage);
    const last = stage.users[stage.users.length - 1];
    if (last !== undefined) return last;
    stage = byName.get(stage.from);
  }
  return null;
}

export function readRepoFile(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/** True when `user` (compose `user:` or Dockerfile `USER`) is not uid 0 / root. */
export function isNonRootUser(user: string | null): boolean {
  if (user === null) return false;
  const name = user.split(':')[0]?.trim() ?? '';
  return name !== '' && name !== '0' && name.toLowerCase() !== 'root';
}
