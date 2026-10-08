import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { forbidden } from './http.ts';

export const ROLES = [
  'admin',
  'branch_manager',
  'pathologist',
  'technician',
  'reception',
  'collector',
  'cashier',
  'inventory',
  'qa_auditor',
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'patients.read',
  'patients.write',
  'catalog.read',
  'catalog.write',
  'catalog.approve_ranges',
  'orders.write',
  'specimens.write',
  'results.enter',
  'results.review',
  'results.authorize',
  'results.amend',
  'reports.read',
  'reports.template',
  'reports.send',
  'billing.read',
  'billing.write',
  'billing.discount_override',
  'billing.approve_refund',
  'billing.close',
  'inventory.read',
  'inventory.write',
  'inventory.adjust_approve',
  'notifications.read',
  'notifications.write',
  'admin.users',
  'admin.branches',
  'admin.audit',
  'ops.backup',
  'dashboard.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: ALL,
  branch_manager: [
    'patients.read', 'patients.write', 'catalog.read', 'orders.write', 'specimens.write',
    'results.review', 'reports.read', 'reports.template', 'reports.send',
    'billing.read', 'billing.write', 'billing.discount_override', 'billing.approve_refund', 'billing.close',
    'inventory.read', 'inventory.write', 'inventory.adjust_approve',
    'notifications.read', 'notifications.write', 'admin.audit', 'dashboard.read',
  ],
  pathologist: [
    'patients.read', 'catalog.read', 'catalog.approve_ranges', 'results.enter', 'results.review',
    'results.authorize', 'results.amend', 'reports.read', 'reports.template', 'reports.send',
    'notifications.read', 'dashboard.read',
  ],
  technician: [
    'patients.read', 'catalog.read', 'specimens.write', 'results.enter', 'results.review',
    'reports.read', 'dashboard.read',
  ],
  reception: [
    'patients.read', 'patients.write', 'orders.write', 'reports.read', 'reports.send',
    'billing.read', 'billing.write', 'notifications.read', 'notifications.write', 'dashboard.read',
  ],
  collector: ['patients.read', 'orders.write', 'specimens.write', 'dashboard.read'],
  cashier: ['patients.read', 'billing.read', 'billing.write', 'billing.close', 'dashboard.read'],
  inventory: ['inventory.read', 'inventory.write', 'dashboard.read'],
  qa_auditor: [
    'patients.read', 'catalog.read', 'reports.read', 'billing.read', 'inventory.read',
    'admin.audit', 'notifications.read', 'dashboard.read',
  ],
};

export interface AuthUser {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  branchIds: number[] | 'all';
  perms: ReadonlySet<Permission>;
}

// ---- Passwords (scrypt, built in). Stored as scrypt$N$r$p$salt$hash.

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'Password must contain letters and digits';
  return null;
}

// ---- Sessions. Only a SHA-256 of the token is stored.

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function createSession(db: DatabaseSync, userId: number): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)').run(hashToken(token), userId);
  return token;
}

export function destroySession(db: DatabaseSync, req: IncomingMessage): void {
  const token = readCookie(req, config.sessionCookie);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

export function sessionCookie(token: string): string {
  // Browser-session cookie; the server enforces the idle timeout on every request.
  return `${config.sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${config.sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function authenticate(db: DatabaseSync, req: IncomingMessage): AuthUser | null {
  const token = readCookie(req, config.sessionCookie);
  if (!token) return null;
  const idleLimit = new Date(Date.now() - config.sessionIdleMinutes * 60_000).toISOString();
  const session = db
    .prepare('SELECT user_id, last_seen FROM sessions WHERE token_hash = ?')
    .get(hashToken(token)) as { user_id: number; last_seen: string } | undefined;
  if (!session) return null;
  if (session.last_seen < idleLimit) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  db.prepare("UPDATE sessions SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ?").run(
    hashToken(token),
  );
  return loadUser(db, session.user_id);
}

export function loadUser(db: DatabaseSync, userId: number): AuthUser | null {
  const row = db
    .prepare('SELECT id, username, full_name, role, is_active FROM users WHERE id = ?')
    .get(userId) as { id: number; username: string; full_name: string; role: Role; is_active: number } | undefined;
  if (!row || row.is_active !== 1) return null;
  const role = row.role as Role;
  const branchIds: number[] | 'all' =
    role === 'admin' || role === 'qa_auditor'
      ? 'all'
      : (db.prepare('SELECT branch_id FROM user_branches WHERE user_id = ?').all(userId) as Array<{ branch_id: number }>).map(
          (r) => r.branch_id,
        );
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    role,
    branchIds,
    perms: new Set(ROLE_PERMISSIONS[role] ?? []),
  };
}

export function can(user: AuthUser, perm: Permission): boolean {
  return user.perms.has(perm);
}

export function requirePerm(user: AuthUser, perm: Permission): void {
  if (!user.perms.has(perm)) throw forbidden(perm);
}

export function assertBranch(user: AuthUser, branchId: number): void {
  if (user.branchIds === 'all') return;
  if (!user.branchIds.includes(branchId)) throw forbidden('this branch');
}

export function visibleBranches(user: AuthUser): number[] | 'all' {
  return user.branchIds;
}

// Resolve the branch a request works on: explicit branch_id if allowed, else the user's first branch.
export function activeBranch(user: AuthUser, requested: number | undefined, fallback: number): number {
  const branch = requested ?? fallback;
  assertBranch(user, branch);
  return branch;
}
