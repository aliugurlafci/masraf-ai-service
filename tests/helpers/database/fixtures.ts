// Row factories for database integration tests. Every row created here is removed by resetDb().
import { randomBytes, randomUUID } from 'node:crypto';
import type { Actor, AgentRecord, AttemptRecord, Database, NewProject, ProjectRecord, TaskRecord, UserRecord } from '@orc/database';
import type { Role } from '@orc/shared';

export function uniq(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

/** A syntactically valid scrypt hash string (the repositories never verify it). */
export const FAKE_PASSWORD_HASH = `scrypt$16384$8$1$${'A'.repeat(22)}$${'B'.repeat(86)}`;

export async function createUser(db: Database, o: { role?: Role; username?: string } = {}): Promise<UserRecord> {
  return db.repos.users.insert({
    username: o.username ?? uniq('user').toLowerCase(),
    displayName: 'Test User',
    email: null,
    role: o.role ?? 'operator',
    passwordHash: FAKE_PASSWORD_HASH,
  });
}

export function userActor(user: UserRecord): Actor {
  return { type: 'user', userId: user.id, label: user.username };
}

export const WORKER_ID = 'worker-test-1';
export const workerActor: Actor = { type: 'worker', workerId: WORKER_ID };

/** One of the seeded manager agents (never modified by tests). */
export async function seededAgent(db: Database, name = 'Backend Manager'): Promise<AgentRecord> {
  const agent = (await db.repos.agents.list({})).find((a) => a.name === name);
  if (!agent) throw new Error(`seeded agent ${name} missing`);
  return agent;
}

export function newProject(user: UserRecord, agent: AgentRecord | null, o: Partial<NewProject> = {}): NewProject {
  const name = uniq('proj');
  return {
    name,
    description: 'integration test project',
    repoPath: `acme/${name}`,
    testCommand: ['npm', 'test'],
    testTimeoutSeconds: 600,
    junitReportPath: null,
    requireIndex: false,
    autoIndex: true,
    indexMode: 'moderate',
    defaultAgentId: agent?.id ?? null,
    defaultTimeoutSeconds: 3600,
    workspaceMaxBytes: 2_000_000_000,
    createdByUserId: user.id,
    defaultBranch: 'main',
    ...o,
  };
}

/** Inserts a project and marks it `ready` (as the worker sync would). */
export async function createReadyProject(db: Database, user: UserRecord, agent: AgentRecord): Promise<ProjectRecord> {
  const project = await db.repos.projects.insert(newProject(user, agent));
  await db.repos.projects.updateSyncState(project.id, {
    status: 'ready',
    statusDetail: null,
    defaultBranch: 'main',
    headSha: 'a'.repeat(40),
    synced: true,
  });
  const ready = await db.repos.projects.findById(project.id);
  if (!ready) throw new Error('project vanished');
  return ready;
}

export interface TaskWorld {
  user: UserRecord;
  agent: AgentRecord;
  project: ProjectRecord;
}

export async function createTaskWorld(db: Database): Promise<TaskWorld> {
  const user = await createUser(db);
  const agent = await seededAgent(db);
  const project = await createReadyProject(db, user, agent);
  return { user, agent, project };
}

/** createTask through the TaskStateStore (task queued, attempt #1 queued). */
export async function createQueuedTask(
  db: Database,
  w: TaskWorld,
  o: { title?: string; timeoutSeconds?: number; prompt?: string } = {},
): Promise<{ task: TaskRecord; attempt: AttemptRecord }> {
  return db.repos.taskState.createTask({
    task: {
      projectId: w.project.id,
      agentId: w.agent.id,
      createdByUserId: w.user.id,
      title: o.title ?? uniq('task'),
      prompt: o.prompt ?? 'Implement the feature.',
      acceptanceCriteria: null,
      scope: null,
      baseRef: null,
      model: 'sonnet',
      effort: null,
      timeoutSeconds: o.timeoutSeconds ?? 600,
      maxBudgetUsd: null,
      correlationId: randomUUID(),
    },
    actor: userActor(w.user),
    audit: { requestId: uniq('req'), ip: '127.0.0.1', userAgent: 'vitest' },
  });
}
