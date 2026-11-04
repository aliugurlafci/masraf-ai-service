// Diff-seeded impact analysis (ADR-0035; amends the impact row of contract §12.2).
//
// In runner mode codebase-memory-mcp runs as the attempt's sandbox uid. The worktree's `.git` file names the
// admin dir `<WORKSPACES_ROOT>/.repos/<projectId>.git/worktrees/<name>` inside the worker-owned mirror, which a
// sandbox uid can never read (§10.11 item 4, §11.3), so the server's `detect_changes` cannot resolve a revision.
// The worker already computes the diff base..head with hardened git (`collectChanges`); the server only answers
// graph queries over the re-indexed worktree, so no git and no access to the mirror is needed:
//   1. get_file_outline per changed file -> declarations with line ranges;
//   2. seeds = declarations containing a changed new-side line of the file's hunks (every declaration of the
//      file when its patch is unavailable or truncated);
//   3. trace_path inbound (CALLS, depth 2) per seed -> impacted symbols (seeds excluded, minimum hop kept).
// The result keeps detect_changes' keys (`changed_files`, `seeds`, `impacted`, `impacted_modules`) and adds
// `impacted_symbols` (qualified names) and `source: 'worker_diff'`.
import { z } from 'zod';
import {
  IMPACT_DEPTH,
  IMPACT_MAX_FILES,
  IMPACT_MAX_IMPACTED,
  IMPACT_MAX_LISTED,
  IMPACT_MAX_SEEDS,
  IMPACT_MAX_SKIPPED_LISTED,
  IMPACT_MCP_TOOLS,
  IMPACT_TOOL_PARAMS,
  OUTLINE_MAX_PAGES,
  OUTLINE_PAGE_LIMIT,
  TRACE_LIMIT,
} from './constants';
import { McpError } from './errors';
import { decodeValue, toolErrorFrom } from './result';
import { supports, verifyTools } from './tools';
import type { ToolMap } from './tools';
import type { ImpactChangeSet, ImpactFileChange, McpSession, McpToolResult } from './types';

/** A declaration of the index (one get_file_outline row). */
export interface Declaration {
  qn: string;
  label: string | null;
  start: number;
  end: number;
}

interface Seed extends Declaration {
  file: string;
  seedReason: 'hunk' | 'file';
}

interface Caller {
  qn: string;
  module: string;
  hop: number;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const LINE_RANGE = /^(\d+)(?:-(\d+))?$/;
const MAX_REPO_PATH_CHARS = 4096;

/**
 * New-side line numbers touched by a git unified diff: every added line, and for removed lines the line before
 * the removal point (git `-U0` convention). A patch without hunks (pure rename, mode change) touches no line.
 */
export function changedLines(patch: string): number[] {
  const out = new Set<number>();
  let next = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      next = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const marker = line.charAt(0);
    if (marker === '+') {
      out.add(next);
      next += 1;
    } else if (marker === ' ') {
      next += 1;
    } else if (marker === '-') {
      out.add(Math.max(1, next - 1));
    } else if (marker !== '\\') {
      // "\ No newline at end of file" stays inside the hunk; anything else (next header, end) leaves it
      inHunk = false;
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** True when the sorted `lines` contain a value in [start, end]. */
function hasLineIn(lines: readonly number[], start: number, end: number): boolean {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((lines[mid] ?? 0) < start) lo = mid + 1;
    else hi = mid;
  }
  return lo < lines.length && (lines[lo] ?? Number.POSITIVE_INFINITY) <= end;
}

/** Declarations containing a changed line; every declaration when `lines` is null (patch unavailable). */
export function selectSeeds(decls: readonly Declaration[], lines: readonly number[] | null): Declaration[] {
  if (lines === null) return [...decls];
  return decls.filter((d) => hasLineIn(lines, d.start, d.end));
}

/** A repository-relative `/`-separated path as git reports it; anything else is never sent to the server. */
export function isSafeRepoPath(p: string): boolean {
  if (p.length === 0 || p.length > MAX_REPO_PATH_CHARS) return false;
  // C0 controls (incl. NUL), backslashes and drive prefixes never reach the server
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const RowsSchema = z.array(z.array(z.unknown()));

const OutlineSchema = z
  .object({ cols: z.array(z.string()).optional(), rows: RowsSchema, has_more: z.boolean().optional() })
  .loose();
type Outline = z.infer<typeof OutlineSchema>;

const TraceSchema = z
  .object({
    callers_total: z.number().optional(),
    callers: z
      .object({
        cols: z.array(z.string()).optional(),
        groups: z.array(z.object({ qn_prefix: z.string(), rows: RowsSchema }).loose()),
      })
      .loose(),
  })
  .loose();
type Trace = z.infer<typeof TraceSchema>;

const ToolErrorSchema = z.object({ error: z.string() }).loose();

const OUTLINE_COLS = ['name', 'label', 'lines', 'qn'];
const TRACE_COLS = ['name', 'hop'];

function decodeAs<T>(schema: z.ZodType<T>, tool: string, res: McpToolResult): T {
  const parsed = schema.safeParse(decodeValue(res));
  if (!parsed.success) {
    throw new McpError('mcp_protocol_error', `codebase-memory-mcp ${tool} returned an unexpected result`, {
      details: { tool },
    });
  }
  return parsed.data;
}

function columnIndex(cols: readonly string[] | undefined, defaults: readonly string[], name: string): number {
  return (cols ?? defaults).indexOf(name);
}

function cell(row: readonly unknown[], index: number): unknown {
  return index < 0 ? undefined : row[index];
}

/** Outline rows -> declarations; malformed rows are skipped. */
export function outlineDeclarations(value: Outline): Declaration[] {
  const iLabel = columnIndex(value.cols, OUTLINE_COLS, 'label');
  const iLines = columnIndex(value.cols, OUTLINE_COLS, 'lines');
  const iQn = columnIndex(value.cols, OUTLINE_COLS, 'qn');
  const out: Declaration[] = [];
  for (const row of value.rows) {
    const qn = cell(row, iQn);
    const lines = cell(row, iLines);
    const label = cell(row, iLabel);
    if (typeof qn !== 'string' || qn.length === 0 || typeof lines !== 'string') continue;
    const m = LINE_RANGE.exec(lines.trim());
    if (m === null) continue;
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : Number(m[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) continue;
    out.push({ qn, label: typeof label === 'string' ? label : null, start, end });
  }
  return out;
}

/** trace_path groups -> callers (qn = qn_prefix == "" ? name : qn_prefix + "." + name); malformed rows skipped. */
export function traceCallers(value: Trace): Caller[] {
  const iName = columnIndex(value.callers.cols, TRACE_COLS, 'name');
  const iHop = columnIndex(value.callers.cols, TRACE_COLS, 'hop');
  const out: Caller[] = [];
  for (const group of value.callers.groups) {
    for (const row of group.rows) {
      const name = cell(row, iName);
      const hop = cell(row, iHop);
      if (typeof name !== 'string' || name.length === 0) continue;
      if (typeof hop !== 'number' || !Number.isSafeInteger(hop) || hop < 1) continue;
      out.push({ qn: group.qn_prefix === '' ? name : `${group.qn_prefix}.${name}`, module: group.qn_prefix, hop });
    }
  }
  return out;
}

/** v0.12.0 answers `{"error":"function not found",...}` for a qualified name that is not (or no longer) indexed. */
function isUnknownFunction(res: McpToolResult): boolean {
  const parsed = ToolErrorSchema.safeParse(decodeValue(res));
  return parsed.success && /function not found/i.test(parsed.data.error);
}

export interface ImpactContext {
  session: McpSession;
  tools: ToolMap;
  /** Index name of the workspace. */
  project: string;
  /** Options of the next tool call; throws mcp_timeout once the operation budget is spent. */
  callOptions: () => { timeoutMs: number; signal?: AbortSignal };
}

/** Runs the diff-seeded impact analysis in an open session and returns the result document. */
export async function diffImpact(
  ctx: ImpactContext,
  baseSha: string,
  changes: ImpactChangeSet,
): Promise<Record<string, unknown>> {
  verifyTools(ctx.tools, IMPACT_MCP_TOOLS, IMPACT_TOOL_PARAMS);
  const jsonFormat = (tool: string): Record<string, unknown> =>
    supports(ctx.tools, tool, 'format') ? { format: 'json' } : {};
  const call = (tool: string, args: Record<string, unknown>): Promise<McpToolResult> =>
    ctx.session.callTool(tool, args, ctx.callOptions());

  const skipped: { file: string; reason: string }[] = [];
  let skippedTotal = 0;
  let fileLimitHit = false;
  const skip = (file: string, reason: string): void => {
    skippedTotal += 1;
    if (skipped.length < IMPACT_MAX_SKIPPED_LISTED) skipped.push({ file, reason });
  };

  const candidates: ImpactFileChange[] = [];
  for (const f of changes.files) {
    if (f.changeType === 'D') continue;
    if (f.isBinary) skip(f.path, 'binary');
    else if (!isSafeRepoPath(f.path)) skip(f.path, 'invalid_path');
    else if (candidates.length >= IMPACT_MAX_FILES) {
      fileLimitHit = true;
      skip(f.path, 'file_limit');
    } else candidates.push(f);
  }

  const paged = supports(ctx.tools, 'get_file_outline', 'limit') && supports(ctx.tools, 'get_file_outline', 'offset');
  let outlineIncomplete = false;
  const outline = async (file: string): Promise<Declaration[]> => {
    const decls: Declaration[] = [];
    for (let page = 0; page < OUTLINE_MAX_PAGES; page += 1) {
      const res = await call('get_file_outline', {
        project: ctx.project,
        file_path: file,
        ...jsonFormat('get_file_outline'),
        ...(paged ? { limit: OUTLINE_PAGE_LIMIT, offset: page * OUTLINE_PAGE_LIMIT } : {}),
      });
      if (res.isError) throw toolErrorFrom('get_file_outline', res);
      const value = decodeAs(OutlineSchema, 'get_file_outline', res);
      decls.push(...outlineDeclarations(value));
      if (!paged || value.has_more !== true || value.rows.length === 0) return decls;
    }
    outlineIncomplete = true;
    return decls;
  };

  const seeds: Seed[] = [];
  const seedNames = new Set<string>();
  for (const f of candidates) {
    const decls = await outline(f.path);
    const patch = f.patchTruncated ? null : f.patch;
    const lines = patch === null ? null : changedLines(patch);
    for (const d of selectSeeds(decls, lines)) {
      if (seedNames.has(d.qn)) continue;
      seedNames.add(d.qn);
      seeds.push({ ...d, file: f.path, seedReason: patch === null ? 'file' : 'hunk' });
    }
  }

  const traced = seeds.slice(0, IMPACT_MAX_SEEDS);
  const impacted = new Map<string, { module: string; hop: number; via: string }>();
  let unresolved = 0;
  let traceIncomplete = false;
  for (const s of traced) {
    const res = await call('trace_path', {
      project: ctx.project,
      function_name: s.qn,
      direction: 'inbound',
      depth: IMPACT_DEPTH,
      ...jsonFormat('trace_path'),
      ...(supports(ctx.tools, 'trace_path', 'limit') ? { limit: TRACE_LIMIT } : {}),
    });
    if (res.isError) {
      if (isUnknownFunction(res)) {
        unresolved += 1;
        continue;
      }
      throw toolErrorFrom('trace_path', res);
    }
    const value = decodeAs(TraceSchema, 'trace_path', res);
    const callers = traceCallers(value);
    if (value.callers_total !== undefined && value.callers_total > callers.length) traceIncomplete = true;
    for (const c of callers) {
      if (seedNames.has(c.qn)) continue;
      const prev = impacted.get(c.qn);
      if (prev === undefined || c.hop < prev.hop) impacted.set(c.qn, { module: c.module, hop: c.hop, via: s.qn });
    }
  }

  const impactedList = [...impacted]
    .map(([qn, v]) => ({ qn, module: v.module, hop: v.hop, via: v.via }))
    .sort((a, b) => a.hop - b.hop || (a.qn < b.qn ? -1 : a.qn > b.qn ? 1 : 0));
  const shown = impactedList.slice(0, IMPACT_MAX_IMPACTED);
  const moduleCounts = new Map<string, number>();
  for (const i of impactedList) moduleCounts.set(i.module, (moduleCounts.get(i.module) ?? 0) + 1);
  const modules = [...moduleCounts]
    .map(([module, count]) => ({ module, count }))
    .sort((a, b) => b.count - a.count || (a.module < b.module ? -1 : a.module > b.module ? 1 : 0))
    .slice(0, IMPACT_MAX_LISTED);
  const changedFiles = changes.files.map((f) => f.path);

  return {
    source: 'worker_diff',
    base: baseSha,
    head: changes.headSha,
    direction: 'inbound',
    depth: IMPACT_DEPTH,
    changed_total: changes.totalFiles,
    changed_files: changedFiles.slice(0, IMPACT_MAX_LISTED),
    changed_has_more: changes.truncated || changedFiles.length > IMPACT_MAX_LISTED,
    files_examined: candidates.length,
    skipped_total: skippedTotal,
    skipped_files: skipped,
    seed_total: seeds.length,
    seeds_traced: traced.length,
    seeds_unresolved: unresolved,
    seeds: seeds.slice(0, IMPACT_MAX_LISTED).map((s) => ({
      qn: s.qn,
      label: s.label,
      file: s.file,
      start: s.start,
      end: s.end,
      seed_reason: s.seedReason,
    })),
    impacted_total: impactedList.length,
    impacted_total_relation: traceIncomplete ? 'gte' : 'eq',
    impacted: shown,
    impacted_symbols: shown.map((i) => i.qn),
    impacted_has_more: impactedList.length > shown.length,
    impacted_modules: modules,
    truncated:
      changes.truncated || fileLimitHit || outlineIncomplete || traceIncomplete || seeds.length > traced.length,
  };
}
