// createApp(deps): the Express 5 application with the exact §9.1 middleware order. Exported for supertest.
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { requestIds } from './context.js';
import { authenticate, cookieParser, csrfProtection } from './auth.js';
import { buildOpenApiDocument } from './openapi.js';
import type { OpenApiDocument } from './openapi.js';
import { errorHandler, problem, sendProblem } from './problem.js';
import { createRateLimiters } from './rate-limit.js';
import type { RateLimiters } from './rate-limit.js';
import { API_PREFIX, mountRoutes, pathMatcher } from './route.js';
import type { AnyRouteDef } from './route.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { projectRoutes } from './routes/projects.js';
import { systemRoutes } from './routes/system.js';
import { taskRoutes } from './routes/tasks.js';
import { userRoutes } from './routes/users.js';
import { createSseHub } from './sse/hub.js';
import type { ApiRuntime, AppDeps } from './types.js';

const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);
const LOGIN_PATH = `${API_PREFIX}/auth/login`;
const DOCS_PATH = '/api/docs';
const OPENAPI_PATH = '/api/openapi.json';

export function createApiRuntime(): ApiRuntime {
  return { ready: false, startedAtMs: Date.now(), sse: createSseHub() };
}

/** Every /api/v1 route definition (also the source of the OpenAPI document). */
export function routeTable(limiters: RateLimiters): AnyRouteDef[] {
  return [
    ...authRoutes(limiters),
    ...userRoutes(limiters),
    ...projectRoutes(),
    ...taskRoutes(),
    ...catalogRoutes(),
    ...systemRoutes(),
  ];
}

/** POST/PUT/PATCH bodies must be application/json (415); /auth/login always requires it (§9.1, §15.2). */
function requireJsonBody(req: Request, res: Response, next: NextFunction): void {
  if (!BODY_METHODS.has(req.method)) {
    next();
    return;
  }
  const length = req.get('content-length');
  const hasBody = req.get('transfer-encoding') !== undefined || (length !== undefined && length !== '0');
  const isJson = typeof req.is('application/json') === 'string';
  if ((hasBody || req.path === LOGIN_PATH) && !isJson) {
    sendProblem(req, res, problem('unsupported_media_type', 'Content-Type must be application/json'));
    return;
  }
  next();
}

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function notFound(defs: readonly AnyRouteDef[]) {
  const matchers = defs.map((d) => ({ method: d.method.toUpperCase(), re: pathMatcher(d.path) }));
  return (req: Request, res: Response): void => {
    const allowed = new Set(matchers.filter((m) => m.re.test(req.path)).map((m) => m.method));
    if (allowed.size > 0) {
      if (allowed.has('GET')) allowed.add('HEAD');
      res.setHeader('Allow', [...allowed].sort().join(', '));
      sendProblem(req, res, problem('method_not_allowed', `Method ${req.method} not allowed`));
      return;
    }
    sendProblem(req, res, problem('route_not_found', `No route for ${req.method} ${req.path}`));
  };
}

export function createApp(deps: AppDeps): Express {
  const { config } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  const limiters = createRateLimiters(deps);
  const defs = routeTable(limiters);

  app.use(requestIds());
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (_req, res) => {
        const id = res.getHeader('x-request-id');
        return typeof id === 'string' ? id : 'unknown';
      },
      customLogLevel: (_req, res, err) => {
        if (err !== undefined || res.statusCode >= 500) return 'error';
        return res.statusCode >= 400 ? 'warn' : 'info';
      },
      autoLogging: { ignore: (req) => (req.url ?? '').startsWith(`${API_PREFIX}/health/`) },
    }),
  );
  const apiHelmet = helmet({ contentSecurityPolicy: false });
  const docsHelmet = helmet();
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === DOCS_PATH || req.path.startsWith(`${DOCS_PATH}/`)) docsHelmet(req, res, next);
    else apiHelmet(req, res, next);
  });
  app.use(noStore);
  app.use(express.json({ limit: config.jsonBodyLimitBytes, strict: true, type: 'application/json' }));
  app.use(requireJsonBody);
  app.use(cookieParser());
  app.use(authenticate(deps, limiters.authFailures));
  app.use(csrfProtection(deps, limiters));

  const router = express.Router({ caseSensitive: true, strict: false });
  mountRoutes(router, defs, deps, limiters);
  app.use(API_PREFIX, router);

  if (config.openapiEnabled || config.swaggerUiEnabled) {
    const doc: OpenApiDocument = buildOpenApiDocument(defs, {
      version: config.appVersion,
      cookieSecure: config.cookieSecure,
      swaggerUi: config.swaggerUiEnabled,
    });
    const publicLimiter = limiters.middleware('public');
    if (config.openapiEnabled) {
      app.get(OPENAPI_PATH, publicLimiter, (_req: Request, res: Response) => {
        res.status(200).json(doc);
      });
    }
    if (config.swaggerUiEnabled) {
      app.use(
        DOCS_PATH,
        publicLimiter,
        swaggerUi.serveFiles(doc),
        swaggerUi.setup(doc, { customSiteTitle: 'Orchestrator API' }),
      );
    }
  }

  app.use(notFound(defs));
  app.use(errorHandler(deps));
  return app;
}
