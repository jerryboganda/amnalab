import type { DatabaseSync } from 'node:sqlite';
import type { Router } from '../http.ts';
import { RawResponse, badRequest, bool, conflict, int, intParam, invalid, json, notFound, num, oneOf, optStr, str } from '../http.ts';
import { audit } from '../audit.ts';
import { requirePerm, type AuthUser } from '../security.ts';
import { toPaisa, fromPaisa, businessDate } from '../util.ts';
import { parseCsv, toCsv } from '../services/csv.ts';
import { validateFormula } from '../services/formula.ts';

const RESULT_TYPES = ['numeric', 'text', 'qualitative', 'calculated'] as const;

function testDto(row: Record<string, any>) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    departmentId: row.department_id,
    departmentName: row.department_name ?? null,
    specimenType: row.specimen_type,
    isPanel: row.is_panel === 1,
    basePricePkr: fromPaisa(Number(row.base_price_paisa)),
    taxRatePercent: Number(row.tax_rate_bp) / 100,
    tatHours: row.tat_hours,
    loincCode: row.loinc_code,
    methodNote: row.method_note,
    displayOrder: row.display_order,
    isActive: row.is_active === 1,
  };
}

function ensureDepartment(db: DatabaseSync, id: number): void {
  if (!db.prepare('SELECT id FROM departments WHERE id = ?').get(id)) throw badRequest('Department not found');
}

function paramsOf(db: DatabaseSync, testId: number) {
  const params = db
    .prepare('SELECT * FROM test_parameters WHERE test_id = ? AND is_active = 1 ORDER BY display_order, id')
    .all(testId) as Array<Record<string, any>>;
  return params.map((p) => {
    const ranges = db
      .prepare(
        `SELECT id, sex, age_min_days, age_max_days, low, high, text_range, status, version, note, created_by, approved_by, approved_at
         FROM reference_ranges WHERE parameter_id = ? AND status IN ('approved','pending') ORDER BY status, sex, age_min_days`,
      )
      .all(p.id);
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      unit: p.unit,
      decimals: p.decimals,
      resultType: p.result_type,
      formula: p.formula,
      qualitativeOptions: p.qualitative_options ? JSON.parse(String(p.qualitative_options)) : null,
      criticalLow: p.critical_low,
      criticalHigh: p.critical_high,
      displayOrder: p.display_order,
      ranges,
    };
  });
}

// Four-eyes rule for reference ranges: the approver must be a different pathologist.
function approveRange(db: DatabaseSync, actor: AuthUser, rangeId: number): void {
  const row = db
    .prepare('SELECT id, parameter_id, sex, age_min_days, age_max_days, status, created_by FROM reference_ranges WHERE id = ?')
    .get(rangeId) as
    | { id: number; parameter_id: number; sex: string; age_min_days: number; age_max_days: number; status: string; created_by: number | null }
    | undefined;
  if (!row) throw notFound('Range not found');
  if (row.status !== 'pending') throw conflict('Only pending ranges can be approved');
  if (row.created_by === actor.id) throw conflict('A different pathologist must approve a range change');
  db.exec('BEGIN IMMEDIATE');
  try {
    // The previous approved range for the same band is retired, never deleted, so history is kept.
    db.prepare(
      `UPDATE reference_ranges SET status = 'retired'
       WHERE parameter_id = ? AND sex = ? AND age_min_days = ? AND age_max_days = ? AND status = 'approved'`,
    ).run(row.parameter_id, row.sex, row.age_min_days, row.age_max_days);
    db.prepare(
      `UPDATE reference_ranges SET status = 'approved', approved_by = ?, approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).run(actor.id, rangeId);
    audit(db, { actor, action: 'range.approve', entity: 'reference_range', entityId: rangeId });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function registerCatalog(r: Router, db: DatabaseSync) {
  r.get('/api/catalog/departments', (ctx) => {
    requirePerm(ctx.user!, 'catalog.read');
    return db.prepare('SELECT id, code, name, display_order FROM departments ORDER BY display_order, name').all();
  });

  r.post('/api/catalog/departments', (ctx) => {
    requirePerm(ctx.user!, 'catalog.write');
    const code = str(ctx.body, 'code', { max: 12 }).toUpperCase();
    const name = str(ctx.body, 'name', { max: 80 });
    if (db.prepare('SELECT id FROM departments WHERE code = ?').get(code)) throw conflict('Department code already exists');
    const row = db
      .prepare('INSERT INTO departments (code, name, display_order) VALUES (?, ?, ?) RETURNING id')
      .get(code, name, int(ctx.body, 'displayOrder', { min: 0, max: 999, required: false })) as { id: number };
    audit(db, { actor: ctx.user!, action: 'department.create', entity: 'department', entityId: row.id, after: { code, name } });
    return json({ id: row.id }, 201);
  });

  r.get('/api/catalog/tests', (ctx) => {
    if (!ctx.user!.perms.has('orders.write')) requirePerm(ctx.user!, 'catalog.read');
    const q = (ctx.query.get('q') ?? '').trim();
    const dept = ctx.query.get('department');
    const includeInactive = ctx.query.get('all') === '1';
    const where: string[] = [];
    const vals: Array<string | number> = [];
    if (!includeInactive) where.push('t.is_active = 1');
    if (q) {
      where.push('(t.name LIKE ? OR t.code LIKE ?)');
      vals.push(`%${q}%`, `%${q}%`);
    }
    if (dept) {
      where.push('t.department_id = ?');
      vals.push(Number(dept));
    }
    const rows = db
      .prepare(
        `SELECT t.*, d.name AS department_name FROM tests t JOIN departments d ON d.id = t.department_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.display_order, t.display_order, t.name LIMIT 1000`,
      )
      .all(...vals) as Array<Record<string, any>>;
    return rows.map(testDto);
  });

  r.get('/api/catalog/tests/:id', (ctx) => {
    requirePerm(ctx.user!, 'catalog.read');
    const id = intParam(ctx.params.id!, 'id');
    const row = db
      .prepare('SELECT t.*, d.name AS department_name FROM tests t JOIN departments d ON d.id = t.department_id WHERE t.id = ?')
      .get(id) as Record<string, any> | undefined;
    if (!row) throw notFound('Test not found');
    const members = db
      .prepare(
        `SELECT t.id, t.code, t.name FROM panel_members pm JOIN tests t ON t.id = pm.member_test_id WHERE pm.panel_test_id = ? ORDER BY t.name`,
      )
      .all(id);
    const reagents = db
      .prepare(
        `SELECT i.id AS item_id, i.code, i.name, i.unit, tr.qty_per_test FROM test_reagents tr JOIN inv_items i ON i.id = tr.item_id WHERE tr.test_id = ?`,
      )
      .all(id);
    const prices = db
      .prepare(
        `SELECT bp.branch_id, b.code AS branch_code, bp.price_paisa, bp.effective_from FROM branch_prices bp
         JOIN branches b ON b.id = bp.branch_id WHERE bp.test_id = ? ORDER BY bp.effective_from DESC, bp.id DESC LIMIT 50`,
      )
      .all(id)
      .map((p) => ({ ...p, price_pkr: fromPaisa(Number((p as { price_paisa: number }).price_paisa)) }));
    return { ...testDto(row), parameters: paramsOf(db, id), members, reagents, prices };
  });

  r.post('/api/catalog/tests', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'catalog.write');
    const b = ctx.body;
    const code = str(b, 'code', { max: 24 }).toUpperCase();
    if (!/^[A-Z0-9_-]+$/.test(code)) throw invalid('Test code may use letters, digits, dash and underscore');
    const departmentId = int(b, 'departmentId', { min: 1 });
    ensureDepartment(db, departmentId);
    if (db.prepare('SELECT id FROM tests WHERE code = ?').get(code)) throw conflict('Test code already exists');
    const isPanel = bool(b, 'isPanel');
    const members = isPanel && Array.isArray(b.memberTestIds) ? (b.memberTestIds as unknown[]).map((x) => Number(x)) : [];
    if (isPanel && members.length === 0) throw invalid('A panel needs at least one member test');

    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db
        .prepare(
          `INSERT INTO tests (code, name, department_id, specimen_type, is_panel, base_price_paisa, tax_rate_bp, tat_hours, loinc_code, method_note, display_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          code,
          str(b, 'name', { max: 120 }),
          departmentId,
          str(b, 'specimenType', { max: 60 }),
          isPanel ? 1 : 0,
          toPaisa(num(b, 'basePricePkr', { min: 0, max: 10_000_000, required: false })),
          Math.round(num(b, 'taxRatePercent', { min: 0, max: 100, required: false }) * 100),
          int(b, 'tatHours', { min: 1, max: 24 * 60, required: false }) || 24,
          optStr(b, 'loincCode', 20),
          optStr(b, 'methodNote', 200),
          int(b, 'displayOrder', { min: 0, max: 9999, required: false }),
        ) as { id: number };
      for (const m of members) {
        if (m === row.id) continue;
        if (!db.prepare('SELECT id FROM tests WHERE id = ?').get(m)) throw badRequest(`Panel member ${m} not found`);
        db.prepare('INSERT INTO panel_members (panel_test_id, member_test_id) VALUES (?, ?)').run(row.id, m);
      }
      audit(db, { actor, action: 'test.create', entity: 'test', entityId: row.id, after: { code, isPanel } });
      db.exec('COMMIT');
      return json({ id: row.id }, 201);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });

  r.patch('/api/catalog/tests/:id', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'catalog.write');
    const id = intParam(ctx.params.id!, 'id');
    const before = db.prepare('SELECT * FROM tests WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!before) throw notFound('Test not found');
    const b = ctx.body;
    const priceChanged = b.basePricePkr !== undefined;
    db.prepare(
      `UPDATE tests SET name = ?, base_price_paisa = ?, tax_rate_bp = ?, tat_hours = ?, method_note = ?, is_active = ?, specimen_type = ?
       WHERE id = ?`,
    ).run(
      b.name !== undefined ? str(b, 'name', { max: 120 }) : before.name,
      priceChanged ? toPaisa(num(b, 'basePricePkr', { min: 0, max: 10_000_000 })) : before.base_price_paisa,
      b.taxRatePercent !== undefined ? Math.round(num(b, 'taxRatePercent', { min: 0, max: 100 }) * 100) : before.tax_rate_bp,
      b.tatHours !== undefined ? int(b, 'tatHours', { min: 1, max: 24 * 60 }) : before.tat_hours,
      b.methodNote !== undefined ? optStr(b, 'methodNote', 200) : before.method_note,
      b.isActive !== undefined ? (bool(b, 'isActive') ? 1 : 0) : before.is_active,
      b.specimenType !== undefined ? str(b, 'specimenType', { max: 60 }) : before.specimen_type,
      id,
    );
    audit(db, {
      actor,
      action: priceChanged ? 'test.price_change' : 'test.update',
      entity: 'test',
      entityId: id,
      before: { base_price_paisa: before.base_price_paisa, is_active: before.is_active },
      after: { base_price_paisa: priceChanged ? toPaisa(num(b, 'basePricePkr', { min: 0, max: 10_000_000 })) : before.base_price_paisa },
    });
    return { ok: true };
  });

  r.post('/api/catalog/tests/:id/parameters', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'catalog.write');
    const testId = intParam(ctx.params.id!, 'id');
    if (!db.prepare('SELECT id FROM tests WHERE id = ?').get(testId)) throw notFound('Test not found');
    const b = ctx.body;
    const code = str(b, 'code', { max: 24 }).toUpperCase();
    const resultType = oneOf(b, 'resultType', RESULT_TYPES);
    const formula = resultType === 'calculated' ? str(b, 'formula', { max: 200 }) : null;
    const options = Array.isArray(b.qualitativeOptions) ? (b.qualitativeOptions as unknown[]).map(String) : null;
    if (db.prepare('SELECT id FROM test_parameters WHERE test_id = ? AND code = ?').get(testId, code)) {
      throw conflict('Parameter code already exists for this test');
    }
    if (formula) {
      const siblings = db.prepare('SELECT code FROM test_parameters WHERE test_id = ? AND is_active = 1').all(testId) as Array<{ code: string }>;
      const problem = validateFormula(formula, [...siblings.map((s) => s.code), code].filter((c) => c !== code));
      if (problem) throw invalid(`Formula: ${problem}`);
    }
    const row = db
      .prepare(
        `INSERT INTO test_parameters (test_id, code, name, unit, decimals, result_type, formula, qualitative_options, critical_low, critical_high, display_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        testId,
        code,
        str(b, 'name', { max: 120 }),
        optStr(b, 'unit', 30),
        int(b, 'decimals', { min: 0, max: 6, required: false }),
        resultType,
        formula,
        options ? JSON.stringify(options) : null,
        b.criticalLow == null ? null : num(b, 'criticalLow'),
        b.criticalHigh == null ? null : num(b, 'criticalHigh'),
        int(b, 'displayOrder', { min: 0, max: 9999, required: false }),
      ) as { id: number };
    audit(db, { actor, action: 'parameter.create', entity: 'test_parameter', entityId: row.id, after: { testId, code, resultType } });
    return json({ id: row.id }, 201);
  });

  r.patch('/api/catalog/parameters/:id', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'catalog.write');
    const id = intParam(ctx.params.id!, 'id');
    const before = db.prepare('SELECT * FROM test_parameters WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!before) throw notFound('Parameter not found');
    const b = ctx.body;
    db.prepare(
      `UPDATE test_parameters SET name = ?, unit = ?, decimals = ?, critical_low = ?, critical_high = ?, display_order = ?, is_active = ? WHERE id = ?`,
    ).run(
      b.name !== undefined ? str(b, 'name', { max: 120 }) : before.name,
      b.unit !== undefined ? optStr(b, 'unit', 30) : before.unit,
      b.decimals !== undefined ? int(b, 'decimals', { min: 0, max: 6 }) : before.decimals,
      b.criticalLow !== undefined ? (b.criticalLow == null ? null : num(b, 'criticalLow')) : before.critical_low,
      b.criticalHigh !== undefined ? (b.criticalHigh == null ? null : num(b, 'criticalHigh')) : before.critical_high,
      b.displayOrder !== undefined ? int(b, 'displayOrder', { min: 0, max: 9999 }) : before.display_order,
      b.isActive !== undefined ? (bool(b, 'isActive') ? 1 : 0) : before.is_active,
      id,
    );
    audit(db, {
      actor,
      action: 'parameter.update',
      entity: 'test_parameter',
      entityId: id,
      before: { critical_low: before.critical_low, critical_high: before.critical_high },
      after: { critical_low: b.criticalLow, critical_high: b.criticalHigh },
    });
    return { ok: true };
  });

  // New ranges are always 'pending' until a different pathologist approves them.
  r.post('/api/catalog/parameters/:id/ranges', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'catalog.write');
    const paramId = intParam(ctx.params.id!, 'id');
    if (!db.prepare('SELECT id FROM test_parameters WHERE id = ?').get(paramId)) throw notFound('Parameter not found');
    const b = ctx.body;
    const sex = oneOf(b, 'sex', ['A', 'M', 'F'] as const, false);
    const ageMin = int(b, 'ageMinDays', { min: 0, max: 36500, required: false });
    const ageMax = int(b, 'ageMaxDays', { min: 0, max: 36500, required: false }) || 36500;
    if (ageMax < ageMin) throw invalid('ageMaxDays must be at least ageMinDays');
    const low = b.low == null || b.low === '' ? null : num(b, 'low');
    const high = b.high == null || b.high === '' ? null : num(b, 'high');
    if (low != null && high != null && low > high) throw invalid('Low limit cannot be above high limit');
    const textRange = optStr(b, 'textRange', 200);
    if (low == null && high == null && !textRange) throw invalid('Give a numeric low/high range or a text range');
    const version = (db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM reference_ranges WHERE parameter_id = ?')
      .get(paramId) as { v: number }).v + 1;
    const row = db
      .prepare(
        `INSERT INTO reference_ranges (parameter_id, sex, age_min_days, age_max_days, low, high, text_range, status, version, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?) RETURNING id`,
      )
      .get(paramId, sex || 'A', ageMin, ageMax, low, high, textRange, version, optStr(b, 'note', 200), actor.id) as { id: number };
    audit(db, { actor, action: 'range.propose', entity: 'reference_range', entityId: row.id, after: { paramId, low, high, sex: sex || 'A' } });
    return json({ id: row.id, status: 'pending' }, 201);
  });

  r.post('/api/catalog/ranges/:id/approve', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'catalog.approve_ranges');
    approveRange(db, actor, intParam(ctx.params.id!, 'id'));
    return { ok: true, status: 'approved' };
  });

  // Starter ranges are loaded as usable but unverified; a pathologist confirms them here (recorded with name and time).
  r.post('/api/catalog/ranges/:id/verify', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'catalog.approve_ranges');
    const id = intParam(ctx.params.id!, 'id');
    const row = db.prepare('SELECT status, approved_by FROM reference_ranges WHERE id = ?').get(id) as { status: string; approved_by: number | null } | undefined;
    if (!row) throw notFound('Range not found');
    if (row.status !== 'approved' || row.approved_by != null) throw conflict('Only unverified starter ranges can be verified');
    db.prepare("UPDATE reference_ranges SET approved_by = ?, approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(actor.id, id);
    audit(db, { actor, action: 'range.verify', entity: 'reference_range', entityId: id });
    return { ok: true };
  });

  r.post('/api/catalog/tests/:id/prices', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'catalog.write');
    const testId = intParam(ctx.params.id!, 'id');
    if (!db.prepare('SELECT id FROM tests WHERE id = ?').get(testId)) throw notFound('Test not found');
    const b = ctx.body;
    const branchId = int(b, 'branchId', { min: 1 });
    if (!db.prepare('SELECT id FROM branches WHERE id = ?').get(branchId)) throw badRequest('Branch not found');
    const effectiveFrom = str(b, 'effectiveFrom', { max: 10, min: 10 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw invalid('effectiveFrom must be YYYY-MM-DD');
    const price = num(b, 'pricePkr', { min: 0, max: 10_000_000 });
    db.prepare('INSERT INTO branch_prices (branch_id, test_id, price_paisa, effective_from, created_by) VALUES (?, ?, ?, ?, ?)').run(
      branchId,
      testId,
      toPaisa(price),
      effectiveFrom,
      actor.id,
    );
    audit(db, { actor, branchId, action: 'price.set', entity: 'test', entityId: testId, after: { pricePkr: price, effectiveFrom } });
    return json({ ok: true }, 201);
  });

  r.put('/api/catalog/tests/:id/reagents', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'catalog.write');
    const testId = intParam(ctx.params.id!, 'id');
    if (!db.prepare('SELECT id FROM tests WHERE id = ?').get(testId)) throw notFound('Test not found');
    const items = (Array.isArray(ctx.body.items) ? ctx.body.items : []) as Array<{ itemId: unknown; qtyPerTest: unknown }>;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM test_reagents WHERE test_id = ?').run(testId);
      for (const it of items) {
        const itemId = Number(it.itemId);
        const qty = Number(it.qtyPerTest);
        if (!Number.isInteger(itemId) || !(qty > 0)) throw badRequest('Each reagent needs an item and a positive quantity');
        db.prepare('INSERT INTO test_reagents (test_id, item_id, qty_per_test) VALUES (?, ?, ?)').run(testId, itemId, qty);
      }
      audit(db, { actor, action: 'reagents.update', entity: 'test', entityId: testId, after: { items: items.length } });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { ok: true };
  });

  // ---- CSV: one row per parameter reference range. Tests and parameters are created when missing.
  const HEADERS = [
    'test_code', 'test_name', 'department_code', 'specimen_type', 'price_pkr', 'parameter_code', 'parameter_name', 'unit',
    'decimals', 'result_type', 'sex', 'age_min_days', 'age_max_days', 'low', 'high', 'text_range', 'critical_low', 'critical_high',
  ];

  r.get('/api/catalog/export.csv', (ctx) => {
    requirePerm(ctx.user!, 'catalog.read');
    const rows = db
      .prepare(
        `SELECT t.code AS test_code, t.name AS test_name, d.code AS department_code, t.specimen_type, t.base_price_paisa,
                p.code AS parameter_code, p.name AS parameter_name, p.unit, p.decimals, p.result_type,
                r.sex, r.age_min_days, r.age_max_days, r.low, r.high, r.text_range, p.critical_low, p.critical_high
         FROM tests t JOIN departments d ON d.id = t.department_id
         LEFT JOIN test_parameters p ON p.test_id = t.id AND p.is_active = 1
         LEFT JOIN reference_ranges r ON r.parameter_id = p.id AND r.status = 'approved'
         WHERE t.is_panel = 0 AND t.is_active = 1
         ORDER BY d.display_order, t.display_order, t.code, p.display_order, r.sex, r.age_min_days`,
      )
      .all() as Array<Record<string, any>>;
    const body = toCsv([
      HEADERS,
      ...rows.map((r) => [
        r.test_code, r.test_name, r.department_code, r.specimen_type,
        fromPaisa(Number(r.base_price_paisa)), r.parameter_code, r.parameter_name, r.unit, r.decimals, r.result_type,
        r.sex, r.age_min_days, r.age_max_days, r.low, r.high, r.text_range, r.critical_low, r.critical_high,
      ]),
    ]);
    return new RawResponse('text/csv; charset=utf-8', body, {
      'Content-Disposition': `attachment; filename="catalog-${businessDate()}.csv"`,
    });
  });

  r.post('/api/catalog/import', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'catalog.write');
    const csv = str(ctx.body, 'csv', { max: 5_000_000 });
    const dryRun = bool(ctx.body, 'dryRun');
    const rows = parseCsv(csv);
    if (rows.length < 2) throw badRequest('The file has no data rows');
    const header = rows[0]!.map((h) => h.trim().toLowerCase());
    const missing = HEADERS.filter((h) => !header.includes(h));
    if (missing.length) throw badRequest(`Missing columns: ${missing.join(', ')}`);
    const idx = (name: string) => header.indexOf(name);
    const errors: Array<{ line: number; message: string }> = [];
    const parsed = rows.slice(1).map((cells, i) => {
      const get = (name: string) => (cells[idx(name)] ?? '').trim();
      return { line: i + 2, get };
    });
    const depts = new Map((db.prepare('SELECT id, code FROM departments').all() as Array<{ id: number; code: string }>).map((d) => [d.code, d.id]));
    for (const { line, get } of parsed) {
      if (!get('test_code')) errors.push({ line, message: 'test_code is empty' });
      if (get('department_code') && !depts.has(get('department_code').toUpperCase())) {
        errors.push({ line, message: `Unknown department ${get('department_code')}` });
      }
      if (get('result_type') && !(RESULT_TYPES as readonly string[]).includes(get('result_type'))) {
        errors.push({ line, message: `result_type must be one of ${RESULT_TYPES.join(', ')}` });
      }
      const low = get('low');
      const high = get('high');
      if (low && Number.isNaN(Number(low))) errors.push({ line, message: 'low must be a number' });
      if (high && Number.isNaN(Number(high))) errors.push({ line, message: 'high must be a number' });
    }
    if (errors.length) return json({ ok: false, errors, rows: parsed.length }, 422);
    if (dryRun) return { ok: true, dryRun: true, rows: parsed.length };

    let created = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const { get } of parsed) {
        const testCode = get('test_code').toUpperCase();
        let test = db.prepare('SELECT id FROM tests WHERE code = ?').get(testCode) as { id: number } | undefined;
        if (!test) {
          const deptCode = get('department_code').toUpperCase() || [...depts.keys()][0]!;
          const deptId = depts.get(deptCode)!;
          test = db
            .prepare(
              `INSERT INTO tests (code, name, department_id, specimen_type, base_price_paisa) VALUES (?, ?, ?, ?, ?) RETURNING id`,
            )
            .get(testCode, get('test_name') || testCode, deptId, get('specimen_type') || 'Blood', toPaisa(Number(get('price_pkr') || 0))) as { id: number };
          created++;
        }
        const paramCode = get('parameter_code').toUpperCase();
        if (!paramCode) continue;
        let param = db.prepare('SELECT id FROM test_parameters WHERE test_id = ? AND code = ?').get(test.id, paramCode) as { id: number } | undefined;
        if (!param) {
          param = db
            .prepare(
              `INSERT INTO test_parameters (test_id, code, name, unit, decimals, result_type, critical_low, critical_high)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            )
            .get(
              test.id,
              paramCode,
              get('parameter_name') || paramCode,
              get('unit') || null,
              Number(get('decimals') || 1),
              get('result_type') || 'numeric',
              get('critical_low') ? Number(get('critical_low')) : null,
              get('critical_high') ? Number(get('critical_high')) : null,
            ) as { id: number };
        }
        const low = get('low') ? Number(get('low')) : null;
        const high = get('high') ? Number(get('high')) : null;
        const text = get('text_range') || null;
        if (low == null && high == null && !text) continue;
        const sex = (get('sex') || 'A').toUpperCase();
        const ageMin = Number(get('age_min_days') || 0);
        const ageMax = Number(get('age_max_days') || 36500);
        if (!['A', 'M', 'F'].includes(sex) || !Number.isInteger(ageMin) || !Number.isInteger(ageMax) || ageMin < 0 || ageMax < ageMin) {
          throw badRequest(`Test ${testCode} / ${paramCode}: sex must be A, M or F and age days must be whole numbers (min <= max)`);
        }
        const version = (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM reference_ranges WHERE parameter_id = ?').get(param.id) as { v: number }).v + 1;
        db.prepare(
          `INSERT INTO reference_ranges (parameter_id, sex, age_min_days, age_max_days, low, high, text_range, status, version, note, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'CSV import', ?)`,
        ).run(param.id, sex, ageMin, ageMax, low, high, text, version, actor.id);
      }
      audit(db, { actor, action: 'catalog.import', entity: 'catalog', after: { rows: parsed.length, testsCreated: created } });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return json({ ok: true, rows: parsed.length, testsCreated: created, rangesPendingApproval: true }, 201);
  });
}
