import type { DatabaseSync } from 'node:sqlite';
import { verifyPassword } from '../security.ts';
import { loadUser, type AuthUser, type Permission } from '../security.ts';
import { conflict, forbidden, badRequest } from '../http.ts';

// Four-eyes check for high-risk actions. The approver must be a different, active user
// who holds the permission and re-enters their own password. Nothing is stored about the password.
export function verifyApprover(
  db: DatabaseSync,
  requester: AuthUser,
  creds: { username?: unknown; password?: unknown } | undefined,
  perm: Permission,
): AuthUser {
  if (!creds || typeof creds.username !== 'string' || typeof creds.password !== 'string') {
    throw badRequest('An approver username and password are required for this action');
  }
  const row = db
    .prepare('SELECT id, password_hash, locked_until FROM users WHERE username = ? AND is_active = 1')
    .get(creds.username) as { id: number; password_hash: string; locked_until: string | null } | undefined;
  if (row?.locked_until && row.locked_until > new Date().toISOString()) {
    throw forbidden('the approver account is temporarily locked');
  }
  if (!row || !verifyPassword(creds.password, row.password_hash)) {
    if (row) {
      const fails = (db.prepare('SELECT failed_logins FROM users WHERE id = ?').get(row.id) as { failed_logins: number }).failed_logins + 1;
      const lockedUntil = fails >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
      db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(lockedUntil ? 0 : fails, lockedUntil, row.id);
    }
    throw forbidden('approver credentials were not accepted');
  }
  db.prepare('UPDATE users SET failed_logins = 0 WHERE id = ?').run(row.id);
  if (row.id === requester.id) throw conflict('The approver must be a different user from the requester');
  const approver = loadUser(db, row.id);
  if (!approver || !approver.perms.has(perm)) throw forbidden(`approver lacks ${perm}`);
  return approver;
}
