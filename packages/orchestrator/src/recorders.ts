// Database-backed recorders for git-manager and mcp-manager (contract §11.7, §12.5).
import type { Uuid } from '@orc/shared';
import type { Database } from '@orc/database';
import type { GitOperationRecorder } from '@orc/git-manager';
import type { McpOperationRecorder } from '@orc/mcp-manager';
import type { Logger } from '@orc/logger';
import { serializeError } from '@orc/logger';

/** GitOperations rows; failures are logged, never thrown (§11.7). */
export function createDbGitOperationRecorder(db: Database, logger: Logger): GitOperationRecorder {
  return {
    async record(op) {
      try {
        await db.repos.gitOperations.insert(op);
      } catch (err) {
        logger.warn({ err: serializeError(err), operation: op.operation }, 'git operation record failed');
      }
    },
  };
}

export interface DbMcpOperationRecorder extends McpOperationRecorder {
  /** HEAD recorded into `ResultJson.headSha` of the next succeeded project_index of this project (§12.5). */
  setProjectHead(projectId: Uuid, headSha: string): void;
}

/** McpIndexOperations rows: insert `running` (or adopt an existing queued/running row) and finish. */
export function createDbMcpOperationRecorder(
  db: Database,
  o: { workerId: string; logger: Logger },
): DbMcpOperationRecorder {
  const heads = new Map<Uuid, string>();
  const projectOps = new Map<Uuid, Uuid>();
  return {
    setProjectHead(projectId, headSha) {
      heads.set(projectId, headSha);
    },
    async start(s) {
      if (s.kind === 'project_index') {
        if (s.existingOperationId !== undefined) {
          projectOps.set(s.existingOperationId, s.projectId);
          return s.existingOperationId;
        }
      } else if (s.existingOperationId !== undefined) {
        return s.existingOperationId;
      }
      const row = await db.repos.mcpOperations.insert({
        projectId: s.projectId,
        taskId: s.taskId,
        attemptId: s.attemptId,
        workspaceId: s.workspaceId,
        kind: s.kind,
        indexName: s.indexName,
        mode: s.mode,
        status: 'running',
        requestedByUserId: null,
        workerId: o.workerId,
      });
      if (s.kind === 'project_index') projectOps.set(row.id, s.projectId);
      return row.id;
    },
    async finish(id, outcome) {
      let result: unknown = outcome.result;
      const projectId = projectOps.get(id);
      if (projectId !== undefined) {
        projectOps.delete(id);
        const head = heads.get(projectId);
        if (head !== undefined && outcome.status === 'succeeded') {
          result =
            typeof result === 'object' && result !== null && !Array.isArray(result)
              ? { ...(result as Record<string, unknown>), headSha: head }
              : { value: result, headSha: head };
        }
      }
      await db.repos.mcpOperations.finish(id, {
        status: outcome.status,
        nodeCount: outcome.nodeCount,
        edgeCount: outcome.edgeCount,
        result,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
        durationMs: outcome.durationMs,
      });
    },
  };
}
