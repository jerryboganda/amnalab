import type { DatabaseSync } from 'node:sqlite';
import type { Router } from '../http.ts';
import { badRequest, conflict, int, intParam, intQuery, invalid, json, notFound, num, oneOf, optStr, str } from '../http.ts';
import { audit } from '../audit.ts';
import { assertBranch, requirePerm, type AuthUser } from '../security.ts';
import { getSettings } from '../services/settings.ts';
import { verifyApprover } from '../services/approval.ts';
import { consumeFefo, lotBalances } from '../services/inventory-core.ts';
import { addDays, businessDate, nowIso } from '../util.ts';

const TODAY_TZ = 'Asia/Karachi';

function itemRow(db: DatabaseSync, id: number) {
  const it = db.prepare('SELECT * FROM inv_items WHERE id = ?').get(id) as Record<string, any> | undefined;
  if (!it) throw notFound('Item not found');
  return it;
}

function getOrCreateLot(
  db: DatabaseSync,
  args: { itemId: number; branchId: number; lotNo: string; expiry: string; supplierId: number | null; locationId: number | null },
): number {
  const existing = db
    .prepare('SELECT id, expiry_date FROM inv_lots WHERE item_id = ? AND branch_id = ? AND lot_no = ?')
    .get(args.itemId, args.branchId, args.lotNo) as { id: number; expiry_date: string } | undefined;
  if (existing) {
    if (existing.expiry_date !== args.expiry) throw conflict(`Lot ${args.lotNo} already exists with expiry ${existing.expiry_date}`);
    return existing.id;
  }
  const row = db
    .prepare(
      `INSERT INTO inv_lots (item_id, branch_id, lot_no, expiry_date, supplier_id, location_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(args.itemId, args.branchId, args.lotNo, args.expiry, args.supplierId, args.locationId) as { id: number };
  return row.id;
}

function lotOnHand(db: DatabaseSync, lotId: number): number {
  const row = db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM inv_ledger WHERE lot_id = ?').get(lotId) as { q: number };
  return row.q;
}

export function registerInventory(r: Router, db: DatabaseSync) {
  // ---- Masters
  r.get('/api/inventory/categories', (ctx) => {
    requirePerm(ctx.user!, 'inventory.read');
    return db.prepare('SELECT id, name FROM inv_categories ORDER BY name').all();
  });
  r.post('/api/inventory/categories', (ctx) => {
    requirePerm(ctx.user!, 'inventory.write');
    const name = str(ctx.body, 'name', { max: 80 });
    if (db.prepare('SELECT id FROM inv_categories WHERE name = ?').get(name)) throw conflict('Category already exists');
    const row = db.prepare('INSERT INTO inv_categories (name) VALUES (?) RETURNING id').get(name) as { id: number };
    return json({ id: row.id, name }, 201);
  });

  r.get('/api/inventory/suppliers', (ctx) => {
    requirePerm(ctx.user!, 'inventory.read');
    return db.prepare('SELECT id, name, contact FROM inv_suppliers ORDER BY name').all();
  });
  r.post('/api/inventory/suppliers', (ctx) => {
    requirePerm(ctx.user!, 'inventory.write');
    const name = str(ctx.body, 'name', { max: 120 });
    if (db.prepare('SELECT id FROM inv_suppliers WHERE name = ?').get(name)) throw conflict('Supplier already exists');
    const row = db.prepare('INSERT INTO inv_suppliers (name, contact) VALUES (?, ?) RETURNING id').get(name, optStr(ctx.body, 'contact', 120)) as { id: number };
    return json({ id: row.id, name }, 201);
  });

  r.get('/api/inventory/locations', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'inventory.read');
    const branchId = intQuery(ctx.query, 'branchId');
    if (!branchId) throw badRequest('branchId is required');
    assertBranch(user, branchId);
    return db.prepare('SELECT id, name FROM inv_locations WHERE branch_id = ? ORDER BY name').all(branchId);
  });
  r.post('/api/inventory/locations', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'inventory.write');
    const branchId = int(ctx.body, 'branchId', { min: 1 });
    assertBranch(user, branchId);
    const name = str(ctx.body, 'name', { max: 80 });
    if (db.prepare('SELECT id FROM inv_locations WHERE branch_id = ? AND name = ?').get(branchId, name)) throw conflict('Location already exists');
    const row = db.prepare('INSERT INTO inv_locations (branch_id, name) VALUES (?, ?) RETURNING id').get(branchId, name) as { id: number };
    return json({ id: row.id, name }, 201);
  });

  r.get('/api/inventory/items', (ctx) => {
    requirePerm(ctx.user!, 'inventory.read');
    return db
      .prepare(
        `SELECT i.id, i.code, i.name, i.unit, i.reorder_level, i.near_expiry_days, i.is_active, i.category_id, c.name AS category_name
         FROM inv_items i LEFT JOIN inv_categories c ON c.id = i.category_id ORDER BY i.name`,
      )
      .all();
  });

  r.post('/api/inventory/items', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'inventory.write');
    const b = ctx.body;
    const code = str(b, 'code', { max: 24 }).toUpperCase();
    if (!/^[A-Z0-9_-]+$/.test(code)) throw invalid('Item code may use letters, digits, dash and underscore');
    if (db.prepare('SELECT id FROM inv_items WHERE code = ?').get(code)) throw conflict('Item code already exists');
    const row = db
      .prepare(
        `INSERT INTO inv_items (code, name, category_id, unit, reorder_level, near_expiry_days) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        code,
        str(b, 'name', { max: 120 }),
        b.categoryId == null ? null : int(b, 'categoryId', { min: 1 }),
        str(b, 'unit', { max: 20, required: false }) || 'pcs',
        num(b, 'reorderLevel', { min: 0, max: 1_000_000, required: false }),
        int(b, 'nearExpiryDays', { min: 0, max: 3650, required: false }) || 60,
      ) as { id: number };
    audit(db, { actor: user, action: 'inventory.item_create', entity: 'inv_item', entityId: row.id, after: { code } });
    return json({ id: row.id }, 201);
  });

  r.patch('/api/inventory/items/:id', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'inventory.write');
    const id = intParam(ctx.params.id!, 'id');
    const before = itemRow(db, id);
    const b = ctx.body;
    db.prepare('UPDATE inv_items SET name = ?, reorder_level = ?, near_expiry_days = ?, is_active = ? WHERE id = ?').run(
      b.name !== undefined ? str(b, 'name', { max: 120 }) : before.name,
      b.reorderLevel !== undefined ? num(b, 'reorderLevel', { min: 0, max: 1_000_000 }) : before.reorder_level,
      b.nearExpiryDays !== undefined ? int(b, 'nearExpiryDays', { min: 0, max: 3650 }) : before.near_expiry_days,
      b.isActive !== undefined ? (b.isActive === false ? 0 : 1) : before.is_active,
      id,
    );
    audit(db, { actor: user, action: 'inventory.item_update', entity: 'inv_item', entityId: id, before: { reorder_level: before.reorder_level }, after: { reorderLevel: b.reorderLevel } });
    return { ok: true };
  });

  // ---- Stock view
  r.get('/api/inventory/stock', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'inventory.read');
    const branchId = intQuery(ctx.query, 'branchId');
    if (!branchId) throw badRequest('branchId is required');
    assertBranch(user, branchId);
    const today = businessDate(TODAY_TZ);
    const items = db.prepare('SELECT id, code, name, unit, reorder_level, near_expiry_days FROM inv_items WHERE is_active = 1 ORDER BY name').all() as Array<
      Record<string, any>
    >;
    return items.map((it) => {
      const lots = lotBalances(db, branchId, Number(it.id));
      const onHand = lots.reduce((s, l) => s + l.qty, 0);
      const nearLimit = addDays(today, Number(it.near_expiry_days));
      return {
        ...it,
        onHand,
        lowStock: onHand <= Number(it.reorder_level) && Number(it.reorder_level) > 0,
        lots: lots.map((l) => ({
          lotId: l.lot_id,
          lotNo: l.lot_no,
          expiry: l.expiry_date,
          qty: l.qty,
          expired: l.expiry_date < today,
          nearExpiry: l.expiry_date >= today && l.expiry_date <= nearLimit,
        })),
      };
    });
  });

  r.post('/api/inventory/receipts', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'inventory.write');
    const b = ctx.body;
    const branchId = int(b, 'branchId', { min: 1 });
    assertBranch(user, branchId);
    const itemId = int(b, 'itemId', { min: 1 });
    itemRow(db, itemId);
    const qty = num(b, 'qty', { min: 0.001, max: 1_000_000 });
    const expiry = str(b, 'expiryDate', { max: 10, min: 10 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw invalid('expiryDate must be YYYY-MM-DD');
    if (expiry < businessDate(TODAY_TZ)) throw invalid('Cannot receive stock that has already expired');
    const lotNo = str(b, 'lotNo', { max: 60 });
    const supplierId = b.supplierId == null ? null : int(b, 'supplierId', { min: 1 });
    const locationId = b.locationId == null ? null : int(b, 'locationId', { min: 1 });
    db.exec('BEGIN IMMEDIATE');
    try {
      const lotId = getOrCreateLot(db, { itemId, branchId, lotNo, expiry, supplierId, locationId });
      db.prepare(
        `INSERT INTO inv_ledger (branch_id, item_id, lot_id, txn_type, qty, reason, reference, created_by) VALUES (?, ?, ?, 'receipt', ?, ?, ?, ?)`,
      ).run(branchId, itemId, lotId, qty, optStr(b, 'reference', 80) ?? 'Goods received', optStr(b, 'reference', 80), user.id);
      audit(db, { actor: user, branchId, action: 'inventory.receipt', entity: 'inv_lot', entityId: lotId, after: { qty, lotNo, expiry } });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return json({ ok: true }, 201);
  });

  r.post('/api/inventory/issues', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'inventory.write');
    const b = ctx.body;
    const branchId = int(b, 'branchId', { min: 1 });
    assertBranch(user, branchId);
    const itemId = int(b, 'itemId', { min: 1 });
    itemRow(db, itemId);
    const qty = num(b, 'qty', { min: 0.001, max: 1_000_000 });
    const reason = str(b, 'reason', { max: 200, min: 3 });
    const available = lotBalances(db, branchId, itemId).reduce((s, l) => s + l.qty, 0);
    if (qty > available) throw conflict(`Only ${available} available in this branch`);
    db.exec('BEGIN IMMEDIATE');
    try {
      consumeFefo(db, { branchId, itemId, qty, txnType: 'issue', reason, reference: optStr(b, 'reference', 80), userId: user.id });
      audit(db, { actor: user, branchId, action: 'inventory.issue', entity: 'inv_item', entityId: itemId, after: { qty, reason } });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return json({ ok: true }, 201);
  });

  // Adjustments, wastage and returns on one lot. Large adjustments need a second approver.
  r.post('/api/inventory/adjustments', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'inventory.write');
    const b = ctx.body;
    const branchId = int(b, 'branchId', { min: 1 });
    assertBranch(user, branchId);
    const lotId = int(b, 'lotId', { min: 1 });
    const lot = db.prepare('SELECT id, item_id, branch_id FROM inv_lots WHERE id = ?').get(lotId) as
      | { id: number; item_id: number; branch_id: number }
      | undefined;
    if (!lot || lot.branch_id !== branchId) throw badRequest('Lot not found in this branch');
    const qty = num(b, 'qty', { min: -1_000_000, max: 1_000_000 });
    if (qty === 0) throw invalid('Quantity cannot be zero');
    const txnType = oneOf(b, 'txnType', ['adjustment', 'wastage', 'return'] as const, false) || 'adjustment';
    const reason = str(b, 'reason', { max: 200, min: 5 });
    const onHand = lotOnHand(db, lotId);
    if (onHand + qty < -1e-9) throw conflict(`Adjustment would make the lot negative (on hand ${onHand})`);
    const threshold = getSettings(db).adjustment_approval_threshold;
    let approvedBy: number | null = null;
    if (Math.abs(qty) > threshold) {
      approvedBy = verifyApprover(db, user, b.approver as { username?: unknown; password?: unknown }, 'inventory.adjust_approve').id;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO inv_ledger (branch_id, item_id, lot_id, txn_type, qty, reason, reference, approved_by, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(branchId, lot.item_id, lotId, txnType, qty, reason, optStr(b, 'reference', 80), approvedBy, user.id);
      audit(db, { actor: user, branchId, action: `inventory.${txnType}`, entity: 'inv_lot', entityId: lotId, after: { qty, reason, approvedBy } });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return json({ ok: true, onHand: onHand + qty }, 201);
  });

  // Branch-to-branch transfer: FEFO out of the source, same lot numbers and expiry into the destination.
  r.post('/api/inventory/transfers', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'inventory.write');
    const b = ctx.body;
    const fromBranch = int(b, 'fromBranchId', { min: 1 });
    const toBranch = int(b, 'toBranchId', { min: 1 });
    assertBranch(user, fromBranch);
    assertBranch(user, toBranch);
    if (fromBranch === toBranch) throw badRequest('Source and destination branch are the same');
    const itemId = int(b, 'itemId', { min: 1 });
    const qty = num(b, 'qty', { min: 0.001, max: 1_000_000 });
    const available = lotBalances(db, fromBranch, itemId).reduce((s, l) => s + l.qty, 0);
    if (qty > available) throw conflict(`Only ${available} available at the source branch`);
    const reason = str(b, 'reason', { max: 200, min: 3 });
    db.exec('BEGIN IMMEDIATE');
    try {
      let remaining = qty;
      for (const lot of lotBalances(db, fromBranch, itemId)) {
        if (remaining <= 0) break;
        const take = Math.min(lot.qty, remaining);
        db.prepare(
          `INSERT INTO inv_ledger (branch_id, item_id, lot_id, txn_type, qty, reason, reference, created_by) VALUES (?, ?, ?, 'transfer_out', ?, ?, ?, ?)`,
        ).run(fromBranch, itemId, lot.lot_id, -take, reason, `to branch ${toBranch}`, user.id);
        const destLot = getOrCreateLot(db, { itemId, branchId: toBranch, lotNo: lot.lot_no, expiry: lot.expiry_date, supplierId: null, locationId: null });
        db.prepare(
          `INSERT INTO inv_ledger (branch_id, item_id, lot_id, txn_type, qty, reason, reference, created_by) VALUES (?, ?, ?, 'transfer_in', ?, ?, ?, ?)`,
        ).run(toBranch, itemId, destLot, take, reason, `from branch ${fromBranch}`, user.id);
        remaining -= take;
      }
      audit(db, { actor: user, branchId: fromBranch, action: 'inventory.transfer', entity: 'inv_item', entityId: itemId, after: { qty, toBranch } });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return json({ ok: true }, 201);
  });

  r.get('/api/inventory/ledger', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'inventory.read');
    const branchId = intQuery(ctx.query, 'branchId');
    if (!branchId) throw badRequest('branchId is required');
    assertBranch(user, branchId);
    const itemId = intQuery(ctx.query, 'itemId');
    const vals: Array<number> = [branchId];
    let sql = `SELECT g.id, g.created_at, g.txn_type, g.qty, g.reason, g.reference, l.lot_no, l.expiry_date, i.code, i.name,
                      u.username AS created_by, a.username AS approved_by
               FROM inv_ledger g JOIN inv_lots l ON l.id = g.lot_id JOIN inv_items i ON i.id = g.item_id
               LEFT JOIN users u ON u.id = g.created_by LEFT JOIN users a ON a.id = g.approved_by
               WHERE g.branch_id = ?`;
    if (itemId) {
      sql += ' AND g.item_id = ?';
      vals.push(itemId);
    }
    sql += ' ORDER BY g.id DESC LIMIT 500';
    return db.prepare(sql).all(...vals);
  });

  r.get('/api/inventory/alerts', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'inventory.read');
    const branchId = intQuery(ctx.query, 'branchId');
    if (!branchId) throw badRequest('branchId is required');
    assertBranch(user, branchId);
    const today = businessDate(TODAY_TZ);
    const items = db.prepare('SELECT id, code, name, reorder_level, near_expiry_days FROM inv_items WHERE is_active = 1').all() as Array<{
      id: number;
      code: string;
      name: string;
      reorder_level: number;
      near_expiry_days: number;
    }>;
    const low: unknown[] = [];
    const nearExpiry: unknown[] = [];
    const expired: unknown[] = [];
    for (const it of items) {
      const lots = lotBalances(db, branchId, it.id);
      const onHand = lots.reduce((s, l) => s + l.qty, 0);
      if (it.reorder_level > 0 && onHand <= it.reorder_level) low.push({ code: it.code, name: it.name, onHand, reorderLevel: it.reorder_level });
      const limit = addDays(today, it.near_expiry_days);
      for (const l of lots) {
        const base = { code: it.code, name: it.name, lotNo: l.lot_no, expiry: l.expiry_date, qty: l.qty };
        if (l.expiry_date < today) expired.push(base);
        else if (l.expiry_date <= limit) nearExpiry.push(base);
      }
    }
    return { low, nearExpiry, expired, generatedAt: nowIso() };
  });
}
