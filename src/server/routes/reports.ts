import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Router } from '../http.ts';
import { RawResponse, conflict, intParam, json, notFound, oneOf, optStr, str } from '../http.ts';
import { assertBranch, requirePerm } from '../security.ts';
import { generateReportForOrder } from '../services/reports.ts';
import { queueReport, type Channel } from '../services/notify.ts';

export function registerReports(r: Router, db: DatabaseSync) {
  r.get('/api/orders/:id/reports', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'reports.read');
    const id = intParam(ctx.params.id!, 'id');
    const order = db.prepare('SELECT branch_id FROM orders WHERE id = ?').get(id) as { branch_id: number } | undefined;
    if (!order) throw notFound('Order not found');
    assertBranch(user, order.branch_id);
    return db
      .prepare(
        `SELECT id, report_no, verification_code, version, status, reason, issued_at, sha256 FROM reports WHERE order_id = ? ORDER BY version DESC`,
      )
      .all(id);
  });

  // Re-issues the report after a non-result change (for example a template update). Needs a reason.
  r.post('/api/orders/:id/reissue', async (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'results.authorize');
    const id = intParam(ctx.params.id!, 'id');
    const order = db.prepare('SELECT branch_id, status FROM orders WHERE id = ?').get(id) as { branch_id: number; status: string } | undefined;
    if (!order) throw notFound('Order not found');
    assertBranch(actor, order.branch_id);
    if (order.status !== 'completed') throw conflict('Only completed orders can be re-issued');
    const reason = str(ctx.body, 'reason', { max: 300, min: 5 });
    const rec = await generateReportForOrder(db, actor, id, reason);
    return json({ id: rec.id, reportNo: rec.reportNo, version: rec.version }, 201);
  });

  r.get('/api/reports/:id/pdf', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'reports.read');
    const id = intParam(ctx.params.id!, 'id');
    const row = db.prepare('SELECT branch_id, pdf_path, print_pdf_path, report_no FROM reports WHERE id = ?').get(id) as
      | { branch_id: number; pdf_path: string; print_pdf_path: string | null; report_no: string }
      | undefined;
    if (!row) throw notFound('Report not found');
    assertBranch(user, row.branch_id);
    // ?variant=print gives the copy laid out for the branch's paper (blank letterhead area when pre-printed).
    const print = ctx.query.get('variant') === 'print' && row.print_pdf_path && existsSync(row.print_pdf_path);
    const path = print ? row.print_pdf_path! : row.pdf_path;
    if (!existsSync(path)) throw notFound('The PDF file is missing from disk');
    return new RawResponse('application/pdf', readFileSync(path), {
      'Content-Disposition': `inline; filename="${row.report_no.replace(/[^A-Za-z0-9-]/g, '_')}${print ? '-print' : ''}.pdf"`,
    });
  });

  r.post('/api/reports/:id/send', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'reports.send');
    const id = intParam(ctx.params.id!, 'id');
    const rep = db.prepare('SELECT branch_id, status FROM reports WHERE id = ?').get(id) as { branch_id: number; status: string } | undefined;
    if (!rep) throw notFound('Report not found');
    assertBranch(actor, rep.branch_id);
    if (rep.status !== 'final') throw conflict('Only the current report version can be sent');
    const channel = oneOf(ctx.body, 'channel', ['email', 'sms', 'whatsapp'] as const) as Channel;
    const destination = optStr(ctx.body, 'destination', 120) ?? undefined;
    const result = queueReport(db, actor, id, channel, destination);
    return json(result, 201);
  });

  // Public verification: confirms a report is genuine and current. Returns no patient details.
  r.get('/api/verify/:code', (ctx) => {
    const code = ctx.params.code!.toUpperCase();
    const row = db
      .prepare(
        `SELECT r.report_no, r.version, r.status, r.issued_at, b.name AS branch_name
         FROM reports r JOIN branches b ON b.id = r.branch_id WHERE r.verification_code = ?`,
      )
      .get(code) as Record<string, any> | undefined;
    if (!row) return json({ valid: false, message: 'No report matches this code' }, 404);
    return { valid: true, reportNo: row.report_no, version: row.version, currentVersion: row.status === 'final', issuedAt: row.issued_at, branch: row.branch_name };
  }, false);
}
