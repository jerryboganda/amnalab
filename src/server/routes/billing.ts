import type { DatabaseSync } from 'node:sqlite';
import type { Router } from '../http.ts';
import { RawResponse, badRequest, conflict, int, intParam, intQuery, invalid, json, notFound, num, oneOf, optStr, str } from '../http.ts';
import { audit } from '../audit.ts';
import { assertBranch, requirePerm, visibleBranches, type AuthUser } from '../security.ts';
import { businessDate, dayEndUtc, dayStartUtc, fmtPkr, fromPaisa, nowIso, toPaisa } from '../util.ts';
import { verifyApprover } from '../services/approval.ts';
import { assertDayOpen } from '../services/billing-core.ts';
import { PRINT_CSP } from './orders.ts';
import { config, loadFileConfig } from '../config.ts';
import { branchDesign } from '../services/doc-branch.ts';
import { renderInvoicePdf } from '../services/invoice-pdf.tsx';

const METHODS = ['cash', 'card', 'bank_transfer', 'jazzcash', 'easypaisa'] as const;

function invoiceRow(db: DatabaseSync, id: number) {
  return db
    .prepare(
      `SELECT i.*, b.code AS branch_code, b.name AS branch_name, b.timezone, p.full_name AS patient_name, p.mrn, p.phone AS patient_phone,
              o.order_no, pr.name AS practitioner_name
       FROM invoices i JOIN branches b ON b.id = i.branch_id JOIN patients p ON p.id = i.patient_id JOIN orders o ON o.id = i.order_id
       LEFT JOIN practitioners pr ON pr.id = o.practitioner_id
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
    verificationCode: row.verification_code,
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
  const status = net >= inv.total_paisa ? 'paid' : net <= 0 ? 'issued' : 'partially_paid';
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
      where.push('i.created_at >= ?');
      vals.push(dayStartUtc(q.get('from')!));
    }
    if (q.get('to')) {
      where.push('i.created_at < ?');
      vals.push(dayEndUtc(q.get('to')!));
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
    assertDayOpen(db, Number(inv.branch_id), date);
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
    const refundDate = businessDate(branch.timezone);
    assertDayOpen(db, Number(inv.branch_id), refundDate);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO payments (invoice_id, branch_id, kind, method, amount_paisa, reason, received_by, approved_by, business_date)
         VALUES (?, ?, 'refund', ?, ?, ?, ?, ?, ?)`,
      ).run(id, Number(inv.branch_id), method, amount, reason, actor.id, approver.id, refundDate);
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
    const design = branchDesign(db, Number(dto.branchId));
    const brand = design.brand.primary;
    const statusLabel = ({ paid: 'PAID', partially_paid: 'PARTIALLY PAID', issued: 'PAYMENT DUE', void: 'VOID' } as Record<string, string>)[String(dto.status)] ?? String(dto.status);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${esc(dto.invoiceNo)}</title>
      <style>body{font-family:'Inter','Segoe UI',Arial,sans-serif;width:280px;margin:0;padding:8px;font-size:11.5px;color:#0f172a}table{width:100%;border-collapse:collapse}
      td{padding:2px 0;vertical-align:top}.r{text-align:right}.t{text-align:center;font-weight:800;font-size:15px;color:${brand};letter-spacing:.3px}
      .m{text-align:center;color:#64748b;font-size:10.5px}.b{border-top:1px dashed #94a3b8;margin:7px 0}.k{color:#64748b}
      .tot td{font-size:14px;font-weight:800;padding-top:4px}.st{margin:8px auto 2px;border:2px solid ${brand};border-radius:6px;padding:4px;text-align:center;font-weight:800;letter-spacing:2px;color:${brand}}
      @media print{@page{size:80mm auto;margin:2mm}}</style></head><body>
      <div class="t">${esc(String(dto.branchName).toUpperCase())}</div>
      ${design.branch.phone ? `<div class="m">Ph: ${esc(design.branch.phone)}</div>` : ''}
      <div class="b"></div>
      <table><tr><td class="k">Receipt</td><td class="r"><b>${esc(dto.invoiceNo)}</b></td></tr>
      <tr><td class="k">Order</td><td class="r">${esc(dto.orderNo)}</td></tr>
      <tr><td class="k">Date</td><td class="r">${esc(new Date(String(dto.createdAt)).toLocaleString('en-GB', { timeZone: 'Asia/Karachi' }))}</td></tr>
      <tr><td class="k">Patient</td><td class="r">${esc(dto.patient.name)}<br><span class="k">${esc(dto.patient.mrn)}</span></td></tr></table>
      <div class="b"></div><table>${lines}</table><div class="b"></div>
      <table><tr><td class="k">Subtotal</td><td class="r">${fmtPkr(toPaisa(dto.subtotalPkr))}</td></tr>
      ${dto.discountPkr > 0 ? `<tr><td class="k">Discount${dto.discountReason ? ` (${esc(dto.discountReason)})` : ''}</td><td class="r">-${fmtPkr(toPaisa(dto.discountPkr))}</td></tr>` : ''}
      <tr><td class="k">Tax</td><td class="r">${fmtPkr(toPaisa(dto.taxPkr))}</td></tr>
      <tr class="tot"><td>TOTAL (PKR)</td><td class="r">${fmtPkr(toPaisa(dto.totalPkr))}</td></tr></table>
      ${pays ? `<div class="b"></div><table>${pays}</table>` : ''}
      <table class="tot"><tr><td>Balance due</td><td class="r">${fmtPkr(toPaisa(dto.balancePkr))}</td></tr></table>
      <div class="st">${esc(statusLabel)}</div>
      <div class="m">Thank you for choosing ${esc(dto.branchName)}</div>
      <script>window.onload=()=>window.print()</script></body></html>`;
    return new RawResponse('text/html; charset=utf-8', html, { 'Content-Security-Policy': PRINT_CSP });
  });

  // A4 invoice PDF in the same design as the lab report. Rendered on demand because payments change it.
  r.get('/api/invoices/:id/pdf', async (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'billing.read');
    const id = intParam(ctx.params.id!, 'id');
    const dto = invoiceDto(db, id, user);
    const row = invoiceRow(db, id)!;
    const design = branchDesign(db, Number(row.branch_id));
    const base = loadFileConfig().publicBaseUrl ?? `http://${config.host}:${config.port}`;
    const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short' });
    const pdf = await renderInvoicePdf({
      brand: design.brand,
      branch: { ...design.branch, letterhead: { ...design.branch.letterhead, enabled: false } },
      invoiceNo: String(dto.invoiceNo),
      orderNo: String(dto.orderNo),
      issuedAt: when(String(dto.createdAt)),
      status: String(dto.status),
      voidReason: (row.void_reason as string | null) ?? null,
      patient: { name: dto.patient.name, mrn: dto.patient.mrn, phone: (row.patient_phone as string | null) ?? null, practitioner: (row.practitioner_name as string | null) ?? null },
      lines: (dto.lines as Array<Record<string, any>>).map((l) => ({
        description: String(l.description),
        price: fromPaisa(Number(l.unit_price_paisa)),
        tax: fromPaisa(Number(l.tax_paisa)),
        total: fromPaisa(Number(l.line_total_paisa)),
      })),
      subtotal: dto.subtotalPkr,
      discount: dto.discountPkr,
      discountReason: (dto.discountReason as string | null) ?? null,
      tax: dto.taxPkr,
      total: dto.totalPkr,
      paid: dto.paidPkr,
      refunded: dto.refundedPkr,
      balance: dto.balancePkr,
      payments: (dto.payments as Array<Record<string, any>>).map((p) => ({
        when: when(String(p.created_at)),
        kind: String(p.kind),
        method: String(p.method),
        reference: (p.reference as string | null) ?? (p.reason as string | null) ?? null,
        amount: fromPaisa(Number(p.amount_paisa)),
      })),
      paymentDetails: design.paymentDetails,
      verificationUrl: `${base}/#/verify-invoice/${row.verification_code}`,
      verificationCode: String(row.verification_code ?? ''),
    });
    return new RawResponse('application/pdf', Buffer.from(pdf), {
      'Content-Disposition': `inline; filename="${String(dto.invoiceNo).replace(/[^A-Za-z0-9-]/g, '_')}.pdf"`,
    });
  });

  // Public check of an invoice from its QR code. Shows no patient details.
  r.get('/api/verify/invoice/:code', (ctx) => {
    const code = ctx.params.code!.toUpperCase();
    const row = db
      .prepare(
        `SELECT i.invoice_no, i.status, i.total_paisa, i.paid_paisa, i.refunded_paisa, i.created_at, b.name AS branch_name
         FROM invoices i JOIN branches b ON b.id = i.branch_id WHERE i.verification_code = ?`,
      )
      .get(code) as Record<string, any> | undefined;
    if (!row) return json({ valid: false, message: 'No invoice matches this code' }, 404);
    return {
      valid: true,
      invoiceNo: row.invoice_no,
      status: row.status,
      totalPkr: fromPaisa(Number(row.total_paisa)),
      paidPkr: fromPaisa(Number(row.paid_paisa) - Number(row.refunded_paisa)),
      issuedAt: row.created_at,
      branch: row.branch_name,
    };
  }, false);

  // ---- Daily cash closing
  r.get('/api/billing/closing', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'billing.read');
    const branchId = intQuery(ctx.query, 'branchId');
    if (!branchId) throw badRequest('branchId is required');
    assertBranch(user, branchId);
    const tz = (db.prepare('SELECT timezone FROM branches WHERE id = ?').get(branchId) as { timezone: string } | undefined)?.timezone ?? 'Asia/Karachi';
    const date = ctx.query.get('date') ?? businessDate(tz);
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
    const tz = (db.prepare('SELECT timezone FROM branches WHERE id = ?').get(branchId) as { timezone: string } | undefined)?.timezone ?? 'Asia/Karachi';
    if (date > businessDate(tz)) throw invalid('A future day cannot be closed');
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

  // A closed day can be reopened by a manager (same permission as refunds) with a reason; it is audited.
  r.post('/api/billing/closing/reopen', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'billing.approve_refund');
    const branchId = int(ctx.body, 'branchId', { min: 1 });
    assertBranch(actor, branchId);
    const date = str(ctx.body, 'date', { max: 10, min: 10 });
    const reason = str(ctx.body, 'reason', { max: 300, min: 5 });
    const closing = db.prepare('SELECT * FROM cash_closings WHERE branch_id = ? AND business_date = ?').get(branchId, date);
    if (!closing) throw conflict('This day is not closed');
    db.prepare('DELETE FROM cash_closings WHERE branch_id = ? AND business_date = ?').run(branchId, date);
    audit(db, { actor, branchId, action: 'cash.reopen', entity: 'cash_closing', entityId: date, before: closing, after: { reason } });
    return { ok: true };
  });

}
