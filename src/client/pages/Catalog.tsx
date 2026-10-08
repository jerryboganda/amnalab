import { useEffect, useState } from 'react';
import { get, patch, post, pkr, put } from '../api.ts';
import { Badge, Field, Notice, Panel, RangeBar, Table, useAction } from '../ui.tsx';
import type { Session } from '../App.tsx';

interface TestRow {
  id: number;
  code: string;
  name: string;
  departmentId: number;
  departmentName: string;
  specimenType: string;
  isPanel: boolean;
  basePricePkr: number;
  tatHours: number;
  isActive: boolean;
}

interface Range {
  id: number;
  sex: 'A' | 'M' | 'F';
  age_min_days: number;
  age_max_days: number;
  low: number | null;
  high: number | null;
  text_range: string | null;
  status: 'pending' | 'approved' | 'retired';
  version: number;
  note: string | null;
  created_by: number | null;
  approved_by: number | null;
}

interface ParamDetail {
  id: number;
  code: string;
  name: string;
  unit: string | null;
  decimals: number;
  resultType: string;
  formula: string | null;
  options: string[] | null;
  criticalLow: number | null;
  criticalHigh: number | null;
  ranges: Range[];
}

interface TestDetail extends TestRow {
  parameters: ParamDetail[];
  members: Array<{ id: number; code: string; name: string }>;
  reagents: Array<{ item_id: number; code: string; name: string; unit: string; qty_per_test: number }>;
  prices: Array<{ branch_code: string; price_pkr: number; effective_from: string }>;
}

export function Catalog({ s }: { s: Session }) {
  const id = Number(window.location.hash.split('/')[1]);
  if (Number.isInteger(id) && id > 0) return <TestView s={s} id={id} />;
  return <TestList s={s} />;
}

function TestList({ s }: { s: Session }) {
  const [rows, setRows] = useState<TestRow[]>([]);
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [depts, setDepts] = useState<Array<{ id: number; name: string }>>([]);
  const [creating, setCreating] = useState(false);
  const [csvMsg, setCsvMsg] = useState<string | null>(null);
  const load = () => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (dept) p.set('department', dept);
    get<TestRow[]>(`/api/catalog/tests?${p}`).then(setRows).catch(() => setRows([]));
  };
  useEffect(() => {
    get<Array<{ id: number; name: string }>>('/api/catalog/departments').then(setDepts).catch(() => setDepts([]));
  }, []);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dept]);

  async function importCsv(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    try {
      const preview = await post('/api/catalog/import', { csv: text, dryRun: true });
      if (!window.confirm(`The file has ${preview.rows} rows. Import now? New ranges wait for pathologist approval.`)) return;
      const out = await post('/api/catalog/import', { csv: text });
      setCsvMsg(`Imported ${out.rows} rows. ${out.testsCreated} new tests. Ranges need approval.`);
      load();
    } catch (e) {
      const err = e as { data?: { errors?: Array<{ line: number; message: string }> }; message: string };
      setCsvMsg(err.data?.errors ? `Not imported: ${err.data.errors.slice(0, 5).map((x) => `line ${x.line}: ${x.message}`).join('; ')}` : err.message);
    }
  }

  return (
    <>
      <div className="toolbar">
        <h1>Test catalog</h1>
        <div className="toolbar-right">
          <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} aria-label="Search tests" />
          <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
            <option value="">All departments</option>
            {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button onClick={load}>Search</button>
          {s.can('catalog.write') ? <button className="primary" onClick={() => setCreating(!creating)}>{creating ? 'Close' : 'New test'}</button> : null}
          <a className="button-like" href="/api/catalog/export.csv">Export CSV</a>
          {s.can('catalog.write') ? (
            <label className="button-like">
              Import CSV
              <input type="file" accept=".csv,text/csv" hidden onChange={(e) => void importCsv(e.target.files?.[0])} />
            </label>
          ) : null}
        </div>
      </div>
      {csvMsg ? <Notice kind="info">{csvMsg}</Notice> : null}
      {creating ? <NewTest s={s} depts={depts} onCreated={(id) => { setCreating(false); window.location.hash = `#/catalog/${id}`; }} /> : null}
      <Panel>
        <Table
          head={['Code', 'Name', 'Department', 'Specimen', 'Price (PKR)', 'TAT (h)', 'Type']}
          rows={rows.map((t) => [
            <code key="c">{t.code}</code>,
            <a key="n" href={`#/catalog/${t.id}`}>{t.name}</a>,
            t.departmentName,
            t.specimenType,
            pkr(t.basePricePkr),
            t.tatHours,
            t.isPanel ? <Badge key="p" tone="info">panel</Badge> : 'test',
          ])}
          empty="No tests match"
        />
      </Panel>
    </>
  );
}

function NewTest({ s, depts, onCreated }: { s: Session; depts: Array<{ id: number; name: string }>; onCreated: (id: number) => void }) {
  const [f, setF] = useState({ code: '', name: '', departmentId: '', specimenType: 'EDTA whole blood', price: '0', tat: '24', isPanel: false });
  const act = useAction();
  async function submit() {
    const out = await act.run(() => post<{ id: number }>('/api/catalog/tests', {
      code: f.code,
      name: f.name,
      departmentId: Number(f.departmentId),
      specimenType: f.specimenType,
      basePricePkr: Number(f.price),
      tatHours: Number(f.tat),
      isPanel: f.isPanel,
    }));
    if (out) onCreated(out.id);
  }
  return (
    <Panel title="New test">
      <div className="form-grid">
        <Field label="Code"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Department">
          <select value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}>
            <option value="">-</option>
            {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Specimen type"><input value={f.specimenType} onChange={(e) => setF({ ...f, specimenType: e.target.value })} /></Field>
        <Field label="Price (PKR)"><input type="number" min={0} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
        <Field label="Turnaround (hours)"><input type="number" min={1} value={f.tat} onChange={(e) => setF({ ...f, tat: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={f.isPanel} onChange={(e) => setF({ ...f, isPanel: e.target.checked })} /> This is a panel (adds member tests later)</label>
      </div>
      {act.error ? <Notice kind="error">{act.error}</Notice> : null}
      <button className="primary" disabled={act.busy || !f.code || !f.name || !f.departmentId || !s.can('catalog.write')} onClick={() => void submit()}>Create test</button>
    </Panel>
  );
}

function TestView({ s, id }: { s: Session; id: number }) {
  const [test, setTest] = useState<TestDetail | null>(null);
  const [items, setItems] = useState<Array<{ id: number; code: string; name: string }>>([]);
  const act = useAction();
  const load = () => get<TestDetail>(`/api/catalog/tests/${id}`).then(setTest).catch((e: Error) => act.setError(e.message));
  useEffect(() => {
    void load();
    get('/api/inventory/items').then((r: Array<{ id: number; code: string; name: string }>) => setItems(r)).catch(() => setItems([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!test) return <p className="muted">Loading test...</p>;
  const canWrite = s.can('catalog.write');

  return (
    <>
      <div className="toolbar">
        <a href="#/catalog">&larr; Catalog</a>
        <h1>{test.name}</h1>
        <code>{test.code}</code>
        {test.isPanel ? <Badge tone="info">panel</Badge> : null}
        {!test.isActive ? <Badge tone="danger">inactive</Badge> : null}
      </div>
      {act.error ? <Notice kind="error">{act.error}</Notice> : null}
      {act.ok ? <Notice kind="ok">{act.ok}</Notice> : null}

      <div className="grid-2">
        <Panel title="Test details">
          <EditTest test={test} canWrite={canWrite} onSaved={load} run={act.run} busy={act.busy} />
          {test.isPanel ? (
            <>
              <h3>Members</h3>
              <ul className="plain">{test.members.map((m) => <li key={m.id}>{m.name} <span className="muted small">{m.code}</span></li>)}</ul>
            </>
          ) : null}
        </Panel>
        <Panel title="Prices">
          <Table head={['Branch', 'Price (PKR)', 'From']} rows={test.prices.map((p) => [p.branch_code, pkr(p.price_pkr), p.effective_from])} empty="Standard price applies in all branches" />
          {canWrite ? <PriceForm test={test} run={act.run} busy={act.busy} onSaved={load} /> : null}
        </Panel>
      </div>

      {!test.isPanel ? (
        <Panel title="Parameters and reference ranges">
          {test.parameters.map((p) => (
            <ParamBlock key={p.id} p={p} canWrite={canWrite} canApprove={s.can('catalog.approve_ranges')} userId={s.me.id} run={act.run} busy={act.busy} onChanged={load} />
          ))}
          {canWrite ? <AddParam testId={test.id} run={act.run} busy={act.busy} onAdded={load} /> : null}
        </Panel>
      ) : null}

      {!test.isPanel && canWrite ? (
        <Panel title="Reagents used per test (stock deducted on first result entry)">
          <ReagentEditor test={test} items={items} run={act.run} busy={act.busy} onSaved={load} />
        </Panel>
      ) : null}
    </>
  );
}

function EditTest({ test, canWrite, onSaved, run, busy }: { test: TestDetail; canWrite: boolean; onSaved: () => void; run: ReturnType<typeof useAction>['run']; busy: boolean }) {
  const [f, setF] = useState({ name: test.name, price: String(test.basePricePkr), tat: String(test.tatHours), active: test.isActive });
  async function save() {
    await run(() => patch(`/api/catalog/tests/${test.id}`, { name: f.name, basePricePkr: Number(f.price), tatHours: Number(f.tat), isActive: f.active }), 'Saved');
    onSaved();
  }
  if (!canWrite) {
    return (
      <dl className="kv">
        <dt>Department</dt><dd>{test.departmentName}</dd>
        <dt>Specimen</dt><dd>{test.specimenType}</dd>
        <dt>Base price</dt><dd>PKR {pkr(test.basePricePkr)}</dd>
        <dt>Turnaround</dt><dd>{test.tatHours} h</dd>
      </dl>
    );
  }
  return (
    <div className="form-grid">
      <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Base price (PKR)"><input type="number" min={0} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
      <Field label="Turnaround (hours)"><input type="number" min={1} value={f.tat} onChange={(e) => setF({ ...f, tat: e.target.value })} /></Field>
      <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Orderable</label>
      <div><button disabled={busy} onClick={() => void save()}>Save test</button></div>
    </div>
  );
}

function PriceForm({ test, run, busy, onSaved }: { test: TestDetail; run: ReturnType<typeof useAction>['run']; busy: boolean; onSaved: () => void }) {
  const [f, setF] = useState({ branchId: '', price: '', from: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date()) });
  const [branches, setBranches] = useState<Array<{ id: number; name: string; code: string }>>([]);
  useEffect(() => {
    get<Array<{ id: number; name: string; code: string }>>('/api/branches').then(setBranches).catch(() => setBranches([]));
  }, []);
  async function save() {
    await run(() => post(`/api/catalog/tests/${test.id}/prices`, { branchId: Number(f.branchId), pricePkr: Number(f.price), effectiveFrom: f.from }), 'Price scheduled');
    onSaved();
  }
  return (
    <div className="form-grid">
      <Field label="Branch">
        <select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>
          <option value="">-</option>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </Field>
      <Field label="Price (PKR)"><input type="number" min={0} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
      <Field label="Effective from"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
      <div><button disabled={busy || !f.branchId || !f.price} onClick={() => void save()}>Schedule price</button></div>
    </div>
  );
}

function ParamBlock({
  p,
  canWrite,
  canApprove,
  userId,
  run,
  busy,
  onChanged,
}: {
  p: ParamDetail;
  canWrite: boolean;
  canApprove: boolean;
  userId: number;
  run: ReturnType<typeof useAction>['run'];
  busy: boolean;
  onChanged: () => void;
}) {
  const [range, setRange] = useState({ sex: 'A', low: '', high: '', text: '', note: '', ageMin: '0', ageMax: '36500' });
  const approved = p.ranges.filter((r) => r.status === 'approved');
  const pending = p.ranges.filter((r) => r.status === 'pending');

  async function propose() {
    await run(() => post(`/api/catalog/parameters/${p.id}/ranges`, {
      sex: range.sex,
      low: range.low === '' ? undefined : Number(range.low),
      high: range.high === '' ? undefined : Number(range.high),
      textRange: range.text || undefined,
      note: range.note || undefined,
      ageMinDays: Number(range.ageMin),
      ageMaxDays: Number(range.ageMax),
    }), 'Range proposed. A different pathologist must approve it.');
    setRange({ sex: 'A', low: '', high: '', text: '', note: '', ageMin: '0', ageMax: '36500' });
    onChanged();
  }

  async function approve(id: number) {
    await run(() => post(`/api/catalog/ranges/${id}/approve`), 'Range approved');
    onChanged();
  }

  const first = approved[0];
  return (
    <div className="param-block">
      <h3>
        {p.name} <code className="small">{p.code}</code>
        {p.unit ? <span className="muted small"> ({p.unit})</span> : null}
        {p.resultType !== 'numeric' ? <Badge tone="neutral">{p.resultType}</Badge> : null}
      </h3>
      {p.options ? <p className="small">Options: {p.options.join(', ')}</p> : null}
      {p.formula ? <p className="small">Formula: <code>{p.formula}</code></p> : null}
      {approved.length === 0 ? <p className="muted small">No approved reference range. Flags will not be calculated.</p> : null}
      <Table
        head={['Sex', 'Age band (days)', 'Reference', 'Status', 'Note', '']}
        rows={p.ranges.map((r) => [
          r.sex,
          `${r.age_min_days}-${r.age_max_days}`,
          r.text_range ?? `${r.low ?? '-'} to ${r.high ?? '-'}`,
          <Badge key="s" tone={r.status === 'approved' ? 'ok' : r.status === 'pending' ? 'warn' : 'neutral'}>{r.status}</Badge>,
          <span key="n" className="small">{r.note ?? ''} {r.approved_by ? '' : r.status === 'approved' ? '(starter, unverified)' : ''}</span>,
          r.status === 'pending' && canApprove && r.created_by !== userId ? (
            <button key="a" disabled={busy} onClick={() => void approve(r.id)}>Approve</button>
          ) : r.status === 'pending' && r.created_by === userId ? (
            <span key="a" className="muted small">awaiting another pathologist</span>
          ) : null,
        ])}
        empty="No ranges yet"
      />
      {first && (first.low != null || first.high != null) ? (
        <RangeBar low={first.low} high={first.high} critLow={p.criticalLow} critHigh={p.criticalHigh} unit={p.unit} />
      ) : null}
      {pending.length > 0 ? <p className="small muted">{pending.length} range change(s) waiting for approval.</p> : null}
      {canWrite && p.resultType === 'numeric' ? (
        <details>
          <summary>Propose a new reference range</summary>
          <div className="form-grid">
            <Field label="Sex">
              <select value={range.sex} onChange={(e) => setRange({ ...range, sex: e.target.value })}>
                <option value="A">Any</option>
                <option value="M">Male</option>
                <option value="F">Female</option>
              </select>
            </Field>
            <Field label="Low"><input type="number" step="any" value={range.low} onChange={(e) => setRange({ ...range, low: e.target.value })} /></Field>
            <Field label="High"><input type="number" step="any" value={range.high} onChange={(e) => setRange({ ...range, high: e.target.value })} /></Field>
            <Field label="Age from (days)"><input type="number" min={0} value={range.ageMin} onChange={(e) => setRange({ ...range, ageMin: e.target.value })} /></Field>
            <Field label="Age to (days)"><input type="number" min={0} value={range.ageMax} onChange={(e) => setRange({ ...range, ageMax: e.target.value })} /></Field>
            <Field label="Note / source"><input value={range.note} onChange={(e) => setRange({ ...range, note: e.target.value })} /></Field>
          </div>
          <button disabled={busy || (range.low === '' && range.high === '')} onClick={() => void propose()}>Propose range</button>
        </details>
      ) : null}
    </div>
  );
}

function AddParam({ testId, run, busy, onAdded }: { testId: number; run: ReturnType<typeof useAction>['run']; busy: boolean; onAdded: () => void }) {
  const [f, setF] = useState({ code: '', name: '', unit: '', resultType: 'numeric', decimals: '1', formula: '', options: '', critLow: '', critHigh: '' });
  async function add() {
    await run(() => post(`/api/catalog/tests/${testId}/parameters`, {
      code: f.code,
      name: f.name,
      unit: f.unit || undefined,
      resultType: f.resultType,
      decimals: Number(f.decimals),
      formula: f.formula || undefined,
      qualitativeOptions: f.options ? f.options.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
      criticalLow: f.critLow === '' ? undefined : Number(f.critLow),
      criticalHigh: f.critHigh === '' ? undefined : Number(f.critHigh),
    }), 'Parameter added');
    setF({ code: '', name: '', unit: '', resultType: 'numeric', decimals: '1', formula: '', options: '', critLow: '', critHigh: '' });
    onAdded();
  }
  return (
    <details className="stack">
      <summary>Add a parameter</summary>
      <div className="form-grid">
        <Field label="Code"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Unit"><input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></Field>
        <Field label="Result type">
          <select value={f.resultType} onChange={(e) => setF({ ...f, resultType: e.target.value })}>
            <option value="numeric">Numeric</option>
            <option value="qualitative">Qualitative (choose)</option>
            <option value="text">Free text</option>
            <option value="calculated">Calculated (formula)</option>
          </select>
        </Field>
        <Field label="Decimals"><input type="number" min={0} max={6} value={f.decimals} onChange={(e) => setF({ ...f, decimals: e.target.value })} /></Field>
        {f.resultType === 'calculated' ? <Field label="Formula" hint="e.g. TC - HDL - TG / 5"><input value={f.formula} onChange={(e) => setF({ ...f, formula: e.target.value })} /></Field> : null}
        {f.resultType === 'qualitative' ? <Field label="Options (comma separated)"><input value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} /></Field> : null}
        <Field label="Critical low"><input type="number" step="any" value={f.critLow} onChange={(e) => setF({ ...f, critLow: e.target.value })} /></Field>
        <Field label="Critical high"><input type="number" step="any" value={f.critHigh} onChange={(e) => setF({ ...f, critHigh: e.target.value })} /></Field>
      </div>
      <button disabled={busy || !f.code || !f.name} onClick={() => void add()}>Add parameter</button>
    </details>
  );
}

function ReagentEditor({ test, items, run, busy, onSaved }: { test: TestDetail; items: Array<{ id: number; code: string; name: string }>; run: ReturnType<typeof useAction>['run']; busy: boolean; onSaved: () => void }) {
  const [rows, setRows] = useState<Array<{ itemId: string; qty: string }>>(
    test.reagents.map((r) => ({ itemId: String(r.item_id), qty: String(r.qty_per_test) })),
  );
  async function save() {
    const items = rows.filter((r) => r.itemId && Number(r.qty) > 0).map((r) => ({ itemId: Number(r.itemId), qtyPerTest: Number(r.qty) }));
    await run(() => put(`/api/catalog/tests/${test.id}/reagents`, { items }), 'Reagents saved');
    onSaved();
  }
  return (
    <div className="stack">
      {rows.map((r, i) => (
        <div key={i} className="row-actions">
          <select value={r.itemId} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))} aria-label="Reagent item">
            <option value="">-</option>
            {items.map((it) => <option key={it.id} value={it.id}>{it.name} ({it.code})</option>)}
          </select>
          <input type="number" min={0} step="any" value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} aria-label="Quantity per test" className="num" />
          <button onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <div className="row-actions">
        <button onClick={() => setRows([...rows, { itemId: '', qty: '1' }])}>Add reagent</button>
        <button className="primary" disabled={busy} onClick={() => void save()}>Save reagents</button>
      </div>
      <p className="muted small">Changes apply to tests processed from now on.</p>
    </div>
  );
}
