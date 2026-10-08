import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/server/db.ts';
import { consumeFefo, lotBalances } from '../../src/server/services/inventory-core.ts';

// In-memory database with the real migrations applied.
const db = openDb(':memory:');

test('migrations apply and audit log is append-only', () => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Org') RETURNING id").get() as { id: number };
  db.prepare("INSERT INTO audit_events (action, entity) VALUES ('test', 'x')").run();
  assert.throws(() => db.prepare("UPDATE audit_events SET action = 'changed'").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_events').run(), /append-only/);
  assert.ok(org.id > 0);
});

test('FEFO consumption uses the earliest-expiring lot first and never goes negative', () => {
  const branch = db.prepare("INSERT INTO branches (organization_id, name, code) VALUES (1, 'Main', 'MAIN') RETURNING id").get() as { id: number };
  const item = db.prepare("INSERT INTO inv_items (code, name) VALUES ('REAG1', 'Reagent 1') RETURNING id").get() as { id: number };
  const late = db
    .prepare("INSERT INTO inv_lots (item_id, branch_id, lot_no, expiry_date) VALUES (?, ?, 'L2', '2028-12-31') RETURNING id")
    .get(item.id, branch.id) as { id: number };
  const early = db
    .prepare("INSERT INTO inv_lots (item_id, branch_id, lot_no, expiry_date) VALUES (?, ?, 'L1', '2027-01-31') RETURNING id")
    .get(item.id, branch.id) as { id: number };
  db.prepare("INSERT INTO inv_ledger (branch_id, item_id, lot_id, txn_type, qty) VALUES (?, ?, ?, 'receipt', 5)").run(branch.id, item.id, late.id);
  db.prepare("INSERT INTO inv_ledger (branch_id, item_id, lot_id, txn_type, qty) VALUES (?, ?, ?, 'receipt', 4)").run(branch.id, item.id, early.id);

  const r = consumeFefo(db, { branchId: branch.id, itemId: item.id, qty: 6, txnType: 'issue', reason: 'test', reference: null, userId: null });
  assert.equal(r.consumed, 6);
  assert.equal(r.shortfall, 0);
  const left = lotBalances(db, branch.id, item.id);
  assert.deepEqual(
    left.map((l) => [l.lot_no, l.qty]),
    [['L2', 3]],
  );

  const over = consumeFefo(db, { branchId: branch.id, itemId: item.id, qty: 10, txnType: 'issue', reason: 'test', reference: null, userId: null });
  assert.equal(over.consumed, 3);
  assert.equal(over.shortfall, 7);
  assert.equal(lotBalances(db, branch.id, item.id).length, 0);

  // The ledger has rows now, so the immutability trigger must fire on any change.
  assert.throws(() => db.prepare('UPDATE inv_ledger SET qty = 1').run(), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM inv_ledger').run(), /immutable/);
});
