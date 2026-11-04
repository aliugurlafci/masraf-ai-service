// OpenAPI 3.1 document generated from the Zod route table (contract §9.5): GET /api/openapi.json, Swagger UI at /api/docs.
import { z } from 'zod';
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import type { ResponseConfig, RouteConfig } from '@asteasolutions/zod-to-openapi';
import { ProblemDetailsSchema } from '@orc/shared';
import { sessionCookieName } from './auth.js';
import { openApiPath } from './route.js';
import type { AnyRouteDef, RequestHeaderDoc, ResponseDoc } from './route.js';

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const PROBLEM_REF = { $ref: '#/components/schemas/ProblemDetails' } as const;

type ComponentSchema = Parameters<OpenAPIRegistry['registerComponent']>[2];

/** ProblemDetails as a JSON Schema 2020-12 component (OpenAPI 3.1 dialect). */
function problemComponent(): ComponentSchema {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(ProblemDetailsSchema);
  return schema;
}

const HEADER_DOCS: Readonly<Record<string, string>> = {
  Location: 'URI of the created resource',
  ETag: 'Strong entity tag of the resource (base64url RowVer)',
  'Retry-After': 'Seconds to wait before retrying',
  'Set-Cookie': 'Session cookie',
  'Idempotent-Replayed': '`true` when the response is a stored replay',
};

function headerSchema(headers: readonly RequestHeaderDoc[]): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const h of headers) {
    const base = z.string().describe(h.description);
    shape[h.name] = h.required ? base : base.optional();
  }
  return z.object(shape);
}

function response(status: number, doc: ResponseDoc): ResponseConfig {
  const out: ResponseConfig = { description: doc.description };
  if (doc.schema !== undefined) {
    out.content = { [doc.contentType ?? 'application/json']: { schema: doc.schema } };
  } else if (status >= 400) {
    out.content = { [PROBLEM_CONTENT_TYPE]: { schema: PROBLEM_REF } };
  }
  if (doc.headers !== undefined && doc.headers.length > 0) {
    out.headers = Object.fromEntries(
      doc.headers.map((name) => [name, { description: HEADER_DOCS[name] ?? name, schema: { type: 'string' } }]),
    );
  }
  return out;
}

function commonErrors(def: AnyRouteDef): Record<number, ResponseDoc> {
  const errors: Record<number, ResponseDoc> = {
    500: { description: 'internal_error' },
    503: { description: 'dependency_unavailable', headers: ['Retry-After'] },
  };
  if (def.params !== undefined || def.query !== undefined || def.body !== undefined) {
    errors[400] = { description: 'validation_failed | invalid_json | invalid_cursor' };
  }
  if (def.auth !== 'public') {
    errors[401] = { description: 'unauthenticated | session_expired' };
    errors[403] = { description: 'forbidden | csrf_failed | token_not_allowed' };
  }
  if (def.rateClass !== null) errors[429] = { description: 'rate_limited', headers: ['Retry-After'] };
  return errors;
}

function security(def: AnyRouteDef): RouteConfig['security'] {
  if (def.auth === 'public') return [];
  if (def.auth === 'session') return [{ sessionCookie: [] }];
  return [{ sessionCookie: [] }, { bearerToken: [] }];
}

export function buildOpenApiDocument(
  defs: readonly AnyRouteDef[],
  o: { version: string; cookieSecure: boolean; swaggerUi: boolean },
): OpenApiDocument {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'sessionCookie', {
    type: 'apiKey',
    in: 'cookie',
    name: sessionCookieName(o.cookieSecure),
    description: 'Session cookie from POST /api/v1/auth/login; unsafe methods also need X-CSRF-Token',
  });
  registry.registerComponent('securitySchemes', 'bearerToken', {
    type: 'http',
    scheme: 'bearer',
    description: 'Personal access token (orc_pat_...); read-only tokens may call only GET',
  });
  registry.registerComponent('schemas', 'ProblemDetails', problemComponent());

  for (const def of defs) {
    const responses: RouteConfig['responses'] = {};
    const docs = { ...commonErrors(def), ...def.responses };
    for (const [status, doc] of Object.entries(docs)) {
      responses[status] = response(Number(status), doc);
    }
    const request: NonNullable<RouteConfig['request']> = {};
    if (def.params !== undefined) request.params = def.params as z.ZodObject;
    if (def.query !== undefined) request.query = def.query as z.ZodObject;
    if (def.body !== undefined) {
      request.body = {
        required: def.bodyOptional !== true,
        content: { 'application/json': { schema: def.body } },
      };
    }
    if (def.headers !== undefined && def.headers.length > 0) request.headers = headerSchema(def.headers);
    registry.registerPath({
      method: def.method,
      path: openApiPath(def.path),
      operationId: def.operationId,
      summary: def.summary,
      tags: [def.tag],
      security: security(def),
      request,
      responses,
    });
  }

  registry.registerPath({
    method: 'get',
    path: '/api/openapi.json',
    operationId: 'getOpenApiDocument',
    summary: 'This OpenAPI 3.1 document',
    tags: ['meta'],
    security: [],
    responses: { 200: { description: 'OpenAPI document', content: { 'application/json': { schema: z.looseObject({}) } } } },
  });
  if (o.swaggerUi) {
    registry.registerPath({
      method: 'get',
      path: '/api/docs',
      operationId: 'getSwaggerUi',
      summary: 'Swagger UI',
      tags: ['meta'],
      security: [],
      responses: { 200: { description: 'Swagger UI', content: { 'text/html': { schema: z.string() } } } },
    });
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Claude Code Orchestrator API',
      version: o.version,
      description: 'HTTP API of the orchestrator (contract §9). Errors are RFC 9457 Problem Details.',
    },
    servers: [{ url: '/' }],
  });
}
