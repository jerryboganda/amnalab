import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, dateOnly, get, patch, post } from '../api.ts';
import { Badge, Field, Notice, Panel, Table, useAction } from '../ui.tsx';
import type { Session } from '../App.tsx';

interface PatientRow {
  id: number;
  mrn: string;
  fullName: string;
  gender: string;
  ageYears: number | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  consent: { whatsapp: boolean; email: boolean; sms: boolean };
  latestReportId?: number | null;
}

interface Practitioner {
  id: number;
  name: string;
}

// Shared by Patients and Orders: queue the report for WhatsApp, open the chat and the PDF folder,
// then wait for staff to attach the PDF, press send, and confirm it here.
export async function startWhatsApp(reportId: number): Promise<{ outboxId: number; waUrl: string }> {
  const queued = await post<{ id: number; waUrl: string; pdfFolder: string }>(`/api/reports/${reportId}/send`, { channel: 'whatsapp' });
  window.open(queued.waUrl, '_blank', 'noopener');
  await post(`/api/notifications/${queued.id}/whatsapp`, { action: 'open' }).catch(() => undefined);
  return { outboxId: queued.id, waUrl: queued.waUrl };
}

export function Patients({ s }: { s: Session }) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<PatientRow[]>([]);
  const [selected, setSelected] = useState<number | null>(() => {
    const id = Number(window.location.hash.split('/')[1]);
    return Number.isInteger(id) && id > 0 ? id : null;
  });
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string; outboxId?: number } | null>(null);
  const load = async (q = query) => setRows(await get<PatientRow[]>(`/api/patients?q=${encodeURIComponent(q)}`));

  useEffect(() => {
    void load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendWhatsApp(reportId: number, name: string) {
    try {
      const { outboxId } = await startWhatsApp(reportId);
      setNotice({ kind: 'ok', text: `Chat opened for ${name}. Attach the PDF from the folder that opened, press send, then confirm below.`, outboxId });
    } catch (e) {
      setNotice({ kind: 'error', text: (e as Error).message });
    }
  }

  async function confirmSent(outboxId: number) {
    try {
      await post(`/api/notifications/${outboxId}/whatsapp`, { action: 'confirm' });
      setNotice({ kind: 'ok', text: 'Recorded as sent.' });
    } catch (e) {
      setNotice({ kind: 'error', text: (e as Error).message });
    }
  }

  if (selected) {
    return (
      <PatientDetail
        id={selected}
        s={s}
        onBack={() => {
          setSelected(null);
          void load();
        }}
        onWhatsApp={sendWhatsApp}
        notice={notice}
        onConfirm={confirmSent}
      />
    );
  }

  return (
    <>
      <div className="toolbar">
        <h1>Patients</h1>
        <div className="toolbar-right">
          <input
            placeholder="Search name, MRN, phone"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void load()}
            aria-label="Search patients"
          />
          <button onClick={() => void load()}>Search</button>
          {s.can('patients.write') ? <button className="primary" onClick={() => setCreating(!creating)}>{creating ? 'Close' : 'Register patient'}</button> : null}
        </div>
      </div>
      {notice ? (
        <Notice kind={notice.kind}>
          {notice.text}{' '}
          {notice.outboxId ? <button onClick={() => void confirmSent(notice.outboxId!)}>I sent it on WhatsApp</button> : null}
        </Notice>
      ) : null}
      {creating ? (
        <RegisterForm
          s={s}
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
          }}
        />
      ) : null}
      <Panel>
        <Table
          head={['MRN', 'Name', 'Age / sex', 'Phone', 'Consent', 'Actions']}
          rows={rows.map((p) => [
            <code key="m">{p.mrn}</code>,
            <button key="n" className="link" onClick={() => setSelected(p.id)}>{p.fullName}</button>,
            `${p.ageYears ?? '-'} / ${p.gender}`,
            p.phone ?? p.whatsapp ?? '-',
            <span key="c" className="small">
              {p.consent.whatsapp ? 'WA ' : ''}
              {p.consent.email ? 'Email ' : ''}
              {p.consent.sms ? 'SMS' : ''}
              {!p.consent.whatsapp && !p.consent.email && !p.consent.sms ? <Badge tone="warn">none</Badge> : null}
            </span>,
            <span key="a" className="row-actions">
              <button onClick={() => setSelected(p.id)}>Open</button>
              {p.latestReportId && s.can('reports.send') ? (
                <button onClick={() => void sendWhatsApp(p.latestReportId!, p.fullName)}>WhatsApp report</button>
              ) : null}
            </span>,
          ])}
          empty="No patients match. Register one to start."
        />
      </Panel>
    </>
  );
}

function RegisterForm({ s, onCreated }: { s: Session; onCreated: (id: number) => void }) {
  const [practitioners, setPractitioners] = useState<Practitioner[]>([]);
  const [f, setF] = useState({
    fullName: '',
    gender: 'M',
    useDob: true,
    dob: '',
    ageYears: '',
    phone: '',
    whatsapp: '',
    email: '',
    address: '',
    allergies: '',
    practitionerId: '',
    consentWhatsapp: false,
    consentEmail: false,
    consentSms: false,
  });
  const [duplicates, setDuplicates] = useState<Array<{ id: number; mrn: string; fullName: string; phone: string | null }> | null>(null);
  const act = useAction();

  useEffect(() => {
    get<Practitioner[]>('/api/practitioners').then(setPractitioners).catch(() => setPractitioners([]));
  }, []);

  const set = (k: keyof typeof f) => (e: { target: { value: string; checked?: boolean; type?: string } }) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value } as typeof f);

  function body(force: boolean) {
    return {
      branchId: s.branchId,
      fullName: f.fullName,
      gender: f.gender,
      dob: f.useDob && f.dob ? f.dob : undefined,
      ageYears: !f.useDob && f.ageYears ? Number(f.ageYears) : undefined,
      phone: f.phone || undefined,
      whatsapp: f.whatsapp || undefined,
      email: f.email || undefined,
      address: f.address || undefined,
      allergies: f.allergies || undefined,
      practitionerId: f.practitionerId ? Number(f.practitionerId) : null,
      consent: { whatsapp: f.consentWhatsapp, email: f.consentEmail, sms: f.consentSms },
      force,
    };
  }

  async function submit(e: FormEvent, force = false) {
    e.preventDefault();
    setDuplicates(null);
    try {
      const created = await post<{ id: number }>('/api/patients', body(force));
      onCreated(created.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && Array.isArray((err.data as { duplicates?: unknown }).duplicates)) {
        setDuplicates((err.data as { duplicates: Array<{ id: number; mrn: string; fullName: string; phone: string | null }> }).duplicates);
        return;
      }
      act.setError((err as Error).message);
    }
  }

  return (
    <Panel title="New patient">
      <form onSubmit={(e) => void submit(e)} className="form-grid">
        <Field label="Full name"><input required minLength={2} value={f.fullName} onChange={set('fullName')} /></Field>
        <Field label="Gender">
          <select value={f.gender} onChange={set('gender')}>
            <option value="M">Male</option>
            <option value="F">Female</option>
            <option value="O">Other</option>
          </select>
        </Field>
        <Field label="Age known as">
          <select value={f.useDob ? 'dob' : 'age'} onChange={(e) => setF({ ...f, useDob: e.target.value === 'dob' })}>
            <option value="dob">Date of birth</option>
            <option value="age">Age in years</option>
          </select>
        </Field>
        {f.useDob ? (
          <Field label="Date of birth"><input type="date" value={f.dob} onChange={set('dob')} max={new Date().toISOString().slice(0, 10)} /></Field>
        ) : (
          <Field label="Age (years)"><input type="number" min={0} max={120} value={f.ageYears} onChange={set('ageYears')} /></Field>
        )}
        <Field label="Mobile (Pakistan)" hint="e.g. 0300 1234567"><input value={f.phone} onChange={set('phone')} /></Field>
        <Field label="WhatsApp number" hint="Leave blank to use the mobile number"><input value={f.whatsapp} onChange={set('whatsapp')} /></Field>
        <Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Referring doctor">
          <select value={f.practitionerId} onChange={set('practitionerId')}>
            <option value="">Self / none</option>
            {practitioners.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Address"><input value={f.address} onChange={set('address')} /></Field>
        <Field label="Known allergies"><input value={f.allergies} onChange={set('allergies')} placeholder="None known" /></Field>
        <fieldset className="consent">
          <legend>Report delivery consent</legend>
          <label><input type="checkbox" checked={f.consentWhatsapp} onChange={set('consentWhatsapp')} /> WhatsApp</label>
          <label><input type="checkbox" checked={f.consentEmail} onChange={set('consentEmail')} /> Email</label>
          <label><input type="checkbox" checked={f.consentSms} onChange={set('consentSms')} /> SMS</label>
        </fieldset>
        {duplicates ? (
          <div className="span-all">
            <Notice kind="warn">
              Possible duplicate: {duplicates.map((d) => `${d.fullName} (${d.mrn}${d.phone ? `, ${d.phone}` : ''})`).join('; ')}. Check before continuing.
            </Notice>
            <button type="button" onClick={(e) => void submit(e as unknown as FormEvent, true)}>Register anyway</button>
          </div>
        ) : null}
        {act.error ? <div className="span-all"><Notice kind="error">{act.error}</Notice></div> : null}
        <div className="span-all">
          <button type="submit" className="primary">Save patient</button>
        </div>
      </form>
    </Panel>
  );
}

interface Detail {
  patient: PatientRow & { address: string | null; allergies: string | null; practitionerName: string | null; dob: string | null };
  history: Array<{ id: number; order_no: string; created_at: string; status: string; priority: string; tests: Array<{ name: string; status: string }> }>;
}

function PatientDetail({
  id,
  s,
  onBack,
  onWhatsApp,
  notice,
  onConfirm,
}: {
  id: number;
  s: Session;
  onBack: () => void;
  onWhatsApp: (reportId: number, name: string) => void;
  notice: { kind: 'ok' | 'error' | 'warn'; text: string; outboxId?: number } | null;
  onConfirm: (outboxId: number) => void;
}) {
  const [data, setData] = useState<Detail | null>(null);
  const act = useAction();
  const reload = () => get<Detail>(`/api/patients/${id}`).then(setData).catch((e: Error) => act.setError(e.message));
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function toggleConsent(key: 'consentWhatsapp' | 'consentEmail' | 'consentSms', value: boolean) {
    await act.run(() => patch(`/api/patients/${id}`, { [key]: value }), 'Consent updated');
    await reload();
  }

  if (!data) return <p className="muted">Loading patient...</p>;
  const p = data.patient;
  return (
    <>
      <div className="toolbar">
        <button onClick={onBack}>&larr; All patients</button>
        <h1>{p.fullName}</h1>
        <span className="muted">MRN {p.mrn}</span>
      </div>
      {notice ? (
        <Notice kind={notice.kind}>
          {notice.text}{' '}
          {notice.outboxId ? <button onClick={() => onConfirm(notice.outboxId!)}>I sent it on WhatsApp</button> : null}
        </Notice>
      ) : null}
      {act.error ? <Notice kind="error">{act.error}</Notice> : null}
      {act.ok ? <Notice kind="ok">{act.ok}</Notice> : null}
      <div className="grid-2">
        <Panel title="Details">
          <dl className="kv">
            <dt>Age / sex</dt><dd>{p.ageYears ?? '-'} / {p.gender}</dd>
            <dt>Date of birth</dt><dd>{p.dob ? dateOnly(p.dob) : 'not recorded'}</dd>
            <dt>Mobile</dt><dd>{p.phone ?? '-'}</dd>
            <dt>WhatsApp</dt><dd>{p.whatsapp ?? '-'}</dd>
            <dt>Email</dt><dd>{p.email ?? '-'}</dd>
            <dt>Referring doctor</dt><dd>{p.practitionerName ?? 'Self'}</dd>
            <dt>Address</dt><dd>{p.address ?? '-'}</dd>
            <dt>Known allergies</dt><dd>{p.allergies ?? 'None recorded'}</dd>
          </dl>
        </Panel>
        <Panel title="Report delivery consent">
          {(['consentWhatsapp', 'consentEmail', 'consentSms'] as const).map((k) => {
            const key = k === 'consentWhatsapp' ? 'whatsapp' : k === 'consentEmail' ? 'email' : 'sms';
            const value = p.consent[key];
            return (
              <label key={k} className="check">
                <input type="checkbox" checked={value} disabled={!s.can('patients.write') || act.busy} onChange={(e) => void toggleConsent(k, e.target.checked)} />
                {key === 'whatsapp' ? 'WhatsApp' : key === 'email' ? 'Email' : 'SMS'}
              </label>
            );
          })}
          <p className="muted small">Messages are only queued for channels the patient has agreed to.</p>
        </Panel>
      </div>
      <Panel title="Previous investigations">
        <Table
          head={['Order', 'Date', 'Tests', 'Status']}
          rows={data.history.map((h) => [
            <code key="o">{h.order_no}</code>,
            dateOnly(h.created_at),
            h.tests.map((t) => t.name).join(', '),
            <Badge key="s" tone={h.status === 'completed' ? 'ok' : 'info'}>{h.status.replace('_', ' ')}</Badge>,
          ])}
          empty="No investigations yet"
        />
      </Panel>
    </>
  );
}
