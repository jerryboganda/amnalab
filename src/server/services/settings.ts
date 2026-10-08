import type { DatabaseSync } from 'node:sqlite';

export interface Settings {
  // Percent discount each role may give without a second approver.
  discount_caps: Record<string, number>;
  // Stock adjustments larger than this (absolute units) need a second approver.
  adjustment_approval_threshold: number;
}

export const SETTING_DEFAULTS: Settings = {
  discount_caps: { admin: 100, branch_manager: 100, pathologist: 0, cashier: 5, reception: 0 },
  adjustment_approval_threshold: 10,
};

export function getSettings(db: DatabaseSync): Settings {
  const out: Settings = structuredClone(SETTING_DEFAULTS);
  const rows = db.prepare('SELECT key, value_json FROM settings').all() as Array<{ key: string; value_json: string }>;
  for (const row of rows) {
    if (row.key in out) (out as unknown as Record<string, any>)[row.key] = JSON.parse(row.value_json);
  }
  return out;
}

export function setSetting(db: DatabaseSync, key: keyof Settings, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value_json) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(key, JSON.stringify(value));
}
