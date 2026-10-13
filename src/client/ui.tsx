import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
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
  const running = useRef(false);
  async function run<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
    // A second click while the first request is still running is ignored, so nothing is posted twice.
    if (running.current) return undefined;
    running.current = true;
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
      running.current = false;
      setBusy(false);
    }
  }
  // An error and a success message never show together: setting one clears the other.
  const showError = (m: string | null) => {
    setError(m);
    if (m) setOk(null);
  };
  const showOk = (m: string | null) => {
    setOk(m);
    if (m) setError(null);
  };
  return { busy, error, ok, run, setError: showError, setOk: showOk };
}

export interface AskOptions {
  title: string;
  label: string;
  hint?: string;
  initial?: string;
  secret?: boolean; // mask the text, for passwords
  optional?: boolean; // an empty answer is allowed
  minLength?: number;
  submit?: string;
}

function AskDialog({ opts, onDone }: { opts: AskOptions; onDone: (v: string | null) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(opts.initial ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const closed = useRef(false);
  const finish = (v: string | null) => {
    if (closed.current) return;
    closed.current = true;
    onDone(v);
  };
  useEffect(() => ref.current?.showModal(), []);
  function submit(e: FormEvent) {
    e.preventDefault();
    const v = value.trim();
    const min = opts.minLength ?? 1;
    if (!opts.optional && v.length < min) {
      setProblem(`Enter at least ${min} characters.`);
      return;
    }
    finish(v);
  }
  return (
    <dialog ref={ref} className="dialog" onClose={() => finish(null)}>
      <form onSubmit={submit}>
        <h2>{opts.title}</h2>
        <Field label={opts.label} hint={opts.hint}>
          <input
            autoFocus
            type={opts.secret ? 'password' : 'text'}
            autoComplete={opts.secret ? 'new-password' : 'off'}
            required={!opts.optional}
            minLength={opts.minLength}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        {problem ? <Notice kind="error">{problem}</Notice> : null}
        <div className="row">
          <button type="submit" className="primary">{opts.submit ?? 'OK'}</button>
          <button type="button" onClick={() => finish(null)}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}

// Replacement for window.prompt: `const answer = await ask({...})` gives the text, or null when cancelled.
// Render `node` once in the component's output.
export function useAsk() {
  const [req, setReq] = useState<{ opts: AskOptions; resolve: (v: string | null) => void } | null>(null);
  const ask = (opts: AskOptions) => new Promise<string | null>((resolve) => setReq({ opts, resolve }));
  const node = req ? (
    <AskDialog
      opts={req.opts}
      onDone={(v) => {
        req.resolve(v);
        setReq(null);
      }}
    />
  ) : null;
  return { ask, node };
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
        {low != null ? <span style={{ left: pct(low) }}>{low}</span> : null}
        {high != null ? <span style={{ left: pct(high) }}>{high}</span> : null}
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
