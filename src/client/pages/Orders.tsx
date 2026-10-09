import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { get, pkr, post, when } from '../api.ts';
import { Badge, Field, Notice, Panel, Table, useAction } from '../ui.tsx';
import type { Session } from '../App.tsx';
import { startWhatsApp } from './Patients.tsx';

interface Summary {
  id: number;
  order_no: string;
  patient_name: string;
  mrn: string;
  priority: string;
  status: string;
  created_at: string;
}

const STATUS_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'info' | 'danger'> = {
  confirmed: 'info',
  in_progress: 'warn',
  completed: 'ok',
  cancelled: 'danger',
};

export function Orders({ s }: { s: Session }) {
  const id = Number(window.location.hash.split('/')[2]);
  if (Number.isInteger(id) && id > 0) return <OrderDetail s={s} id={id} />;
  return <OrderList s={s} />;
}

function OrderList({ s }: { s: Session }) {
  const [rows, setRows] = useState<Summary[]>([]);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState('');
  const load = () =>
    get<Summary[]>(`/api/orders?branchId=${s.branchId}${status ? `&status=${status}` : ''}`).then(setRows).catch(() => setRows([]));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.branchId, status]);

  return (
    <>
      <div className="toolbar">
        <h1>Orders &amp; specimens</h1>
        <div className="toolbar-right">
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="confirmed">Confirmed</option>
            <option value="in_progress">In progress</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          {s.can('orders.write') ? <button className="primary" onClick={() => setCreating(!creating)}>{creating ? 'Close' : 'New order'}</button> : null}
        </div>
      </div>
      {creating ? (
        <NewOrder
          s={s}
          onCreated={(id) => {
            setCreating(false);
            s.go(`orders/${id}`);
          }}
        />
      ) : null}
      <Panel>
        <Table
          head={['Order', 'Patient', 'MRN', 'Priority', 'Status', 'Created']}
          rows={rows.map((o) => [
            <a key="o" href={`#/orders/${o.id}`}>{o.order_no}</a>,
            o.patient_name,
            <code key="m">{o.mrn}</code>,
            <Badge key="p" tone={o.priority === 'stat' ? 'danger' : o.priority === 'urgent' ? 'warn' : 'neutral'}>{o.priority}</Badge>,
            <Badge key="s" tone={STATUS_TONE[o.status] ?? 'neutral'}>{o.status.replace('_', ' ')}</Badge>,
            when(o.created_at),
          ])}
          empty="No orders for this branch yet"
        />
      </Panel>
    </>
  );
}

interface TestOption {
  id: number;
  code: string;
  name: string;
  departmentName: string;
  isPanel: boolean;
  basePricePkr: number;
  specimenType: string;
}

function NewOrder({ s, onCreated }: { s: Session; onCreated: (id: number) => void }) {
  const [patientQuery, setPatientQuery] = useState('');
  const [patients, setPatients] = useState<Array<{ id: number; mrn: string; fullName: string; ageYears: number | null; gender: string }>>([]);
  const [patient, setPatient] = useState<{ id: number; mrn: string; fullName: string } | null>(null);
  const [tests, setTests] = useState<TestOption[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [testFilter, setTestFilter] = useState('');
  const [priority, setPriority] = useState('routine');
  const [practitionerId, setPractitionerId] = useState('');
  const [practitioners, setPractitioners] = useState<Array<{ id: number; name: string }>>([]);
  const [discount, setDiscount] = useState({ type: 'none', value: '', reason: '', approverUser: '', approverPass: '' });
  const [payment, setPayment] = useState({ method: 'cash', amount: '', reference: '' });
  const act = useAction();

  useEffect(() => {
    get<TestOption[]>('/api/catalog/tests').then(setTests).catch(() => setTests([]));
    get<Array<{ id: number; name: string }>>('/api/practitioners').then(setPractitioners).catch(() => setPractitioners([]));
  }, []);

  async function searchPatients() {
    setPatients(await get(`/api/patients?q=${encodeURIComponent(patientQuery)}`));
  }

  const filtered = useMemo(
    () => tests.filter((t) => !testFilter || `${t.name} ${t.code} ${t.departmentName}`.toLowerCase().includes(testFilter.toLowerCase())),
    [tests, testFilter],
  );
  const estimate = tests.filter((t) => picked.includes(t.id)).reduce((sum, t) => sum + t.basePricePkr, 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!patient) return act.setError('Choose a patient first');
    if (picked.length === 0) return act.setError('Choose at least one test');
    const body: Record<string, unknown> = {
      branchId: s.branchId,
      patientId: patient.id,
      priority,
      practitionerId: practitionerId ? Number(practitionerId) : null,
      testIds: picked,
    };
    if (discount.type !== 'none') {
      body.discount = {
        type: discount.type,
        value: Number(discount.value),
        reason: discount.reason,
        approver: discount.approverUser ? { username: discount.approverUser, password: discount.approverPass } : undefined,
      };
    }
    if (payment.amount && Number(payment.amount) > 0) {
      body.payment = { method: payment.method, amountPkr: Number(payment.amount), reference: payment.reference || undefined };
    }
    const created = await act.run(() => post<{ id: number }>('/api/orders', body), 'Order created');
    if (created) onCreated(created.id);
  }

  return (
    <Panel title="New order">
      <form onSubmit={(e) => void submit(e)} className="stack">
        <div className="grid-2">
          <div>
            <h3>1. Patient</h3>
            {patient ? (
              <p>
                <strong>{patient.fullName}</strong> <code>{patient.mrn}</code>{' '}
                <button type="button" className="link" onClick={() => setPatient(null)}>change</button>
              </p>
            ) : (
              <>
                <div className="toolbar-right">
                  <input placeholder="Name, MRN or phone" value={patientQuery} onChange={(e) => setPatientQuery(e.target.value)} />
                  <button type="button" onClick={() => void searchPatients()}>Find</button>
                </div>
                <ul className="plain">
                  {patients.map((p) => (
                    <li key={p.id}>
                      <button type="button" className="link" onClick={() => setPatient({ id: p.id, mrn: p.mrn, fullName: p.fullName })}>
                        {p.fullName}
                      </button>{' '}
                      <span className="muted small">{p.mrn}, {p.ageYears ?? '-'}/{p.gender}</span>
                    </li>
                  ))}
                </ul>
                <p className="muted small">Not registered? Add them under Patients first.</p>
              </>
            )}
          </div>
          <div className="form-grid">
            <Field label="Priority">
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="routine">Routine</option>
                <option value="urgent">Urgent</option>
                <option value="stat">STAT</option>
              </select>
            </Field>
            <Field label="Referring doctor">
              <select value={practitionerId} onChange={(e) => setPractitionerId(e.target.value)}>
                <option value="">Self / none</option>
                {practitioners.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
          </div>
        </div>

        <h3>2. Tests and panels</h3>
        <input placeholder="Filter tests" value={testFilter} onChange={(e) => setTestFilter(e.target.value)} aria-label="Filter tests" />
        <div className="test-grid">
          {filtered.map((t) => (
            <label key={t.id} className={`test-chip ${picked.includes(t.id) ? 'on' : ''}`}>
              <input
                type="checkbox"
                checked={picked.includes(t.id)}
                onChange={(e) => setPicked(e.target.checked ? [...picked, t.id] : picked.filter((x) => x !== t.id))}
              />
              <span>
                {t.name} {t.isPanel ? <Badge tone="info">panel</Badge> : null}
                <span className="muted small"> {t.departmentName} | PKR {pkr(t.basePricePkr)}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="grid-2">
          <fieldset>
            <legend>3. Discount (optional)</legend>
            <div className="form-grid">
              <Field label="Type">
                <select value={discount.type} onChange={(e) => setDiscount({ ...discount, type: e.target.value })}>
                  <option value="none">None</option>
                  <option value="percent">Percent</option>
                  <option value="fixed">Fixed amount (PKR)</option>
                </select>
              </Field>
              <Field label="Value"><input type="number" min={0} value={discount.value} onChange={(e) => setDiscount({ ...discount, value: e.target.value })} /></Field>
              <Field label="Reason"><input value={discount.reason} onChange={(e) => setDiscount({ ...discount, reason: e.target.value })} /></Field>
              <Field label="Approver username" hint="Needed only when the discount is above your limit"><input value={discount.approverUser} onChange={(e) => setDiscount({ ...discount, approverUser: e.target.value })} /></Field>
              <Field label="Approver password"><input type="password" value={discount.approverPass} onChange={(e) => setDiscount({ ...discount, approverPass: e.target.value })} autoComplete="off" /></Field>
            </div>
          </fieldset>
          <fieldset>
            <legend>4. Payment now (optional)</legend>
            <div className="form-grid">
              <Field label="Method">
                <select value={payment.method} onChange={(e) => setPayment({ ...payment, method: e.target.value })}>
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="jazzcash">JazzCash</option>
                  <option value="easypaisa">Easypaisa</option>
                </select>
              </Field>
              <Field label="Amount (PKR)"><input type="number" min={0} step="0.01" value={payment.amount} onChange={(e) => setPayment({ ...payment, amount: e.target.value })} /></Field>
              <Field label="Reference" hint="Required for non-cash"><input value={payment.reference} onChange={(e) => setPayment({ ...payment, reference: e.target.value })} /></Field>
            </div>
          </fieldset>
        </div>

        <p>Estimated total before discount: <strong>PKR {pkr(estimate)}</strong> <span className="muted small">(final amount is calculated by the server)</span></p>
        {act.error ? <Notice kind="error">{act.error}</Notice> : null}
        <div>
          <button type="submit" className="primary" disabled={act.busy}>{act.busy ? 'Saving...' : 'Create order'}</button>
        </div>
      </form>
    </Panel>
  );
}

interface OrderDetailData {
  id: number;
  order_no: string;
  status: string;
  priority: string;
  created_at: string;
  patient_name: string;
  mrn: string;
  practitioner_name: string | null;
  items: Array<{ id: number; status: string; test_name: string; department_name: string; authorized_count: number; result_count: number; specimen_id: number }>;
  specimens: Array<{ id: number; accession_no: string; specimen_type: string; status: string; collector_name: string | null; reject_reason: string | null; recollect_required: number }>;
  invoice: { id: number; invoice_no: string; total_paisa: number; paid_paisa: number; refunded_paisa: number; status: string } | null;
  reports: Array<{ id: number; report_no: string; version: number; status: string; issued_at: string }>;
}

function OrderDetail({ s, id }: { s: Session; id: number }) {
  const [order, setOrder] = useState<OrderDetailData | null>(null);
  const [pendingReject, setPendingReject] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [recollect, setRecollect] = useState(true);
  const [collector, setCollector] = useState<Record<number, string>>({});
  const [sendTo, setSendTo] = useState<Record<number, { channel: string; destination: string }>>({});
  const [pendingWa, setPendingWa] = useState<number | null>(null);
  const act = useAction();

  const load = () => get<OrderDetailData>(`/api/orders/${id}`).then(setOrder).catch((e: Error) => act.setError(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function specimenAction(specimenId: number, path: string, body: unknown = {}, success?: string) {
    await act.run(() => post(`/api/specimens/${specimenId}/${path}`, body), success);
    await load();
  }

  async function cancelItem(itemId: number, name: string) {
    const reason = window.prompt(`Reason for cancelling ${name} (required). Refund any payment from Billing.`);
    if (!reason || reason.trim().length < 5) return;
    await act.run(() => post(`/api/order-items/${itemId}/cancel`, { reason }), `${name} cancelled`);
    await load();
  }

  async function reissue() {
    const reason = window.prompt('Reason for re-issuing this report (required)');
    if (!reason) return;
    await act.run(() => post(`/api/orders/${id}/reissue`, { reason }), 'New report version issued');
    await load();
  }

  async function sendReport(reportId: number) {
    const cfg = sendTo[reportId] ?? { channel: 'email', destination: '' };
    if (cfg.channel === 'whatsapp') {
      const r = await act.run(() => startWhatsApp(reportId), 'Chat opened. Attach the PDF, press send, then confirm.');
      if (r) setPendingWa(r.outboxId);
      return;
    }
    await act.run(() => post(`/api/reports/${reportId}/send`, { channel: cfg.channel, destination: cfg.destination || undefined }), `Queued for ${cfg.channel}`);
  }

  if (!order) return act.error ? <Notice kind="error">{act.error}</Notice> : <p className="muted">Loading order...</p>;
  const invoice = order.invoice;
  const due = invoice ? invoice.total_paisa - invoice.paid_paisa + invoice.refunded_paisa : 0;

  return (
    <>
      <div className="toolbar">
        <a href="#/orders">&larr; Orders</a>
        <h1>{order.order_no}</h1>
        <Badge tone={STATUS_TONE[order.status] ?? 'neutral'}>{order.status.replace('_', ' ')}</Badge>
        {order.priority !== 'routine' ? <Badge tone="danger">{order.priority.toUpperCase()}</Badge> : null}
      </div>
      <p className="muted">{order.patient_name} ({order.mrn}) | Ordered {when(order.created_at)}{order.practitioner_name ? ` | Ref. ${order.practitioner_name}` : ''}</p>
      {act.error ? <Notice kind="error">{act.error}</Notice> : null}
      {act.ok ? <Notice kind="ok">{act.ok}</Notice> : null}
      {pendingWa ? (
        <Notice kind="info">
          WhatsApp chat is open. After you attach the PDF and press send: <button onClick={() => void act.run(() => post(`/api/notifications/${pendingWa}/whatsapp`, { action: 'confirm' }), 'Recorded as sent').then((r) => r && setPendingWa(null))}>I sent it</button>
        </Notice>
      ) : null}

      <Panel title="Specimens">
        <Table
          head={['Accession', 'Type', 'Status', 'Collected by', 'Actions']}
          rows={order.specimens.map((sp) => [
            <code key="a">{sp.accession_no}</code>,
            sp.specimen_type,
            <Badge key="s" tone={sp.status === 'rejected' ? 'danger' : sp.status === 'received' || sp.status === 'processing' ? 'ok' : 'info'}>
              {sp.status}
            </Badge>,
            sp.collector_name ?? '-',
            <span key="act" className="row-actions">
              {sp.status === 'expected' && s.can('specimens.write') ? (
                <>
                  <input
                    placeholder="Collector name"
                    value={collector[sp.id] ?? ''}
                    onChange={(e) => setCollector({ ...collector, [sp.id]: e.target.value })}
                    aria-label="Collector name"
                  />
                  <button disabled={!collector[sp.id] || act.busy} onClick={() => void specimenAction(sp.id, 'collect', { collectorName: collector[sp.id] }, 'Collected')}>Mark collected</button>
                </>
              ) : null}
              {sp.status === 'collected' && s.can('specimens.write') ? <button onClick={() => void specimenAction(sp.id, 'receive', {}, 'Received in the lab')}>Receive</button> : null}
              {['expected', 'collected', 'received'].includes(sp.status) && s.can('specimens.write') ? (
                <button className="danger" onClick={() => setPendingReject(sp.id)}>Reject</button>
              ) : null}
              {sp.status === 'rejected' && !sp.recollect_required && s.can('specimens.write') ? (
                <button onClick={() => void specimenAction(sp.id, 'recollect', {}, 'New specimen requested for recollection')}>Recollect</button>
              ) : null}
              {['received', 'processing'].includes(sp.status) && s.can('specimens.write') && order.items.filter((i) => i.specimen_id === sp.id).every((i) => i.status === 'completed' || i.status === 'cancelled') ? (
                <>
                  <button onClick={() => void specimenAction(sp.id, 'store', { disposition: 'stored' }, 'Stored')}>Store</button>
                  <button onClick={() => void specimenAction(sp.id, 'store', { disposition: 'disposed' }, 'Disposed')}>Dispose</button>
                </>
              ) : null}
              {s.can('specimens.write') ? <button onClick={() => window.open(`/api/specimens/${sp.id}/label`, '_blank', 'noopener')}>Label</button> : null}
            </span>,
          ])}
          empty="No specimens"
        />
        {sp(pendingReject, order, rejectReason, setRejectReason, recollect, setRecollect, async () => {
          if (pendingReject === null) return;
          await specimenAction(pendingReject, 'reject', { reason: rejectReason, recollect }, 'Specimen rejected');
          setPendingReject(null);
          setRejectReason('');
        }, () => setPendingReject(null))}
        {order.specimens.some((x) => x.status === 'rejected') ? (
          <Notice kind="warn">A specimen was rejected. Results stay blocked until a valid recollection is received.</Notice>
        ) : null}
      </Panel>

      <Panel title="Tests">
        <Table
          head={['Test', 'Department', 'Status', 'Authorized', '']}
          rows={order.items.map((i) => [
            i.test_name,
            i.department_name,
            <Badge key="s" tone={i.status === 'completed' ? 'ok' : i.status === 'cancelled' ? 'danger' : 'info'}>{i.status}</Badge>,
            `${i.authorized_count} / ${i.result_count}`,
            s.can('orders.write') && i.status !== 'completed' && i.status !== 'cancelled' ? (
              <button key="c" className="danger" onClick={() => void cancelItem(i.id, i.test_name)}>Cancel test</button>
            ) : null,
          ])}
        />
        {s.can('results.enter') ? <p><a href="#/worklist">Open the worklist to enter results &rarr;</a></p> : null}
      </Panel>

      <div className="grid-2">
        <Panel title="Invoice">
          {invoice ? (
            <>
              <p><strong>{invoice.invoice_no}</strong> &middot; <Badge tone={invoice.status === 'paid' ? 'ok' : 'warn'}>{invoice.status.replace('_', ' ')}</Badge></p>
              <p>Total PKR {pkr(invoice.total_paisa / 100)} &middot; Paid {pkr(invoice.paid_paisa / 100)} &middot; Balance due {pkr(due / 100)}</p>
              {s.can('billing.read') ? <a href={`#/billing/${invoice.id}`}>Open invoice &rarr;</a> : null}
            </>
          ) : (
            <p className="muted">No invoice</p>
          )}
        </Panel>
        <Panel title="Reports">
          <Table
            head={['Report', 'Version', 'Status', 'Actions']}
            rows={order.reports.map((r) => [
              <code key="n">{r.report_no}</code>,
              `v${r.version}`,
              <Badge key="st" tone={r.status === 'final' ? 'ok' : 'neutral'}>{r.status}</Badge>,
              <span key="a" className="row-actions">
                <button onClick={() => window.open(`/api/reports/${r.id}/pdf`, '_blank', 'noopener')}>View PDF</button>
                {r.status === 'final' && s.can('reports.send') ? (
                  <>
                    <select
                      aria-label="Channel"
                      value={sendTo[r.id]?.channel ?? 'email'}
                      onChange={(e) => setSendTo({ ...sendTo, [r.id]: { channel: e.target.value, destination: sendTo[r.id]?.destination ?? '' } })}
                    >
                      <option value="email">Email</option>
                      <option value="sms">SMS</option>
                      <option value="whatsapp">WhatsApp</option>
                    </select>
                    <input
                      placeholder="Other number/email (optional)"
                      value={sendTo[r.id]?.destination ?? ''}
                      onChange={(e) => setSendTo({ ...sendTo, [r.id]: { channel: sendTo[r.id]?.channel ?? 'email', destination: e.target.value } })}
                      aria-label="Destination override"
                    />
                    <button onClick={() => void sendReport(r.id)} disabled={act.busy}>Send</button>
                  </>
                ) : null}
              </span>,
            ])}
            empty="No report yet. A report is issued when every test is authorized."
          />
          {s.can('results.authorize') && order.status === 'completed' ? (
            <button onClick={() => void reissue()}>Re-issue report (new version)</button>
          ) : null}
        </Panel>
      </div>
    </>
  );
}

// Inline reject form, shown under the specimens table when a specimen is picked for rejection.
function sp(
  pendingId: number | null,
  order: OrderDetailData,
  reason: string,
  setReason: (v: string) => void,
  recollect: boolean,
  setRecollect: (v: boolean) => void,
  onConfirm: () => void,
  onCancel: () => void,
) {
  if (pendingId === null) return null;
  const target = order.specimens.find((x) => x.id === pendingId);
  return (
    <div className="reject-form">
      <h3>Reject {target?.accession_no}</h3>
      <Field label="Reason (required)">
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. haemolysed sample" />
      </Field>
      <label className="check">
        <input type="checkbox" checked={recollect} onChange={(e) => setRecollect(e.target.checked)} /> Request recollection (new accession number)
      </label>
      <div className="row-actions">
        <button className="danger" disabled={reason.trim().length < 3} onClick={onConfirm}>Confirm rejection</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
