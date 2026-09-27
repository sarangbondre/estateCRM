// Hono app factory for every service (F-10): correlation ID, RFC 7807 errors, contract validation per operation,
// health endpoints, body limit, and a request-end hook for logs/metrics (libs/observability plugs in there).
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { Contract } from './contract.js';
import type { OpenApiDoc, Operation } from './contract.js';
import { DownstreamError } from './client.js';
import { HttpError, badRequest, problemResponse } from './errors.js';

export interface ServiceVariables {
  correlationId: string;
  /** Set by libs/auth. */
  principal: unknown;
  operation: Operation | undefined;
}
export type ServiceEnv = { Variables: ServiceVariables };
export type ServiceContext = Context<ServiceEnv>;

export interface RequestEndInfo {
  method: string;
  route: string;
  operationId: string | undefined;
  status: number;
  durationMs: number;
  correlationId: string;
}

export interface ReadyCheck {
  ok: boolean;
  checks?: Record<string, string>;
}

export interface ServiceOptions {
  service: string;
  /** contracts/generated/openapi/<service>.json */
  spec: OpenApiDoc;
  ready: () => Promise<ReadyCheck>;
  /** Default 1 MiB (uploads go straight to storage via signed URLs). */
  maxBodyBytes?: number;
  /** Validate every JSON response against the contract (contract tests). Default: NODE_ENV === 'test'. */
  validateResponses?: boolean;
  onRequestEnd?: (info: RequestEndInfo) => void;
  /** Unexpected errors (500). The lib never logs. */
  onError?: (err: unknown, c: ServiceContext) => void;
}

/** Validated request parts, typed from the contract's generated `operations`. */
export interface OperationInput<Op> {
  params: Op extends { parameters: { path: infer P } } ? P : Record<string, never>;
  query: Op extends { parameters: { query?: infer Q } } ? NonNullable<Q> : Record<string, never>;
  headers: Op extends { parameters: { header?: infer H } } ? NonNullable<H> : Record<string, never>;
  body: Op extends { requestBody: { content: infer C } }
    ? C[keyof C]
    : Op extends { requestBody?: { content: infer C } }
      ? C[keyof C] | undefined
      : undefined;
}

export type OperationHandler<Op> = (
  c: ServiceContext,
  input: OperationInput<Op>,
) => Promise<Response> | Response;

const CORRELATION = /^[A-Za-z0-9._:-]{1,64}$/;

export function correlationId(): MiddlewareHandler<ServiceEnv> {
  return async (c, next) => {
    const given = c.req.header('x-correlation-id');
    const id = given && CORRELATION.test(given) ? given : randomUUID();
    c.set('correlationId', id);
    await next();
    c.header('x-correlation-id', id);
  };
}

const mediaTypeOf = (c: Context) =>
  (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

export interface Service<Ops> {
  app: Hono<ServiceEnv>;
  contract: Contract;
  /** Registers the handler for a contract operation; method and path come from the spec. */
  op<K extends keyof Ops & string>(
    operationId: K,
    handler: OperationHandler<Ops[K]>,
    ...middleware: MiddlewareHandler<ServiceEnv>[]
  ): void;
  /** Operations in the contract that have no handler yet. */
  unimplemented(): string[];
}

export function createService<Ops>(options: ServiceOptions): Service<Ops> {
  const contract = new Contract(options.spec);
  const app = new Hono<ServiceEnv>();
  const implemented = new Set<string>();
  const maxBody = options.maxBodyBytes ?? 1024 * 1024;
  const validateResponses = options.validateResponses ?? process.env['NODE_ENV'] === 'test';

  app.use('*', correlationId());
  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    options.onRequestEnd?.({
      method: c.req.method,
      route: c.get('operation')?.path ?? c.req.routePath,
      operationId: c.get('operation')?.operationId,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
      correlationId: c.get('correlationId'),
    });
  });

  app.onError((err, c) => {
    const cid = c.get('correlationId') ?? randomUUID();
    if (err instanceof HttpError) return problemResponse(err, cid);
    options.onError?.(err, c);
    if (err instanceof DownstreamError)
      return problemResponse(new HttpError(503, 'dependency-unavailable'), cid);
    return problemResponse(new HttpError(500, 'internal'), cid);
  });
  app.notFound((c) =>
    problemResponse(new HttpError(404, 'not-found'), c.get('correlationId') ?? randomUUID()),
  );

  app.get('/health/live', (c) => c.json({ status: 'ok' }));
  app.get('/health/ready', async (c) => {
    try {
      const r = await options.ready();
      return c.json(
        { status: r.ok ? 'ok' : 'down', ...(r.checks ? { checks: r.checks } : {}) },
        r.ok ? 200 : 503,
      );
    } catch {
      return c.json({ status: 'down' }, 503);
    }
  });

  const op: Service<Ops>['op'] = (operationId, handler, ...middleware) => {
    const operation = contract.operation(operationId);
    implemented.add(operationId);

    const validate: MiddlewareHandler<ServiceEnv> = async (c, next) => {
      c.set('operation', operation);
      await next();
    };

    const run: MiddlewareHandler<ServiceEnv> = async (c) => {
      const errors = [];
      const path = contract.validateParams(operation, 'path', c.req.param() as Record<string, string>);
      const query = contract.validateParams(operation, 'query', c.req.queries() as Record<string, string[]>);
      const headers = contract.validateParams(operation, 'header', c.req.header());
      errors.push(...path.errors, ...query.errors, ...headers.errors);

      let body: unknown;
      if (operation.body) {
        const length = Number(c.req.header('content-length') ?? 0);
        if (length > maxBody) throw new HttpError(413, 'payload-too-large');
        const text = await c.req.text();
        if (text.length > maxBody) throw new HttpError(413, 'payload-too-large');
        if (text.length) {
          const mt = mediaTypeOf(c);
          if (!operation.body.mediaTypes.includes(mt)) {
            throw new HttpError(415, 'unsupported-media-type', {
              detail: `expected ${operation.body.mediaTypes.join(' or ')}`,
            });
          }
          try {
            body = JSON.parse(text);
          } catch {
            throw badRequest([{ field: 'body', code: 'invalid-json' }]);
          }
          errors.push(...contract.validateBody(operation, mt, body));
        } else if (operation.body.required) {
          errors.push({ field: 'body', code: 'required', message: 'request body is required' });
        }
      }
      if (errors.length) throw badRequest(errors);

      const input = {
        params: path.value,
        query: query.value,
        headers: headers.value,
        body,
      } as unknown as OperationInput<Ops[typeof operationId]>;
      const res = await handler(c, input);
      if (validateResponses && (res.headers.get('content-type') ?? '').includes('application/json')) {
        const problems = contract.validateResponse(operation, res.status, await res.clone().json());
        if (problems.length) {
          throw new HttpError(500, 'contract-violation', {
            detail: `${operationId} ${res.status}: ${problems.map((p) => `${p.field} ${p.code}`).join('; ')}`,
          });
        }
      }
      return res;
    };

    app.on(operation.method, operation.honoPath, validate, ...middleware, run);
  };

  return {
    app,
    contract,
    op,
    unimplemented: () => [...contract.operations.keys()].filter((id) => !implemented.has(id)),
  };
}
