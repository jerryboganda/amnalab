import type { DatabaseSync } from 'node:sqlite';
import type { Router } from '../http.ts';
import { RawResponse, arr, badRequest, bool, conflict, forbidden, int, intParam, intQuery, invalid, json, notFound, oneOf, optStr, str } from '../http.ts';
import { audit } from '../audit.ts';
import { requirePerm, visibleBranches, assertBranch, type AuthUser } from '../security.ts';
import { nextSequence, pad, businessDate, nowIso, toPaisa, dayStartUtc, dayEndUtc } from '../util.ts';
import { patientVisible } from './patients.ts';
import { assertDayOpen, computeInvoice, invoiceNumber } from '../services/billing-core.ts';
import { priceFor } from '../services/pricing.ts';
import { specimenLabelSvg } from '../services/labels.ts';
import { completeOrderIfDone } from './results.ts';

const PRIORITIES = ['routine', 'urgent', 'stat'] as const;
// Print pages carry a small inline script that opens the print dialog. Nothing else is allowed.
export const PRINT_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:";
const ORDER_SELECT = `SELECT o.*, p.full_name AS patient_name, p.mrn, b.code AS branch_code, b.name AS branch_name,
  pr.name AS practitioner_name FROM orders o
  JOIN patients p ON p.id = o.patient_id
  JOIN branches b ON b.id = o.branch_id
  LEFT JOIN practitioners pr ON pr.id = o.practitioner_id`;

function branchAccessible(user: AuthUser, branchId: number): void {
  assertBranch(user, branchId);
}

// Panels expand to their member tests. The panel itself is what the patient is billed for.
function expandTests(db: DatabaseSync, testIds: number[]): { leaves: number[]; billed: Array<{ id: number; name: string }> } {
  const leaves = new Set<number>();
  const billed: Array<{ id: number; name: string }> = [];
  for (const id of testIds) {
    const t = db.prepare('SELECT id, name, is_panel, is_active FROM tests WHERE id = ?').get(id) as
      | { id: number; name: string; is_panel: number; is_active: number }
      | undefined;
    if (!t || t.is_active !== 1) throw badRequest(`Test ${id} is not available`);
    billed.push({ id: t.id, name: t.name });
    if (t.is_panel === 1) {
      const members = db.prepare('SELECT member_test_id FROM panel_members WHERE panel_test_id = ?').all(id) as Array<{ member_test_id: number }>;
      for (const m of members) leaves.add(m.member_test_id);
    } else {
      leaves.add(t.id);
    }
  }
  return { leaves: [...leaves], billed };
}

export function registerOrders(r: Router, db: DatabaseSync) {
  r.post('/api/orders', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'orders.write');
    const b = ctx.body;
    const branchId = int(b, 'branchId', { min: 1 });
    branchAccessible(actor, branchId);
    const branch = db.prepare('SELECT id, code, timezone FROM branches WHERE id = ? AND is_active = 1').get(branchId) as
      | { id: number; code: string; timezone: string }
      | undefined;
    if (!branch) throw badRequest('Branch not found');
    const patientId = int(b, 'patientId', { min: 1 });
    if (!patientVisible(db, actor, patientId)) throw notFound('Patient not found');
    const patient = db.prepare('SELECT id, full_name FROM patients WHERE id = ?').get(patientId) as { id: number; full_name: string } | undefined;
    if (!patient) throw notFound('Patient not found');
    const priority = oneOf(b, 'priority', PRIORITIES, false) || 'routine';
    const practitionerId = b.practitionerId == null ? null : int(b, 'practitionerId', { min: 1 });
    if (practitionerId && !db.prepare('SELECT id FROM practitioners WHERE id = ?').get(practitionerId)) throw badRequest('Referring doctor not found');
    const testIds = (arr(b, 'testIds', 100) as unknown[]).map((x) => Number(x));
    if (testIds.some((x) => !Number.isInteger(x) || x <= 0)) throw invalid('testIds must be test ids');

    const today = businessDate(branch.timezone || 'Asia/Karachi');
    const { leaves, billed } = expandTests(db, testIds);
    const leafRows = leaves.map((id) =>
      db.prepare('SELECT id, name, specimen_type, tat_hours, tax_rate_bp, is_active FROM tests WHERE id = ?').get(id) as {
        id: number;
        name: string;
        specimen_type: string;
        tat_hours: number;
        tax_rate_bp: number;
        is_active: number;
      },
    );
    if (leafRows.some((t) => t.is_active !== 1)) throw badRequest('A selected test is inactive');

    // Billing lines are the ordered tests (panels once, at panel price), not their members.
    const lines = billed.map((t) => {
      const row = db.prepare('SELECT tax_rate_bp FROM tests WHERE id = ?').get(t.id) as { tax_rate_bp: number };
      return {
        testId: t.id,
        description: t.name,
        unitPricePaisa: priceFor(db, branchId, t.id, today),
        taxRateBp: row.tax_rate_bp,
      };
    });
    const discountBody = (b.discount ?? { type: 'none' }) as Record<string, any>;
    const discount = {
      type: oneOf(discountBody, 'type', ['none', 'percent', 'fixed'] as const, false) || 'none',
      value: discountBody.value == null ? 0 : Number(discountBody.value),
      reason: optStr(discountBody, 'reason', 200),
      approver: discountBody.approver as { username?: unknown; password?: unknown } | undefined,
    } as const;
    const totals = computeInvoice(db, actor, lines, { ...discount, reason: discount.reason });

    const payment = b.payment && typeof b.payment === 'object' ? (b.payment as Record<string, any>) : null;
    const paidPaisa = payment ? toPaisa(Number(payment.amountPkr ?? 0)) : 0;
    if (!Number.isFinite(paidPaisa)) throw invalid('Payment amount must be a number');
    if (paidPaisa < 0 || paidPaisa > totals.total) throw invalid('Initial payment cannot exceed the invoice total');
    if (paidPaisa > 0) assertDayOpen(db, branchId, today);
    if (paidPaisa > 0 && payment && payment.method !== 'cash' && !optStr(payment, 'reference', 80)) {
      throw invalid('A reference number is required for non-cash payments');
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const orderNo = `${branch.code}-O${pad(nextSequence(db, `order:${branch.code}`), 6)}`;
      const maxTat = Math.max(...leafRows.map((t) => t.tat_hours), 24);
      const tatDue = new Date(Date.now() + maxTat * 3_600_000).toISOString();
      const order = db
        .prepare(
          `INSERT INTO orders (branch_id, order_no, patient_id, practitioner_id, priority, status, created_by)
           VALUES (?, ?, ?, ?, ?, 'confirmed', ?) RETURNING id`,
        )
        .get(branchId, orderNo, patientId, practitionerId, priority, actor.id) as { id: number };

      // One specimen per specimen type. Each gets its own accession number and label.
      const specimenByType = new Map<string, number>();
      for (const t of leafRows) {
        if (!specimenByType.has(t.specimen_type)) {
          const accession = `${branch.code}-S${pad(nextSequence(db, `accession:${branch.code}`), 7)}`;
          const sp = db
            .prepare(
              `INSERT INTO specimens (branch_id, order_id, accession_no, specimen_type, status) VALUES (?, ?, ?, ?, 'expected') RETURNING id`,
            )
            .get(branchId, order.id, accession, t.specimen_type) as { id: number };
          specimenByType.set(t.specimen_type, sp.id);
        }
        db.prepare(
          `INSERT INTO order_items (order_id, test_id, specimen_id, status, tat_due_at) VALUES (?, ?, ?, 'ordered', ?)`,
        ).run(order.id, t.id, specimenByType.get(t.specimen_type)!, tatDue);
      }

      const invoiceId = (db
        .prepare(
          `INSERT INTO invoices (branch_id, invoice_no, order_id, patient_id, subtotal_paisa, discount_type, discount_value,
                                 discount_paisa, discount_reason, discount_approved_by, tax_paisa, total_paisa, paid_paisa, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'issued', ?) RETURNING id`,
        )
        .get(
          branchId,
          invoiceNumber(db, branch.code),
          order.id,
          patientId,
          totals.subtotal,
          discount.type,
          discount.type === 'percent' ? discount.value : Math.round(discount.value * 100),
          totals.discount,
          discount.reason,
          totals.approvedBy,
          totals.tax,
          totals.total,
          actor.id,
        ) as { id: number }).id;
      lines.forEach((l, i) => {
        db.prepare(
          `INSERT INTO invoice_lines (invoice_id, test_id, description, unit_price_paisa, tax_rate_bp, tax_paisa, line_total_paisa)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(invoiceId, l.testId, l.description, l.unitPricePaisa, l.taxRateBp, totals.taxByLine[i]!, l.unitPricePaisa + totals.taxByLine[i]!);
      });

      if (totals.total === 0) db.prepare("UPDATE invoices SET status = 'paid' WHERE id = ?").run(invoiceId);
      if (paidPaisa > 0 && payment) {
        const method = oneOf(payment, 'method', ['cash', 'card', 'bank_transfer', 'jazzcash', 'easypaisa'] as const);
        db.prepare(
          `INSERT INTO payments (invoice_id, branch_id, kind, method, amount_paisa, reference, received_by, business_date)
           VALUES (?, ?, 'payment', ?, ?, ?, ?, ?)`,
        ).run(invoiceId, branchId, method, paidPaisa, optStr(payment, 'reference', 80), actor.id, today);
        db.prepare("UPDATE invoices SET paid_paisa = ?, status = ? WHERE id = ?").run(
          paidPaisa,
          paidPaisa >= totals.total ? 'paid' : 'partially_paid',
          invoiceId,
        );
      }
      audit(db, {
        actor,
        branchId,
        action: 'order.create',
        entity: 'order',
        entityId: order.id,
        after: { orderNo, tests: billed.length, total: totals.total, discount: totals.discount, approvedBy: totals.approvedBy },
      });
      db.exec('COMMIT');
      return json(orderDetail(db, actor, order.id), 201);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });

  r.get('/api/orders', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'patients.read');
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
    const status = q.get('status');
    if (status) {
      where.push('o.status = ?');
      vals.push(status);
    }
    const date = q.get('date');
    if (date) {
      where.push('o.created_at >= ? AND o.created_at < ?');
      vals.push(dayStartUtc(date), dayEndUtc(date));
    }
    const patientId = intQuery(q, 'patientId');
    if (patientId) {
      where.push('o.patient_id = ?');
      vals.push(patientId);
    }
    const sql = `${ORDER_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.id DESC LIMIT 300`;
    return db.prepare(sql).all(...vals);
  });

  r.get('/api/orders/:id', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'patients.read');
    return orderDetail(db, user, intParam(ctx.params.id!, 'id'));
  });

  // ---- Specimen lifecycle: expected -> collected -> received -> (rejected | processing) -> stored / disposed
  r.post('/api/specimens/:id/collect', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'specimens.write');
    const sp = loadSpecimen(db, actor, intParam(ctx.params.id!, 'id'));
    if (sp.status !== 'expected') throw conflict(`Specimen is ${sp.status}, not waiting for collection`);
    const collector = str(ctx.body, 'collectorName', { max: 120, min: 2 });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `UPDATE specimens SET status = 'collected', collector_name = ?, collected_at = ?, collected_by = ? WHERE id = ?`,
      ).run(collector, nowIso(), actor.id, sp.id);
      db.prepare("UPDATE order_items SET status = 'collected' WHERE specimen_id = ? AND status = 'ordered'").run(sp.id);
      audit(db, { actor, branchId: sp.branch_id, action: 'specimen.collect', entity: 'specimen', entityId: sp.id, after: { collector } });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return specimenDto(db, sp.id);
  });

  r.post('/api/specimens/:id/receive', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'specimens.write');
    const sp = loadSpecimen(db, actor, intParam(ctx.params.id!, 'id'));
    if (sp.status !== 'collected') throw conflict(`Specimen must be collected before receipt (now ${sp.status})`);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE specimens SET status = 'received', received_at = ?, received_by = ? WHERE id = ?").run(nowIso(), actor.id, sp.id);
      db.prepare("UPDATE order_items SET status = 'received' WHERE specimen_id = ? AND status = 'collected'").run(sp.id);
      db.prepare("UPDATE orders SET status = 'in_progress' WHERE id = ? AND status = 'confirmed'").run(sp.order_id);
      audit(db, { actor, branchId: sp.branch_id, action: 'specimen.receive', entity: 'specimen', entityId: sp.id });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return specimenDto(db, sp.id);
  });

  // Rejection needs a reason. Results for the rejected specimen stay blocked until a recollection is received.
  r.post('/api/specimens/:id/reject', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'specimens.write');
    const sp = loadSpecimen(db, actor, intParam(ctx.params.id!, 'id'));
    if (!['collected', 'received', 'expected'].includes(sp.status)) throw conflict(`A ${sp.status} specimen cannot be rejected`);
    const reason = str(ctx.body, 'reason', { max: 300, min: 3 });
    const recollect = bool(ctx.body, 'recollect');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE specimens SET status = 'rejected', reject_reason = ?, recollect_required = ? WHERE id = ?").run(
        reason,
        recollect ? 1 : 0,
        sp.id,
      );
      db.prepare("UPDATE order_items SET status = 'ordered' WHERE specimen_id = ? AND status IN ('collected','received')").run(sp.id);
      let newSpecimenId: number | null = null;
      if (recollect) {
        const accession = `${sp.branch_code}-S${pad(nextSequence(db, `accession:${sp.branch_code}`), 7)}`;
        newSpecimenId = (db
          .prepare(
            `INSERT INTO specimens (branch_id, order_id, accession_no, specimen_type, status) VALUES (?, ?, ?, ?, 'expected') RETURNING id`,
          )
          .get(sp.branch_id, sp.order_id, accession, sp.specimen_type) as { id: number }).id;
        db.prepare('UPDATE order_items SET specimen_id = ? WHERE specimen_id = ? AND status = ?').run(newSpecimenId, sp.id, 'ordered');
      }
      audit(db, { actor, branchId: sp.branch_id, action: 'specimen.reject', entity: 'specimen', entityId: sp.id, after: { reason, recollect, newSpecimenId } });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return specimenDto(db, sp.id);
  });

  // A rejected specimen can be recollected later: a new accession is issued for the tests still waiting on it.
  r.post('/api/specimens/:id/recollect', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'specimens.write');
    const sp = loadSpecimen(db, actor, intParam(ctx.params.id!, 'id'));
    if (sp.status !== 'rejected') throw conflict('Only a rejected specimen can be recollected');
    const waiting = db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE specimen_id = ? AND status = 'ordered'").get(sp.id) as { n: number };
    if (waiting.n === 0) throw conflict('No tests are waiting on this specimen');
    db.exec('BEGIN IMMEDIATE');
    try {
      const accession = `${sp.branch_code}-S${pad(nextSequence(db, `accession:${sp.branch_code}`), 7)}`;
      const created = db
        .prepare(`INSERT INTO specimens (branch_id, order_id, accession_no, specimen_type, status) VALUES (?, ?, ?, ?, 'expected') RETURNING id`)
        .get(sp.branch_id, sp.order_id, accession, sp.specimen_type) as { id: number };
      db.prepare("UPDATE order_items SET specimen_id = ? WHERE specimen_id = ? AND status = 'ordered'").run(created.id, sp.id);
      db.prepare('UPDATE specimens SET recollect_required = 1 WHERE id = ?').run(sp.id);
      audit(db, { actor, branchId: sp.branch_id, action: 'specimen.recollect', entity: 'specimen', entityId: sp.id, after: { newSpecimenId: created.id, accession } });
      db.exec('COMMIT');
      return json(specimenDto(db, created.id), 201);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });

  // Cancels one test on an order (e.g. specimen could not be recollected). Billing is refunded separately.
  r.post('/api/order-items/:id/cancel', async (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'orders.write');
    const itemId = intParam(ctx.params.id!, 'id');
    const item = db
      .prepare('SELECT oi.id, oi.status, oi.order_id, o.branch_id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id = ?')
      .get(itemId) as { id: number; status: string; order_id: number; branch_id: number } | undefined;
    if (!item) throw notFound('Test not found on any order');
    assertBranch(actor, item.branch_id);
    if (item.status === 'completed' || item.status === 'cancelled') throw conflict(`This test is already ${item.status}`);
    const reason = str(ctx.body, 'reason', { max: 300, min: 5 });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE order_items SET status = 'cancelled' WHERE id = ?").run(itemId);
      db.prepare("UPDATE results SET status = 'cancelled', cancel_reason = ? WHERE order_item_id = ? AND status <> 'authorized'").run(reason, itemId);
      audit(db, { actor, branchId: item.branch_id, action: 'order_item.cancel', entity: 'order_item', entityId: itemId, after: { reason } });
      // Nothing left to bill: void the invoice when no money is held against it. If money was paid, a manager refunds it first.
      const open = db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE order_id = ? AND status <> 'cancelled'").get(item.order_id) as { n: number };
      const inv = db.prepare('SELECT id, status, paid_paisa, refunded_paisa FROM invoices WHERE order_id = ?').get(item.order_id) as
        | { id: number; status: string; paid_paisa: number; refunded_paisa: number }
        | undefined;
      if (open.n === 0 && inv && inv.status !== 'void' && inv.paid_paisa === inv.refunded_paisa) {
        db.prepare("UPDATE invoices SET status = 'void', voided_by = ?, voided_at = ?, void_reason = ? WHERE id = ?").run(actor.id, nowIso(), 'Every test on the order was cancelled', inv.id);
        audit(db, { actor, branchId: item.branch_id, action: 'invoice.void', entity: 'invoice', entityId: inv.id, after: { reason: 'Every test on the order was cancelled', automatic: true } });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const done = await completeOrderIfDone(db, actor, item.order_id);
    return json({ ok: true, orderCompleted: done.completed, report: done.report });
  });

  r.post('/api/specimens/:id/store', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'specimens.write');
    const sp = loadSpecimen(db, actor, intParam(ctx.params.id!, 'id'));
    if (!['received', 'processing'].includes(sp.status)) throw conflict(`Specimen is ${sp.status}`);
    const open = db
      .prepare("SELECT COUNT(*) AS n FROM order_items WHERE specimen_id = ? AND status NOT IN ('completed','cancelled')")
      .get(sp.id) as { n: number };
    if (open.n > 0) throw conflict('Finish (authorize or cancel) every test on this specimen before storing or disposing of it');
    const disposition = oneOf(ctx.body, 'disposition', ['stored', 'disposed'] as const);
    db.prepare('UPDATE specimens SET status = ?, stored_at = ? WHERE id = ?').run(disposition, nowIso(), sp.id);
    audit(db, { actor, branchId: sp.branch_id, action: `specimen.${disposition}`, entity: 'specimen', entityId: sp.id });
    return specimenDto(db, sp.id);
  });

  // Printable label: QR of the accession number, patient name, MRN, tests and collection time.
  r.get('/api/specimens/:id/label', async (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'specimens.write');
    const sp = loadSpecimen(db, actor, intParam(ctx.params.id!, 'id'));
    const info = db
      .prepare(
        `SELECT p.full_name, p.mrn, p.gender, p.dob, b.name AS branch_name FROM orders o
         JOIN patients p ON p.id = o.patient_id JOIN branches b ON b.id = o.branch_id WHERE o.id = ?`,
      )
      .get(sp.order_id) as { full_name: string; mrn: string; gender: string; dob: string | null; branch_name: string };
    const tests = db
      .prepare(`SELECT t.name FROM order_items oi JOIN tests t ON t.id = oi.test_id WHERE oi.specimen_id = ? ORDER BY t.name`)
      .all(sp.id) as Array<{ name: string }>;
    const svg = await specimenLabelSvg(sp.accession_no);
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(sp.accession_no)}</title>
      <style>body{font-family:Arial,sans-serif;margin:0;padding:6px;width:260px}
      .l{font-size:11px;line-height:1.35}.a{font-weight:700;font-size:13px}@media print{@page{size:50mm 25mm;margin:2mm}}</style>
      </head><body>
      <div style="display:flex;gap:6px;align-items:center">${svg.replace('<svg', '<svg style="width:70px;height:70px"')}
      <div class="l"><div class="a">${esc(sp.accession_no)}</div>
      <div>${esc(info.full_name)} (${esc(info.mrn)})</div>
      <div>${esc(sp.specimen_type)} | ${esc(info.branch_name)}</div>
      <div>${esc(tests.map((t) => t.name).join(', ').slice(0, 120))}</div></div></div>
      <script>window.onload=()=>window.print()</script></body></html>`;
    return new RawResponse('text/html; charset=utf-8', html, { 'Content-Security-Policy': PRINT_CSP });
  });

  // Worklists: items waiting for or in processing, filtered by department, priority and date.
  r.get('/api/worklists', (ctx) => {
    const user = ctx.user!;
    if (!user.perms.has('results.enter') && !user.perms.has('results.review') && !user.perms.has('specimens.write')) {
      throw forbidden('worklists');
    }
    const q = ctx.query;
    const where: string[] = ["oi.status IN ('received','processing')"];
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
    const dept = intQuery(q, 'department');
    if (dept) {
      where.push('t.department_id = ?');
      vals.push(dept);
    }
    const priority = q.get('priority');
    if (priority) {
      where.push('o.priority = ?');
      vals.push(priority);
    }
    const date = q.get('date');
    if (date) {
      where.push('o.created_at >= ? AND o.created_at < ?');
      vals.push(dayStartUtc(date), dayEndUtc(date));
    }
    const rows = db
      .prepare(
        `SELECT oi.id AS order_item_id, oi.status, oi.tat_due_at, o.id AS order_id, o.order_no, o.priority, o.created_at,
                p.full_name AS patient_name, p.mrn, t.id AS test_id, t.name AS test_name, t.code AS test_code,
                d.id AS department_id, d.name AS department_name, sp.accession_no, sp.specimen_type,
                (SELECT COUNT(*) FROM test_parameters tp WHERE tp.test_id = t.id AND tp.is_active = 1) AS parameter_count,
                (SELECT COUNT(*) FROM results r WHERE r.order_item_id = oi.id AND r.status = 'authorized') AS authorized_count
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN patients p ON p.id = o.patient_id
         JOIN tests t ON t.id = oi.test_id
         JOIN departments d ON d.id = t.department_id
         JOIN specimens sp ON sp.id = oi.specimen_id
         WHERE ${where.join(' AND ')}
         ORDER BY CASE o.priority WHEN 'stat' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, oi.tat_due_at, oi.id
         LIMIT 500`,
      )
      .all(...vals);
    return rows;
  });

}

function loadSpecimen(db: DatabaseSync, user: AuthUser, id: number) {
  const sp = db
    .prepare(
      `SELECT s.*, b.code AS branch_code FROM specimens s JOIN branches b ON b.id = s.branch_id WHERE s.id = ?`,
    )
    .get(id) as
    | (Record<string, any> & { id: number; branch_id: number; order_id: number; status: string; specimen_type: string; branch_code: string; accession_no: string })
    | undefined;
  if (!sp) throw notFound('Specimen not found');
  assertBranch(user, Number(sp.branch_id));
  return sp as unknown as {
    id: number;
    branch_id: number;
    order_id: number;
    status: string;
    specimen_type: string;
    branch_code: string;
    accession_no: string;
  };
}

function specimenDto(db: DatabaseSync, id: number) {
  return db
    .prepare(
      `SELECT id, accession_no, specimen_type, status, collector_name, collected_at, received_at, reject_reason, recollect_required, order_id
       FROM specimens WHERE id = ?`,
    )
    .get(id);
}

export function orderDetail(db: DatabaseSync, user: AuthUser, id: number) {
  const order = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id) as Record<string, any> | undefined;
  if (!order) throw notFound('Order not found');
  assertBranch(user, Number(order.branch_id));
  const items = db
    .prepare(
      `SELECT oi.id, oi.status, oi.specimen_id, oi.tat_due_at, t.id AS test_id, t.code AS test_code, t.name AS test_name, d.name AS department_name,
              (SELECT COUNT(*) FROM results r WHERE r.order_item_id = oi.id AND r.status = 'authorized') AS authorized_count,
              (SELECT COUNT(*) FROM results r WHERE r.order_item_id = oi.id AND r.status <> 'cancelled') AS result_count
       FROM order_items oi JOIN tests t ON t.id = oi.test_id JOIN departments d ON d.id = t.department_id
       WHERE oi.order_id = ? ORDER BY d.display_order, t.name`,
    )
    .all(id);
  const specimens = db
    .prepare(
      `SELECT id, accession_no, specimen_type, status, collector_name, collected_at, received_at, reject_reason, recollect_required
       FROM specimens WHERE order_id = ? ORDER BY id`,
    )
    .all(id);
  const invoice = db
    .prepare(
      `SELECT id, invoice_no, subtotal_paisa, discount_paisa, discount_reason, tax_paisa, total_paisa, paid_paisa, refunded_paisa, status
       FROM invoices WHERE order_id = ?`,
    )
    .get(id) ?? null;
  const reports = db
    .prepare('SELECT id, report_no, version, status, issued_at FROM reports WHERE order_id = ? ORDER BY version DESC')
    .all(id);
  return { ...order, items, specimens, invoice, reports };
}
