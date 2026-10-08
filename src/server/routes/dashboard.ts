import type { DatabaseSync } from 'node:sqlite';
import type { Router } from '../http.ts';
import { intQuery, badRequest } from '../http.ts';
import { assertBranch, requirePerm, visibleBranches } from '../security.ts';
import { fromPaisa, businessDate } from '../util.ts';

// Lab day starts at local midnight in Asia/Karachi (UTC+5, no daylight saving).
const dayStartIso = (date: string) => new Date(`${date}T00:00:00+05:00`).toISOString();

export function registerDashboard(r: Router, db: DatabaseSync) {
  r.get('/api/dashboard', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'dashboard.read');
    const vis = visibleBranches(user);
    const branchId = intQuery(ctx.query, 'branchId');
    if (branchId) assertBranch(user, branchId);
    if (vis !== 'all' && vis.length === 0) throw badRequest('No branch is assigned to this user');

    // Scope filter: a single branch if chosen, else every branch the user can see.
    const scope: string[] = [];
    const scopeVals: number[] = [];
    if (branchId) {
      scope.push('branch_id = ?');
      scopeVals.push(branchId);
    } else if (vis !== 'all') {
      scope.push(`branch_id IN (${vis.map(() => '?').join(',')})`);
      scopeVals.push(...vis);
    }
    const s = (alias = '') => (scope.length ? scope.map((c) => `${alias}${c}`).join(' AND ') : '1=1');
    const count = (sql: string, vals: Array<string | number> = []) => (db.prepare(sql).get(...vals) as { n: number }).n;

    const today = businessDate('Asia/Karachi');
    const dayStart = dayStartIso(today);

    const ordersToday = count(`SELECT COUNT(*) AS n FROM orders WHERE ${s()} AND created_at >= ?`, [...scopeVals, dayStart]);
    const patientsToday = count(`SELECT COUNT(*) AS n FROM patients WHERE ${s()} AND created_at >= ?`, [...scopeVals, dayStart]);
    const awaitingCollection = count(`SELECT COUNT(*) AS n FROM specimens WHERE ${s()} AND status = 'expected'`, scopeVals);
    const awaitingReceipt = count(`SELECT COUNT(*) AS n FROM specimens WHERE ${s()} AND status = 'collected'`, scopeVals);
    const awaitingReview = count(
      `SELECT COUNT(*) AS n FROM results r JOIN order_items oi ON oi.id = r.order_item_id JOIN orders o ON o.id = oi.order_id
       WHERE ${s('r.')} AND r.status = 'draft'`,
      scopeVals,
    );
    const awaitingAuthorization = count(
      `SELECT COUNT(*) AS n FROM results r WHERE ${s('r.')} AND r.status = 'reviewed'`,
      scopeVals,
    );
    const criticalPending = count(
      `SELECT COUNT(*) AS n FROM results r WHERE ${s('r.')} AND r.critical = 1 AND r.status IN ('draft','reviewed')`,
      scopeVals,
    );
    const overdue = count(
      `SELECT COUNT(*) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE ${s('o.')} AND oi.status NOT IN ('completed','cancelled') AND oi.tat_due_at < ?`,
      [...scopeVals, new Date().toISOString()],
    );
    const completedToday = count(
      `SELECT COUNT(*) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${s('o.')} AND oi.completed_at >= ?`,
      [...scopeVals, dayStart],
    );
    const outboxFailed = count(`SELECT COUNT(*) AS n FROM outbox WHERE ${s()} AND status = 'failed'`, scopeVals);
    const outboxWaiting = count(
      `SELECT COUNT(*) AS n FROM outbox WHERE ${s()} AND status IN ('queued','retrying','awaiting_staff')`,
      scopeVals,
    );

    const cashRows = db
      .prepare(
        `SELECT method, kind, SUM(amount_paisa) AS total FROM payments WHERE ${s()} AND business_date = ? GROUP BY method, kind`,
      )
      .all(...scopeVals, today) as Array<{ method: string; kind: string; total: number }>;
    const byMethod: Record<string, number> = {};
    for (const row of cashRows) {
      byMethod[row.method] = (byMethod[row.method] ?? 0) + (row.kind === 'refund' ? -row.total : row.total);
    }
    const collectedPaisa = Object.values(byMethod).reduce((a, b) => a + b, 0);

    const unpaid = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_paisa - paid_paisa + refunded_paisa), 0) AS due
         FROM invoices WHERE ${s()} AND status IN ('issued','partially_paid')`,
      )
      .get(...scopeVals) as { n: number; due: number };

    const lowStock = count(
      `SELECT COUNT(*) AS n FROM (
         SELECT i.id, i.reorder_level, COALESCE(SUM(g.qty), 0) AS onhand FROM inv_items i
         LEFT JOIN inv_ledger g ON g.item_id = i.id ${branchId ? 'AND g.branch_id = ?' : ''}
         WHERE i.is_active = 1 AND i.reorder_level > 0 GROUP BY i.id HAVING onhand <= i.reorder_level)`,
      branchId ? [branchId] : [],
    );

    return {
      businessDate: today,
      scope: branchId ? 'branch' : 'all-visible',
      operations: {
        ordersToday,
        patientsToday,
        awaitingCollection,
        awaitingReceipt,
        awaitingReview,
        awaitingAuthorization,
        criticalPending,
        overdue,
        completedToday,
      },
      messaging: { outboxFailed, outboxWaiting },
      finance: {
        collectedTodayPkr: fromPaisa(collectedPaisa),
        byMethodPkr: Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, fromPaisa(v)])),
        unpaidInvoices: unpaid.n,
        unpaidDuePkr: fromPaisa(unpaid.due),
      },
      inventory: { lowStockItems: lowStock },
    };
  });
}
