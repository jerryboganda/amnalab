import type { DatabaseSync } from 'node:sqlite';
import type { Router } from '../http.ts';
import { badRequest, conflict, forbidden, invalid, json, str, unauthorized } from '../http.ts';
import {
  authenticate,
  clearSessionCookie,
  createSession,
  destroySession,
  hashPassword,
  loadUser,
  passwordProblem,
  ROLES,
  sessionCookie,
  verifyPassword,
  type AuthUser,
  type Role,
} from '../security.ts';
import { audit } from '../audit.ts';
import { config } from '../config.ts';
import { nowIso } from '../util.ts';

export interface BranchRef {
  id: number;
  name: string;
  code: string;
}

export function branchesFor(db: DatabaseSync, user: AuthUser): BranchRef[] {
  const rows =
    user.branchIds === 'all'
      ? (db.prepare('SELECT id, name, code FROM branches WHERE is_active = 1 ORDER BY code').all() as unknown as BranchRef[])
      : user.branchIds.length === 0
        ? []
        : (db
            .prepare(
              `SELECT id, name, code FROM branches WHERE is_active = 1 AND id IN (${user.branchIds.map(() => '?').join(',')}) ORDER BY code`,
            )
            .all(...user.branchIds) as unknown as BranchRef[]);
  return rows;
}

export function userSummary(db: DatabaseSync, user: AuthUser) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    permissions: [...user.perms],
    branches: branchesFor(db, user),
  };
}

export function registerAuth(r: Router, db: DatabaseSync) {
  r.get('/api/setup/status', () => ({
    needsSetup: (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n === 0,
  }), false);

  // First run only: creates the organization, first branch and the administrator.
  r.post('/api/setup', (ctx) => {
    const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    if (count > 0) throw conflict('Setup is already complete');
    const b = ctx.body;
    const organizationName = str(b, 'organizationName', { max: 120 });
    const branchName = str(b, 'branchName', { max: 120 });
    const branchCode = str(b, 'branchCode', { max: 12 }).toUpperCase();
    const adminName = str(b, 'adminName', { max: 120 });
    const username = str(b, 'username', { max: 40, min: 3 });
    const password = str(b, 'password', { max: 200, min: 1 });
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) throw invalid('Username may use letters, digits, dot, dash and underscore');
    if (!/^[A-Z0-9]+$/.test(branchCode)) throw invalid('Branch code may use letters and digits only');
    const problem = passwordProblem(password);
    if (problem) throw invalid(problem);

    db.exec('BEGIN IMMEDIATE');
    try {
      const org = db.prepare('INSERT INTO organizations (name) VALUES (?) RETURNING id').get(organizationName) as { id: number };
      const branch = db
        .prepare('INSERT INTO branches (organization_id, name, code) VALUES (?, ?, ?) RETURNING id')
        .get(org.id, branchName, branchCode) as { id: number };
      const user = db
        .prepare('INSERT INTO users (username, full_name, role, password_hash) VALUES (?, ?, ?, ?) RETURNING id')
        .get(username, adminName, 'admin', hashPassword(password)) as { id: number };
      db.prepare('INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)').run(user.id, branch.id);
      audit(db, {
        action: 'setup.complete',
        entity: 'organization',
        entityId: org.id,
        after: { organizationName, branchName, branchCode, username },
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return json({ ok: true }, 201);
  }, false);

  r.post('/api/auth/login', (ctx) => {
    const username = str(ctx.body, 'username', { max: 40 });
    const password = str(ctx.body, 'password', { max: 200 });
    const row = db
      .prepare('SELECT id, password_hash, is_active, failed_logins, locked_until FROM users WHERE username = ?')
      .get(username) as
      | { id: number; password_hash: string; is_active: number; failed_logins: number; locked_until: string | null }
      | undefined;

    if (row?.locked_until && row.locked_until > nowIso()) {
      throw forbidden('Account is temporarily locked after failed sign-ins. Try again later or ask an administrator.');
    }
    const ok = row !== undefined && row.is_active === 1 && verifyPassword(password, row.password_hash);
    if (!ok || !row) {
      if (row) {
        const fails = row.failed_logins + 1;
        const lockedUntil = fails >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
        db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(
          lockedUntil ? 0 : fails,
          lockedUntil,
          row.id,
        );
      }
      audit(db, { action: 'auth.login_failed', entity: 'user', entityId: username, source: ctx.ip });
      throw unauthorized();
    }

    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(row.id);
    const token = createSession(db, row.id);
    const user = loadUser(db, row.id)!;
    audit(db, { actor: user, action: 'auth.login', entity: 'user', entityId: user.id, source: ctx.ip });
    const maxAge = config.sessionIdleMinutes * 60;
    return json(userSummary(db, user), 200, { 'Set-Cookie': sessionCookie(token, maxAge) });
  }, false);

  r.post('/api/auth/logout', (ctx) => {
    if (ctx.user) audit(db, { actor: ctx.user, action: 'auth.logout', entity: 'user', entityId: ctx.user.id });
    destroySession(db, ctx.req);
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
  }, false);

  r.get('/api/auth/me', (ctx) => {
    const user = authenticate(db, ctx.req);
    if (!user) throw unauthorized();
    return userSummary(db, user);
  }, false);

  r.post('/api/auth/change-password', (ctx) => {
    const user = ctx.user!;
    const current = str(ctx.body, 'currentPassword', { max: 200 });
    const next = str(ctx.body, 'newPassword', { max: 200 });
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
    if (!verifyPassword(current, row.password_hash)) throw badRequest('Current password is incorrect');
    const problem = passwordProblem(next);
    if (problem) throw invalid(problem);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
    audit(db, { actor: user, action: 'auth.password_changed', entity: 'user', entityId: user.id });
    return { ok: true };
  });
}

export const roleList = (): readonly Role[] => ROLES;
