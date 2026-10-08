import type { DatabaseSync } from 'node:sqlite';
import type { Router } from '../http.ts';
import { intParam, intQuery, json, oneOf } from '../http.ts';
import { assertBranch, requirePerm, visibleBranches } from '../security.ts';
import { cancelOutbox, processOutbox, retryOutbox, staffWhatsapp } from '../services/notify.ts';

export function registerNotifications(r: Router, db: DatabaseSync) {
  r.get('/api/notifications', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'notifications.read');
    const q = ctx.query;
    const where: string[] = [];
    const vals: Array<string | number> = [];
    const vis = visibleBranches(user);
    if (vis !== 'all') {
      if (vis.length === 0) return [];
      where.push(`o.branch_id IN (${vis.map(() => '?').join(',')})`);
      vals.push(...vis);
    }
    const branchId = intQuery(q, 'branchId');
    if (branchId) {
      assertBranch(user, branchId);
      where.push('o.branch_id = ?');
      vals.push(branchId);
    }
    if (q.get('status')) {
      where.push('o.status = ?');
      vals.push(q.get('status')!);
    }
    if (q.get('channel')) {
      where.push('o.channel = ?');
      vals.push(q.get('channel')!);
    }
    const sql = `SELECT o.id, o.channel, o.destination, o.status, o.attempts, o.last_error, o.created_at, o.sent_at, o.subject,
                        o.report_id, o.body, o.attachment_path, p.full_name AS patient_name, p.mrn, rp.report_no
                 FROM outbox o JOIN patients p ON p.id = o.patient_id LEFT JOIN reports rp ON rp.id = o.report_id
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.id DESC LIMIT 300`;
    return db.prepare(sql).all(...vals);
  });

  r.post('/api/notifications/process', async (ctx) => {
    requirePerm(ctx.user!, 'notifications.write');
    const sent = await processOutbox(db);
    return { ok: true, sent };
  });

  r.post('/api/notifications/:id/retry', (ctx) => {
    requirePerm(ctx.user!, 'notifications.write');
    retryOutbox(db, ctx.user!, intParam(ctx.params.id!, 'id'));
    return { ok: true };
  });

  r.post('/api/notifications/:id/cancel', (ctx) => {
    requirePerm(ctx.user!, 'notifications.write');
    cancelOutbox(db, ctx.user!, intParam(ctx.params.id!, 'id'));
    return { ok: true };
  });

  // WhatsApp is staff-operated: "open" reveals the chat link and PDF folder; "confirm" records that staff sent it.
  r.post('/api/notifications/:id/whatsapp', (ctx) => {
    if (!ctx.user!.perms.has('notifications.write') && !ctx.user!.perms.has('reports.send')) requirePerm(ctx.user!, 'notifications.write');
    const action = oneOf(ctx.body, 'action', ['open', 'confirm'] as const);
    return json(staffWhatsapp(db, ctx.user!, intParam(ctx.params.id!, 'id'), action));
  });
}
