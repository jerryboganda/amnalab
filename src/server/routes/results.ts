import type { DatabaseSync } from 'node:sqlite';
import type { Router } from '../http.ts';
import { RawResponse, arr, conflict, forbidden, intParam, json, notFound, num, str } from '../http.ts';
import { audit } from '../audit.ts';
import { requirePerm, type AuthUser } from '../security.ts';
import { nowIso } from '../util.ts';
import { readIfExists, saveAttachment } from '../services/files.ts';
import {
  activeParams,
  approvedRanges,
  itemHasAuthorizedAll,
  loadItem,
  patientAgeSex,
  rangeLabel,
  saveEntries,
  type Entry,
} from '../services/results-core.ts';
import { selectRange } from '../services/flags.ts';
import { generateReportForOrder } from '../services/reports.ts';

function itemView(db: DatabaseSync, user: AuthUser, itemId: number) {
  const ctx = loadItem(db, user, itemId);
  const { ageDays, sex } = patientAgeSex(ctx);
  const params = activeParams(db, ctx.test_id).map((p) => {
    const result = db
      .prepare(
        `SELECT id, value_numeric, value_text, flag, status, version, critical, critical_notified_to, comment, entered_by, reviewed_by, authorized_by, cancel_reason
         FROM results WHERE order_item_id = ? AND parameter_id = ?`,
      )
      .get(itemId, p.id) as Record<string, any> | undefined;
    const range = selectRange(approvedRanges(db, p.id), sex, ageDays);
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      unit: p.unit,
      decimals: p.decimals,
      resultType: p.result_type,
      formula: p.formula,
      options: p.qualitative_options ? JSON.parse(p.qualitative_options) : null,
      criticalLow: p.critical_low,
      criticalHigh: p.critical_high,
      range: range
        ? { low: range.low, high: range.high, text: range.text_range, label: rangeLabel(range, p.unit) }
        : null,
      result: result ?? null,
    };
  });
  const attachments = db
    .prepare('SELECT id, filename, mime, size, uploaded_at FROM attachments WHERE order_item_id = ? ORDER BY id')
    .all(itemId);
  return {
    id: ctx.id,
    status: ctx.status,
    testName: ctx.test_name,
    testCode: ctx.test_code,
    department: ctx.department_name,
    orderNo: ctx.order_no,
    priority: ctx.priority,
    patient: { id: ctx.patient_id, name: ctx.patient_name, mrn: ctx.mrn, gender: ctx.gender, ageDays },
    specimen: { accession: ctx.accession_no, status: ctx.specimen_status, type: ctx.specimen_type },
    parameters: params,
    attachments,
  };
}

export function registerResults(r: Router, db: DatabaseSync) {
  r.get('/api/order-items/:id', (ctx) => {
    const user = ctx.user!;
    if (!user.perms.has('results.enter') && !user.perms.has('results.review') && !user.perms.has('results.authorize')) {
      throw forbidden('results');
    }
    return itemView(db, user, intParam(ctx.params.id!, 'id'));
  });

  // Entry: { values: [{ parameterId, valueNumeric | valueText, comment }] }. Partial saves are allowed.
  r.post('/api/order-items/:id/results', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'results.enter');
    const itemId = intParam(ctx.params.id!, 'id');
    const values = arr(ctx.body, 'values', 200) as Array<Record<string, any>>;
    const entries: Entry[] = values.map((v) => ({
      parameterId: Number(v.parameterId),
      valueNumeric: v.valueNumeric === undefined || v.valueNumeric === null || v.valueNumeric === '' ? null : Number(v.valueNumeric),
      valueText: typeof v.valueText === 'string' ? v.valueText : null,
      comment: typeof v.comment === 'string' ? v.comment.slice(0, 300) : null,
    }));
    saveEntries(db, user, itemId, entries);
    return json(itemView(db, user, itemId));
  });

  // Technical review: a different person from whoever entered the values.
  r.post('/api/order-items/:id/review', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'results.review');
    const itemId = intParam(ctx.params.id!, 'id');
    loadItem(db, user, itemId);
    const rows = db
      .prepare("SELECT id, status, entered_by FROM results WHERE order_item_id = ? AND status <> 'cancelled'")
      .all(itemId) as Array<{ id: number; status: string; entered_by: number | null }>;
    if (rows.length === 0) throw conflict('No results have been entered yet');
    if (rows.some((x) => x.entered_by === user.id)) throw conflict('Technical review must be done by a different person from the one who entered the results');
    if (rows.some((x) => x.status === 'authorized')) throw conflict('Some results are already authorized');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE results SET status = 'reviewed', reviewed_by = ?, reviewed_at = ? WHERE order_item_id = ? AND status = 'draft'").run(
        user.id,
        nowIso(),
        itemId,
      );
      audit(db, { actor: user, action: 'result.review', entity: 'order_item', entityId: itemId, after: { results: rows.length } });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return json(itemView(db, user, itemId));
  });

  // Authorization (final release). Critical values need the clinician or patient notification recorded first.
  r.post('/api/order-items/:id/authorize', async (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'results.authorize');
    const itemId = intParam(ctx.params.id!, 'id');
    const item = loadItem(db, user, itemId);
    const rows = db
      .prepare(
        `SELECT id, status, entered_by, reviewed_by, critical FROM results WHERE order_item_id = ? AND status <> 'cancelled'`,
      )
      .all(itemId) as Array<{ id: number; status: string; entered_by: number | null; reviewed_by: number | null; critical: number }>;
    if (rows.length === 0) throw conflict('No results to authorize');
    if (rows.some((x) => x.status !== 'reviewed')) throw conflict('Every result must be technically reviewed before authorization');
    if (rows.some((x) => x.entered_by === user.id)) {
      throw conflict('The person who entered a result cannot authorize it');
    }
    const criticals = rows.filter((x) => x.critical === 1);
    let notifiedTo: string | null = null;
    if (criticals.length > 0) {
      notifiedTo = str(ctx.body, 'criticalNotifiedTo', { max: 160, min: 2 });
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `UPDATE results SET status = 'authorized', authorized_by = ?, authorized_at = ?,
                critical_notified_to = COALESCE(?, critical_notified_to), critical_notified_at = CASE WHEN ? IS NOT NULL THEN ? ELSE critical_notified_at END
         WHERE order_item_id = ? AND status = 'reviewed'`,
      ).run(user.id, nowIso(), notifiedTo, notifiedTo, nowIso(), itemId);
      db.prepare("UPDATE order_items SET status = 'completed', completed_at = ? WHERE id = ?").run(nowIso(), itemId);
      audit(db, {
        actor: user,
        branchId: item.branch_id,
        action: 'result.authorize',
        entity: 'order_item',
        entityId: itemId,
        after: { results: rows.length, criticals: criticals.length, criticalNotifiedTo: notifiedTo },
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const orderDone = await completeOrderIfDone(db, user, item.order_id);
    return json({ ...itemView(db, user, itemId), orderCompleted: orderDone.completed, report: orderDone.report });
  });

  // Amendment of an authorized result. Keeps the previous value in revisions; the report is re-issued on re-authorization.
  r.post('/api/results/:id/amend', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'results.amend');
    const resultId = intParam(ctx.params.id!, 'id');
    const row = db
      .prepare(
        `SELECT r.*, oi.order_id FROM results r JOIN order_items oi ON oi.id = r.order_item_id WHERE r.id = ?`,
      )
      .get(resultId) as Record<string, any> | undefined;
    if (!row) throw notFound('Result not found');
    loadItem(db, user, Number(row.order_item_id));
    if (row.status !== 'authorized') throw conflict('Only authorized results are amended');
    const reason = str(ctx.body, 'reason', { max: 300, min: 5 });
    const isText = row.value_numeric === null;
    const newNum = isText ? null : num(ctx.body, 'valueNumeric');
    const newText = isText ? str(ctx.body, 'valueText', { max: 300 }) : null;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO result_revisions (result_id, version, value_numeric, value_text, flag, status, changed_by, reason)
         VALUES (?, ?, ?, ?, ?, 'authorized', ?, ?)`,
      ).run(resultId, row.version, row.value_numeric, row.value_text, row.flag, user.id, reason);
      db.prepare(
        `UPDATE results SET value_numeric = ?, value_text = ?, status = 'draft', version = version + 1,
                entered_by = ?, entered_at = ?, reviewed_by = NULL, reviewed_at = NULL, authorized_by = NULL, authorized_at = NULL
         WHERE id = ?`,
      ).run(newNum, newText, user.id, nowIso(), resultId);
      db.prepare("UPDATE order_items SET status = 'processing', completed_at = NULL WHERE id = ?").run(row.order_item_id);
      db.prepare("UPDATE orders SET status = 'in_progress' WHERE id = ?").run(row.order_id);
      audit(db, {
        actor: user,
        branchId: Number(row.branch_id),
        action: 'result.amend',
        entity: 'result',
        entityId: resultId,
        before: { value_numeric: row.value_numeric, value_text: row.value_text, version: row.version },
        after: { value_numeric: newNum, value_text: newText, reason },
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return json({ ok: true, version: Number(row.version) + 1, status: 'draft' });
  });

  r.post('/api/results/:id/cancel', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'results.amend');
    const resultId = intParam(ctx.params.id!, 'id');
    const row = db.prepare('SELECT id, order_item_id, status, branch_id FROM results WHERE id = ?').get(resultId) as
      | { id: number; order_item_id: number; status: string; branch_id: number }
      | undefined;
    if (!row) throw notFound('Result not found');
    loadItem(db, user, row.order_item_id);
    if (row.status === 'authorized') throw conflict('Amend an authorized result instead of cancelling it');
    const reason = str(ctx.body, 'reason', { max: 300, min: 5 });
    db.prepare("UPDATE results SET status = 'cancelled', cancel_reason = ? WHERE id = ?").run(reason, resultId);
    audit(db, { actor: user, branchId: row.branch_id, action: 'result.cancel', entity: 'result', entityId: resultId, after: { reason } });
    return { ok: true, status: 'cancelled' };
  });

  r.post('/api/order-items/:id/attachments', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'results.enter');
    const itemId = intParam(ctx.params.id!, 'id');
    const item = loadItem(db, user, itemId);
    const filename = str(ctx.body, 'filename', { max: 120 });
    const saved = saveAttachment(itemId, str(ctx.body, 'dataUrl', { max: 16_000_000 }), filename);
    const row = db
      .prepare(
        `INSERT INTO attachments (order_item_id, branch_id, filename, mime, size, path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(itemId, item.branch_id, filename, saved.mime, saved.size, saved.path, user.id) as { id: number };
    audit(db, { actor: user, branchId: item.branch_id, action: 'attachment.add', entity: 'order_item', entityId: itemId, after: { filename, size: saved.size } });
    return json({ id: row.id, filename, mime: saved.mime, size: saved.size }, 201);
  });

  r.get('/api/attachments/:id', (ctx) => {
    const user = ctx.user!;
    const id = intParam(ctx.params.id!, 'id');
    const row = db.prepare('SELECT order_item_id, path, mime, filename FROM attachments WHERE id = ?').get(id) as
      | { order_item_id: number; path: string; mime: string; filename: string }
      | undefined;
    if (!row) throw notFound('Attachment not found');
    loadItem(db, user, row.order_item_id);
    const data = readIfExists(row.path);
    if (!data) throw notFound('File missing');
    return new RawResponse(row.mime, data, { 'Content-Disposition': `inline; filename="${row.filename.replace(/"/g, '')}"` });
  });

}

// When every test on an order is authorized, the order completes and a report version is issued.
export async function completeOrderIfDone(
  db: DatabaseSync,
  actor: AuthUser,
  orderId: number,
): Promise<{ completed: boolean; report: unknown }> {
  const open = db
    .prepare("SELECT COUNT(*) AS n FROM order_items WHERE order_id = ? AND status NOT IN ('completed','cancelled')")
    .get(orderId) as { n: number };
  if (open.n > 0) return { completed: false, report: null };
  db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(orderId);
  const items = db.prepare('SELECT id FROM order_items WHERE order_id = ?').all(orderId) as Array<{ id: number }>;
  const allAuthorized = items.every((i) => itemHasAuthorizedAll(db, i.id));
  if (!allAuthorized) return { completed: true, report: null };
  const report = await generateReportForOrder(db, actor, orderId, null);
  return { completed: true, report: { id: report.id, reportNo: report.reportNo, version: report.version } };
}
