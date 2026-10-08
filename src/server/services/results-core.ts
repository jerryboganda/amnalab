import type { DatabaseSync } from 'node:sqlite';
import { badRequest, conflict, invalid, notFound } from '../http.ts';
import { flagNumeric, selectRange, ageSexFromPatient, type Flag, type RangeRow, type Sex } from './flags.ts';
import { evaluate } from './formula.ts';
import { audit } from '../audit.ts';
import type { AuthUser } from '../security.ts';
import { assertBranch } from '../security.ts';
import { nowIso } from '../util.ts';
import { consumeReagentsForItem } from './inventory-core.ts';

export interface ItemContext {
  id: number;
  status: string;
  order_id: number;
  branch_id: number;
  test_id: number;
  test_name: string;
  test_code: string;
  specimen_id: number;
  specimen_status: string;
  accession_no: string;
  specimen_type: string;
  patient_id: number;
  patient_name: string;
  mrn: string;
  dob: string | null;
  age_years_at_registration: number | null;
  gender: string;
  order_no: string;
  priority: string;
  department_name: string;
}

export function loadItem(db: DatabaseSync, user: AuthUser | null, itemId: number): ItemContext {
  const row = db
    .prepare(
      `SELECT oi.id, oi.status, oi.order_id, o.branch_id, t.id AS test_id, t.name AS test_name, t.code AS test_code,
              sp.id AS specimen_id, sp.status AS specimen_status, sp.accession_no, sp.specimen_type,
              p.id AS patient_id, p.full_name AS patient_name, p.mrn, p.dob, p.age_years_at_registration, p.gender,
              o.order_no, o.priority, d.name AS department_name
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN tests t ON t.id = oi.test_id
       JOIN departments d ON d.id = t.department_id
       JOIN specimens sp ON sp.id = oi.specimen_id
       JOIN patients p ON p.id = o.patient_id
       WHERE oi.id = ?`,
    )
    .get(itemId) as unknown as ItemContext | undefined;
  if (!row) throw notFound('Order item not found');
  if (user) assertBranch(user, row.branch_id);
  return row;
}

interface ParamRow {
  id: number;
  code: string;
  name: string;
  unit: string | null;
  decimals: number;
  result_type: 'numeric' | 'text' | 'qualitative' | 'calculated';
  formula: string | null;
  qualitative_options: string | null;
  critical_low: number | null;
  critical_high: number | null;
  display_order: number;
}

export function activeParams(db: DatabaseSync, testId: number): ParamRow[] {
  return db
    .prepare('SELECT * FROM test_parameters WHERE test_id = ? AND is_active = 1 ORDER BY display_order, id')
    .all(testId) as unknown as ParamRow[];
}

export function approvedRanges(db: DatabaseSync, paramId: number): RangeRow[] {
  return db
    .prepare(
      `SELECT sex, age_min_days, age_max_days, low, high, text_range, version FROM reference_ranges
       WHERE parameter_id = ? AND status = 'approved'`,
    )
    .all(paramId) as unknown as RangeRow[];
}

export function patientAgeSex(ctx: ItemContext): { ageDays: number; sex: Sex } {
  return ageSexFromPatient(ctx.dob, ctx.age_years_at_registration, ctx.gender);
}

export function rangeLabel(range: RangeRow | null, unit: string | null): string | null {
  if (!range) return null;
  if (range.text_range) return range.text_range;
  if (range.low != null && range.high != null) return `${range.low} - ${range.high}${unit ? ` ${unit}` : ''}`;
  if (range.low != null) return `>= ${range.low}${unit ? ` ${unit}` : ''}`;
  if (range.high != null) return `<= ${range.high}${unit ? ` ${unit}` : ''}`;
  return null;
}

export interface Entry {
  parameterId: number;
  valueNumeric?: number | null;
  valueText?: string | null;
  comment?: string | null;
}

// Saves a batch of entries for one order item. Refuses unless the specimen was received.
export function saveEntries(db: DatabaseSync, actor: AuthUser, itemId: number, entries: Entry[]): void {
  const ctx = loadItem(db, actor, itemId);
  if (ctx.specimen_status !== 'received' && ctx.specimen_status !== 'processing') {
    throw conflict(`Specimen ${ctx.accession_no} is ${ctx.specimen_status}. Results can be entered only after receipt.`);
  }
  if (ctx.status === 'completed' || ctx.status === 'cancelled') throw conflict(`This test is ${ctx.status}`);
  const params = activeParams(db, ctx.test_id);
  const byId = new Map(params.map((p) => [p.id, p]));
  const { ageDays, sex } = patientAgeSex(ctx);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const e of entries) {
      const p = byId.get(Number(e.parameterId));
      if (!p) throw badRequest(`Parameter ${e.parameterId} does not belong to this test`);
      if (p.result_type === 'calculated') continue; // computed below
      const existing = db.prepare('SELECT id, status, value_numeric, value_text, version FROM results WHERE order_item_id = ? AND parameter_id = ?').get(
        itemId,
        p.id,
      ) as { id: number; status: string; value_numeric: number | null; value_text: string | null; version: number } | undefined;
      if (existing?.status === 'authorized') throw conflict(`${p.name} is authorized. Amend it instead of re-entering.`);

      let num: number | null = null;
      let text: string | null = null;
      if (p.result_type === 'numeric') {
        if (e.valueNumeric == null || e.valueNumeric === ('' as unknown)) continue;
        num = Number(e.valueNumeric);
        if (!Number.isFinite(num)) throw invalid(`${p.name} must be a number`);
      } else {
        text = (e.valueText ?? '').toString().trim();
        if (!text) continue;
        if (p.result_type === 'qualitative' && p.qualitative_options) {
          const options = JSON.parse(p.qualitative_options) as string[];
          if (!options.includes(text)) throw invalid(`${p.name} must be one of: ${options.join(', ')}`);
        }
      }
      const { flag, critical, range } = computeFlag(db, p, num, ageDays, sex);
      if (existing) {
        const changed = existing.value_numeric !== num || existing.value_text !== text;
        if (changed) {
          db.prepare(
            `INSERT INTO result_revisions (result_id, version, value_numeric, value_text, flag, status, changed_by, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'entry correction')`,
          ).run(existing.id, existing.version, existing.value_numeric, existing.value_text, null, existing.status, actor.id);
        }
        db.prepare(
          `UPDATE results SET value_numeric = ?, value_text = ?, flag = ?, ref_low = ?, ref_high = ?, ref_text = ?, unit = ?,
                  critical = ?, comment = ?, status = 'draft', entered_by = ?, entered_at = ?
           WHERE id = ?`,
        ).run(num, text, flag, range?.low ?? null, range?.high ?? null, range?.text_range ?? null, p.unit, critical ? 1 : 0, e.comment ?? null, actor.id, nowIso(), existing.id);
      } else {
        db.prepare(
          `INSERT INTO results (order_item_id, parameter_id, branch_id, value_numeric, value_text, flag, ref_low, ref_high, ref_text, unit,
                                status, version, critical, comment, entered_by, entered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)`,
        ).run(itemId, p.id, ctx.branch_id, num, text, flag, range?.low ?? null, range?.high ?? null, range?.text_range ?? null, p.unit, critical ? 1 : 0, e.comment ?? null, actor.id, nowIso());
      }
    }
    recomputeCalculated(db, actor, ctx, params, ageDays, sex);
    db.prepare("UPDATE order_items SET status = 'processing' WHERE id = ? AND status IN ('received','processing')").run(itemId);
    db.prepare("UPDATE specimens SET status = 'processing' WHERE id = ? AND status = 'received'").run(ctx.specimen_id);
    db.prepare("UPDATE orders SET status = 'in_progress' WHERE id = ? AND status = 'confirmed'").run(ctx.order_id);
    consumeReagentsForItem(db, ctx.branch_id, itemId, ctx.test_id, actor.id);
    audit(db, { actor, branchId: ctx.branch_id, action: 'result.enter', entity: 'order_item', entityId: itemId, after: { count: entries.length } });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function computeFlag(
  db: DatabaseSync,
  p: ParamRow,
  value: number | null,
  ageDays: number,
  sex: Sex,
): { flag: Flag; critical: boolean; range: RangeRow | null } {
  const range = selectRange(approvedRanges(db, p.id), sex, ageDays);
  if (value == null) return { flag: null, critical: false, range };
  const f = flagNumeric(value, range, { low: p.critical_low, high: p.critical_high });
  return { flag: f.flag, critical: f.critical, range };
}

function recomputeCalculated(db: DatabaseSync, actor: AuthUser, ctx: ItemContext, params: ParamRow[], ageDays: number, sex: Sex): void {
  const calcs = params.filter((p) => p.result_type === 'calculated' && p.formula);
  if (calcs.length === 0) return;
  const numeric = db
    .prepare(
      `SELECT tp.code, r.value_numeric FROM results r JOIN test_parameters tp ON tp.id = r.parameter_id
       WHERE r.order_item_id = ? AND r.status <> 'cancelled' AND r.value_numeric IS NOT NULL`,
    )
    .all(ctx.id) as Array<{ code: string; value_numeric: number }>;
  const vars: Record<string, number> = {};
  for (const n of numeric) vars[n.code] = n.value_numeric;
  for (const p of calcs) {
    let value: number | null = null;
    try {
      value = evaluate(p.formula!, vars);
    } catch {
      value = null;
    }
    if (value == null) continue;
    const rounded = Number(value.toFixed(Math.max(0, p.decimals)));
    const { flag, critical, range } = computeFlag(db, p, rounded, ageDays, sex);
    const existing = db.prepare('SELECT id FROM results WHERE order_item_id = ? AND parameter_id = ?').get(ctx.id, p.id) as
      | { id: number }
      | undefined;
    if (existing) {
      db.prepare(
        `UPDATE results SET value_numeric = ?, flag = ?, ref_low = ?, ref_high = ?, ref_text = ?, unit = ?, critical = ?,
                status = CASE WHEN status = 'authorized' THEN status ELSE 'draft' END, entered_by = ?, entered_at = ?
         WHERE id = ?`,
      ).run(rounded, flag, range?.low ?? null, range?.high ?? null, range?.text_range ?? null, p.unit, critical ? 1 : 0, actor.id, nowIso(), existing.id);
    } else {
      db.prepare(
        `INSERT INTO results (order_item_id, parameter_id, branch_id, value_numeric, flag, ref_low, ref_high, ref_text, unit, status, version, critical, entered_by, entered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?)`,
      ).run(ctx.id, p.id, ctx.branch_id, rounded, flag, range?.low ?? null, range?.high ?? null, range?.text_range ?? null, p.unit, critical ? 1 : 0, actor.id, nowIso());
    }
  }
}

export function itemHasAuthorizedAll(db: DatabaseSync, itemId: number): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'authorized' THEN 1 ELSE 0 END) AS authorized
       FROM results WHERE order_item_id = ? AND status <> 'cancelled'`,
    )
    .get(itemId) as { total: number; authorized: number | null };
  return row.total > 0 && row.authorized === row.total;
}
