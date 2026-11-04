#!/usr/bin/env node
// Fake codebase-memory-mcp (contract §18.4): a stdio MCP server built with @modelcontextprotocol/sdk that
// exposes REQUIRED_MCP_TOOLS (input schemas contain REQUIRED_TOOL_PARAMS and `format`) and answers with
// deterministic JSON text.
//
// Graph tools of the diff-seeded impact analysis (ADR-0035), same JSON shapes as v0.12.0:
//   get_file_outline => {file_path, cols:[name,label,lines,qn], rows, total, offset, limit, returned, has_more}
//   trace_path       => {function, direction, callers_total, callers:{qn_rule, cols:[name,hop], groups}} or
//                       isError {error:"function not found"}
// index_repository records, for .js/.mjs/.cjs/.ts/.tsx/.jsx files, every `function`/`class` declaration (lines
// up to its balanced closing brace) and a call edge X -> Y when Y's name followed by `(` (or `new Y`) appears
// in X's lines; qualified names are `<project>.<path without extension, / => .>.<name>`.
//
// Behaviour switch: `.fake-cbm.json` at CBM_ALLOWED_ROOT:
//   { "mode": "ok" | "missing-tool:<name>" | "error:<tool>" | "hang:<tool>" | "crash"
//             | "crash:startup" | "fatal:startup" | "garbage:<tool>",
//     "omitParams": { "<tool>": ["<param>", ...] },   // drop properties from the advertised inputSchema
//     "structured": true }                            // also return structuredContent
// crash          => the process exits (code 70) on the first tools/call
// crash:startup  => the process exits (code 70) before the MCP handshake
// fatal:startup  => writes a JSON-RPC error with id null and exits (code 1) before the handshake
// garbage:<tool> => writes a non JSON-RPC line to stdout when <tool> is called
//
// Every tools/call is appended to <CBM_CACHE_DIR>/fake-cbm-calls.jsonl as {"tool","args"}; index state
// lives in <CBM_CACHE_DIR>/fake-cbm-state.json.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const cacheDir = process.env.CBM_CACHE_DIR;
const allowedRoot = process.env.CBM_ALLOWED_ROOT;
if (!cacheDir || !allowedRoot) {
  process.stderr.write('fake-cbm: CBM_CACHE_DIR and CBM_ALLOWED_ROOT are required\n');
  process.exit(64);
}
mkdirSync(cacheDir, { recursive: true });

function readSwitch() {
  const file = join(allowedRoot, '.fake-cbm.json');
  if (!existsSync(file)) return { mode: 'ok', omitParams: {}, structured: false };
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return {
    mode: typeof raw.mode === 'string' ? raw.mode : 'ok',
    omitParams: raw.omitParams && typeof raw.omitParams === 'object' ? raw.omitParams : {},
    structured: raw.structured === true,
  };
}

const behaviour = readSwitch();
const [modeName, modeArg] = (() => {
  const i = behaviour.mode.indexOf(':');
  return i === -1 ? [behaviour.mode, null] : [behaviour.mode.slice(0, i), behaviour.mode.slice(i + 1)];
})();

if (modeName === 'crash' && modeArg === 'startup') {
  process.stderr.write('fake-cbm: simulated startup crash\n');
  process.exit(70);
}
const fatalStartup = modeName === 'fatal' && modeArg === 'startup';

const str = (description) => ({ type: 'string', description });
const TOOLS = [
  {
    name: 'index_repository',
    description: 'Index a repository',
    properties: {
      repo_path: str('Repository path'),
      mode: { type: 'string', enum: ['full', 'moderate', 'fast'] },
      name: str('Name override'),
      doc_candidates: { type: 'boolean' },
      async: { type: 'boolean' },
      format: { type: 'string', enum: ['tree', 'json'] },
    },
    required: ['repo_path'],
  },
  {
    name: 'index_status',
    description: 'Index status',
    properties: { project: str('Project'), format: { type: 'string', enum: ['tree', 'json'] } },
    required: ['project'],
  },
  {
    name: 'list_projects',
    description: 'List projects',
    properties: { format: { type: 'string', enum: ['tree', 'json'] } },
    required: [],
  },
  {
    name: 'delete_project',
    description: 'Delete a project',
    properties: { project: str('Project'), format: { type: 'string', enum: ['tree', 'json'] } },
    required: ['project'],
  },
  {
    name: 'detect_changes',
    description: 'Detect changes',
    properties: {
      project: str('Project'),
      base_branch: str('Base'),
      scope: { type: 'string', enum: ['files', 'impact', 'tests'] },
      format: { type: 'string', enum: ['tree', 'json'] },
    },
    required: ['project'],
  },
  {
    name: 'get_file_outline',
    description: 'Declaration outline of one repository-relative file',
    properties: {
      project: str('Project'),
      file_path: str('Repository-relative file path'),
      format: { type: 'string', enum: ['tree', 'json'] },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
    },
    required: ['project', 'file_path'],
  },
  {
    name: 'trace_path',
    description: 'Trace callers/callees',
    properties: {
      project: str('Project'),
      function_name: str('Qualified or short name'),
      direction: { type: 'string', enum: ['inbound', 'outbound', 'both'] },
      depth: { type: 'integer' },
      format: { type: 'string', enum: ['tree', 'json'] },
      limit: { type: 'integer' },
    },
    required: ['function_name', 'project'],
  },
];

function advertisedTools() {
  return TOOLS.filter((t) => !(modeName === 'missing-tool' && t.name === modeArg)).map((t) => {
    const omit = Array.isArray(behaviour.omitParams[t.name]) ? behaviour.omitParams[t.name] : [];
    const properties = Object.fromEntries(Object.entries(t.properties).filter(([k]) => !omit.includes(k)));
    return {
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object', properties, required: t.required.filter((r) => !omit.includes(r)) },
    };
  });
}

const stateFile = join(cacheDir, 'fake-cbm-state.json');
function loadState() {
  return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { projects: {} };
}
function saveState(state) {
  writeFileSync(stateFile, JSON.stringify(state));
}

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else if (entry.isFile()) n += 1;
  }
  return n;
}

const SOURCE_EXT = /\.(?:m?js|cjs|tsx?|jsx|mts|cts)$/;
const DECL = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function\*?|class)\s+([A-Za-z_$][\w$]*)/;

function sourceFiles(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(root, full, out);
    else if (entry.isFile() && SOURCE_EXT.test(entry.name)) out.push(relative(root, full).split('\\').join('/'));
  }
  return out.sort();
}

/** Declarations of one file: `function`/`class` lines up to the balanced closing brace. */
function parseDecls(text) {
  const lines = text.split(/\r?\n/);
  const decls = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = DECL.exec(lines[i]);
    if (!m) continue;
    let depth = 0;
    let opened = false;
    let end = i;
    for (let j = i; j < lines.length; j += 1) {
      for (const ch of lines[j]) {
        if (ch === '{') {
          depth += 1;
          opened = true;
        } else if (ch === '}') depth -= 1;
      }
      end = j;
      if (opened && depth <= 0) break;
    }
    const body = [lines[i].slice(m.index + m[0].length), ...lines.slice(i + 1, end + 1)].join('\n');
    decls.push({ name: m[2], label: m[1] === 'class' ? 'Class' : 'Function', start: i + 1, end: end + 1, body });
  }
  return decls;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Declarations and call edges of the repository (see the header). */
function buildGraph(project, root) {
  const decls = [];
  for (const rel of sourceFiles(root)) {
    const modulePath = rel.replace(/\.[^./]+$/, '').split('/').join('.');
    for (const d of parseDecls(readFileSync(join(root, rel), 'utf8'))) {
      decls.push({ file: rel, ...d, qn: `${project}.${modulePath}.${d.name}` });
    }
  }
  const edges = [];
  for (const caller of decls) {
    for (const callee of decls) {
      if (callee === caller) continue;
      const n = escapeRegExp(callee.name);
      if (new RegExp(`(?:\\b${n}\\s*\\(|\\bnew\\s+${n}\\b)`).test(caller.body)) edges.push([caller.qn, callee.qn]);
    }
  }
  return {
    decls: decls.map((d) => ({ file: d.file, name: d.name, label: d.label, start: d.start, end: d.end, qn: d.qn })),
    edges,
  };
}

function qnPrefix(qn) {
  const i = qn.lastIndexOf('.');
  return i === -1 ? '' : qn.slice(0, i);
}

function pageArgs(args, fallback, max) {
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, max) : fallback;
  const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0;
  return { limit, offset };
}

function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function reply(value, isError = false) {
  const text = JSON.stringify(value);
  const res = { content: [{ type: 'text', text }] };
  if (behaviour.structured) res.structuredContent = value;
  if (isError) res.isError = true;
  return res;
}

function changedFiles(root, base) {
  try {
    const out = execFileSync('git', ['-C', root, 'diff', '--name-only', base], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return out.split(/\r?\n/).filter((l) => l.length > 0).sort();
  } catch {
    return [];
  }
}

const server = new Server(
  { name: 'codebase-memory-mcp', version: '0.12.0-fake' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: advertisedTools() }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = request.params.name;
  const args = request.params.arguments ?? {};
  appendFileSync(join(cacheDir, 'fake-cbm-calls.jsonl'), `${JSON.stringify({ tool, args })}\n`);

  if (modeName === 'crash') {
    process.stderr.write(`fake-cbm: simulated crash in ${tool}\n`);
    process.exit(70);
  }
  if (modeName === 'hang' && modeArg === tool) {
    process.stderr.write(`fake-cbm: hanging in ${tool}\n`);
    return new Promise(() => undefined);
  }
  if (modeName === 'garbage' && modeArg === tool) {
    process.stdout.write('this is not a JSON-RPC message\n');
    return new Promise(() => undefined);
  }
  if (modeName === 'error' && modeArg === tool) {
    return reply({ error: `simulated failure in ${tool}` }, true);
  }

  const state = loadState();
  switch (tool) {
    case 'index_repository': {
      const repoPath = String(args.repo_path ?? '');
      if (!repoPath || !within(allowedRoot, repoPath)) {
        return reply({ error: 'repo_path is outside CBM_ALLOWED_ROOT' }, true);
      }
      const name = typeof args.name === 'string' && args.name ? args.name : 'fake-project';
      const files = countFiles(repoPath);
      state.projects[name] = { root: resolve(repoPath), files, ...buildGraph(name, repoPath) };
      saveState(state);
      return reply({ project: name, nodes: 10 * files, edges: 5 * files, status: 'ready' });
    }
    case 'index_status': {
      const name = String(args.project ?? '');
      const p = state.projects[name];
      if (!p) return reply({ error: 'project not found or not indexed' }, true);
      return reply({ project: name, nodes: 10 * p.files, edges: 5 * p.files, status: 'ready' });
    }
    case 'list_projects':
      return reply({ projects: Object.keys(state.projects).sort(), status: 'ok' });
    case 'delete_project': {
      const name = String(args.project ?? '');
      if (!state.projects[name]) return reply({ project: name, status: 'not_found' }, true);
      delete state.projects[name];
      saveState(state);
      return reply({ project: name, status: 'deleted' });
    }
    case 'detect_changes': {
      const name = String(args.project ?? '');
      const p = state.projects[name];
      if (!p) return reply({ error: 'project not found or not indexed' }, true);
      const base = typeof args.base_branch === 'string' ? args.base_branch : 'HEAD';
      return reply({ changed_files: changedFiles(p.root, base), impacted_symbols: [] });
    }
    case 'get_file_outline': {
      const name = String(args.project ?? '');
      const p = state.projects[name];
      if (!p) return reply({ error: 'project not found or not indexed' }, true);
      const file = String(args.file_path ?? '');
      if (file === '' || isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
        return { content: [{ type: 'text', text: "file_path must be a repository-relative path without '..'" }], isError: true };
      }
      const { limit, offset } = pageArgs(args, 100, 200);
      const all = (p.decls ?? []).filter((d) => d.file === file).sort((a, b) => a.start - b.start);
      const rows = all.slice(offset, offset + limit).map((d) => [d.name, d.label, `${d.start}-${d.end}`, d.qn]);
      return reply({
        file_path: file,
        cols: ['name', 'label', 'lines', 'qn'],
        rows,
        total: all.length,
        offset,
        limit,
        returned: rows.length,
        has_more: offset + rows.length < all.length,
      });
    }
    case 'trace_path': {
      const name = String(args.project ?? '');
      const p = state.projects[name];
      if (!p) return reply({ error: 'project not found or not indexed' }, true);
      const fn = String(args.function_name ?? '');
      const decls = p.decls ?? [];
      const targets = new Set(decls.filter((d) => d.qn === fn || d.name === fn).map((d) => d.qn));
      if (targets.size === 0) return reply({ error: 'function not found', function_name: fn }, true);
      const direction = ['inbound', 'outbound', 'both'].includes(args.direction) ? args.direction : 'both';
      const depth = Number.isInteger(args.depth) && args.depth > 0 ? args.depth : 3;
      const { limit } = pageArgs(args, 100, 5000);
      const next = (qn) => (p.edges ?? []).flatMap(([from, to]) => {
        const out = [];
        if (direction !== 'outbound' && to === qn) out.push(from);
        if (direction !== 'inbound' && from === qn) out.push(to);
        return out;
      });
      const hops = new Map();
      let frontier = [...targets];
      for (let hop = 1; hop <= depth && frontier.length > 0; hop += 1) {
        const following = [];
        for (const qn of frontier) {
          for (const n of next(qn)) {
            if (targets.has(n) || hops.has(n)) continue;
            hops.set(n, hop);
            following.push(n);
          }
        }
        frontier = following;
      }
      const found = [...hops].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
      const groups = new Map();
      for (const [qn, hop] of found.slice(0, limit)) {
        const prefix = qnPrefix(qn);
        if (!groups.has(prefix)) groups.set(prefix, []);
        groups.get(prefix).push([prefix === '' ? qn : qn.slice(prefix.length + 1), hop]);
      }
      return reply({
        function: fn,
        direction,
        callers_total: found.length,
        callers_total_relation: 'eq',
        callers: {
          qn_rule: 'qn = qn_prefix == "" ? name : qn_prefix + "." + name',
          cols: ['name', 'hop'],
          groups: [...groups].map(([qn_prefix, rows]) => ({ qn_prefix, rows })),
        },
      });
    }
    default:
      return reply({ error: `unknown tool ${tool}` }, true);
  }
});

if (fatalStartup) {
  // like v0.12.0 when its daemon cannot start: a session-level JSON-RPC error (id null), then exit
  const fatal = { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'fake-cbm: daemon refused to start' } };
  process.stdout.write(`${JSON.stringify(fatal)}\n`, () => process.exit(1));
} else {
  await server.connect(new StdioServerTransport());
}
