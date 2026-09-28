// Contract-driven request/response validation (CR-007): Ajv 2020-12 against the bundled OpenAPI 3.1 spec of the
// service (contracts/generated/openapi/<service>.json). Validators are compiled lazily per operation and cached.
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { FieldError } from './errors.js';

// ajv-formats is CommonJS; under NodeNext its default export is the module object.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

type Json = Record<string, unknown>;
export interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
  components?: Json;
  security?: Record<string, string[]>[];
}

interface ParamDef {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  schemaPointer: string;
  isArray: boolean;
}

export interface Operation {
  operationId: string;
  method: string;
  /** OpenAPI path template, e.g. /v1/offers/{idOrCode} */
  path: string;
  /** Hono route, e.g. /v1/offers/:idOrCode */
  honoPath: string;
  params: ParamDef[];
  body?: { required: boolean; mediaTypes: string[]; pointerByMediaType: Record<string, string> };
  responses: Record<string, string | undefined>;
  /** Effective security requirements (operation-level, else document-level). [] = no auth. */
  security: Record<string, string[]>[];
  raw: Json;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const esc = (s: string) => s.replaceAll('~', '~0').replaceAll('/', '~1');
const SPEC_ID = 'spec';

/**
 * `pattern` compiler that also accepts a leading inline-flag group such as `(?i)` (used by contracts, e.g. intake
 * UploadCreate.fileName). JavaScript RegExp has no global inline flags, so `(?i)abc` becomes `/abc/i`. Other
 * patterns compile exactly as before (`new RegExp(pattern, 'u')`).
 */
export const patternRegExp = Object.assign(
  (pattern: string, flags: string): RegExp => {
    const m = /^\(\?([imsu]+)\)/.exec(pattern);
    if (!m) return new RegExp(pattern, flags);
    const extra = [...new Set(m[1])].filter((f) => !flags.includes(f)).join('');
    return new RegExp(pattern.slice(m[0].length), flags + extra);
  },
  { code: 'new RegExp' },
);

export class Contract {
  readonly operations = new Map<string, Operation>();
  readonly #doc: OpenApiDoc;
  readonly #bodyAjv: Ajv2020;
  readonly #paramAjv: Ajv2020;
  readonly #cache = new Map<string, ValidateFunction>();

  constructor(doc: OpenApiDoc) {
    this.#doc = doc;
    const opts = {
      strict: false,
      allErrors: true,
      validateSchema: false,
      code: { regExp: patternRegExp },
    } as const;
    this.#bodyAjv = addFormats(new Ajv2020(opts));
    this.#paramAjv = addFormats(new Ajv2020({ ...opts, coerceTypes: 'array', useDefaults: true }));
    this.#bodyAjv.addSchema(doc as object, SPEC_ID);
    this.#paramAjv.addSchema(doc as object, SPEC_ID);
    this.#index();
  }

  #resolve(node: unknown, pointer: string): { value: Json; pointer: string } {
    let value = node as Json;
    let at = pointer;
    for (let hops = 0; typeof value?.['$ref'] === 'string' && hops < 10; hops++) {
      const ref = value['$ref'] as string;
      if (!ref.startsWith('#/')) throw new Error(`external $ref not supported: ${ref}`);
      at = ref.slice(1);
      value = ref
        .slice(2)
        .split('/')
        .map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'))
        .reduce<unknown>((o, k) => (o as Json | undefined)?.[k], this.#doc) as Json;
    }
    return { value, pointer: at };
  }

  #index() {
    for (const [path, item] of Object.entries(this.#doc.paths)) {
      const itemPtr = `/paths/${esc(path)}`;
      const shared = (item['parameters'] as unknown[] | undefined) ?? [];
      for (const method of METHODS) {
        const op = item[method] as Json | undefined;
        if (!op) continue;
        const opPtr = `${itemPtr}/${method}`;
        const params = new Map<string, ParamDef>();
        const addParams = (list: unknown[], basePtr: string) =>
          list.forEach((p, i) => {
            const { value, pointer } = this.#resolve(p, `${basePtr}/${i}`);
            const schema = this.#resolve(value['schema'], `${pointer}/schema`);
            params.set(`${value['in']}:${value['name']}`, {
              name: value['name'] as string,
              in: value['in'] as ParamDef['in'],
              required: value['required'] === true,
              schemaPointer: `${pointer}/schema`,
              isArray: schema.value?.['type'] === 'array',
            });
          });
        addParams(shared, `${itemPtr}/parameters`);
        addParams((op['parameters'] as unknown[] | undefined) ?? [], `${opPtr}/parameters`);

        let body: Operation['body'];
        if (op['requestBody']) {
          const rb = this.#resolve(op['requestBody'], `${opPtr}/requestBody`);
          const content = (rb.value['content'] as Json | undefined) ?? {};
          const pointerByMediaType: Record<string, string> = {};
          for (const mt of Object.keys(content))
            pointerByMediaType[mt] = `${rb.pointer}/content/${esc(mt)}/schema`;
          body = {
            required: rb.value['required'] === true,
            mediaTypes: Object.keys(content),
            pointerByMediaType,
          };
        }

        const responses: Record<string, string | undefined> = {};
        for (const [status, r] of Object.entries((op['responses'] as Json | undefined) ?? {})) {
          const res = this.#resolve(r, `${opPtr}/responses/${esc(status)}`);
          const json = (res.value['content'] as Json | undefined)?.['application/json'] as Json | undefined;
          responses[status] = json?.['schema']
            ? `${res.pointer}/content/application~1json/schema`
            : undefined;
        }

        const operationId = op['operationId'] as string;
        const operation: Operation = {
          operationId,
          method: method.toUpperCase(),
          path,
          honoPath: path.replace(/\{([^}]+)\}/g, ':$1'),
          params: [...params.values()],
          responses,
          security: (op['security'] as Record<string, string[]>[] | undefined) ?? this.#doc.security ?? [],
          raw: op,
        };
        if (body) operation.body = body;
        this.operations.set(operationId, operation);
      }
    }
  }

  operation(operationId: string): Operation {
    const op = this.operations.get(operationId);
    if (!op) throw new Error(`operation ${operationId} is not in the contract`);
    return op;
  }

  #compile(key: string, ajv: Ajv2020, schema: object): ValidateFunction {
    let v = this.#cache.get(key);
    if (!v) {
      v = ajv.compile(schema);
      this.#cache.set(key, v);
    }
    return v;
  }

  /** Validates (and coerces, with defaults) one parameter location. Returns the typed values or field errors. */
  validateParams(
    op: Operation,
    location: 'path' | 'query' | 'header',
    input: Record<string, string | string[] | undefined>,
  ): { value: Json; errors: FieldError[] } {
    const defs = op.params.filter((p) => p.in === location);
    const value: Json = {};
    for (const d of defs) {
      const raw = input[location === 'header' ? d.name.toLowerCase() : d.name];
      if (raw === undefined) continue;
      value[d.name] = d.isArray ? (Array.isArray(raw) ? raw : [raw]) : Array.isArray(raw) ? raw[0] : raw;
    }
    const errors: FieldError[] = [];
    if (location === 'query') {
      const known = new Set(defs.map((d) => d.name));
      for (const k of Object.keys(input))
        if (!known.has(k)) errors.push({ field: k, code: 'unknown-parameter' });
    }
    const schema = {
      type: 'object',
      properties: Object.fromEntries(defs.map((d) => [d.name, { $ref: `${SPEC_ID}#${d.schemaPointer}` }])),
      required: defs.filter((d) => d.required).map((d) => d.name),
    };
    const validate = this.#compile(`${op.operationId}:${location}`, this.#paramAjv, schema);
    if (!validate(value)) errors.push(...toFieldErrors(validate.errors, ''));
    return { value, errors };
  }

  validateBody(op: Operation, mediaType: string, body: unknown): FieldError[] {
    const pointer = op.body?.pointerByMediaType[mediaType];
    if (!pointer) return [];
    const validate = this.#compile(`${op.operationId}:body:${mediaType}`, this.#bodyAjv, {
      $ref: `${SPEC_ID}#${pointer}`,
    });
    return validate(body) ? [] : toFieldErrors(validate.errors, 'body');
  }

  /** For contract tests: validates a JSON response body against the declared response. */
  validateResponse(op: Operation, status: number, body: unknown): FieldError[] {
    const key = String(status);
    if (!(key in op.responses) && !('default' in op.responses)) {
      return [
        {
          field: 'status',
          code: 'undeclared-status',
          message: `${status} is not declared for ${op.operationId}`,
        },
      ];
    }
    const pointer = op.responses[key] ?? op.responses['default'];
    if (!pointer) return [];
    const validate = this.#compile(`${op.operationId}:res:${key}`, this.#bodyAjv, {
      $ref: `${SPEC_ID}#${pointer}`,
    });
    return validate(body) ? [] : toFieldErrors(validate.errors, 'response');
  }
}

function toFieldErrors(errors: ErrorObject[] | null | undefined, prefix: string): FieldError[] {
  return (errors ?? [])
    .filter((e) => !['if', 'anyOf', 'oneOf', 'allOf'].includes(e.keyword) || (errors?.length ?? 0) === 1)
    .map((e) => {
      const path = e.instancePath
        .split('/')
        .filter(Boolean)
        .map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'));
      const missing =
        e.keyword === 'required' ? (e.params as { missingProperty?: string }).missingProperty : undefined;
      if (missing) path.push(missing);
      const extra =
        e.keyword === 'additionalProperties'
          ? (e.params as { additionalProperty?: string }).additionalProperty
          : undefined;
      if (extra) path.push(extra);
      const field = [prefix, ...path].filter(Boolean).join('.') || prefix || '(root)';
      const err: FieldError = { field, code: e.keyword };
      if (e.message) err.message = e.message;
      return err;
    });
}
