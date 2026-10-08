import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import type { AuthUser } from './security.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (msg: string) => new HttpError(400, 'bad_request', msg);
export const unauthorized = () => new HttpError(401, 'unauthorized', 'Sign in required');
export const forbidden = (what: string) => new HttpError(403, 'forbidden', `Not allowed: ${what}`);
export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);
export const invalid = (msg: string) => new HttpError(422, 'validation_failed', msg);

export class JsonResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  constructor(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new JsonResponse(status, body, headers);

export class RawResponse {
  readonly contentType: string;
  readonly body: Buffer | string;
  readonly headers: Record<string, string>;
  readonly status: number;
  constructor(contentType: string, body: Buffer | string, headers: Record<string, string> = {}, status = 200) {
    this.contentType = contentType;
    this.body = body;
    this.headers = headers;
    this.status = status;
  }
}

export interface Ctx {
  method: string;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  user: AuthUser | null;
  req: IncomingMessage;
  ip: string;
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
  auth: boolean;
}

export class Router {
  private routes: Route[] = [];

  private add(method: string, path: string, handler: Handler, auth: boolean) {
    const keys: string[] = [];
    const pattern = path.replace(/:([a-zA-Z]+)/g, (_m, key: string) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.routes.push({ method, regex: new RegExp(`^${pattern}$`), keys, handler, auth });
  }

  get(path: string, handler: Handler, auth = true) {
    this.add('GET', path, handler, auth);
  }
  post(path: string, handler: Handler, auth = true) {
    this.add('POST', path, handler, auth);
  }
  put(path: string, handler: Handler, auth = true) {
    this.add('PUT', path, handler, auth);
  }
  patch(path: string, handler: Handler, auth = true) {
    this.add('PATCH', path, handler, auth);
  }

  find(method: string, pathname: string) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]!);
      });
      return { route, params };
    }
    return pathMatched ? 'method_not_allowed' : null;
  }
}

export function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > config.maxBodyBytes) {
        reject(new HttpError(413, 'payload_too_large', 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(badRequest('Body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

export function sendRaw(res: ServerResponse, raw: RawResponse): void {
  res.writeHead(raw.status, {
    'Content-Type': raw.contentType,
    'Cache-Control': 'no-store',
    ...raw.headers,
  });
  res.end(raw.body);
}

// ---- Input validation helpers. They throw HttpError(422) so the client gets a clear message.

type Body = Record<string, any>;

function field(body: Body, key: string): unknown {
  return body == null ? undefined : body[key];
}

export function str(body: Body, key: string, opts: { max?: number; min?: number; required?: boolean } = {}): string {
  const { max = 255, min = 1, required = true } = opts;
  const v = field(body, key);
  if (v === undefined || v === null || v === '') {
    if (required) throw invalid(`${key} is required`);
    return '';
  }
  if (typeof v !== 'string') throw invalid(`${key} must be text`);
  const t = v.trim();
  if (t.length < min) throw invalid(`${key} is too short`);
  if (t.length > max) throw invalid(`${key} is too long (max ${max})`);
  return t;
}

export function optStr(body: Body, key: string, max = 255): string | null {
  const t = str(body, key, { max, min: 0, required: false });
  return t === '' ? null : t;
}

export function num(body: Body, key: string, opts: { min?: number; max?: number; required?: boolean } = {}): number {
  const { min = -Infinity, max = Infinity, required = true } = opts;
  const v = field(body, key);
  if (v === undefined || v === null || v === '') {
    if (required) throw invalid(`${key} is required`);
    return 0;
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw invalid(`${key} must be a number`);
  if (n < min || n > max) throw invalid(`${key} must be between ${min} and ${max}`);
  return n;
}

export function int(body: Body, key: string, opts: { min?: number; max?: number; required?: boolean } = {}): number {
  const n = num(body, key, opts);
  if (!Number.isInteger(n)) throw invalid(`${key} must be a whole number`);
  return n;
}

export function bool(body: Body, key: string): boolean {
  return field(body, key) === true;
}

export function oneOf<T extends string>(body: Body, key: string, allowed: readonly T[], required = true): T {
  const v = field(body, key);
  if (v === undefined || v === null || v === '') {
    if (required) throw invalid(`${key} is required`);
    return allowed[0]!;
  }
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw invalid(`${key} must be one of: ${allowed.join(', ')}`);
  }
  return v as T;
}

export function arr(body: Body, key: string, max = 200): unknown[] {
  const v = field(body, key);
  if (!Array.isArray(v) || v.length === 0) throw invalid(`${key} must be a non-empty list`);
  if (v.length > max) throw invalid(`${key} has too many items (max ${max})`);
  return v;
}

export function intParam(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${name} must be a positive integer`);
  return n;
}

export function intQuery(q: URLSearchParams, key: string): number | undefined {
  const v = q.get(key);
  if (v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw badRequest(`${key} must be an integer`);
  return n;
}
