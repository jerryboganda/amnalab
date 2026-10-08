import type { DatabaseSync } from 'node:sqlite';

// Branch price in effect today, else the test's base price. Price changes carry an effective date.
export function priceFor(db: DatabaseSync, branchId: number, testId: number, onDate: string): number {
  const row = db
    .prepare(
      `SELECT price_paisa FROM branch_prices
       WHERE branch_id = ? AND test_id = ? AND effective_from <= ?
       ORDER BY effective_from DESC, id DESC LIMIT 1`,
    )
    .get(branchId, testId, onDate) as { price_paisa: number } | undefined;
  if (row) return row.price_paisa;
  const base = db.prepare('SELECT base_price_paisa FROM tests WHERE id = ?').get(testId) as
    | { base_price_paisa: number }
    | undefined;
  return base?.base_price_paisa ?? 0;
}
