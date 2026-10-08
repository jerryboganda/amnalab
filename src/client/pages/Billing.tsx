import { useEffect, useState } from 'react';
import { get, pkr, post, when } from '../api.ts';
import { Badge, Field, Notice, Panel, Table, useAction } from '../ui.tsx';
import type { Session } from '../App.tsx';

interface InvoiceRow {
  id: number;
  invoice_no: string;
  order_id: number;
  patient_name: string;
  total_paisa: number;
  paid_paisa: number;
  refunded_paisa: number;
  status: string;
  created_at: string;
  balancePkr: number;
}

interface InvoiceDetail {
  id: number;
  invoiceNo: string;
  orderNo: string;
  orderId: number;
  branchName: string;
  patient: { name: string; mrn: string };
  status: string;
  subtotalPkr: number;
  discountPkr: number;
  discountReason: string | null;
  taxPkr: number;
  totalPkr: number;
  paidPkr: number;
  refundedPkr: number;
  balancePkr: number;
  createdAt: string;
  lines: Array<{ description: string; unitPricePkr: number; line_total_paisa: number }>;
  payments: Array<{ id: number; kind: string; method: string; amountPkr: number; reference: string | null; reason: string | null; business_date: string; created_at: string }>;
}

const METHODS = ['cash', 'card', 'bank_transfer', 'jazzcash', 'easypaisa'];

export function Billing({ s }: { s: Session }) {
  const id = Number(window.location.hash.split('/')[1]);
  const [tab, setTab] = useState<'invoices' | 'closing'>('invoices');
  if (Number.isInteger(id) && id > 0) return <InvoiceView s={s} id={id} />;
  return (
    <>
      <div className="toolbar">
        <h1>Billing</h1>
        <div className="toolbar-right">
          <button className={tab === 'invoices' ? 'primary' : ''} onClick={() => setTab('invoices')}>Invoices</button>
          <button className={tab === 'closing' ? 'primary' : ''} onClick={() => setTab('closing')}>Daily closing</button>
        </div>
      </div>
      {tab === 'invoices' ? <InvoiceList s={s} /> : <DailyClosing s={s} />}
    </>
  );
}

function InvoiceList({ s }: { s: Session }) {
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [status, setStatus] = useState('');
  useEffect(() => {
    get<InvoiceRow[]>(`/api/invoices?branchId=${s.branchId}${status ? `&status=${status}` : ''}`).then(setRows).catch(() => setRows([]));
  }, [s.branchId, status]);
  return (
    <>
      <div className="toolbar-right">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter invoices">
          <option value="">All</option>
          <option value="issued">Unpaid</option>
          <option value="partially_paid">Part paid</option>
          <option value="paid">Paid</option>
          <option value="void">Void</option>
        </select>
      </div>
      <Panel>
        <Table
          head={['Invoice', 'Patient', 'Total (PKR)', 'Paid', 'Balance', 'Status', 'Date']}
          rows={rows.map((r) => [
            <a key="i" href={`#/billing/${r.id}`}>{r.invoice_no}</a>,
            r.patient_name,
            pkr(r.total_paisa / 100),
            pkr((r.paid_paisa - r.refunded_paisa) / 100),
            pkr(r.balancePkr),
            <Badge key="s" tone={r.status === 'paid' ? 'ok' : r.status === 'void' ? 'danger' : 'warn'}>{r.status.replace('_', ' ')}</Badge>,
            when(r.created_at),
          ])}
          empty="No invoices yet"
        />
      </Panel>
    </>
  );
}

function InvoiceView({ s, id }: { s: Session; id: number }) {
  const [inv, setInv] = useState<InvoiceDetail | null>(null);
  const [pay, setPay] = useState({ method: 'cash', amount: '', reference: '' });
  const [refund, setRefund] = useState({ amount: '', reason: '', user: '', pass: '' });
  const [voidForm, setVoidForm] = useState({ reason: '', user: '', pass: '' });
  const [showVoid, setShowVoid] = useState(false);
  const [showRefund, setShowRefund] = useState(false);
  const act = useAction();
  const load = () => get<InvoiceDetail>(`/api/invoices/${id}`).then(setInv).catch((e: Error) => act.setError(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function addPayment() {
    await act.run(
      () => post(`/api/invoices/${id}/payments`, { method: pay.method, amountPkr: Number(pay.amount), reference: pay.reference || undefined }),
      'Payment recorded',
    );
    setPay({ method: 'cash', amount: '', reference: '' });
    await load();
  }

  async function doRefund() {
    await act.run(
      () => post(`/api/invoices/${id}/refund`, {
        amountPkr: Number(refund.amount),
        reason: refund.reason,
        approver: { username: refund.user, password: refund.pass },
      }),
      'Refund recorded',
    );
    setRefund({ amount: '', reason: '', user: '', pass: '' });
    setShowRefund(false);
    await load();
  }

  async function doVoid() {
    await act.run(
      () => post(`/api/invoices/${id}/void`, { reason: voidForm.reason, approver: { username: voidForm.user, password: voidForm.pass } }),
      'Invoice voided',
    );
    setShowVoid(false);
    await load();
  }

  if (!inv) return <p className="muted">Loading invoice...</p>;
  const canWrite = s.can('billing.write');
  return (
    <>
      <div className="toolbar">
        <a href="#/billing">&larr; Billing</a>
        <h1>{inv.invoiceNo}</h1>
        <Badge tone={inv.status === 'paid' ? 'ok' : inv.status === 'void' ? 'danger' : 'warn'}>{inv.status.replace('_', ' ')}</Badge>
        <button onClick={() => window.open(`/api/invoices/${id}/receipt`, '_blank', 'noopener')}>Print receipt</button>
      </div>
      <p className="muted">{inv.patient.name} ({inv.patient.mrn}) | Order <a href={`#/orders/${inv.orderId}`}>{inv.orderNo}</a> | {inv.branchName} | {when(inv.createdAt)}</p>
      {act.error ? <Notice kind="error">{act.error}</Notice> : null}
      {act.ok ? <Notice kind="ok">{act.ok}</Notice> : null}

      <div className="grid-2">
        <Panel title="Charges">
          <Table
            head={['Test', 'Price (PKR)']}
            rows={inv.lines.map((l) => [l.description, pkr(l.unitPricePkr)])}
          />
          <dl className="kv">
            <dt>Subtotal</dt><dd>{pkr(inv.subtotalPkr)}</dd>
            <dt>Discount{inv.discountReason ? ` (${inv.discountReason})` : ''}</dt><dd>-{pkr(inv.discountPkr)}</dd>
            <dt>Tax</dt><dd>{pkr(inv.taxPkr)}</dd>
            <dt><strong>Total</strong></dt><dd><strong>{pkr(inv.totalPkr)}</strong></dd>
            <dt>Paid</dt><dd>{pkr(inv.paidPkr)}</dd>
            <dt>Refunded</dt><dd>{pkr(inv.refundedPkr)}</dd>
            <dt>Balance due</dt><dd><strong>{pkr(inv.balancePkr)}</strong></dd>
          </dl>
        </Panel>

        <Panel title="Payments">
          <Table
            head={['When', 'Kind', 'Method', 'Amount', 'Reference / reason']}
            rows={inv.payments.map((p) => [
              when(p.created_at),
              p.kind === 'refund' ? <Badge key="k" tone="danger">refund</Badge> : <Badge key="k" tone="ok">payment</Badge>,
              p.method.replace('_', ' '),
              pkr(p.amountPkr),
              p.reference ?? p.reason ?? '-',
            ])}
            empty="No payments yet"
          />
          {canWrite && inv.status !== 'void' && inv.balancePkr > 0 ? (
            <div className="form-grid">
              <Field label="Method">
                <select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                  {METHODS.map((m) => (
                    <option key={m} value={m}>{m.replace('_', ' ')}</option>
                  ))}
                </select>
              </Field>
              <Field label="Amount (PKR)"><input type="number" min={0} step="0.01" max={inv.balancePkr} value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
              <Field label="Reference" hint="Required for non-cash"><input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>
              <button className="primary" disabled={act.busy || !pay.amount} onClick={() => void addPayment()}>Record payment</button>
            </div>
          ) : null}

          {canWrite && inv.paidPkr - inv.refundedPkr > 0 ? (
            <div className="stack">
              <button onClick={() => setShowRefund(!showRefund)}>{showRefund ? 'Cancel refund' : 'Refund'}</button>
              {showRefund ? (
                <div className="form-grid">
                  <Field label="Amount (PKR)"><input type="number" min={0} step="0.01" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} /></Field>
                  <Field label="Reason"><input value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} /></Field>
                  <Field label="Approver username" hint="A different user with refund approval"><input value={refund.user} onChange={(e) => setRefund({ ...refund, user: e.target.value })} /></Field>
                  <Field label="Approver password"><input type="password" value={refund.pass} onChange={(e) => setRefund({ ...refund, pass: e.target.value })} autoComplete="off" /></Field>
                  <button className="danger" disabled={act.busy} onClick={() => void doRefund()}>Confirm refund</button>
                </div>
              ) : null}
            </div>
          ) : null}

          {canWrite && inv.status !== 'void' && inv.paidPkr - inv.refundedPkr <= 0 ? (
            <div className="stack">
              <button onClick={() => setShowVoid(!showVoid)}>{showVoid ? 'Cancel void' : 'Void invoice'}</button>
              {showVoid ? (
                <div className="form-grid">
                  <Field label="Reason"><input value={voidForm.reason} onChange={(e) => setVoidForm({ ...voidForm, reason: e.target.value })} /></Field>
                  <Field label="Approver username"><input value={voidForm.user} onChange={(e) => setVoidForm({ ...voidForm, user: e.target.value })} /></Field>
                  <Field label="Approver password"><input type="password" value={voidForm.pass} onChange={(e) => setVoidForm({ ...voidForm, pass: e.target.value })} autoComplete="off" /></Field>
                  <button className="danger" disabled={act.busy} onClick={() => void doVoid()}>Confirm void</button>
                </div>
              ) : null}
            </div>
          ) : null}
        </Panel>
      </div>
    </>
  );
}

interface ClosingData {
  date: string;
  byMethodPkr: Record<string, number>;
  expectedCashPkr: number;
  totalPkr: number;
  closing: { counted_paisa: number; expected_paisa: number; variance_paisa: number; closed_at: string } | null;
}

function DailyClosing({ s }: { s: Session }) {
  const [date, setDate] = useState(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date()));
  const [data, setData] = useState<ClosingData | null>(null);
  const [counted, setCounted] = useState('');
  const act = useAction();
  const load = () => get<ClosingData>(`/api/billing/closing?branchId=${s.branchId}&date=${date}`).then(setData).catch((e: Error) => act.setError(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.branchId, date]);

  async function close() {
    await act.run(() => post('/api/billing/closing', { branchId: s.branchId, date, countedPkr: Number(counted) }), 'Day closed');
    await load();
  }

  if (!data) return <p className="muted">Loading...</p>;
  return (
    <Panel title="End-of-day cash reconciliation">
      <div className="toolbar-right">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Business date" />
      </div>
      {act.error ? <Notice kind="error">{act.error}</Notice> : null}
      <Table
        head={['Method', 'Net (PKR)']}
        rows={Object.entries(data.byMethodPkr).map(([m, v]) => [m.replace('_', ' '), pkr(v)])}
        empty="No payments on this day"
      />
      <p>Expected cash in the drawer: <strong>PKR {pkr(data.expectedCashPkr)}</strong></p>
      {data.closing ? (
        <Notice kind={data.closing.variance_paisa === 0 ? 'ok' : 'warn'}>
          Closed. Counted PKR {pkr(data.closing.counted_paisa / 100)}, variance PKR {pkr(data.closing.variance_paisa / 100)}.
        </Notice>
      ) : s.can('billing.close') ? (
        <div className="row-actions">
          <Field label="Counted cash (PKR)"><input type="number" min={0} step="0.01" value={counted} onChange={(e) => setCounted(e.target.value)} /></Field>
          <button className="primary" disabled={!counted || act.busy} onClick={() => void close()}>Close day</button>
        </div>
      ) : (
        <p className="muted">Only a cashier or branch manager can close the day.</p>
      )}
    </Panel>
  );
}
