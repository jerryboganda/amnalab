import type { DatabaseSync } from 'node:sqlite';
import { audit } from '../audit.ts';

export interface LotBalance {
  lot_id: number;
  item_id: number;
  lot_no: string;
  expiry_date: string;
  qty: number;
}

// Balances per lot for one item in one branch. Expired lots still show here, so they can be wasted.
export function lotBalances(db: DatabaseSync, branchId: number, itemId: number): LotBalance[] {
  return db
    .prepare(
      `SELECT l.id AS lot_id, l.item_id, l.lot_no, l.expiry_date, SUM(g.qty) AS qty
       FROM inv_lots l JOIN inv_ledger g ON g.lot_id = l.id
       WHERE l.branch_id = ? AND l.item_id = ?
       GROUP BY l.id HAVING SUM(g.qty) > 0.0000001
       ORDER BY l.expiry_date ASC, l.id ASC`,
    )
    .all(branchId, itemId) as unknown as LotBalance[];
}

// First-expiry-first-out consumption. Writes one negative ledger line per lot touched.
// Returns the quantity that could not be covered (shortfall); it is never allowed to go negative.
export function consumeFefo(
  db: DatabaseSync,
  args: {
    branchId: number;
    itemId: number;
    qty: number;
    txnType: 'issue' | 'reagent_use' | 'wastage' | 'adjustment' | 'transfer_out';
    reason: string | null;
    reference: string | null;
    userId: number | null;
    approvedBy?: number | null;
  },
): { consumed: number; shortfall: number } {
  let remaining = args.qty;
  let consumed = 0;
  for (const lot of lotBalances(db, args.branchId, args.itemId)) {
    if (remaining <= 0) break;
    const take = Math.min(lot.qty, remaining);
    db.prepare(
      `INSERT INTO inv_ledger (branch_id, item_id, lot_id, txn_type, qty, reason, reference, approved_by, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(args.branchId, args.itemId, lot.lot_id, args.txnType, -take, args.reason, args.reference, args.approvedBy ?? null, args.userId);
    remaining -= take;
    consumed += take;
  }
  return { consumed, shortfall: Math.max(0, remaining) };
}

// Called once per order item, on its first saved result. Reagent use is recorded per test.
export function consumeReagentsForItem(db: DatabaseSync, branchId: number, orderItemId: number, testId: number, userId: number | null): void {
  const already = db.prepare('SELECT reagents_consumed FROM order_items WHERE id = ?').get(orderItemId) as
    | { reagents_consumed: number }
    | undefined;
  if (!already || already.reagents_consumed === 1) return;
  const needs = db
    .prepare('SELECT item_id, qty_per_test FROM test_reagents WHERE test_id = ?')
    .all(testId) as Array<{ item_id: number; qty_per_test: number }>;
  for (const n of needs) {
    const r = consumeFefo(db, {
      branchId,
      itemId: n.item_id,
      qty: n.qty_per_test,
      txnType: 'reagent_use',
      reason: 'Test processing',
      reference: `order_item:${orderItemId}`,
      userId,
    });
    if (r.shortfall > 0) {
      audit(db, {
        action: 'inventory.shortfall',
        entity: 'inv_item',
        entityId: n.item_id,
        branchId,
        after: { orderItemId, shortfall: r.shortfall },
      });
    }
  }
  db.prepare('UPDATE order_items SET reagents_consumed = 1 WHERE id = ?').run(orderItemId);
}
