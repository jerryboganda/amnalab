import type { DatabaseSync } from 'node:sqlite';
import type { Router } from '../http.ts';
import { RawResponse, badRequest, conflict, int, intParam, intQuery, invalid, json, notFound, num, oneOf, optStr, str } from '../http.ts';
import { audit } from '../audit.ts';
import { assertBranch, requirePerm, visibleBranches, type AuthUser } from '../security.ts';
import { businessDate, fmtPkr, fromPaisa, nowIso, toPaisa } from '../util.ts';
import { verifyApprover } from '../services/approval.ts';
import { PRINT_CSP } from './orders.ts';

const METHODS = ['cash', 'card', 'bank_transfer', 'jazzcash', 'easypaisa'] as const;

function invoiceRow(db: DatabaseSync, id: number) {
  return db
    .prepare(
      `SELECT i.*, b.code AS branch_code, b.name AS branch_name, b.timezone, p.full_name AS patient_name, p.mrn, o.order_no
       FROM invoices i JOIN branches b ON b.id = i.branch_id JOIN patients p ON p.id = i.patient_id JOIN orders o ON o.id = i.order_id
       WHERE i.id = ?`,
    )
    .get(id) as Record<string, any> | undefined;
}

function invoiceDto(db: DatabaseSync, id: number, user: AuthUser) {
  const row = invoiceRow(db, id);
  if (!row) throw notFound('Invoice not found');
  assertBranch(user, Number(row.branch_id));
  const lines = db
    .prepare('SELECT test_id, description, unit_price_paisa, tax_rate_bp, tax_paisa, line_total_paisa FROM invoice_lines WHERE invoice_id = ? ORDER BY id')
    .all(id) as Array<Record<string, any>>;
  const payments = db
    .prepare('SELECT id, kind, method, amount_paisa, reference, reason, business_date, created_at, approved_by FROM payments WHERE invoice_id = ? ORDER BY id')
    .all(id) as Array<Record<string, any>>;
  const balance = Number(row.total_paisa) - Number(row.paid_paisa) + Number(row.refunded_paisa);
  return {
    id: row.id,
    invoiceNo: row.invoice_no,
    orderId: row.order_id,
    orderNo: row.order_no,
    branchId: row.branch_id,
    branchName: row.branch_name,
    patient: { name: row.patient_name, mrn: row.mrn },
    status: row.status,
    subtotalPkr: fromPaisa(Number(row.subtotal_paisa)),
    discountPkr: fromPaisa(Number(row.discount_paisa)),
    discountReason: row.discount_reason,
    taxPkr: fromPaisa(Number(row.tax_paisa)),
    totalPkr: fromPaisa(Number(row.total_paisa)),
    paidPkr: fromPaisa(Number(row.paid_paisa)),
    refundedPkr: fromPaisa(Number(row.refunded_paisa)),
    balancePkr: fromPaisa(balance),
    createdAt: row.created_at,
    lines: lines.map((l) => ({ ...l, unitPricePkr: fromPaisa(Number(l.unit_price_paisa)) })),
    payments: payments.map((p) => ({ ...p, amountPkr: fromPaisa(Number(p.amount_paisa)) })),
  };
}

function refreshInvoice(db: DatabaseSync, invoiceId: number): void {
  const inv = db.prepare('SELECT total_paisa, paid_paisa, refunded_paisa, status FROM invoices WHERE id = ?').get(invoiceId) as
    | { total_paisa: number; paid_paisa: number; refunded_paisa: number; status: string }
    | undefined;
  if (!inv || inv.status === 'void') return;
  const net = inv.paid_paisa - inv.refunded_paisa;
  const status = net <= 0 ? 'issued' : net >= inv.total_paisa ? 'paid' : 'partially_paid';
  db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, invoiceId);
}

function closingFigures(db: DatabaseSync, branchId: number, date: string) {
  const rows = db
    .prepare(
      `SELECT method, kind, SUM(amount_paisa) AS total FROM payments WHERE branch_id = ? AND business_date = ? GROUP BY method, kind`,
    )
    .all(branchId, date) as Array<{ method: string; kind: string; total: number }>;
  const byMethod: Record<string, number> = {};
  for (const r of rows) {
    const signed = r.kind === 'refund' ? -r.total : r.total;
    byMethod[r.method] = (byMethod[r.method] ?? 0) + signed;
  }
  const expectedCash = byMethod.cash ?? 0;
  const total = Object.values(byMethod).reduce((s, v) => s + v, 0);
  return { byMethod, expectedCashPaisa: expectedCash, totalPaisa: total };
}

export function registerBilling(r: Router, db: DatabaseSync) {
  r.get('/api/invoices', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'billing.read');
    const q = ctx.query;
    const where: string[] = [];
    const vals: Array<string | number> = [];
    const vis = visibleBranches(user);
    if (vis !== 'all') {
      if (vis.length === 0) return [];
      where.push(`i.branch_id IN (${vis.map(() => '?').join(',')})`);
      vals.push(...vis);
    }
    const branchId = intQuery(q, 'branchId');
    if (branchId) {
      assertBranch(user, branchId);
      where.push('i.branch_id = ?');
      vals.push(branchId);
    }
    if (q.get('status')) {
      where.push('i.status = ?');
      vals.push(q.get('status')!);
    }
    if (q.get('from')) {
      where.push('substr(i.created_at,1,10) >= ?');
      vals.push(q.get('from')!);
    }
    if (q.get('to')) {
      where.push('substr(i.created_at,1,10) <= ?');
      vals.push(q.get('to')!);
    }
    const sql = `SELECT i.id, i.invoice_no, i.order_id, i.total_paisa, i.paid_paisa, i.refunded_paisa, i.status, i.created_at, p.full_name AS patient_name, b.code AS branch_code
                 FROM invoices i JOIN patients p ON p.id = i.patient_id JOIN branches b ON b.id = i.branch_id
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.id DESC LIMIT 300`;
    return (db.prepare(sql).all(...vals) as Array<Record<string, any>>).map((x) => ({
      ...x,
      totalPkr: fromPaisa(Number(x.total_paisa)),
      paidPkr: fromPaisa(Number(x.paid_paisa)),
      balancePkr: fromPaisa(Number(x.total_paisa) - Number(x.paid_paisa) + Number(x.refunded_paisa)),
    }));
  });

  r.get('/api/invoices/:id', (ctx) => {
    requirePerm(ctx.user!, 'billing.read');
    return invoiceDto(db, intParam(ctx.params.id!, 'id'), ctx.user!);
  });

  r.post('/api/invoices/:id/payments', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'billing.write');
    const id = intParam(ctx.params.id!, 'id');
    const inv = invoiceRow(db, id);
    if (!inv) throw notFound('Invoice not found');
    assertBranch(actor, Number(inv.branch_id));
    if (inv.status === 'void') throw conflict('This invoice is void');
    const amount = toPaisa(num(ctx.body, 'amountPkr', { min: 0.01, max: 10_000_000 }));
    const balance = Number(inv.total_paisa) - Number(inv.paid_paisa) + Number(inv.refunded_paisa);
    if (amount > balance) throw conflict(`Amount exceeds the balance due (${fmtPkr(balance)})`);
    const method = oneOf(ctx.body, 'method', METHODS);
    const reference = optStr(ctx.body, 'reference', 80);
    if (method !== 'cash' && !reference) throw invalid('A reference number is required for non-cash payments');
    const branch = db.prepare('SELECT timezone FROM branches WHERE id = ?').get(Number(inv.branch_id)) as { timezone: string };
    const date = businessDate(branch.timezone);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO payments (invoice_id, branch_id, kind, method, amount_paisa, reference, received_by, business_date) VALUES (?, ?, 'payment', ?, ?, ?, ?, ?)`,
      ).run(id, Number(inv.branch_id), method, amount, reference, actor.id, date);
      db.prepare('UPDATE invoices SET paid_paisa = paid_paisa + ? WHERE id = ?').run(amount, id);
      refreshInvoice(db, id);
      audit(db, { actor, branchId: Number(inv.branch_id), action: 'payment.receive', entity: 'invoice', entityId: id, after: { method, amountPkr: fromPaisa(amount) } });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return json(invoiceDto(db, id, actor), 201);
  });

  r.post('/api/invoices/:id/refund', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'billing.write');
    const id = intParam(ctx.params.id!, 'id');
    const inv = invoiceRow(db, id);
    if (!inv) throw notFound('Invoice not found');
    assertBranch(actor, Number(inv.branch_id));
    const amount = toPaisa(num(ctx.body, 'amountPkr', { min: 0.01, max: 10_000_000 }));
    const reason = str(ctx.body, 'reason', { max: 300, min: 5 });
    const maxRefund = Number(inv.paid_paisa) - Number(inv.refunded_paisa);
    if (amount > maxRefund) throw conflict(`Refund exceeds the amount paid (${fmtPkr(maxRefund)})`);
    const approver = verifyApprover(db, actor, ctx.body.approver, 'billing.approve_refund');
    const method = oneOf(ctx.body, 'method', METHODS, false) || 'cash';
    const branch = db.prepare('SELECT timezone FROM branches WHERE id = ?').get(Number(inv.branch_id)) as { timezone: string };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO payments (invoice_id, branch_id, kind, method, amount_paisa, reason, received_by, approved_by, business_date)
         VALUES (?, ?, 'refund', ?, ?, ?, ?, ?, ?)`,
      ).run(id, Number(inv.branch_id), method, amount, reason, actor.id, approver.id, businessDate(branch.timezone));
      db.prepare('UPDATE invoices SET refunded_paisa = refunded_paisa + ? WHERE id = ?').run(amount, id);
      refreshInvoice(db, id);
      audit(db, { actor, branchId: Number(inv.branch_id), action: 'payment.refund', entity: 'invoice', entityId: id, after: { amountPkr: fromPaisa(amount), reason, approvedBy: approver.username } });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return json(invoiceDto(db, id, actor), 201);
  });

  // A void is allowed only when nothing is left paid on the invoice, and it needs a second approver.
  r.post('/api/invoices/:id/void', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'billing.write');
    const id = intParam(ctx.params.id!, 'id');
    const inv = invoiceRow(db, id);
    if (!inv) throw notFound('Invoice not found');
    assertBranch(actor, Number(inv.branch_id));
    if (inv.status === 'void') throw conflict('Already void');
    if (Number(inv.paid_paisa) - Number(inv.refunded_paisa) > 0) throw conflict('Refund the amount paid before voiding');
    const reason = str(ctx.body, 'reason', { max: 300, min: 5 });
    const approver = verifyApprover(db, actor, ctx.body.approver, 'billing.approve_refund');
    db.prepare("UPDATE invoices SET status = 'void', voided_by = ?, voided_at = ?, void_reason = ?, void_approved_by = ? WHERE id = ?").run(
      actor.id,
      nowIso(),
      reason,
      approver.id,
      id,
    );
    audit(db, { actor, branchId: Number(inv.branch_id), action: 'invoice.void', entity: 'invoice', entityId: id, after: { reason, approvedBy: approver.username } });
    return invoiceDto(db, id, actor);
  });

  r.get('/api/invoices/:id/receipt', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'billing.read');
    const dto = invoiceDto(db, intParam(ctx.params.id!, 'id'), user);
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const lines = (dto.lines as Array<Record<string, any>>)
      .map((l) => `<tr><td>${esc(l.description)}</td><td style="text-align:right">${fmtPkr(Number(l.unit_price_paisa))}</td></tr>`)
      .join('');
    const pays = (dto.payments as Array<Record<string, any>>)
      .map((p) => `<tr><td>${esc(p.kind === 'refund' ? 'Refund' : 'Paid')} ${esc(p.method)} ${esc(p.reference ?? '')}</td><td style="text-align:right">${p.kind === 'refund' ? '-' : ''}${fmtPkr(Number(p.amount_paisa))}</td></tr>`)
      .join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${esc(dto.invoiceNo)}</title>
      <style>body{font-family:Arial,sans-serif;width:280px;margin:0;padding:8px;font-size:12px}table{width:100%;border-collapse:collapse}
      td{padding:2px 0}.t{text-align:center;font-weight:700;font-size:14px}.b{border-top:1px dashed #000;margin:6px 0}
      @media print{@page{size:80mm auto;margin:2mm}}</style></head><body>
      <div class="t">${esc(dto.branchName)}</div><div style="text-align:center">Receipt ${esc(dto.invoiceNo)}</div>
      <div>Order ${esc(dto.orderNo)} | ${esc(new Date(String(dto.createdAt)).toLocaleString('en-GB', { timeZone: 'Asia/Karachi' }))}</div>
      <div>Patient: ${esc(dto.patient.name)} (${esc(dto.patient.mrn)})</div>
      <div class="b"></div><table>${lines}</table><div class="b"></div>
      <table><tr><td>Subtotal</td><td style="text-align:right">${fmtPkr(toPaisa(dto.subtotalPkr))}</td></tr>
      <tr><td>Discount${dto.discountReason ? ` (${esc(dto.discountReason)})` : ''}</td><td style="text-align:right">-${fmtPkr(toPaisa(dto.discountPkr))}</td></tr>
      <tr><td>Tax</td><td style="text-align:right">${fmtPkr(toPaisa(dto.taxPkr))}</td></tr>
      <tr><td><b>Total (PKR)</b></td><td style="text-align:right"><b>${fmtPkr(toPaisa(dto.totalPkr))}</b></td></tr></table>
      <div class="b"></div><table>${pays}</table>
      <div>Balance due: ${fmtPkr(toPaisa(dto.balancePkr))}</div>
      <div class="b"></div><div style="text-align:center">Thank you. Status: ${esc(dto.status)}</div>
      <script>window.onload=()=>window.print()</script></body></html>`;
    return new RawResponse('text/html; charset=utf-8', html, { 'Content-Security-Policy': PRINT_CSP });
  });

  // ---- Daily cash closing
  r.get('/api/billing/closing', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'billing.read');
    const branchId = intQuery(ctx.query, 'branchId');
    if (!branchId) throw badRequest('branchId is required');
    assertBranch(user, branchId);
    const date = ctx.query.get('date') ?? businessDate('Asia/Karachi');
    const figures = closingFigures(db, branchId, date);
    const closing = db.prepare('SELECT * FROM cash_closings WHERE branch_id = ? AND business_date = ?').get(branchId, date) ?? null;
    return {
      date,
      byMethodPkr: Object.fromEntries(Object.entries(figures.byMethod).map(([k, v]) => [k, fromPaisa(v)])),
      expectedCashPkr: fromPaisa(figures.expectedCashPaisa),
      totalPkr: fromPaisa(figures.totalPaisa),
      closing,
    };
  });

  r.post('/api/billing/closing', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'billing.close');
    const branchId = int(ctx.body, 'branchId', { min: 1 });
    assertBranch(actor, branchId);
    const date = str(ctx.body, 'date', { max: 10, min: 10 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid('date must be YYYY-MM-DD');
    if (db.prepare('SELECT id FROM cash_closings WHERE branch_id = ? AND business_date = ?').get(branchId, date)) {
      throw conflict('This day is already closed');
    }
    const counted = toPaisa(num(ctx.body, 'countedPkr', { min: 0, max: 100_000_000 }));
    const expected = closingFigures(db, branchId, date).expectedCashPaisa;
    const variance = counted - expected;
    db.prepare(
      `INSERT INTO cash_closings (branch_id, business_date, expected_paisa, counted_paisa, variance_paisa, closed_by) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(branchId, date, expected, counted, variance, actor.id);
    audit(db, { actor, branchId, action: 'cash.close', entity: 'cash_closing', entityId: date, after: { expectedPkr: fromPaisa(expected), countedPkr: fromPaisa(counted), variancePkr: fromPaisa(variance) } });
    return json({ ok: true, expectedPkr: fromPaisa(expected), countedPkr: fromPaisa(counted), variancePkr: fromPaisa(variance) }, 201);
  });

}
