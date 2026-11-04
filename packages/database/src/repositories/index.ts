// Repository factory: one set of repositories per executor (pool autocommit or a pinned transaction).
import type { RepoContext } from '../sql.js';
import type { Repositories } from '../types.js';
import { createAuditLogRepository, createWorkerNodeRepository } from './audit.js';
import { createAgentRepository, createProjectRepository, createTeamRepository } from './catalog.js';
import { createClaudeSessionRepository } from './claude-sessions.js';
import {
  createApiTokenRepository,
  createAuthSessionRepository,
  createIdempotencyRepository,
  createUserRepository,
} from './identity.js';
import { createTaskEventRepository, createTaskLogRepository } from './logs.js';
import { createGitOperationRepository, createMcpIndexOperationRepository } from './operations.js';
import { createTaskStateStore } from './task-state.js';
import { createAttemptRepository, createTaskRepository } from './tasks.js';
import { createTestRunRepository } from './test-runs.js';
import {
  createAttemptPatchRepository,
  createChangedFileRepository,
  createWorkspaceRepository,
} from './workspaces.js';

export function createRepositories(ctx: RepoContext): Repositories {
  return {
    users: createUserRepository(ctx),
    authSessions: createAuthSessionRepository(ctx),
    apiTokens: createApiTokenRepository(ctx),
    idempotency: createIdempotencyRepository(ctx),
    projects: createProjectRepository(ctx),
    agents: createAgentRepository(ctx),
    teams: createTeamRepository(ctx),
    tasks: createTaskRepository(ctx),
    attempts: createAttemptRepository(ctx),
    taskState: createTaskStateStore(ctx),
    taskLogs: createTaskLogRepository(ctx),
    taskEvents: createTaskEventRepository(ctx),
    claudeSessions: createClaudeSessionRepository(ctx),
    workspaces: createWorkspaceRepository(ctx),
    changedFiles: createChangedFileRepository(ctx),
    patches: createAttemptPatchRepository(ctx),
    testRuns: createTestRunRepository(ctx),
    gitOperations: createGitOperationRepository(ctx),
    mcpOperations: createMcpIndexOperationRepository(ctx),
    audit: createAuditLogRepository(ctx),
    workerNodes: createWorkerNodeRepository(ctx),
  };
}
