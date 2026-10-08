import type { DatabaseSync } from 'node:sqlite';
import type { AuthUser } from './security.ts';

export interface AuditEntry {
  actor?: AuthUser | null;
  branchId?: number | null;
  action: string;
  entity: string;
  entityId?: string | number | null;
  before?: unknown;
  after?: unknown;
  source?: string;
}

// Append-only. Never pass passwords, tokens or secrets in before/after.
export function audit(db: DatabaseSync, e: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit_events (actor_user_id, branch_id, action, entity, entity_id, before_json, after_json, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.actor?.id ?? null,
    e.branchId ?? null,
    e.action,
    e.entity,
    e.entityId == null ? null : String(e.entityId),
    e.before === undefined ? null : JSON.stringify(e.before),
    e.after === undefined ? null : JSON.stringify(e.after),
    e.source ?? 'web',
  );
}
