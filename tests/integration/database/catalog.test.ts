// Projects, Teams and Agents repositories (§2.5) plus the seeded catalogue (§4.4 seed).
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PreconditionFailedError } from '@orc/shared';
import type { AgentInput, Database } from '@orc/database';
import { runOrcDb } from '../../../packages/database/src/cli/run';
import { SEED_TEAMS, baselineCounts, openDb, openPool, resetDb } from '../../helpers/database/db';
import { silentLogger, testEnv } from '../../helpers/database/env';
import { createUser, newProject, seededAgent, uniq } from '../../helpers/database/fixtures';

class Sink extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
}

describe('catalogue repositories', () => {
  let api: Database;
  let worker: Database;

  beforeAll(async () => {
    api = await openDb('orc_api');
    worker = await openDb('orc_worker');
  });

  afterAll(async () => {
    await api.close();
    await worker.close();
    await resetDb();
  });

  describe('seed', () => {
    it('seeds the 10 teams of CLAUDE.md plus Program Management with their managers', async () => {
      const teams = await api.repos.teams.list();
      const agents = await api.repos.agents.list({});
      const gpm = agents.find((a) => a.name === 'General Project Manager');
      expect(gpm).toMatchObject({ isManager: true, parentAgentId: null, isActive: true, model: 'sonnet' });
      for (const [teamName, managerName] of SEED_TEAMS) {
        const team = teams.find((t) => t.name === teamName);
        const manager = agents.find((a) => a.name === managerName);
        expect(team, teamName).toBeDefined();
        expect(manager, managerName).toBeDefined();
        expect(team?.managerAgentId).toBe(manager?.id);
        expect(manager).toMatchObject({ teamId: team?.id, isManager: true, allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'] });
        expect(manager?.allowedTools.some((t) => t.startsWith('Bash'))).toBe(false);
        if (managerName !== 'General Project Manager') expect(manager?.parentAgentId).toBe(gpm?.id);
      }
      expect(teams.find((t) => t.name === 'MSSQL and Data')?.ownedPaths).toEqual(['packages/database']);
    });

    it('is idempotent and never deletes rows (orc-db seed re-run)', async () => {
      const pool = await openPool('orc_migrator', 1);
      try {
        const before = await baselineCounts(pool);
        const out = new Sink();
        const code = await runOrcDb(['seed'], { env: testEnv(), stdin: Readable.from([]), stdout: out, stderr: new Sink(), overrides: { logger: silentLogger() } });
        expect(code).toBe(0);
        expect(JSON.parse(out.text)).toMatchObject({ command: 'seed', ok: true, teams: 11, agents: 11 });
        expect(await baselineCounts(pool)).toEqual(before);
      } finally {
        await pool.close();
      }
    });
  });

  describe('teams and agents (orc_api)', () => {
    it('inserts, lists and updates with RowVer concurrency', async () => {
      const team = await api.repos.teams.insert({ name: uniq('team'), description: null, managerAgentId: null, ownedPaths: ['apps/x'] });
      expect(team).toMatchObject({ description: null, ownedPaths: ['apps/x'] });
      const input: AgentInput = {
        teamId: team.id,
        parentAgentId: null,
        name: uniq('agent'),
        title: 'Engineer',
        description: 'does things',
        isManager: false,
        model: 'sonnet',
        effort: 'high',
        allowedTools: ['Read', 'Bash(npm test:*)'],
        disallowedTools: ['WebFetch'],
        instructions: 'Be careful.',
        maxTimeoutSeconds: 1800,
        maxBudgetUsd: 2.5,
        isActive: true,
      };
      const agent = await api.repos.agents.insert(input);
      expect(agent).toMatchObject(input);
      expect((await api.repos.agents.list({ teamId: team.id })).map((a) => a.id)).toEqual([agent.id]);

      const updatedTeam = await api.repos.teams.update(team.id, team.rowVer, { managerAgentId: agent.id, description: 'desc' });
      expect(updatedTeam).toMatchObject({ managerAgentId: agent.id, description: 'desc' });
      await expect(api.repos.teams.update(team.id, team.rowVer, { description: 'stale' })).rejects.toBeInstanceOf(PreconditionFailedError);

      const updated = await api.repos.agents.update(agent.id, agent.rowVer, { isActive: false, effort: null, allowedTools: [] });
      expect(updated).toMatchObject({ isActive: false, effort: null, allowedTools: [] });
      await expect(api.repos.agents.update(agent.id, agent.rowVer, { title: 'x' })).rejects.toBeInstanceOf(PreconditionFailedError);
      expect((await api.repos.agents.list({ teamId: team.id, activeOnly: true }))).toEqual([]);
      expect(await api.repos.agents.findById(randomUUID())).toBeNull();
      expect(await api.repos.teams.findById(randomUUID())).toBeNull();
    });

    it('maps unique names and missing references', async () => {
      const name = uniq('team');
      await api.repos.teams.insert({ name, description: null, managerAgentId: null, ownedPaths: [] });
      await expect(api.repos.teams.insert({ name, description: null, managerAgentId: null, ownedPaths: [] })).rejects.toMatchObject({
        code: 'unique_violation',
      });
      const gpm = await seededAgent(api, 'General Project Manager');
      await expect(
        api.repos.agents.insert({ ...gpm, name: uniq('agent'), teamId: randomUUID(), parentAgentId: null }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    it('orc_worker can read the catalogue but not change it', async () => {
      expect((await worker.repos.teams.list()).length).toBeGreaterThanOrEqual(11);
      const team = (await worker.repos.teams.list())[0]!;
      await expect(worker.repos.teams.update(team.id, team.rowVer, { description: 'x' })).rejects.toMatchObject({ code: 'internal_error' });
    });
  });

  describe('projects', () => {
    it('inserts in validating state, lists by status with pagination and finds by id', async () => {
      const user = await createUser(api);
      const agent = await seededAgent(api);
      const created = [];
      for (let i = 0; i < 3; i += 1) created.push(await api.repos.projects.insert(newProject(user, agent)));
      const p = created[0]!;
      expect(p).toMatchObject({ status: 'validating', testCommand: ['npm', 'test'], workspaceMaxBytes: 2_000_000_000, archivedAt: null });
      expect(await api.repos.projects.findById(p.id)).toEqual(p);
      const page = await api.repos.projects.list({ limit: 2, status: 'validating' });
      expect(page).toHaveLength(3);
      const next = await api.repos.projects.list({ limit: 2, status: 'validating', after: { createdAt: page[1]!.createdAt, id: page[1]!.id } });
      expect(next.map((x) => x.id)).not.toContain(page[0]!.id);
      expect(await api.repos.projects.list({ limit: 10, status: 'archived' })).toEqual([]);
      await expect(api.repos.projects.insert({ ...newProject(user, agent), repoPath: p.repoPath })).rejects.toMatchObject({
        code: 'unique_violation',
      });
    });

    it('updates with RowVer, archives and unarchives', async () => {
      const user = await createUser(api);
      const p = await api.repos.projects.insert(newProject(user, null, { testCommand: null }));
      const u1 = await api.repos.projects.update(p.id, p.rowVer, { description: null, testCommand: ['pnpm', 'test'], indexMode: 'fast' });
      expect(u1).toMatchObject({ description: null, testCommand: ['pnpm', 'test'], indexMode: 'fast', name: p.name });
      await expect(api.repos.projects.update(p.id, p.rowVer, { name: 'stale' })).rejects.toBeInstanceOf(PreconditionFailedError);
      const archived = await api.repos.projects.update(p.id, u1.rowVer, { archived: true });
      expect(archived.status).toBe('archived');
      expect(archived.archivedAt).not.toBeNull();
      const restored = await api.repos.projects.update(p.id, archived.rowVer, { archived: false });
      expect(restored).toMatchObject({ status: 'validating', archivedAt: null });
    });

    it('lets orc_worker record sync and index state only through the column grant', async () => {
      const user = await createUser(api);
      const p = await api.repos.projects.insert(newProject(user, null));
      await worker.repos.projects.updateSyncState(p.id, { status: 'ready', statusDetail: null, defaultBranch: 'trunk', headSha: 'b'.repeat(40), synced: true });
      const opId = randomUUID();
      await worker.repos.projects.updateIndexState(p.id, { lastIndexOperationId: opId, indexedAt: true });
      const synced = await worker.repos.projects.findById(p.id);
      expect(synced).toMatchObject({ status: 'ready', defaultBranch: 'trunk', headSha: 'b'.repeat(40), lastIndexOperationId: opId });
      expect(synced?.lastSyncedAt).not.toBeNull();
      expect(synced?.lastIndexedAt).not.toBeNull();
      await expect(worker.repos.projects.update(p.id, synced!.rowVer, { name: 'nope' })).rejects.toMatchObject({ code: 'internal_error' });
    });
  });
});
