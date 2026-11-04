// @orc/project-manager public API (contract §2.10).
export {
  createProjectService,
  projectIndexName,
  redactOperation,
  toProject,
} from './project-service.js';
export type {
  ProjectService,
  ProjectServiceConfig,
  ProjectServiceDeps,
} from './project-service.js';
export { createAgentService, createTeamService, toAgent, toTeam } from './catalog-service.js';
export type { AgentService, TeamService } from './catalog-service.js';
