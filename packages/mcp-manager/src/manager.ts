// McpManager: per-operation codebase-memory-mcp sessions, deterministic index naming, typed outcomes
// recorded through McpOperationRecorder (contract §2.7, §12).
import { mkdir, rm, stat } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { GUID_REGEX, OrcError, isOrcError, shortKey, systemClock } from '@orc/shared';
import type { IndexMode, McpOperationKind, Uuid } from '@orc/shared';
import type { LaunchLease } from '@orc/shared/node';
import { serializeError } from '@orc/logger';
import {
  PathEscapeError,
  UnsafeArgumentError,
  buildChildEnv,
  isCommitSha,
  realpathWithin,
  resolveWithin,
  sha256,
} from '@orc/security';
import { MCP_INHERITED_ENV } from './constants';
import { McpError, clipMessage, errorText, isMcpError } from './errors';
import { diffImpact } from './impact';
import {
  capResult,
  decodeValue,
  extractCounts,
  isNotFoundResult,
  toolErrorFrom,
} from './result';
import { checkTools, supports, verifyTools } from './tools';
import type { ToolMap } from './tools';
import type {
  ClaudeMcpConfigFile,
  ImpactChangeSet,
  IndexKind,
  IndexScope,
  McpManager,
  McpManagerConfig,
  McpManagerDeps,
  McpProbeResult,
  McpSession,
  OperationOutcome,
  WorkspaceScope,
} from './types';

interface ScopeIds {
  projectId: Uuid;
  taskId: Uuid | null;
  attemptId: Uuid | null;
  workspaceId: Uuid | null;
}

interface OperationValue {
  nodeCount: number | null;
  edgeCount: number | null;
  result: unknown;
}

const CACHE_DIR_MODE = 0o700;
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 300 } as const;

function abortedError(cause?: unknown): McpError {
  return new McpError('mcp_timeout', 'codebase-memory-mcp operation aborted', {
    cause,
    details: { aborted: true },
  });
}

/** Reads the live abort state (a property read the compiler cannot narrow across awaits). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function toMcpError(e: unknown, signal: AbortSignal | undefined): McpError {
  if (signal?.aborted === true) {
    return isMcpError(e) && e.code === 'mcp_timeout' ? e : abortedError(e);
  }
  if (isMcpError(e)) return e;
  const reason = isOrcError(e) ? e.code : 'error';
  return new McpError('mcp_unavailable', `codebase-memory-mcp operation failed: ${errorText(e)}`, {
    cause: e,
    details: { reason },
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export function createMcpManager(cfg: McpManagerConfig, deps: McpManagerDeps): McpManager {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger;
  const launcher = deps.launcher;
  const workerId = cfg.workerId ?? `${hostname()}-${process.pid}`;
  const platform = process.platform === 'win32' ? 'win32' : 'posix';
  const localMode = launcher.mode === 'local';

  function assertGuid(value: string, field: string): void {
    if (typeof value !== 'string' || !GUID_REGEX.test(value)) {
      throw new OrcError('validation_failed', `MCP scope ${field} is not a GUID`);
    }
  }

  function validateScope(scope: IndexScope): void {
    assertGuid(scope.projectId, 'projectId');
    if (scope.kind === 'workspace') {
      assertGuid(scope.workspaceId, 'workspaceId');
      assertGuid(scope.taskId, 'taskId');
      assertGuid(scope.attemptId, 'attemptId');
      if (!Number.isInteger(scope.attemptNumber) || scope.attemptNumber < 1) {
        throw new OrcError('validation_failed', 'MCP scope attemptNumber must be a positive integer');
      }
      if (scope.keyLength !== 8 && scope.keyLength !== 12 && scope.keyLength !== 32) {
        throw new OrcError('validation_failed', 'MCP scope keyLength must be 8, 12 or 32');
      }
    }
  }

  function indexName(scope: IndexScope): string {
    validateScope(scope);
    return scope.kind === 'project'
      ? `orc-p-${shortKey(scope.projectId, 8)}`
      : `orc-t-${shortKey(scope.taskId, scope.keyLength)}-a${scope.attemptNumber}`;
  }

  function cacheDir(scope: IndexScope): string {
    validateScope(scope);
    return scope.kind === 'project'
      ? resolveWithin(cfg.cacheRoot, 'p', scope.projectId)
      : resolveWithin(cfg.cacheRoot, 'w', scope.workspaceId);
  }

  /** Scope path pinned inside WORKSPACES_ROOT (DB-derived path). */
  function scopePath(scope: IndexScope): string {
    if (typeof scope.path !== 'string' || !isAbsolute(scope.path)) {
      throw new PathEscapeError('MCP scope path must be absolute');
    }
    const rel = relative(resolve(cfg.workspacesRoot), resolve(scope.path));
    if (rel.length === 0) throw new PathEscapeError('MCP scope path must not be WORKSPACES_ROOT itself');
    return resolveWithin(cfg.workspacesRoot, rel);
  }

  /** Rejects a scope path that leaves WORKSPACES_ROOT through a symlink/junction (the path must exist). */
  async function assertRealScopePath(dir: string): Promise<void> {
    await realpathWithin(cfg.workspacesRoot, relative(resolve(cfg.workspacesRoot), dir));
  }

  /**
   * codebase-memory-mcp v0.12.0 joins the daemon of its runtime dir (default: account-wide) and refuses
   * to start when that daemon serves another CBM_CACHE_DIR (a developer's own session or a concurrent
   * operation on another scope), so every cache gets its own runtime dir (CBM_RUNTIME_DIR, accepted by
   * the launcher for kind `mcp` only). Local mode: a short per-cache dir below the OS temp dir (socket
   * path length; removed with the cache). Runner mode: the leased cache dir itself — the only per-cache
   * directory the sandbox uid can write (the runner rejects a runtime dir outside the lease).
   */
  function runtimeDir(cache: string): string {
    return localMode ? localRuntimeDir(cache) : cache;
  }

  function localRuntimeDir(cache: string): string {
    return join(tmpdir(), 'orc-cbm-rt', sha256(cache).toString('hex').slice(0, 16));
  }

  async function removeLocalRuntimeDir(cache: string): Promise<void> {
    try {
      await rm(localRuntimeDir(cache), RM_OPTIONS);
    } catch (e) {
      logger.warn({ source: 'mcp', err: serializeError(e) }, 'MCP runtime dir removal failed');
    }
  }

  function cbmEnv(dir: string, cache: string): Record<string, string> {
    const env: Record<string, string> = {
      CBM_CACHE_DIR: cache,
      CBM_ALLOWED_ROOT: dir,
      CBM_LOG_LEVEL: cfg.logLevel,
    };
    env['CBM_RUNTIME_DIR'] = runtimeDir(cache);
    return env;
  }

  function serverEnv(dir: string, cache: string): Record<string, string> {
    return buildChildEnv(MCP_INHERITED_ENV, process.env, cbmEnv(dir, cache), platform);
  }

  function ids(scope: IndexScope): ScopeIds {
    return scope.kind === 'project'
      ? { projectId: scope.projectId, taskId: null, attemptId: null, workspaceId: null }
      : {
          projectId: scope.projectId,
          taskId: scope.taskId,
          attemptId: scope.attemptId,
          workspaceId: scope.workspaceId,
        };
  }

  async function prepareDirs(cache: string, mustCreateCache: boolean): Promise<void> {
    if (mustCreateCache || localMode) await mkdir(cache, { recursive: true, mode: CACHE_DIR_MODE });
    if (localMode) await mkdir(localRuntimeDir(cache), { recursive: true, mode: CACHE_DIR_MODE });
  }

  async function acquireOpLease(key: string, paths: string[]): Promise<LaunchLease> {
    return launcher.acquire({ key, attemptId: null, workerId, paths });
  }

  async function releaseLease(lease: LaunchLease): Promise<void> {
    try {
      await lease.release();
    } catch (e) {
      logger.warn({ source: 'mcp', leaseKey: lease.key, err: serializeError(e) }, 'MCP lease release failed');
    }
  }

  async function withSession<T>(
    o: { cwd: string; env: Record<string, string>; lease: LaunchLease; signal: AbortSignal | undefined },
    fn: (session: McpSession, tools: ToolMap) => Promise<T>,
  ): Promise<T> {
    if (o.signal?.aborted === true) throw abortedError();
    const session = await deps.factory.connect({
      env: o.env,
      cwd: o.cwd,
      lease: o.lease,
      timeoutMs: cfg.connectTimeoutMs,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    const onAbort = (): void => {
      session.close().catch((e: unknown) => {
        logger.warn({ source: 'mcp', err: serializeError(e) }, 'MCP session close on abort failed');
      });
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // an abort between connect() and addEventListener() fires no event
      if (isAborted(o.signal)) throw abortedError();
      const list = await session.listTools();
      const tools: ToolMap = new Map(list.map((t) => [t.name, t]));
      verifyTools(tools);
      return await fn(session, tools);
    } finally {
      o.signal?.removeEventListener('abort', onAbort);
      try {
        await session.close();
      } catch (e) {
        logger.warn({ source: 'mcp', err: serializeError(e) }, 'MCP session close failed');
      }
    }
  }

  function failedOutcome(err: McpError, durationMs: number): OperationOutcome {
    return {
      status: 'failed',
      nodeCount: null,
      edgeCount: null,
      result: err.details ? capResult({ error: { code: err.code, ...err.details } }, cfg.resultMaxBytes) : null,
      errorCode: err.code,
      errorMessage: clipMessage(err.message),
      durationMs,
    };
  }

  async function finish(
    operationId: Uuid,
    meta: { kind: McpOperationKind; indexName: string },
    outcome: OperationOutcome,
  ): Promise<OperationOutcome & { operationId: Uuid }> {
    await deps.recorder.finish(operationId, outcome);
    const log = {
      source: 'mcp',
      operationId,
      kind: meta.kind,
      indexName: meta.indexName,
      status: outcome.status,
      durationMs: outcome.durationMs,
      errorCode: outcome.errorCode,
    };
    if (outcome.status === 'failed') logger.warn({ ...log, errorMessage: outcome.errorMessage }, 'MCP operation failed');
    else logger.info(log, 'MCP operation finished');
    return { ...outcome, operationId };
  }

  /** Runs one recorded operation: lease (caller's or `op-<operationId>`), session, typed outcome. */
  async function runOperation(
    o: {
      operationId: Uuid;
      kind: McpOperationKind;
      indexName: string;
      lease: LaunchLease | undefined;
      signal: AbortSignal | undefined;
      dir: string;
      cache: string;
      startedMs: number;
    },
    fn: (session: McpSession, tools: ToolMap) => Promise<OperationValue>,
  ): Promise<OperationOutcome & { operationId: Uuid }> {
    let ownLease: LaunchLease | null = null;
    let outcome: OperationOutcome;
    try {
      await assertRealScopePath(o.dir);
      await prepareDirs(o.cache, o.lease === undefined);
      let lease = o.lease;
      if (lease === undefined) {
        ownLease = await acquireOpLease(`op-${o.operationId}`, [o.dir, o.cache]);
        lease = ownLease;
      }
      const value = await withSession(
        { cwd: o.dir, env: serverEnv(o.dir, o.cache), lease, signal: o.signal },
        fn,
      );
      outcome = {
        status: 'succeeded',
        nodeCount: value.nodeCount,
        edgeCount: value.edgeCount,
        result: capResult(value.result, cfg.resultMaxBytes),
        errorCode: null,
        errorMessage: null,
        durationMs: Math.max(0, clock.nowMs() - o.startedMs),
      };
    } catch (e) {
      outcome = failedOutcome(toMcpError(e, o.signal), Math.max(0, clock.nowMs() - o.startedMs));
    } finally {
      if (ownLease !== null) await releaseLease(ownLease);
    }
    return finish(o.operationId, { kind: o.kind, indexName: o.indexName }, outcome);
  }

  async function probe(): Promise<McpProbeResult> {
    const result: McpProbeResult = {
      ok: false,
      serverVersion: null,
      tools: [],
      missingTools: [],
      schemaMismatches: [],
    };
    let lease: LaunchLease | null = null;
    try {
      const dir = resolveWithin(cfg.cacheRoot, 'probe');
      await prepareDirs(dir, true);
      lease = await acquireOpLease(`op-mcp-probe-${workerId}`, [dir]);
      const session = await deps.factory.connect({
        env: serverEnv(dir, dir),
        cwd: dir,
        lease,
        timeoutMs: cfg.connectTimeoutMs,
      });
      try {
        result.serverVersion = session.serverVersion;
        const list = await session.listTools();
        const tools: ToolMap = new Map(list.map((t) => [t.name, t]));
        result.tools = [...tools.keys()].sort();
        const check = checkTools(tools);
        result.missingTools = check.missingTools;
        result.schemaMismatches = check.schemaMismatches;
        if (check.missingTools.length === 0 && check.schemaMismatches.length === 0) {
          const res = await session.callTool('list_projects', {}, { timeoutMs: cfg.callTimeoutMs });
          if (res.isError) throw toolErrorFrom('list_projects', res);
          result.ok = true;
        }
      } finally {
        await session.close().catch(() => undefined);
      }
    } catch (e) {
      logger.warn({ source: 'mcp', err: serializeError(e) }, 'codebase-memory-mcp probe failed');
    } finally {
      if (lease !== null) await releaseLease(lease);
      if (localMode) await removeLocalRuntimeDir(resolveWithin(cfg.cacheRoot, 'probe'));
    }
    if (!result.ok && (result.missingTools.length > 0 || result.schemaMismatches.length > 0)) {
      logger.warn(
        { source: 'mcp', missingTools: result.missingTools, schemaMismatches: result.schemaMismatches },
        'codebase-memory-mcp does not expose the required tools',
      );
    }
    return result;
  }

  async function index(
    scope: IndexScope,
    o: {
      mode: IndexMode;
      kind: IndexKind;
      existingOperationId?: Uuid;
      lease?: LaunchLease;
      signal?: AbortSignal;
    },
  ): Promise<OperationOutcome & { operationId: Uuid }> {
    const name = indexName(scope);
    const cache = cacheDir(scope);
    const dir = scopePath(scope);
    if (scope.kind === 'workspace' && o.lease === undefined) {
      throw new OrcError('internal_error', 'Workspace indexing requires the attempt lease');
    }
    const operationId = await deps.recorder.start({
      ...ids(scope),
      kind: o.kind,
      indexName: name,
      mode: o.mode,
      ...(o.existingOperationId !== undefined ? { existingOperationId: o.existingOperationId } : {}),
    });
    const startedMs = clock.nowMs();
    return runOperation(
      {
        operationId,
        kind: o.kind,
        indexName: name,
        lease: o.lease,
        signal: o.signal,
        dir,
        cache,
        startedMs,
      },
      async (session, tools) => {
        const args: Record<string, unknown> = { repo_path: dir, mode: o.mode, name };
        // F11: doc-code candidates for the base and first task index (never `async`)
        if (o.kind !== 'task_reindex' && supports(tools, 'index_repository', 'doc_candidates')) {
          args['doc_candidates'] = true;
        }
        const res = await session.callTool('index_repository', args, {
          timeoutMs: cfg.indexTimeoutMs,
          ...(o.signal ? { signal: o.signal } : {}),
        });
        if (res.isError) throw toolErrorFrom('index_repository', res);
        const indexValue = decodeValue(res);
        let statusValue: unknown = null;
        try {
          const statusArgs: Record<string, unknown> = { project: name };
          if (supports(tools, 'index_status', 'format')) statusArgs['format'] = 'json';
          const st = await session.callTool('index_status', statusArgs, {
            timeoutMs: cfg.callTimeoutMs,
            ...(o.signal ? { signal: o.signal } : {}),
          });
          if (st.isError) throw toolErrorFrom('index_status', st);
          statusValue = decodeValue(st);
        } catch (e) {
          if (o.signal?.aborted === true) throw e;
          logger.warn(
            { source: 'mcp', operationId, indexName: name, err: serializeError(e) },
            'index_status failed after a successful index; using index_repository counts',
          );
        }
        const fromStatus = extractCounts(statusValue);
        const fromIndex = extractCounts(indexValue);
        return {
          nodeCount: fromStatus.nodeCount ?? fromIndex.nodeCount,
          edgeCount: fromStatus.edgeCount ?? fromIndex.edgeCount,
          result: { index: indexValue, status: statusValue },
        };
      },
    );
  }

  /** Diff-seeded impact (ADR-0035); every call shares the MCP_DETECT_TIMEOUT_MS budget of the operation. */
  async function impactFromDiff(
    session: McpSession,
    tools: ToolMap,
    o: { project: string; baseSha: string; changes: ImpactChangeSet; signal: AbortSignal | undefined },
  ): Promise<OperationValue> {
    const deadline = clock.nowMs() + cfg.detectTimeoutMs;
    const result = await diffImpact(
      {
        session,
        tools,
        project: o.project,
        callOptions: () => {
          const remaining = deadline - clock.nowMs();
          if (remaining <= 0) {
            throw new McpError('mcp_timeout', `impact analysis exceeded ${cfg.detectTimeoutMs} ms`, {
              details: { timeoutMs: cfg.detectTimeoutMs },
            });
          }
          return { timeoutMs: remaining, ...(o.signal ? { signal: o.signal } : {}) };
        },
      },
      o.baseSha,
      o.changes,
    );
    return { nodeCount: null, edgeCount: null, result };
  }

  async function detectChanges(
    scope: WorkspaceScope,
    o: { baseSha: string; lease: LaunchLease; signal?: AbortSignal; changes?: ImpactChangeSet },
  ): Promise<OperationOutcome & { operationId: Uuid }> {
    if (scope.kind !== 'workspace') {
      throw new OrcError('internal_error', 'detectChanges requires a workspace scope');
    }
    const name = indexName(scope);
    const cache = cacheDir(scope);
    const dir = scopePath(scope);
    if (typeof o.baseSha !== 'string' || !isCommitSha(o.baseSha)) {
      throw new UnsafeArgumentError('detectChanges baseSha must be a commit SHA');
    }
    const changes = o.changes;
    if (changes !== undefined && (typeof changes.headSha !== 'string' || !isCommitSha(changes.headSha))) {
      throw new UnsafeArgumentError('detectChanges headSha must be a commit SHA');
    }
    const operationId = await deps.recorder.start({
      ...ids(scope),
      kind: 'impact_analysis',
      indexName: name,
      mode: null,
    });
    const startedMs = clock.nowMs();
    return runOperation(
      {
        operationId,
        kind: 'impact_analysis',
        indexName: name,
        lease: o.lease,
        signal: o.signal,
        dir,
        cache,
        startedMs,
      },
      async (session, tools) => {
        if (changes !== undefined) {
          return impactFromDiff(session, tools, { project: name, baseSha: o.baseSha, changes, signal: o.signal });
        }
        const args: Record<string, unknown> = { project: name, base_branch: o.baseSha, scope: 'impact' };
        if (supports(tools, 'detect_changes', 'format')) args['format'] = 'json';
        const res = await session.callTool('detect_changes', args, {
          timeoutMs: cfg.detectTimeoutMs,
          ...(o.signal ? { signal: o.signal } : {}),
        });
        if (res.isError) throw toolErrorFrom('detect_changes', res);
        const value = decodeValue(res);
        const counts = extractCounts(value);
        return { nodeCount: counts.nodeCount, edgeCount: counts.edgeCount, result: value };
      },
    );
  }

  async function deleteIndex(
    scope: IndexScope,
    o: { lease?: LaunchLease; signal?: AbortSignal } = {},
  ): Promise<void> {
    const name = indexName(scope);
    const cache = cacheDir(scope);
    const dir = scopePath(scope);
    const operationId = await deps.recorder.start({
      ...ids(scope),
      kind: 'index_delete',
      indexName: name,
      mode: null,
    });
    const startedMs = clock.nowMs();
    const meta = { kind: 'index_delete' as const, indexName: name };
    const elapsed = (): number => Math.max(0, clock.nowMs() - startedMs);

    const cacheExisted = await pathExists(cache);
    let deleteResult: unknown = null;
    let warning: McpError | null = null;
    if (cacheExisted && (await pathExists(dir))) {
      let ownLease: LaunchLease | null = null;
      try {
        await assertRealScopePath(dir);
        await prepareDirs(cache, false);
        let lease = o.lease;
        if (lease === undefined) {
          ownLease = await acquireOpLease(`op-${operationId}`, [dir, cache]);
          lease = ownLease;
        }
        deleteResult = await withSession(
          { cwd: dir, env: serverEnv(dir, cache), lease, signal: o.signal },
          async (session) => {
            const res = await session.callTool('delete_project', { project: name }, {
              timeoutMs: cfg.callTimeoutMs,
              ...(o.signal ? { signal: o.signal } : {}),
            });
            // v0.12.0 answers isError + status not_found for an absent project: already deleted
            if (res.isError && !isNotFoundResult(res)) throw toolErrorFrom('delete_project', res);
            return decodeValue(res);
          },
        );
      } catch (e) {
        warning = toMcpError(e, o.signal);
        logger.warn(
          { source: 'mcp', operationId, indexName: name, err: serializeError(warning) },
          'delete_project failed; removing the cache directory anyway',
        );
      } finally {
        if (ownLease !== null) await releaseLease(ownLease);
      }
    }

    if (o.signal?.aborted === true) {
      const err = warning ?? abortedError();
      await finish(operationId, meta, failedOutcome(err, elapsed()));
      throw err;
    }

    try {
      await rm(cache, RM_OPTIONS);
    } catch (e) {
      const outcome: OperationOutcome = {
        status: 'failed',
        nodeCount: null,
        edgeCount: null,
        result: null,
        errorCode: warning?.code ?? null,
        errorMessage: clipMessage(`Failed to remove the index cache: ${errorText(e)}`),
        durationMs: elapsed(),
      };
      await finish(operationId, meta, outcome);
      throw e;
    }
    if (localMode) await removeLocalRuntimeDir(cache);
    await finish(operationId, meta, {
      status: 'succeeded',
      nodeCount: null,
      edgeCount: null,
      result: capResult(
        {
          cacheRemoved: cacheExisted,
          deleteProject: deleteResult,
          warning: warning === null ? null : { code: warning.code, message: clipMessage(warning.message) },
        },
        cfg.resultMaxBytes,
      ),
      errorCode: null,
      errorMessage: null,
      durationMs: elapsed(),
    });
  }

  function claudeMcpConfig(scope: WorkspaceScope): ClaudeMcpConfigFile {
    if (scope.kind !== 'workspace') {
      throw new OrcError('internal_error', 'claudeMcpConfig requires a workspace scope');
    }
    const dir = scopePath(scope);
    return {
      mcpServers: {
        'codebase-memory-mcp': {
          type: 'stdio',
          command: cfg.bin,
          args: [...cfg.binPrefixArgs],
          env: cbmEnv(dir, cacheDir(scope)),
        },
      },
    };
  }

  return { probe, index, detectChanges, deleteIndex, claudeMcpConfig, indexName, cacheDir };
}
