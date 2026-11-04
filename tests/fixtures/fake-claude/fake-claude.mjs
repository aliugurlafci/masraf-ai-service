#!/usr/bin/env node
// Fake Claude Code CLI for tests (contract §18.3). Pure Node, no dependencies.
// Invoked as CLAUDE_BIN=<node> CLAUDE_BIN_PREFIX_ARGS=["<repo>/tests/fixtures/fake-claude/fake-claude.mjs"].
// Emulates `claude -p --output-format stream-json --verbose ...` as built by @orc/claude-runner;
// behaviour is driven by `@@fake <directive> [args]` lines in the prompt read from stdin.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '2.1.316';
const HELP_FILE = join(dirname(fileURLToPath(import.meta.url)), `claude-help-${VERSION}.txt`);
const DIRECTIVE = /^@@fake (\S+)(?: (.*))?$/;
const SECRET_TEXT = 'here is a key sk-ant-FAKE0000000000000000000000 do not leak';
const MCP_TOOLS = [
  'mcp__codebase-memory-mcp__search_graph',
  'mcp__codebase-memory-mcp__get_architecture',
  'mcp__codebase-memory-mcp__index_repository',
];
const SNIPPET_MAX = 4096;
const HUGE_CHUNK = 64 * 1024;

// Option table of the verified CLI flags: 0 = boolean, 1 = one value, 'v' = variadic.
const OPTIONS = {
  '-p': 0,
  '--print': 0,
  '--verbose': 0,
  '--bare': 0,
  '--strict-mcp-config': 0,
  '--fork-session': 0,
  '--output-format': 1,
  '--setting-sources': 1,
  '--model': 1,
  '--effort': 1,
  '--permission-mode': 1,
  '--append-system-prompt': 1,
  '--session-id': 1,
  '--resume': 1,
  '-r': 1,
  '--max-budget-usd': 1,
  '--tools': 'v',
  '--allowed-tools': 'v',
  '--allowedTools': 'v',
  '--disallowed-tools': 'v',
  '--disallowedTools': 'v',
  '--mcp-config': 'v',
};
const CANONICAL = {
  '--print': '-p',
  '-r': '--resume',
  '--allowedTools': '--allowed-tools',
  '--disallowedTools': '--disallowed-tools',
};

// ---- output ------------------------------------------------------------------------------

let delayMs = 0;
let lineCounter = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

function writeTo(stream, text) {
  return new Promise((res) => {
    if (stream.write(text)) res();
    else stream.once('drain', res);
  });
}

function flush(stream) {
  return new Promise((res) => stream.write('', () => res()));
}

async function emit(obj) {
  if (delayMs > 0) await sleep(delayMs);
  lineCounter += 1;
  await writeTo(process.stdout, `${JSON.stringify(obj)}\n`);
}

async function emitRaw(text) {
  if (delayMs > 0) await sleep(delayMs);
  lineCounter += 1;
  await writeTo(process.stdout, `${text}\n`);
}

async function exit(code) {
  await flush(process.stdout);
  await flush(process.stderr);
  process.exit(code);
}

function hangForever() {
  setInterval(() => undefined, 1 << 30);
  return new Promise(() => undefined);
}

// ---- argv -----------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { flags: new Set(), values: {}, lists: {}, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let inline = null;
    if (arg.startsWith('--') && arg.includes('=')) {
      inline = arg.slice(arg.indexOf('=') + 1);
      arg = arg.slice(0, arg.indexOf('='));
    }
    if (!arg.startsWith('-') || arg === '-') {
      opts.positional.push(arg);
      continue;
    }
    if (!(arg in OPTIONS)) return { error: `error: unknown option '${arg}'` };
    const kind = OPTIONS[arg];
    const name = CANONICAL[arg] ?? arg;
    if (kind === 0) {
      opts.flags.add(name);
    } else if (kind === 1) {
      const value = inline ?? argv[i + 1];
      if (value === undefined) return { error: `error: option '${arg}' argument missing` };
      if (inline === null) i += 1;
      opts.values[name] = value;
    } else {
      const list = opts.lists[name] ?? [];
      if (inline !== null) list.push(inline);
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        list.push(argv[i + 1]);
        i += 1;
      }
      if (list.length === 0) return { error: `error: option '${arg}' argument missing` };
      opts.lists[name] = list;
    }
  }
  return { opts };
}

// ---- help / version -----------------------------------------------------------------------

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function helpText() {
  let text = readFileSync(HELP_FILE, 'utf8');
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const omitFile = configDir ? join(configDir, 'fake-help-omit.txt') : null;
  if (omitFile !== null && existsSync(omitFile)) {
    const omit = readFileSync(omitFile, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    // Same flag regex as the probe (§10.9): every line documenting or mentioning the flag goes.
    const patterns = omit.map((f) => new RegExp(`(^|[\\s,])${escapeRegex(f)}([\\s,=<\\[]|$)`));
    text = text
      .split('\n')
      .filter((line) => !patterns.some((p) => p.test(line)))
      .join('\n');
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

// ---- stdin / directives ------------------------------------------------------------------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function parseDirectives(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = DIRECTIVE.exec(line);
    if (m) out.push({ name: m[1], arg: m[2] ?? '' });
  }
  return out;
}

function insideCwd(relpath) {
  if (relpath.length === 0 || isAbsolute(relpath) || relpath.includes('\0')) return null;
  const cwd = process.cwd();
  const target = resolve(cwd, relpath);
  const rel = relative(cwd, target);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null;
  return target;
}

// ---- events ---------------------------------------------------------------------------------

let toolSeq = 0;

function assistant(state, content) {
  return {
    type: 'assistant',
    message: {
      id: `msg_fake_${lineCounter + 1}`,
      type: 'message',
      role: 'assistant',
      model: state.model,
      content,
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    session_id: state.sessionId,
  };
}

function userToolResult(state, toolUseId, content, isError) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
    parent_tool_use_id: null,
    session_id: state.sessionId,
  };
}

async function toolUse(state, name, input, resultText, isError) {
  toolSeq += 1;
  const id = `toolu_fake_${toolSeq}`;
  await emit(assistant(state, [{ type: 'tool_use', id, name, input }]));
  await emit(userToolResult(state, id, resultText, isError));
}

function mcpServerNames(paths) {
  const names = [];
  for (const p of paths) {
    try {
      const json = JSON.parse(readFileSync(p, 'utf8'));
      const servers = json && typeof json === 'object' ? json.mcpServers : null;
      if (servers && typeof servers === 'object') names.push(...Object.keys(servers));
    } catch {
      process.stderr.write(`warning: cannot read MCP config ${p}\n`);
    }
  }
  return names;
}

function runChild(argv) {
  return new Promise((res) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: process.cwd(),
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      res({ exitCode: null, stdout: '', stderr: String(e && e.message) });
      return;
    }
    child.stdout.on('data', (c) => {
      if (stdout.length < SNIPPET_MAX) stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      if (stderr.length < SNIPPET_MAX) stderr += c.toString('utf8');
    });
    child.once('error', (e) => res({ exitCode: null, stdout, stderr: `${stderr}${e.message}` }));
    child.once('close', (code) =>
      res({ exitCode: code, stdout: stdout.slice(0, SNIPPET_MAX), stderr: stderr.slice(0, SNIPPET_MAX) }),
    );
  });
}

function spawnSleeper(detached) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], {
    env: process.env,
    stdio: 'ignore',
    detached,
    windowsHide: true,
  });
  child.on('error', () => undefined);
  child.unref();
  return child;
}

// ---- main -----------------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--version') || argv.includes('-v')) {
    await writeTo(process.stdout, `${VERSION} (Claude Code)\n`);
    return exit(0);
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    await writeTo(process.stdout, helpText());
    return exit(0);
  }
  const parsed = parseArgs(argv);
  if (parsed.error) {
    await writeTo(process.stderr, `${parsed.error}\n`);
    return exit(1);
  }
  const { opts } = parsed;
  if (!opts.flags.has('-p')) {
    await writeTo(process.stderr, 'error: fake-claude supports only print mode (-p)\n');
    return exit(1);
  }
  if (opts.values['--output-format'] === 'stream-json' && !opts.flags.has('--verbose')) {
    await writeTo(
      process.stderr,
      'Error: When using --print, --output-format=stream-json requires --verbose\n',
    );
    return exit(1);
  }
  const resumeId = opts.values['--resume'] ?? null;
  if (resumeId !== null && opts.values['--session-id'] !== undefined && !opts.flags.has('--fork-session')) {
    await writeTo(process.stderr, 'Error: --session-id can only be used with --resume if --fork-session is also specified\n');
    return exit(1);
  }

  const input = await readStdin();
  const directives = parseDirectives(input);

  const cfg = {
    noInit: false,
    mcpExtra: [],
    toolExtra: [],
    permissionMode: null,
    initCwd: null,
    resultSubtype: 'success',
    resultSet: false,
    noResult: false,
    exitCode: 0,
    exitSet: false,
    cost: 0.0123,
    usage: [10, 5],
    sessionMissing: false,
  };
  for (const d of directives) {
    switch (d.name) {
      case 'no-init':
        cfg.noInit = true;
        break;
      case 'init-mcp-extra':
        cfg.mcpExtra.push(d.arg.trim());
        break;
      case 'init-tool-extra':
        cfg.toolExtra.push(d.arg.trim());
        break;
      case 'init-permission-mode':
        cfg.permissionMode = d.arg.trim();
        break;
      case 'init-cwd':
        cfg.initCwd = d.arg.trim();
        break;
      case 'result':
        cfg.resultSubtype = d.arg.trim() || 'success';
        cfg.resultSet = true;
        break;
      case 'no-result':
        cfg.noResult = true;
        break;
      case 'exit':
        cfg.exitCode = Number.parseInt(d.arg.trim(), 10) || 0;
        cfg.exitSet = true;
        break;
      case 'cost':
        cfg.cost = Number(d.arg.trim());
        break;
      case 'usage': {
        const [a, b] = d.arg.trim().split(/\s+/).map((x) => Number.parseInt(x, 10));
        cfg.usage = [a || 0, b || 0];
        break;
      }
      case 'session-missing':
        cfg.sessionMissing = true;
        break;
      case 'ignore-sigterm':
        process.on('SIGTERM', () => undefined);
        break;
      case 'slow-exit-ms': {
        const ms = Number.parseInt(d.arg.trim(), 10) || 0;
        process.on('SIGTERM', () => {
          setTimeout(() => process.exit(143), ms);
        });
        break;
      }
      default:
        break;
    }
  }

  if (cfg.sessionMissing && resumeId !== null) {
    await writeTo(process.stderr, `No conversation found with session ID: ${resumeId}\n`);
    return exit(1);
  }

  const mcpConfigs = opts.lists['--mcp-config'] ?? [];
  const tools = (opts.lists['--tools'] ?? [])
    .flatMap((t) => t.split(','))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const state = {
    model: opts.values['--model'] ?? 'claude-fake',
    sessionId:
      opts.values['--session-id'] ??
      (resumeId !== null ? (opts.flags.has('--fork-session') ? randomUUID() : resumeId) : randomUUID()),
  };
  const started = Date.now();

  if (!cfg.noInit) {
    await emit({
      type: 'system',
      subtype: 'init',
      cwd: cfg.initCwd ?? process.cwd(),
      session_id: state.sessionId,
      tools: [...tools, ...(mcpConfigs.length > 0 ? MCP_TOOLS : []), ...cfg.toolExtra],
      mcp_servers: [...mcpServerNames(mcpConfigs), ...cfg.mcpExtra].map((name) => ({
        name,
        status: 'connected',
      })),
      model: state.model,
      permissionMode: cfg.permissionMode ?? opts.values['--permission-mode'] ?? 'default',
      claude_code_version: VERSION,
      apiKeySource: process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none',
      output_style: 'default',
    });
  }

  for (const d of directives) {
    const arg = d.arg;
    switch (d.name) {
      case 'delay-ms':
        delayMs = Math.max(0, Number.parseInt(arg.trim(), 10) || 0);
        break;
      case 'text':
        await emit(assistant(state, [{ type: 'text', text: arg }]));
        break;
      case 'tool-use': {
        const space = arg.indexOf(' ');
        const name = space === -1 ? arg : arg.slice(0, space);
        let toolInput;
        try {
          toolInput = space === -1 ? {} : JSON.parse(arg.slice(space + 1));
        } catch {
          toolInput = { raw: arg.slice(space + 1) };
        }
        await toolUse(state, name, toolInput, 'ok', false);
        break;
      }
      case 'write': {
        const [relpath, b64 = ''] = arg.split(' ');
        const target = insideCwd(relpath ?? '');
        if (target === null) {
          await toolUse(state, 'Edit', { file_path: relpath }, 'refused: path outside the working directory', true);
          break;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from(b64, 'base64'));
        await toolUse(state, 'Edit', { file_path: target }, `wrote ${relpath}`, false);
        break;
      }
      case 'delete': {
        const target = insideCwd(arg.trim());
        if (target !== null) rmSync(target, { force: true });
        break;
      }
      case 'stderr':
        await writeTo(process.stderr, `${arg}\n`);
        break;
      case 'huge-output': {
        let left = Math.max(0, Number.parseInt(arg.trim(), 10) || 0);
        while (left > 0) {
          const n = Math.min(HUGE_CHUNK, left);
          await emit(assistant(state, [{ type: 'text', text: 'x'.repeat(n) }]));
          left -= n;
        }
        break;
      }
      case 'invalid-line':
        await emitRaw('this is not json');
        break;
      case 'unknown-event':
        await emitRaw('{"type":"future_event","x":1}');
        break;
      case 'secret':
        await emit(assistant(state, [{ type: 'text', text: SECRET_TEXT }]));
        break;
      case 'hook-event':
        await emit({ type: 'system', subtype: 'hook_started', session_id: state.sessionId });
        break;
      case 'spawn-grandchild': {
        const child = spawnSleeper(arg.trim() === 'detached');
        await emit({ type: 'system', subtype: 'fake_pid', pid: child.pid ?? null });
        break;
      }
      case 'echo-env':
        await emit({
          type: 'system',
          subtype: 'fake_env',
          names: Object.keys(process.env).sort(),
          hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
        });
        break;
      case 'echo-argv':
        await emit({ type: 'system', subtype: 'fake_argv', argv });
        break;
      case 'exec': {
        let execArgv;
        try {
          execArgv = JSON.parse(arg);
        } catch {
          execArgv = null;
        }
        if (!Array.isArray(execArgv) || execArgv.length === 0 || !execArgv.every((a) => typeof a === 'string')) {
          await emit({ type: 'system', subtype: 'fake_exec', exitCode: null, stdout: '', stderr: 'invalid argv' });
          break;
        }
        const r = await runChild(execArgv);
        await emit({ type: 'system', subtype: 'fake_exec', ...r });
        break;
      }
      case 'fork-bomb': {
        const n = Math.max(0, Number.parseInt(arg.trim(), 10) || 0);
        let spawned = 0;
        let errors = 0;
        for (let i = 0; i < n; i += 1) {
          try {
            const child = spawnSleeper(true);
            if (child.pid === undefined) errors += 1;
            else spawned += 1;
          } catch {
            errors += 1;
          }
        }
        await emit({ type: 'system', subtype: 'fake_fork', spawned, errors });
        return hangForever();
      }
      case 'crash':
        await flush(process.stdout);
        process.exit(137);
        break;
      case 'hang':
        return hangForever();
      default:
        break;
    }
  }

  if (cfg.noInit) return hangForever();

  await emit(assistant(state, [{ type: 'text', text: 'fake: done' }]));
  const withResult = !cfg.noResult && !(cfg.exitSet && cfg.exitCode !== 0 && !cfg.resultSet);
  if (withResult) {
    await emit({
      type: 'result',
      subtype: cfg.resultSubtype,
      is_error: cfg.resultSubtype !== 'success',
      duration_ms: Date.now() - started,
      duration_api_ms: 1,
      num_turns: 1,
      result: 'fake: done',
      stop_reason: 'end_turn',
      session_id: state.sessionId,
      total_cost_usd: cfg.cost,
      usage: {
        input_tokens: cfg.usage[0],
        output_tokens: cfg.usage[1],
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      permission_denials: [],
    });
  }
  return exit(cfg.exitCode);
}

main().catch(async (e) => {
  await writeTo(process.stderr, `fake-claude internal error: ${e && e.stack ? e.stack : String(e)}\n`);
  await exit(70);
});
