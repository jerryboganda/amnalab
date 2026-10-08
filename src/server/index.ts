import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { config } from './config.ts';
import { openDb, schemaVersion } from './db.ts';
import { HttpError, JsonResponse, RawResponse, Router, readBody, sendJson, sendRaw, type Ctx } from './http.ts';
import { authenticate } from './security.ts';
import { ensureDirs } from './services/files.ts';
import { seedCatalogIfEmpty } from './services/seed.ts';
import { processOutbox } from './services/notify.ts';
import { maybeAutoBackup } from './services/backup.ts';
import { registerAuth } from './routes/auth.ts';
import { registerAdmin } from './routes/admin.ts';
import { registerPatients } from './routes/patients.ts';
import { registerCatalog } from './routes/catalog.ts';
import { registerOrders } from './routes/orders.ts';
import { registerResults } from './routes/results.ts';
import { registerReports } from './routes/reports.ts';
import { registerBilling } from './routes/billing.ts';
import { registerInventory } from './routes/inventory.ts';
import { registerNotifications } from './routes/notifications.ts';
import { registerDashboard } from './routes/dashboard.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
};

const db = openDb(config.dbFile);
ensureDirs();
seedCatalogIfEmpty(db);

const router = new Router();
registerAuth(router, db);
registerAdmin(router, db);
registerPatients(router, db);
registerCatalog(router, db);
registerOrders(router, db);
registerResults(router, db);
registerReports(router, db);
registerBilling(router, db);
registerInventory(router, db);
registerNotifications(router, db);
registerDashboard(router, db);

function isSameOrigin(origin: string, host: string | undefined): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, SECURITY_HEADERS).end();
    return;
  }
  const requested = normalize(join(config.clientDir, pathname === '/' ? 'index.html' : decoded));
  if (!requested.startsWith(config.clientDir)) {
    res.writeHead(403, SECURITY_HEADERS).end();
    return;
  }
  try {
    const body = await readFile(requested);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[extname(requested)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    try {
      // Unknown paths fall back to the single-page app shell.
      const shell = await readFile(join(config.clientDir, 'index.html'));
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME['.html']!, 'Cache-Control': 'no-store' });
      res.end(shell);
    } catch {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('The screens are not built yet. Run: npm run build');
    }
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const match = router.find(method, url.pathname);
  if (match === null) return writeJson(res, 404, { error: 'not_found', message: 'Unknown address' });
  if (match === 'method_not_allowed') return writeJson(res, 405, { error: 'method_not_allowed', message: 'Method not allowed' });

  // Cross-site request protection: every state-changing call must carry our custom header from the same origin.
  if (method !== 'GET' && method !== 'HEAD') {
    if (req.headers['x-requested-with'] !== 'lms') {
      return writeJson(res, 403, { error: 'csrf', message: 'Request rejected' });
    }
    const origin = req.headers.origin;
    if (origin && !isSameOrigin(origin, req.headers.host)) {
      return writeJson(res, 403, { error: 'csrf', message: 'Cross-site request rejected' });
    }
  }

  const user = authenticate(db, req);
  if (match.route.auth && !user) {
    return writeJson(res, 401, { error: 'unauthorized', message: 'Sign in required' });
  }

  const body = method === 'GET' || method === 'HEAD' ? {} : await readBody(req);
  const ctx: Ctx = {
    method,
    url,
    params: match.params,
    query: url.searchParams,
    body,
    user,
    req,
    ip: req.socket.remoteAddress ?? '',
  };
  const out = await match.route.handler(ctx);
  if (out instanceof RawResponse) return sendRaw(res, { ...out, headers: { ...SECURITY_HEADERS, ...out.headers } });
  if (out instanceof JsonResponse) return writeJson(res, out.status, out.body, out.headers);
  return writeJson(res, 200, out ?? { ok: true });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/health') {
    return writeJson(res, 200, { status: 'ok', version: config.version, schemaVersion: schemaVersion(db) });
  }
  if (url.pathname.startsWith('/api/')) {
    try {
      return await handleApi(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) {
        return writeJson(res, err.status, { error: err.code, message: err.message });
      }
      // Database constraints are the last line of defence; report them as input problems, not crashes.
      const msg = (err as Error)?.message ?? '';
      if (/FOREIGN KEY constraint failed/i.test(msg)) {
        return writeJson(res, 422, { error: 'validation_failed', message: 'A referenced record does not exist (check the selected item, doctor, category or branch).' });
      }
      if (/UNIQUE constraint failed/i.test(msg)) {
        return writeJson(res, 409, { error: 'conflict', message: 'This record already exists.' });
      }
      if (/CHECK constraint failed/i.test(msg)) {
        return writeJson(res, 422, { error: 'validation_failed', message: 'A value is outside the allowed choices.' });
      }
      console.error(err);
      return writeJson(res, 500, { error: 'internal_error', message: 'Something went wrong. The details are in the server log.' });
    }
  }
  return serveStatic(url.pathname, res);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error(err);
    if (!res.headersSent) writeJson(res, 500, { error: 'internal_error', message: 'Unexpected error' });
  });
});

// Background work: outbox retries every minute, nightly backup, expired-session cleanup.
let outboxBusy = false;
setInterval(() => {
  if (outboxBusy) return;
  outboxBusy = true;
  processOutbox(db)
    .catch((err: unknown) => console.error('Outbox processing failed:', (err as Error).message))
    .finally(() => {
      outboxBusy = false;
    });
  maybeAutoBackup(db);
  db.prepare("DELETE FROM sessions WHERE last_seen < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)").run(
    `-${config.sessionIdleMinutes} minutes`,
  );
}, 60_000).unref();

server.listen(config.port, config.host, () => {
  console.log(`Amna Lab LMS ${config.version} running at http://${config.host}:${config.port}`);
});
