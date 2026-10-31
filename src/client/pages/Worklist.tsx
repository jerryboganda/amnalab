import { Fragment, useEffect, useState } from 'react';
import { fileToDataUrl, get, post } from '../api.ts';
import { Badge, Field, Notice, Panel, RangeBar, useAction } from '../ui.tsx';
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
  report: { id: number; reportNo: string; version: number } | null;
}

interface SaveResult extends ItemView {
  orderCompleted: boolean;
  report: { id: number; reportNo: string; version: number } | null;
  reportError?: string | null;
  missing: string[];
  dispatch?: Array<{ channel: string; status: string }>;
}

const FLAG_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = { N: 'ok', L: 'warn', H: 'warn', LL: 'danger', HH: 'danger' };

export function Worklist({ s }: { s: Session }) {
  const itemId = Number(window.location.hash.split('/')[2]);
  if (Number.isInteger(itemId) && itemId > 0) return <Entry s={s} itemId={itemId} />;
  return <List s={s} />;
}

function List({ s }: { s: Session }) {
  const [rows, setRows] = useState<WorkItem[]>([]);
  const [expandedPatients, setExpandedPatients] = useState<Set<string>>(() => new Set());
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

  const groups = new Map<string, WorkItem[]>();
  for (const row of rows) {
    const patientRows = groups.get(row.mrn);
    if (patientRows) patientRows.push(row);
    else groups.set(row.mrn, [row]);
  }
  const dueText = (due: string | null) =>
    due ? new Date(due).toLocaleString('en-GB', { timeZone: 'Asia/Karachi', dateStyle: 'short', timeStyle: 'short' }) : '-';
  const togglePatient = (patientMrn: string) => {
    setExpandedPatients((current) => {
      const next = new Set(current);
      if (next.has(patientMrn)) next.delete(patientMrn);
      else next.add(patientMrn);
      return next;
    });
  };

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
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>{['Priority', 'Accession', 'Patient', 'Test', 'Department', 'Due', 'Progress', ''].map((head) => <th key={head}>{head}</th>)}</tr>
            </thead>
            {groups.size === 0 ? (
              <tbody><tr><td colSpan={8} className="muted">Nothing waiting. Received specimens appear here.</td></tr></tbody>
            ) : Array.from(groups, ([patientMrn, items]) => {
              const priorityRank: Record<string, number> = { stat: 0, urgent: 1, routine: 2 };
              const topPriority = items.reduce((best, item) =>
                (priorityRank[item.priority] ?? 3) < (priorityRank[best] ?? 3) ? item.priority : best, items[0]!.priority);
              const accessions = [...new Set(items.map((item) => item.accession_no))];
              const departments = [...new Set(items.map((item) => item.department_name))];
              const earliestDue = items.map((item) => item.tat_due_at).filter((due): due is string => due != null).sort()[0] ?? null;
              const authorized = items.reduce((total, item) => total + item.authorized_count, 0);
              const parameters = items.reduce((total, item) => total + item.parameter_count, 0);
              const multiple = items.length > 1;
              const expanded = expandedPatients.has(patientMrn);
              return (
                <Fragment key={patientMrn}>
                  <tbody>
                    <tr className="worklist-patient-row">
                      <td><Badge tone={topPriority === 'stat' ? 'danger' : topPriority === 'urgent' ? 'warn' : 'neutral'}>{topPriority}</Badge></td>
                      <td><code>{accessions.length === 1 ? accessions[0] : `${accessions.length} accessions`}</code></td>
                      <td>{items[0]!.patient_name} ({items[0]!.mrn})</td>
                      <td>{multiple ? `${items.length} tests` : items[0]!.test_name}</td>
                      <td>{departments.length === 1 ? departments[0] : `${departments.length} departments`}</td>
                      <td>{dueText(multiple ? earliestDue : items[0]!.tat_due_at)}</td>
                      <td>{authorized} / {parameters}</td>
                      <td>
                        {multiple ? (
                          <button type="button" className="link" aria-expanded={expanded} aria-controls={`worklist-items-${patientMrn}`} aria-label={`${expanded ? 'Hide' : 'Show'} tests for ${items[0]!.patient_name}`} onClick={() => togglePatient(patientMrn)}>
                            {expanded ? 'Hide tests' : 'Show tests'}
                          </button>
                        ) : <a href={`#/worklist/${items[0]!.order_item_id}`}>Open</a>}
                      </td>
                    </tr>
                  </tbody>
                  {multiple ? (
                    <tbody id={`worklist-items-${patientMrn}`} hidden={!expanded}>
                      {items.map((item) => (
                        <tr key={item.order_item_id} className="worklist-detail">
                          <td><Badge tone={item.priority === 'stat' ? 'danger' : item.priority === 'urgent' ? 'warn' : 'neutral'}>{item.priority}</Badge></td>
                          <td><code>{item.accession_no}</code></td>
                          <td />
                          <td><span aria-hidden="true">↳ </span>{item.test_name}</td>
                          <td>{item.department_name}</td>
                          <td>{dueText(item.tat_due_at)}</td>
                          <td>{item.authorized_count} / {item.parameter_count}</td>
                          <td><a href={`#/worklist/${item.order_item_id}`}>Open</a></td>
                        </tr>
                      ))}
                    </tbody>
                  ) : null}
                </Fragment>
              );
            })}
          </table>
        </div>
      </Panel>
    </>
  );
}

function Entry({ s, itemId }: { s: Session; itemId: number }) {
  const [item, setItem] = useState<ItemView | null>(null);
  const [values, setValues] = useState<Record<number, { num: string; text: string; comment: string }>>({});
  const [issuedReport, setIssuedReport] = useState<SaveResult['report']>(null);
  const [amend, setAmend] = useState<{ resultId: number; value: string; reason: string; param: string } | null>(null);
  const act = useAction();

  const load = async () => {
    const view = await get<ItemView>(`/api/order-items/${itemId}`);
    setItem(view);
    if (view.report) setIssuedReport(view.report);
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
  const anyEntered = item.parameters.some((p) => p.result);

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
    const completeDraft = item!.status !== 'completed' && item!.parameters.every((p) => p.result && p.result.status !== 'cancelled');
    if (body.values.length === 0 && !completeDraft) {
      act.setOk('Nothing changed');
      return;
    }
    const out = await act.run(() => post<SaveResult>(`/api/order-items/${itemId}/results`, body), 'Results saved');
    if (out?.report) setIssuedReport(out.report);
    if (out?.reportError) act.setError(`Results saved, but report generation failed: ${out.reportError}`);
    else if (out?.report) act.setOk(`All order results saved. Report ${out.report.reportNo} v${out.report.version} is ready.`);
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
      {!specimenReady && !anyEntered ? <Notice kind="warn">Results can be entered only after the specimen is received in the lab.</Notice> : null}
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

        {item.status !== 'completed' ? (
          <div className="row-actions">
            {s.can('results.enter') && specimenReady ? <button className="primary" onClick={() => void saveEntries()} disabled={act.busy}>Save results</button> : null}
          </div>
        ) : null}
        {issuedReport && s.can('reports.read') ? <div className="row-actions"><a className="button-like" href={`/api/reports/${issuedReport.id}/pdf`} target="_blank" rel="noopener">Download report {issuedReport.reportNo}</a></div> : null}
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
