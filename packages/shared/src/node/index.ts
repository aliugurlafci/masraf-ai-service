// @orc/shared/node — node-only helpers (contract §2.2). Never imported by apps/web.

export type {
  Env,
  AppName,
  ApiConfig,
  WorkerConfig,
  EgressProxyConfig,
  DbCliConfig,
  RunnerConfig,
} from './config';
export {
  ConfigError,
  DbNameGuardError,
  readEnvWithFiles,
  loadConfig,
  assertDbNameForEnv,
  SECRET_ENV_KEYS,
  ApiConfigSchema,
  WorkerConfigSchema,
  EgressProxyConfigSchema,
  DbCliConfigSchema,
  RunnerConfigSchema,
  SQL_LOGIN_PASSWORD_REGEX,
  loadApiConfig,
  loadWorkerConfig,
  loadEgressProxyConfig,
  loadDbCliConfig,
  loadRunnerConfig,
  CBM_SOCKET_PATH_MAX_BYTES,
  SANDBOX_UID_MIN,
  cbmSocketPathBytes,
  cbmSocketPathProblem,
} from './config';

export type {
  LaunchKind,
  LaunchLimits,
  LaunchLeaseRequest,
  LeaseMeasurement,
  LaunchLease,
  LaunchSpec,
  LeaseInfo,
  ProcessLauncher,
} from './launcher';

export type {
  SpawnFn,
  HostPlatform,
  RunProcessOptions,
  RunProcessResult,
  SupervisedProcess,
  SpawnSupervisedOptions,
  KillResult,
} from './process';
export {
  runProcess,
  spawnSupervised,
  killProcessTree,
  isProcessAlive,
  isGroupAlive,
  ProcessSpawnError,
  ProcessKillError,
} from './process';

export type { ProcessRegistryEntry, ProcessRegistry, SweepReport } from './registry';
export { createFileProcessRegistry, sweepOrphans } from './registry';
