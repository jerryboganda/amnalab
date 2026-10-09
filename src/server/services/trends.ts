import type { DatabaseSync } from 'node:sqlite';

export interface TrendPoint {
  date: string;
  value: number;
  unit: string | null;
  flag: string | null;
}

/**
 * Authorized numeric results of one parameter for a patient, oldest first.
 * `unit` (when given) keeps only results in the same unit; `before` keeps only orders created before that time,
 * so a report never shows results that came later.
 */
export function trendPoints(
  db: DatabaseSync,
  opts: { patientId: number; code: string; unit?: string | null; before?: string; limit: number },
): TrendPoint[] {
  const where = ['o.patient_id = ?', 'tp.code = ?', "r.status = 'authorized'", 'r.value_numeric IS NOT NULL'];
  const vals: Array<string | number> = [opts.patientId, opts.code];
  if (opts.unit !== undefined) {
    where.push("COALESCE(r.unit, '') = ?");
    vals.push(opts.unit ?? '');
  }
  if (opts.before) {
    where.push('o.created_at < ?');
    vals.push(opts.before);
  }
  vals.push(opts.limit);
  const rows = db
    .prepare(
      `SELECT o.created_at AS date, r.value_numeric AS value, r.unit, r.flag
       FROM results r
       JOIN test_parameters tp ON tp.id = r.parameter_id
       JOIN order_items oi ON oi.id = r.order_item_id
       JOIN orders o ON o.id = oi.order_id
       WHERE ${where.join(' AND ')}
       ORDER BY o.created_at DESC, r.id DESC LIMIT ?`,
    )
    .all(...vals) as unknown as TrendPoint[];
  return rows.reverse();
}
