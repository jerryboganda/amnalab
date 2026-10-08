import type { DatabaseSync } from 'node:sqlite';
import type { AuthUser } from './security.ts';

export const nowIso = (): string => new Date().toISOString();

// Business date (YYYY-MM-DD) in the branch timezone. Default for Pakistan is Asia/Karachi.
export function businessDate(timeZone = 'Asia/Karachi', at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

// Gapless-enough running numbers. Atomic inside SQLite, so two requests never get the same value.
export function nextSequence(db: DatabaseSync, name: string): number {
  db.prepare('INSERT INTO sequences (name, next_value) VALUES (?, 1) ON CONFLICT(name) DO NOTHING').run(name);
  const row = db
    .prepare('UPDATE sequences SET next_value = next_value + 1 WHERE name = ? RETURNING next_value - 1 AS value')
    .get(name) as { value: number };
  return row.value;
}

export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

// Money is stored as integer paisa (1 PKR = 100 paisa) to avoid floating point drift.
export const toPaisa = (rupees: number): number => Math.round(rupees * 100);
export const fromPaisa = (paisa: number): number => paisa / 100;
export const fmtPkr = (paisa: number): string =>
  new Intl.NumberFormat('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(paisa / 100);

// Age in whole days between a date of birth (YYYY-MM-DD) and a moment in time.
export function ageInDays(dob: string, at: Date = new Date()): number {
  const birth = Date.parse(`${dob}T00:00:00Z`);
  return Math.floor((at.getTime() - birth) / 86_400_000);
}

export function ageInYears(dob: string, at: Date = new Date()): number {
  const b = new Date(`${dob}T00:00:00Z`);
  let years = at.getUTCFullYear() - b.getUTCFullYear();
  const m = at.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < b.getUTCDate())) years -= 1;
  return years;
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export function assertDate(v: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new Error(`${name} must be a date in YYYY-MM-DD format`);
  }
  return v;
}

export function actorId(user: AuthUser | null): number | null {
  return user ? user.id : null;
}
