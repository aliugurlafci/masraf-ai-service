// Shared types of the API app (contract §9, §14.7, §15).
import type { RateLimiterRes } from 'rate-limiter-flexible';
import type { Clock, Permission, RateLimitClass, Role, Uuid } from '@orc/shared';
import type { ApiConfig } from '@orc/shared/node';
import type { Database, UserRecord } from '@orc/database';
import type { Logger } from '@orc/logger';
import type {
  QueueRegistry,
  RedisFactory,
  RequestContext,
  TaskService,
  Viewer,
} from '@orc/task-manager';
import type { AgentService, ProjectService, TeamService } from '@orc/project-manager';
import type { SseHub } from './sse/hub.js';

/** An ioredis connection as handed out by the task-manager RedisFactory (the API never imports ioredis). */
export type RedisClient = ReturnType<RedisFactory['create']>;

export interface RateLimitRule {
  points: number;
  durationSeconds: number;
}

/** Process-wide mutable state shared by createApp and main.ts (readiness, live SSE connections). */
export interface ApiRuntime {
  ready: boolean;
  readonly startedAtMs: number;
  readonly sse: SseHub;
}

export interface AppDeps {
  config: ApiConfig;
  logger: Logger;
  db: Database;
  redis: RedisFactory;
  /** Shared command connection: rate limiter, SSE connection ZSET, readiness ping. */
  commandRedis: RedisClient;
  queues: QueueRegistry;
  tasks: TaskService;
  projects: ProjectService;
  agents: AgentService;
  teams: TeamService;
  runtime: ApiRuntime;
  clock?: Clock;
  /** Overrides of the §9.6 rate-limit class rules (tests); `login` comes from LOGIN_IP_MAX/LOGIN_IP_WINDOW_SECONDS. */
  rateLimits?: Partial<Record<RateLimitClass, RateLimitRule>>;
  /** Bound of one Redis command issued by an SSE connection (default REDIS_OP_TIMEOUT_MS). */
  sseRedisTimeoutMs?: number;
}

export type AuthMethod = 'session' | 'token';

/** How the request authenticated; the credential hash is kept for the SSE re-validation (§8.3 step 7). */
export type Credential =
  | { kind: 'session'; sessionId: Uuid; tokenHash: Buffer; csrfToken: string; expiresAt: Date }
  | { kind: 'token'; tokenId: Uuid; tokenHash: Buffer; readOnly: boolean };

export interface AuthenticatedState {
  kind: 'authenticated';
  user: UserRecord;
  role: Role;
  permissions: ReadonlySet<Permission>;
  credential: Credential;
  viewer: Viewer;
}

export interface AnonymousState {
  kind: 'anonymous';
  /**
   * Set when a credential was presented but did not resolve (401 code if the route needs auth), or when the client
   * IP exhausted its `auth` budget and the credential was not looked up (429 if the route needs auth).
   */
  failure: 'unauthenticated' | 'session_expired' | 'rate_limited' | null;
}

/** Per-IP `auth` budget bookkeeping of one request (rate-limit.ts AuthFailureThrottle). */
export interface AuthThrottleState {
  /** The request already counted one failure (a failed credential lookup). */
  counted: boolean;
  /** Set when the budget is exhausted (429 rate_limited on routes that need auth). */
  limited: RateLimiterRes | null;
}

export type AuthState = AuthenticatedState | AnonymousState;

/** Per-request state kept in `res.locals.orc`. */
export interface RequestState {
  requestId: string;
  correlationId: string;
  cookies: Record<string, string | undefined>;
  auth: AuthState;
  authThrottle?: AuthThrottleState;
  /** True while the response is an event stream (the error handler then writes an SSE `error` event). */
  eventStream: boolean;
}

export type { RequestContext, Viewer };
