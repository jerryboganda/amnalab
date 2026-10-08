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
  if (!row || !verifyPassword(creds.password, row.password_hash)) {
    throw forbidden('approver credentials were not accepted');
  }
  if (row.id === requester.id) throw conflict('The approver must be a different user from the requester');
  const approver = loadUser(db, row.id);
  if (!approver || !approver.perms.has(perm)) throw forbidden(`approver lacks ${perm}`);
  return approver;
}
