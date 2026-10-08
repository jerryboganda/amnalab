import { useEffect, useState } from 'react';
import { fileToDataUrl, get, post } from '../api.ts';
import { Badge, Field, Notice, Panel, RangeBar, Table, useAction } from '../ui.tsx';
import type { Session } from '../App.tsx';

interface WorkItem {
  order_item_id: number;
  status: string;
  order_no: string;
  priority: string;
  patient_name: string;
  mrn: string;
  test_name: string;
  department_name: string;
  department_id: number;
  accession_no: string;
  tat_due_at: string | null;
  parameter_count: number;
  authorized_count: number;
}

interface ParamView {
  id: number;
  code: string;
  name: string;
  unit: string | null;
  decimals: number;
  resultType: 'numeric' | 'text' | 'qualitative' | 'calculated';
  formula: string | null;
  options: string[] | null;
  criticalLow: number | null;
  criticalHigh: number | null;
  range: { low: number | null; high: number | null; text: string | null; label: string | null } | null;
  result: {
    id: number;
    value_numeric: number | null;
    value_text: string | null;
    flag: string | null;
    status: string;
    version: number;
    critical: number;
    comment: string | null;
    entered_by: number | null;
  } | null;
}

interface ItemView {
  id: number;
  status: string;
  testName: string;
  department: string;
  orderNo: string;
  priority: string;
  patient: { name: string; mrn: string; gender: string; ageDays: number };
  specimen: { accession: string; status: string; type: string };
  parameters: ParamView[];
  attachments: Array<{ id: number; filename: string; mime: string; size: number }>;
}

const FLAG_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = { N: 'ok', L: 'warn', H: 'warn', LL: 'danger', HH: 'danger' };

export function Worklist({ s }: { s: Session }) {
  const itemId = Number(window.location.hash.split('/')[2]);
  if (Number.isInteger(itemId) && itemId > 0) return <Entry s={s} itemId={itemId} />;
  return <List s={s} />;
}

function List({ s }: { s: Session }) {
  const [rows, setRows] = useState<WorkItem[]>([]);
  const [priority, setPriority] = useState('');
  const [dept, setDept] = useState('');
  const [departments, setDepartments] = useState<Array<{ id: number; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<Array<{ id: number; name: string }>>('/api/catalog/departments').then(setDepartments).catch(() => setDepartments([]));
  }, []);
  useEffect(() => {
    const q = new URLSearchParams({ branchId: String(s.branchId) });
    if (priority) q.set('priority', priority);
    if (dept) q.set('department', dept);
    get<WorkItem[]>(`/api/worklists?${q}`)
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [s.branchId, priority, dept]);

  return (
    <>
      <div className="toolbar">
        <h1>Worklist</h1>
        <div className="toolbar-right">
          <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
            <option value="">All priorities</option>
            <option value="stat">STAT</option>
            <option value="urgent">Urgent</option>
            <option value="routine">Routine</option>
          </select>
        </div>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Panel>
        <Table
          head={['Priority', 'Accession', 'Patient', 'Test', 'Department', 'Due', 'Progress', '']}
          rows={rows.map((w) => [
            <Badge key="p" tone={w.priority === 'stat' ? 'danger' : w.priority === 'urgent' ? 'warn' : 'neutral'}>{w.priority}</Badge>,
            <code key="a">{w.accession_no}</code>,
            `${w.patient_name} (${w.mrn})`,
            w.test_name,
            w.department_name,
            w.tat_due_at ? new Date(w.tat_due_at).toLocaleString('en-GB', { timeZone: 'Asia/Karachi', dateStyle: 'short', timeStyle: 'short' }) : '-',
            `${w.authorized_count} / ${w.parameter_count}`,
            <a key="e" href={`#/worklist/${w.order_item_id}`}>Open</a>,
          ])}
          empty="Nothing waiting. Received specimens appear here."
        />
      </Panel>
    </>
  );
}

function Entry({ s, itemId }: { s: Session; itemId: number }) {
  const [item, setItem] = useState<ItemView | null>(null);
  const [values, setValues] = useState<Record<number, { num: string; text: string; comment: string }>>({});
  const [notify, setNotify] = useState('');
  const [amend, setAmend] = useState<{ resultId: number; value: string; reason: string; param: string } | null>(null);
  const act = useAction();

  const load = async () => {
    const view = await get<ItemView>(`/api/order-items/${itemId}`);
    setItem(view);
    const next: Record<number, { num: string; text: string; comment: string }> = {};
    for (const p of view.parameters) {
      next[p.id] = {
        num: p.result?.value_numeric != null ? String(p.result.value_numeric) : '',
        text: p.result?.value_text ?? '',
        comment: p.result?.comment ?? '',
      };
    }
    setValues(next);
  };

  useEffect(() => {
    load().catch((e: Error) => act.setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  if (!item) return act.error ? <Notice kind="error">{act.error}</Notice> : <p className="muted">Loading...</p>;
  const specimenReady = item.specimen.status === 'received' || item.specimen.status === 'processing';
  const criticals = item.parameters.filter((p) => p.result?.critical === 1 && p.result.status !== 'authorized' && p.result.status !== 'cancelled');
  const allReviewed = item.parameters.filter((p) => p.result && p.result.status !== 'cancelled').every((p) => p.result?.status === 'reviewed' || p.result?.status === 'authorized');
  const anyEntered = item.parameters.some((p) => p.result);
  // Reviewers must be a different person from whoever entered the draft values.
  const draftsByOthers = item.parameters.some((p) => p.result?.status === 'draft' && p.result.entered_by !== s.me.id);

  async function saveEntries() {
    const body = {
      values: item!.parameters
        // Send only new or changed values; resaving unchanged ones would undo the technical review.
        .filter((p) => p.resultType !== 'calculated' && p.result?.status !== 'authorized')
        .filter((p) => {
          const v = values[p.id] ?? { num: '', text: '', comment: '' };
          const r = p.result;
          if (!r) return true;
          const valueSame = p.resultType === 'numeric' ? v.num !== '' && Number(v.num) === r.value_numeric : v.text === (r.value_text ?? '');
          return !valueSame || v.comment !== (r.comment ?? '');
        })
        .map((p) => {
          const v = values[p.id] ?? { num: '', text: '', comment: '' };
          if (p.resultType === 'numeric') return { parameterId: p.id, valueNumeric: v.num === '' ? null : Number(v.num), comment: v.comment };
          return { parameterId: p.id, valueText: v.text, comment: v.comment };
        })
        .filter((x) => ('valueNumeric' in x ? x.valueNumeric !== null : (x.valueText ?? '') !== '')),
    };
    if (body.values.length === 0) {
      act.setOk('Nothing changed');
      return;
    }
    await act.run(() => post(`/api/order-items/${itemId}/results`, body), 'Results saved');
    await load();
  }

  async function review() {
    await act.run(() => post(`/api/order-items/${itemId}/review`), 'Technically reviewed');
    await load();
  }

  async function authorize() {
    if (criticals.length > 0 && notify.trim().length < 2) {
      act.setError('Record who the critical value was communicated to (name and time) before authorizing');
      return;
    }
    const out = await act.run(
      () => post<{ orderCompleted: boolean; report: { reportNo: string; version: number } | null; reportError: string | null }>(`/api/order-items/${itemId}/authorize`, {
        criticalNotifiedTo: criticals.length ? notify : undefined,
      }),
      'Authorized',
    );
    if (out?.orderCompleted) {
      if (out.reportError) act.setError(`Authorized, but the report could not be generated: ${out.reportError}. Use Re-issue on the order.`);
      else act.setOk(out.report ? `Authorized. Report ${out.report.reportNo} v${out.report.version} is ready.` : 'Authorized. The order is complete.');
    }
    await load();
  }

  async function submitAmend() {
    if (!amend) return;
    const done = await act.run(
      () => post(`/api/results/${amend.resultId}/amend`, { valueNumeric: amend.value !== '' && !Number.isNaN(Number(amend.value)) ? Number(amend.value) : undefined, valueText: amend.value, reason: amend.reason }),
      'Amended. It needs review and authorization again by a different person.',
    );
    if (done) setAmend(null);
    await load();
  }

  async function attach(file: File | undefined) {
    if (!file) return;
    const dataUrl = await fileToDataUrl(file, 10).catch((e: Error) => {
      act.setError(e.message);
      return null;
    });
    if (!dataUrl) return;
    await act.run(() => post(`/api/order-items/${itemId}/attachments`, { filename: file.name, dataUrl }), 'Attached');
    await load();
  }

  return (
    <>
      <div className="toolbar">
        <a href="#/worklist">&larr; Worklist</a>
        <h1>{item.testName}</h1>
        <Badge tone="info">{item.status}</Badge>
      </div>
      <p className="muted">
        {item.patient.name} ({item.patient.mrn}) | {item.patient.gender} | Accession <code>{item.specimen.accession}</code> ({item.specimen.type}, {item.specimen.status}) | Order {item.orderNo}{' '}
        {item.priority !== 'routine' ? <Badge tone="danger">{item.priority.toUpperCase()}</Badge> : null}
      </p>
      {!specimenReady ? <Notice kind="warn">Results can be entered only after the specimen is received in the lab.</Notice> : null}
      {act.error ? <Notice kind="error">{act.error}</Notice> : null}
      {act.ok ? <Notice kind="ok">{act.ok}</Notice> : null}

      <Panel title="Results">
        <div className="table-wrap">
        <table className="table results">
          <thead>
            <tr>
              <th>Parameter</th>
              <th>Result</th>
              <th>Unit</th>
              <th>Reference</th>
              <th>Flag</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {item.parameters.map((p) => {
              const r = p.result;
              const v = values[p.id] ?? { num: '', text: '', comment: '' };
              const locked = !specimenReady || r?.status === 'authorized' || item.status === 'completed' || !s.can('results.enter');
              const shownValue = p.resultType === 'calculated' ? (r?.value_numeric != null ? String(r.value_numeric) : '') : null;
              const numVal = r?.value_numeric ?? (v.num !== '' ? Number(v.num) : null);
              return (
                <tr key={p.id}>
                  <td>
                    {p.name}
                    {p.resultType === 'calculated' ? <div className="muted small">calculated</div> : null}
                  </td>
                  <td>
                    {p.resultType === 'numeric' ? (
                      <input
                        type="number"
                        step="any"
                        className="num"
                        value={v.num}
                        disabled={locked}
                        onChange={(e) => setValues({ ...values, [p.id]: { ...v, num: e.target.value } })}
                        aria-label={`${p.name} result`}
                      />
                    ) : p.resultType === 'calculated' ? (
                      <input value={shownValue ?? ''} disabled readOnly aria-label={`${p.name} calculated`} className="num" />
                    ) : p.options ? (
                      <select value={v.text} disabled={locked} onChange={(e) => setValues({ ...values, [p.id]: { ...v, text: e.target.value } })} aria-label={`${p.name} result`}>
                        <option value="">-</option>
                        {p.options.map((o) => (
                          <option key={o} value={o}>{o}</option>
                        ))}
                      </select>
                    ) : (
                      <input value={v.text} disabled={locked} onChange={(e) => setValues({ ...values, [p.id]: { ...v, text: e.target.value } })} aria-label={`${p.name} result`} />
                    )}
                    <input
                      className="comment"
                      placeholder="Comment"
                      value={v.comment}
                      disabled={locked}
                      onChange={(e) => setValues({ ...values, [p.id]: { ...v, comment: e.target.value } })}
                      aria-label={`${p.name} comment`}
                    />
                  </td>
                  <td>{p.unit ?? ''}</td>
                  <td className="range-cell">
                    {p.range?.label ?? p.range?.text ?? <span className="muted small">no approved range</span>}
                    {p.range && (p.range.low != null || p.range.high != null) ? (
                      <RangeBar low={p.range!.low} high={p.range!.high} critLow={p.criticalLow} critHigh={p.criticalHigh} value={numVal} unit={p.unit} />
                    ) : null}
                  </td>
                  <td>{r?.flag ? <Badge tone={FLAG_TONE[r.flag] ?? 'neutral'}>{r.flag}{r.critical ? ' critical' : ''}</Badge> : null}</td>
                  <td>
                    {r ? <Badge tone={r.status === 'authorized' ? 'ok' : r.status === 'reviewed' ? 'info' : 'neutral'}>{r.status}</Badge> : <span className="muted small">not entered</span>}
                    {r?.status === 'authorized' && s.can('results.amend') ? (
                      <div>
                        <button className="link" onClick={() => setAmend({ resultId: r.id, value: r.value_numeric != null ? String(r.value_numeric) : r.value_text ?? '', reason: '', param: p.name })}>
                          Amend
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>

        {specimenReady && item.status !== 'completed' ? (
          <div className="row-actions">
            {s.can('results.enter') ? <button className="primary" onClick={() => void saveEntries()} disabled={act.busy}>Save results</button> : null}
            {act.error ? <span className="text-warn" role="alert">{act.error}</span> : act.ok ? <span className="muted" role="status">{act.ok}</span> : null}
            {s.can('results.review') && draftsByOthers ? <button onClick={() => void review()} disabled={act.busy}>Technical review</button> : null}
          </div>
        ) : null}

        {s.can('results.authorize') && item.status !== 'completed' && anyEntered ? (
          <div className="authorize-box">
            <h3>Authorize</h3>
            {criticals.length > 0 ? (
              <>
                <Notice kind="warn">
                  Critical value: {criticals.map((c) => c.name).join(', ')}. Record who it was communicated to before authorizing.
                </Notice>
                <Field label="Communicated to (name, designation, time)">
                  <input value={notify} onChange={(e) => setNotify(e.target.value)} placeholder="e.g. Dr. Ali (ward), 14:20" />
                </Field>
              </>
            ) : null}
            <button className="primary" disabled={!allReviewed || act.busy} onClick={() => void authorize()}>
              Authorize and release
            </button>
            {!allReviewed ? <p className="muted small">Each result must be technically reviewed by someone other than the person who entered it.</p> : null}
          </div>
        ) : null}
      </Panel>

      {amend ? (
        <Panel title={`Amend: ${amend.param}`}>
          <div className="form-grid">
            <Field label="New value"><input value={amend.value} onChange={(e) => setAmend({ ...amend, value: e.target.value })} /></Field>
            <Field label="Reason for change (required)"><input value={amend.reason} onChange={(e) => setAmend({ ...amend, reason: e.target.value })} /></Field>
          </div>
          <div className="row-actions">
            <button className="primary" disabled={amend.reason.trim().length < 5 || act.busy} onClick={() => void submitAmend()}>Save amendment</button>
            <button onClick={() => setAmend(null)}>Cancel</button>
          </div>
        </Panel>
      ) : null}

      <Panel title="Attachments">
        <ul className="plain">
          {item.attachments.map((a) => (
            <li key={a.id}>
              <a href={`/api/attachments/${a.id}`} target="_blank" rel="noopener">{a.filename}</a>{' '}
              <span className="muted small">{Math.round(a.size / 1024)} KB</span>
            </li>
          ))}
        </ul>
        {s.can('results.enter') ? (
          <label className="field">
            <span className="field-label">Add a file (PDF, PNG or JPEG, up to 10 MB)</span>
            <input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => void attach(e.target.files?.[0])} />
          </label>
        ) : null}
      </Panel>
    </>
  );
}
