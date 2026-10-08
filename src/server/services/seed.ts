import type { DatabaseSync } from 'node:sqlite';
import { DEPARTMENTS, PANELS, TESTS, type SeedTest } from '../seed/catalog.ts';
import { audit } from '../audit.ts';

const STARTER_NOTE = 'Starter range (published references). Pathologist to verify before clinical use.';

// Loads the starter catalog once, on an empty database. Never overwrites existing catalog data.
export function seedCatalogIfEmpty(db: DatabaseSync): void {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM departments').get() as { n: number }).n;
  if (count > 0) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    const deptIds = new Map<string, number>();
    DEPARTMENTS.forEach((d, i) => {
      const row = db
        .prepare('INSERT INTO departments (code, name, display_order) VALUES (?, ?, ?) RETURNING id')
        .get(d.code, d.name, i + 1) as { id: number };
      deptIds.set(d.code, row.id);
    });

    const testIds = new Map<string, number>();
    const insertTest = (t: SeedTest, isPanel: boolean, order: number) => {
      const dept = deptIds.get(t.dept);
      if (!dept) throw new Error(`Seed department ${t.dept} missing`);
      const row = db
        .prepare(
          `INSERT INTO tests (code, name, department_id, specimen_type, is_panel, base_price_paisa, tat_hours, display_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(t.code, t.name, dept, t.specimen, isPanel ? 1 : 0, t.price * 100, t.tat, order) as { id: number };
      testIds.set(t.code, row.id);
      (t.params ?? []).forEach((p, pi) => {
        const param = db
          .prepare(
            `INSERT INTO test_parameters (test_id, code, name, unit, decimals, result_type, formula, qualitative_options, critical_low, critical_high, display_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          )
          .get(
            row.id,
            p.code,
            p.name,
            p.unit ?? null,
            p.decimals ?? 1,
            p.type ?? 'numeric',
            p.formula ?? null,
            p.options ? JSON.stringify(p.options) : null,
            p.crit?.[0] ?? null,
            p.crit?.[1] ?? null,
            pi + 1,
          ) as { id: number };
        for (const rg of p.ranges ?? []) {
          db.prepare(
            `INSERT INTO reference_ranges (parameter_id, sex, age_min_days, age_max_days, low, high, status, version, note)
             VALUES (?, ?, 0, 36500, ?, ?, 'approved', 1, ?)`,
          ).run(param.id, rg.sex ?? 'A', rg.low ?? null, rg.high ?? null, STARTER_NOTE);
        }
      });
    };

    TESTS.forEach((t, i) => insertTest(t, false, i + 1));
    PANELS.forEach((t, i) => insertTest(t, true, TESTS.length + i + 1));

    for (const panel of PANELS) {
      for (const member of panel.members ?? []) {
        const pid = testIds.get(panel.code);
        const mid = testIds.get(member);
        if (!pid || !mid) throw new Error(`Seed panel ${panel.code} references unknown test ${member}`);
        db.prepare('INSERT INTO panel_members (panel_test_id, member_test_id) VALUES (?, ?)').run(pid, mid);
      }
    }

    audit(db, { action: 'catalog.seed', entity: 'catalog', after: { tests: TESTS.length, panels: PANELS.length } });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
