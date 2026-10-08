import { useState, type ReactNode } from 'react';
import { ApiError } from './api.ts';

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'ok' | 'error' | 'warn'; children: ReactNode }) {
  return <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}

// Runs an async action, shows a busy state and surfaces errors. Keeps the forms simple.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  async function run<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const out = await fn();
      if (success) setOk(success);
      return out;
    } catch (e) {
      setError(errorText(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, ok, run, setError, setOk };
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'info'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Panel({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      {title || actions ? (
        <header className="panel-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Table({ head, rows, empty = 'Nothing to show yet' }: { head: ReactNode[]; rows: ReactNode[][]; empty?: string }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={head.length} className="muted">{empty}</td>
            </tr>
          ) : (
            rows.map((cells, r) => (
              <tr key={r}>
                {cells.map((c, i) => (
                  <td key={i}>{c}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// Graphical reference range: a bar for the normal band, a marker for the patient's value,
// and shaded critical zones beyond the critical limits.
export function RangeBar({
  low,
  high,
  critLow,
  critHigh,
  value,
  unit,
}: {
  low: number | null;
  high: number | null;
  critLow?: number | null;
  critHigh?: number | null;
  value?: number | null;
  unit?: string | null;
}) {
  if (low == null && high == null) return null;
  const values = [low, high, critLow, critHigh, value].filter((v): v is number => v != null && Number.isFinite(v));
  const min = Math.min(...values) - (Math.max(...values) - Math.min(...values)) * 0.1;
  const max = Math.max(...values) + (Math.max(...values) - Math.min(...values)) * 0.1;
  const span = max - min || 1;
  const pct = (v: number) => `${Math.min(100, Math.max(0, ((v - min) / span) * 100))}%`;
  const normalLeft = low ?? min;
  const normalRight = high ?? max;
  const outOfRange = value != null && ((low != null && value < low) || (high != null && value > high));
  const critical = value != null && ((critLow != null && value <= critLow) || (critHigh != null && value >= critHigh));
  return (
    <div className="range" aria-label={`Reference ${low ?? ''} to ${high ?? ''} ${unit ?? ''}`}>
      <div className="range-track">
        {critLow != null ? <div className="range-crit" style={{ left: 0, width: pct(critLow) }} /> : null}
        {critHigh != null ? <div className="range-crit" style={{ left: pct(critHigh), right: 0 }} /> : null}
        <div className="range-normal" style={{ left: pct(normalLeft), width: `calc(${pct(normalRight)} - ${pct(normalLeft)})` }} />
        {value != null ? (
          <div className={`range-marker ${critical ? 'marker-crit' : outOfRange ? 'marker-out' : 'marker-ok'}`} style={{ left: pct(value) }} title={`Value ${value}`} />
        ) : null}
      </div>
      <div className="range-scale">
        <span>{low ?? ''}</span>
        <span>{high ?? ''}</span>
      </div>
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'warn' | 'danger' | 'ok' }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
