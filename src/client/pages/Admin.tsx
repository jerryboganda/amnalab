import { useEffect, useState } from 'react';
import { fileToDataUrl, get, patch, post, put, when } from '../api.ts';
import { Badge, Field, Notice, Panel, Table, useAction } from '../ui.tsx';
import type { Session } from '../App.tsx';

type Section = 'users' | 'branches' | 'template' | 'settings' | 'audit' | 'ops';

const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrator',
  branch_manager: 'Branch manager',
  pathologist: 'Pathologist / verifier',
  technician: 'Lab technician',
  reception: 'Reception',
  collector: 'Collection staff',
  cashier: 'Cashier',
  inventory: 'Inventory officer',
  qa_auditor: 'QA / auditor (read only)',
};

export function Admin({ s }: { s: Session }) {
  const [section, setSection] = useState<Section>('users');
  const sections: Array<{ id: Section; label: string; show: boolean }> = [
    { id: 'users', label: 'Users', show: s.can('admin.users') },
    { id: 'branches', label: 'Branches', show: s.can('admin.branches') },
    { id: 'template', label: 'Report template', show: s.can('reports.template') },
    { id: 'settings', label: 'Settings', show: s.can('admin.users') },
    { id: 'audit', label: 'Audit log', show: s.can('admin.audit') },
    { id: 'ops', label: 'Backup & health', show: s.can('ops.backup') || s.can('admin.audit') },
  ];
  const visible = sections.filter((x) => x.show);
  const current = visible.find((x) => x.id === section) ?? visible[0];
  return (
    <>
      <div className="toolbar">
        <h1>Administration</h1>
      </div>
      <nav className="tabs" aria-label="Admin sections">
        {visible.map((x) => (
          <button key={x.id} className={current?.id === x.id ? 'tab active' : 'tab'} onClick={() => setSection(x.id)}>{x.label}</button>
        ))}
      </nav>
      {current?.id === 'users' ? <Users s={s} /> : null}
      {current?.id === 'branches' ? <Branches /> : null}
      {current?.id === 'template' ? <Template s={s} /> : null}
      {current?.id === 'settings' ? <Settings /> : null}
      {current?.id === 'audit' ? <Audit /> : null}
      {current?.id === 'ops' ? <Ops s={s} /> : null}
    </>
  );
}

interface UserRow {
  id: number;
  username: string;
  fullName: string;
  role: string;
  isActive: boolean;
  lockedUntil: string | null;
  qualifications: string | null;
  hasSignature: boolean;
  branches: Array<{ id: number; name: string; code: string }>;
}

function Users({ s }: { s: Session }) {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [branches, setBranches] = useState<Array<{ id: number; name: string; code: string }>>([]);
  const [f, setF] = useState({ username: '', fullName: '', role: 'reception', password: '', branchIds: [] as number[] });
  const act = useAction();
  const load = () => get<UserRow[]>('/api/admin/users').then(setRows).catch((e: Error) => act.setError(e.message));
  useEffect(() => {
    void load();
    get<Array<{ id: number; name: string; code: string }>>('/api/branches').then(setBranches).catch(() => setBranches([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    const ok = await act.run(() => post('/api/admin/users', f), 'User created');
    if (ok) setF({ username: '', fullName: '', role: 'reception', password: '', branchIds: [] });
    await load();
  }

  async function toggle(u: UserRow) {
    await act.run(() => patch(`/api/admin/users/${u.id}`, { isActive: !u.isActive }), u.isActive ? 'User disabled' : 'User enabled');
    await load();
  }

  async function reset(u: UserRow) {
    const pw = window.prompt(`New temporary password for ${u.username} (10+ characters, letters and digits)`);
    if (!pw) return;
    await act.run(() => patch(`/api/admin/users/${u.id}`, { password: pw }), 'Password reset. The user is signed out.');
  }

  async function credentials(u: UserRow) {
    const q = window.prompt(`Qualifications printed under ${u.fullName}'s name on reports (e.g. MBBS, M.Phil Pathology (UHS))`, u.qualifications ?? '');
    if (q === null) return;
    await act.run(() => patch(`/api/admin/users/${u.id}`, { qualifications: q.trim() || null }), 'Qualifications saved');
    await load();
  }

  async function signature(u: UserRow, file: File | undefined) {
    if (!file) return;
    const dataUrl = await fileToDataUrl(file, 4).catch((e: Error) => {
      act.setError(e.message);
      return null;
    });
    if (dataUrl) await act.run(() => patch(`/api/admin/users/${u.id}`, { signature: dataUrl }), 'Signature uploaded. It prints on reports this person authorizes.');
    await load();
  }

  async function unlock(u: UserRow) {
    await act.run(() => patch(`/api/admin/users/${u.id}`, { unlock: true }), 'Unlocked');
    await load();
  }

  return (
    <>
      <Panel title="Add a user">
        <div className="form-grid">
          <Field label="Username"><input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
          <Field label="Full name"><input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
          <Field label="Role">
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Temporary password"><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
          <fieldset className="consent">
            <legend>Branches</legend>
            {branches.map((b) => (
              <label key={b.id} className="check">
                <input type="checkbox" checked={f.branchIds.includes(b.id)} onChange={(e) => setF({ ...f, branchIds: e.target.checked ? [...f.branchIds, b.id] : f.branchIds.filter((x) => x !== b.id) })} />
                {b.name}
              </label>
            ))}
          </fieldset>
        </div>
        {act.error ? <Notice kind="error">{act.error}</Notice> : null}
        {act.ok ? <Notice kind="ok">{act.ok}</Notice> : null}
        <button className="primary" disabled={act.busy || !f.username || !f.fullName || !f.password} onClick={() => void create()}>Create user</button>
      </Panel>
      <Panel title="Users">
        <Table
          head={['Username', 'Name', 'Role', 'Branches', 'Status', 'Actions']}
          rows={rows.map((u) => [
            <code key="u">{u.username}</code>,
            u.fullName,
            ROLE_LABELS[u.role] ?? u.role,
            u.branches.map((b) => b.code).join(', ') || 'all',
            <span key="st">
              {u.isActive ? <Badge tone="ok">active</Badge> : <Badge tone="danger">disabled</Badge>}
              {u.lockedUntil && new Date(u.lockedUntil) > new Date() ? <Badge tone="warn">locked</Badge> : null}
            </span>,
            <span key="a" className="row-actions">
              <button disabled={u.id === s.me.id} onClick={() => void toggle(u)}>{u.isActive ? 'Disable' : 'Enable'}</button>
              <button onClick={() => void reset(u)}>Reset password</button>
              {['pathologist', 'admin', 'branch_manager'].includes(u.role) ? (
                <>
                  <button onClick={() => void credentials(u)}>{u.qualifications ? 'Edit qualifications' : 'Qualifications'}</button>
                  <label className="button-like">
                    {u.hasSignature ? 'Replace signature' : 'Upload signature'}
                    <input type="file" accept="image/png,image/jpeg" hidden onChange={(e) => void signature(u, e.target.files?.[0])} />
                  </label>
                </>
              ) : null}
              {u.lockedUntil ? <button onClick={() => void unlock(u)}>Unlock</button> : null}
            </span>,
          ])}
        />
      </Panel>
    </>
  );
}

function Branches() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [f, setF] = useState({ name: '', code: '', address: '', phone: '', email: '', whatsapp: '', motto: '' });
  const act = useAction();
  const load = () => get('/api/admin/branches').then(setRows).catch((e: Error) => act.setError(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function create() {
    const ok = await act.run(() => post('/api/admin/branches', f), 'Branch added. Give its users access under Users.');
    if (ok) setF({ name: '', code: '', address: '', phone: '', email: '', whatsapp: '', motto: '' });
    await load();
  }
  return (
    <>
      <Panel title="Add a branch">
        <div className="form-grid">
          {(Object.keys(f) as Array<keyof typeof f>).map((k) => (
            <Field key={k} label={k === 'whatsapp' ? 'WhatsApp number' : k[0]!.toUpperCase() + k.slice(1)}>
              <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
        {act.error ? <Notice kind="error">{act.error}</Notice> : null}
        <button className="primary" disabled={act.busy || !f.name || !f.code} onClick={() => void create()}>Add branch</button>
      </Panel>
      <Panel title="Branches">
        <Table
          head={['Code', 'Name', 'Phone', 'Email', 'Logo', 'Background', 'Active', '']}
          rows={rows.map((b) => [
            <code key="c">{String(b.code)}</code>,
            String(b.name),
            String(b.phone ?? '-'),
            String(b.email ?? '-'),
            b.has_logo ? 'yes' : 'no',
            b.has_background ? 'yes' : 'no',
            b.is_active ? 'yes' : 'no',
            <button key="t" disabled={act.busy} onClick={async () => { await act.run(() => patch(`/api/admin/branches/${b.id}`, { isActive: !b.is_active }), 'Branch updated'); await load(); }}>
              {b.is_active ? 'Deactivate' : 'Activate'}
            </button>,
          ])}
        />
      </Panel>
    </>
  );
}

// Template designer: letterhead, colours, footer, signers and paper. Both the lab report and the invoice use it.
const TEXT_FIELDS = ['motto', 'headerText', 'footerText', 'timings', 'disclaimer', 'inchargeName', 'inchargeTitle', 'paymentDetails'] as const;
type TemplateForm = Record<(typeof TEXT_FIELDS)[number], string> & {
  brandPrimary: string;
  brandSecondary: string;
  letterheadMode: boolean;
  letterheadTopMm: string;
  letterheadBottomMm: string;
};
const EMPTY_TEMPLATE: TemplateForm = {
  motto: '', headerText: '', footerText: '', timings: '', disclaimer: '', inchargeName: '', inchargeTitle: '', paymentDetails: '',
  brandPrimary: '#1F5FAE', brandSecondary: '#C8102E', letterheadMode: false, letterheadTopMm: '45', letterheadBottomMm: '30',
};

function Template({ s }: { s: Session }) {
  const [branches, setBranches] = useState<Array<{ id: number; name: string; code: string }>>([]);
  const [branchId, setBranchId] = useState(s.branchId);
  const [f, setF] = useState<TemplateForm>(EMPTY_TEMPLATE);
  const [has, setHas] = useState({ logo: false, background: false, signature: false });
  const [stamp, setStamp] = useState(0); // refreshes image previews after an upload
  const act = useAction();

  const read = (t: Record<string, unknown>) => {
    const str = (k: string) => String(t[k] ?? '');
    setF({
      motto: str('motto'), headerText: str('header_text'), footerText: str('footer_text'), timings: str('timings'), disclaimer: str('disclaimer'),
      inchargeName: str('incharge_name'), inchargeTitle: str('incharge_title'), paymentDetails: str('payment_details'),
      brandPrimary: str('brand_primary') || '#1F5FAE', brandSecondary: str('brand_secondary') || '#C8102E',
      letterheadMode: Number(t.letterhead_mode) === 1, letterheadTopMm: String(t.letterhead_top_mm ?? 45), letterheadBottomMm: String(t.letterhead_bottom_mm ?? 30),
    });
    setHas({ logo: Boolean(t.has_logo), background: Boolean(t.has_background), signature: Boolean(t.has_incharge_signature) });
  };

  useEffect(() => {
    get<Array<{ id: number; name: string; code: string }>>('/api/branches').then(setBranches).catch(() => setBranches([]));
  }, []);
  useEffect(() => {
    get<Record<string, unknown>>(`/api/branches/${branchId}/template`).then(read).catch((e: Error) => act.setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  const body = () => ({
    ...Object.fromEntries(TEXT_FIELDS.map((k) => [k, f[k]])),
    brandPrimary: f.brandPrimary,
    brandSecondary: f.brandSecondary,
    letterheadMode: f.letterheadMode,
    letterheadTopMm: Number(f.letterheadTopMm) || 0,
    letterheadBottomMm: Number(f.letterheadBottomMm) || 0,
  });

  async function save(extra: Record<string, unknown> = {}, ok = 'Template saved. Reports and invoices issued from now on use it.') {
    const done = await act.run(() => put(`/api/branches/${branchId}/template`, { ...body(), ...extra }), ok);
    if (done) {
      await get<Record<string, unknown>>(`/api/branches/${branchId}/template`).then(read);
      setStamp(Date.now());
    }
  }

  async function pickImage(kind: 'logo' | 'background' | 'inchargeSignature', file: File | undefined) {
    if (!file) return;
    const dataUrl = await fileToDataUrl(file, 4).catch((e: Error) => {
      act.setError(e.message);
      return null;
    });
    const label = kind === 'logo' ? 'Logo' : kind === 'background' ? 'Background' : 'Incharge signature';
    if (dataUrl) await save({ [kind]: dataUrl }, `${label} uploaded`);
  }

  const set = (k: keyof TemplateForm) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const preview = (q: string) => window.open(`/api/branches/${branchId}/template/preview.pdf?${q}`, '_blank', 'noopener');

  return (
    <>
      <Panel
        title="Report and invoice design"
        actions={
          <span className="row-actions">
            <button onClick={() => preview('doc=report')}>Preview report</button>
            <button onClick={() => preview('doc=report&variant=print')}>Preview print copy</button>
            <button onClick={() => preview('doc=invoice')}>Preview invoice</button>
          </span>
        }
      >
        <Field label="Branch">
          <select value={branchId} onChange={(e) => setBranchId(Number(e.target.value))}>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.code})</option>)}
          </select>
        </Field>
        <h3>Letterhead</h3>
        <div className="form-grid">
          <Field label="Motto (shown in a pill under the name)"><input value={f.motto} onChange={set('motto')} placeholder="God is the best healer" /></Field>
          <Field label="Header note (small line under the name)"><input value={f.headerText} onChange={set('headerText')} /></Field>
          <Field label="Brand colour (name, bands, headings)">
            <span className="row-actions"><input type="color" value={f.brandPrimary} onChange={set('brandPrimary')} aria-label="Brand colour" /><code>{f.brandPrimary}</code></span>
          </Field>
          <Field label="Accent colour (address band, motto)">
            <span className="row-actions"><input type="color" value={f.brandSecondary} onChange={set('brandSecondary')} aria-label="Accent colour" /><code>{f.brandSecondary}</code></span>
          </Field>
        </div>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Logo (PNG or JPEG, up to 4 MB) {has.logo ? <Badge tone="ok">uploaded</Badge> : <Badge>built-in monogram</Badge>}</span>
            <input type="file" accept="image/png,image/jpeg" onChange={(e) => void pickImage('logo', e.target.files?.[0])} />
            {has.logo ? <img alt="Current logo" className="thumb" src={`/api/branches/${branchId}/branding/logo?v=${stamp}`} /> : null}
            {has.logo ? <button type="button" onClick={() => void save({ logo: null }, 'Logo removed; the built-in monogram is used')}>Remove logo</button> : null}
          </label>
          <label className="field">
            <span className="field-label">Faint page background image (optional) {has.background ? <Badge tone="ok">uploaded</Badge> : null}</span>
            <input type="file" accept="image/png,image/jpeg" onChange={(e) => void pickImage('background', e.target.files?.[0])} />
            <span className="field-hint">Printed very lightly behind every page of the digital copy, e.g. a watermark logo.</span>
            {has.background ? <button type="button" onClick={() => void save({ background: null }, 'Background removed')}>Remove background</button> : null}
          </label>
        </div>

        <h3>Footer</h3>
        <div className="form-grid">
          <Field label="Timings band"><input value={f.timings} onChange={set('timings')} placeholder="Timings: Summer 8:30 a.m. to 10:30 p.m. • Winter 9:00 a.m. to 10:00 p.m." /></Field>
          <Field label="Closing line after the results"><input value={f.footerText} onChange={set('footerText')} /></Field>
        </div>
        <Field label="Disclaimer (small print above the timings band)">
          <textarea rows={2} value={f.disclaimer} onChange={set('disclaimer')} placeholder="Results should be correlated with clinical findings. Lab-to-lab variation may occur." />
        </Field>

        <h3>Signatures</h3>
        <p className="muted small">The Lab Incharge prints on the left of every report. The pathologist who authorized the results prints on the right with the signature and qualifications set under Users.</p>
        <div className="form-grid">
          <Field label="Lab Incharge name"><input value={f.inchargeName} onChange={set('inchargeName')} placeholder="M. Ishaq Bhatti" /></Field>
          <Field label="Lab Incharge qualification / title"><input value={f.inchargeTitle} onChange={set('inchargeTitle')} placeholder="M.A. (Pb)" /></Field>
          <label className="field">
            <span className="field-label">Lab Incharge signature image {has.signature ? <Badge tone="ok">uploaded</Badge> : null}</span>
            <input type="file" accept="image/png,image/jpeg" onChange={(e) => void pickImage('inchargeSignature', e.target.files?.[0])} />
            {has.signature ? <img alt="Incharge signature" className="thumb" src={`/api/branches/${branchId}/branding/incharge-signature?v=${stamp}`} /> : null}
          </label>
        </div>

        <h3>Paper</h3>
        <label className="check">
          <input type="checkbox" checked={f.letterheadMode} onChange={(e) => setF({ ...f, letterheadMode: e.target.checked })} />
          We print reports on pre-printed letterhead paper (the print copy leaves the header and footer blank)
        </label>
        {f.letterheadMode ? (
          <div className="form-grid">
            <Field label="Blank space at the top (mm)"><input type="number" min={0} max={120} value={f.letterheadTopMm} onChange={set('letterheadTopMm')} /></Field>
            <Field label="Blank space at the bottom (mm)"><input type="number" min={0} max={120} value={f.letterheadBottomMm} onChange={set('letterheadBottomMm')} /></Field>
          </div>
        ) : null}
        <p className="muted small">WhatsApp and email always receive the full-colour digital copy.</p>

        <h3>Invoice</h3>
        <Field label="How to pay (bank / JazzCash / Easypaisa details printed on invoices)">
          <textarea rows={3} value={f.paymentDetails} onChange={set('paymentDetails')} placeholder={'Meezan Bank A/C 0123-0101234567 (Aamna Computerized Lab)\nJazzCash / Easypaisa: 0300-1234567'} />
        </Field>

        {act.error ? <Notice kind="error">{act.error}</Notice> : null}
        {act.ok ? <Notice kind="ok">{act.ok}</Notice> : null}
        <button className="primary" disabled={act.busy} onClick={() => void save()}>Save design</button>
      </Panel>
    </>
  );
}

function Settings() {
  const [caps, setCaps] = useState<Record<string, number>>({});
  const [threshold, setThreshold] = useState('10');
  const act = useAction();
  useEffect(() => {
    get<{ discount_caps: Record<string, number>; adjustment_approval_threshold: number }>('/api/admin/settings').then((x) => {
      setCaps(x.discount_caps);
      setThreshold(String(x.adjustment_approval_threshold));
    }).catch((e: Error) => act.setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function save() {
    await act.run(() => put('/api/admin/settings', { discount_caps: caps, adjustment_approval_threshold: Number(threshold) }), 'Settings saved');
  }
  return (
    <Panel title="Money and stock rules">
      <p className="muted small">Discounts above a role's cap need a second person with billing approval. Stock adjustments above the threshold need a second person with inventory approval.</p>
      <div className="form-grid">
        {Object.entries(caps).map(([role, pct]) => (
          <Field key={role} label={`Max discount without approval: ${ROLE_LABELS[role] ?? role} (%)`}>
            <input type="number" min={0} max={100} value={pct} onChange={(e) => setCaps({ ...caps, [role]: Number(e.target.value) })} />
          </Field>
        ))}
        <Field label="Adjustments above this many units need approval"><input type="number" min={0} value={threshold} onChange={(e) => setThreshold(e.target.value)} /></Field>
      </div>
      {act.error ? <Notice kind="error">{act.error}</Notice> : null}
      {act.ok ? <Notice kind="ok">{act.ok}</Notice> : null}
      <button className="primary" disabled={act.busy} onClick={() => void save()}>Save settings</button>
    </Panel>
  );
}

function Audit() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [f, setF] = useState({ action: '', actor: '', entity: '', from: '', to: '' });
  const load = () => {
    const p = new URLSearchParams();
    Object.entries(f).forEach(([k, v]) => v && p.set(k, v));
    p.set('limit', '300');
    return get<Array<Record<string, unknown>>>(`/api/admin/audit?${p}`).then(setRows).catch(() => setRows([]));
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const exportParams = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  return (
    <Panel title="Audit log (append-only)">
      <div className="form-grid">
        <Field label="Action contains"><input value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} /></Field>
        <Field label="User"><input value={f.actor} onChange={(e) => setF({ ...f, actor: e.target.value })} /></Field>
        <Field label="Entity"><input value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })} /></Field>
        <Field label="From (ISO date)"><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="To (ISO date)"><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
      </div>
      <div className="row-actions">
        <button onClick={() => void load()}>Apply filters</button>
        <a className="button-like" href={`/api/admin/audit.csv?${exportParams}`}>Export CSV</a>
      </div>
      <Table
        head={['When', 'User', 'Action', 'Entity', 'ID', 'Detail']}
        rows={rows.map((r) => [
          when(String(r.occurred_at)),
          String(r.actor ?? 'system'),
          String(r.action),
          String(r.entity),
          String(r.entity_id ?? ''),
          <span key="d" className="small">{[r.before_json, r.after_json].filter(Boolean).map(String).join(' -> ')}</span>,
        ])}
        empty="No entries match"
      />
    </Panel>
  );
}

function Ops({ s }: { s: Session }) {
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [backups, setBackups] = useState<Array<Record<string, unknown>>>([]);
  const act = useAction();
  const load = () => {
    get('/api/ops/health').then(setHealth).catch(() => setHealth(null));
    if (s.can('ops.backup')) get('/api/ops/backups').then(setBackups).catch(() => setBackups([]));
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function backupNow() {
    await act.run(() => post('/api/ops/backup'), 'Encrypted backup created');
    load();
  }
  return (
    <>
      <Panel title="System health">
        {health ? (
          <dl className="kv">
            <dt>Version</dt><dd>{String(health.version)}</dd>
            <dt>Database size</dt><dd>{Math.round(Number(health.dbBytes) / 1024)} KB</dd>
            <dt>Last backup</dt><dd>{health.lastBackup ? when(String((health.lastBackup as { created_at: string }).created_at)) : 'none yet'}</dd>
            <dt>Messages waiting</dt><dd>{(health.outbox as Array<{ status: string; n: number }>).length ? (health.outbox as Array<{ status: string; n: number }>).map((o) => `${o.n} ${o.status.replace('_', ' ')}`).join(', ') : 'none'}</dd>
          </dl>
        ) : <p className="muted">Health information unavailable</p>}
      </Panel>
      {s.can('ops.backup') ? (
        <Panel title="Backups" actions={<button className="primary" disabled={act.busy} onClick={() => void backupNow()}>Back up now</button>}>
          {act.error ? <Notice kind="error">{act.error}</Notice> : null}
          {act.ok ? <Notice kind="ok">{act.ok}</Notice> : null}
          <p className="muted small">Backups are encrypted. A backup is also made automatically each night at the hour set in data/config.json. Restore with the restore tool on the server PC.</p>
          <Table
            head={['When', 'Kind', 'File', 'Size (KB)']}
            rows={backups.map((b) => [when(String(b.created_at)), String(b.kind), <span key="f" className="small">{String(b.file)}</span>, Math.round(Number(b.size) / 1024)])}
            empty="No backups yet"
          />
        </Panel>
      ) : null}
    </>
  );
}
