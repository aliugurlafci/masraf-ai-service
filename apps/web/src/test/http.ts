// Mocked fetch for web tests: route table + request recording.
import { vi } from 'vitest';

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  search: URLSearchParams;
  headers: Headers;
  body: unknown;
}

type Reply = Response | ((req: RecordedRequest) => Response | Promise<Response>);

interface Route {
  method: string;
  path: string | RegExp;
  reply: Reply;
  once: boolean;
  used: boolean;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function problem(
  status: number,
  code: string,
  title: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `/api/v1/problems/${code}`,
      title,
      status,
      code,
      requestId: 'req-12345678',
      correlationId: 'req-12345678',
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json', ...headers } },
  );
}

export class FetchMock {
  readonly requests: RecordedRequest[] = [];
  readonly #routes: Route[] = [];

  /** Registers a reply; later registrations take precedence, `once` replies are consumed. */
  on(method: string, path: string | RegExp, reply: Reply, options: { once?: boolean } = {}): this {
    this.#routes.unshift({ method, path, reply, once: options.once ?? false, used: false });
    return this;
  }

  once(method: string, path: string | RegExp, reply: Reply): this {
    return this.on(method, path, reply, { once: true });
  }

  calls(method: string, path: string | RegExp): RecordedRequest[] {
    return this.requests.filter(
      (r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path)),
    );
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const req: RecordedRequest = {
      method,
      url,
      path: parsed.pathname,
      search: parsed.searchParams,
      headers,
      body,
    };
    this.requests.push(req);
    const route = this.#routes.find(
      (r) =>
        !(r.once && r.used) &&
        r.method === method &&
        (typeof r.path === 'string' ? r.path === parsed.pathname : r.path.test(parsed.pathname)),
    );
    if (!route) {
      return problem(404, 'route_not_found', `No mock for ${method} ${parsed.pathname}`);
    }
    route.used = true;
    const reply = typeof route.reply === 'function' ? await route.reply(req) : route.reply.clone();
    return reply;
  };
}

export function installFetch(): FetchMock {
  const mock = new FetchMock();
  vi.stubGlobal('fetch', mock.fetch);
  return mock;
}
