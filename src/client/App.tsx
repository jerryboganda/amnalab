import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { get, post, SESSION_EXPIRED } from './api.ts';
import { Login, Setup } from './pages/Auth.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Patients } from './pages/Patients.tsx';
import { Orders } from './pages/Orders.tsx';
import { Worklist } from './pages/Worklist.tsx';
import { Billing } from './pages/Billing.tsx';
import { Inventory } from './pages/Inventory.tsx';
import { Catalog } from './pages/Catalog.tsx';
import { Notifications } from './pages/Notifications.tsx';
import { Admin } from './pages/Admin.tsx';
import { Verify } from './pages/Verify.tsx';
import { Field, Notice, useAction } from './ui.tsx';

export interface Me {
  id: number;
  username: string;
  fullName: string;
  role: string;
  permissions: string[];
  branches: Array<{ id: number; name: string; code: string }>;
}

export interface Session {
  me: Me;
  branchId: number;
  setBranch: (id: number) => void;
  can: (perm: string) => boolean;
  reload: () => Promise<void>;
  go: (page: string) => void;
}

type PageDef = { id: string; label: string; perm: string[]; render: (s: Session) => ReactElement };

const PAGES: PageDef[] = [
  { id: 'dashboard', label: 'Dashboard', perm: ['dashboard.read'], render: (s) => <Dashboard s={s} /> },
  { id: 'patients', label: 'Patients', perm: ['patients.read'], render: (s) => <Patients s={s} /> },
  { id: 'orders', label: 'Orders & specimens', perm: ['patients.read'], render: (s) => <Orders s={s} /> },
  { id: 'worklist', label: 'Worklist & results', perm: ['results.enter', 'results.review', 'results.authorize'], render: (s) => <Worklist s={s} /> },
  { id: 'billing', label: 'Billing', perm: ['billing.read'], render: (s) => <Billing s={s} /> },
  { id: 'inventory', label: 'Inventory', perm: ['inventory.read'], render: (s) => <Inventory s={s} /> },
  { id: 'catalog', label: 'Test catalog', perm: ['catalog.read'], render: (s) => <Catalog s={s} /> },
  { id: 'notifications', label: 'Messages', perm: ['notifications.read'], render: (s) => <Notifications s={s} /> },
  { id: 'admin', label: 'Admin', perm: ['admin.users', 'admin.branches', 'reports.template', 'admin.audit', 'ops.backup'], render: (s) => <Admin s={s} /> },
];

function pageFromHash(hash: string): string {
  return (hash.replace(/^#\/?/, '') || 'dashboard').split('/')[0] || 'dashboard';
}

// Native <dialog>: focus is trapped and Escape closes it. Password fields stay masked.
function ChangePassword({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const act = useAction();
  useEffect(() => ref.current?.showModal(), []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.next !== f.confirm) {
      act.setError('The two new passwords do not match');
      return;
    }
    await act.run(() => post('/api/auth/change-password', { currentPassword: f.current, newPassword: f.next }), 'Password changed.');
  }

  return (
    <dialog ref={ref} className="dialog" onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Change password</h2>
        <Field label="Current password"><input type="password" autoFocus required autoComplete="current-password" value={f.current} onChange={set('current')} /></Field>
        <Field label="New password" hint="At least 10 characters, with letters and digits."><input type="password" required minLength={10} autoComplete="new-password" value={f.next} onChange={set('next')} /></Field>
        <Field label="Confirm new password"><input type="password" required autoComplete="new-password" value={f.confirm} onChange={set('confirm')} /></Field>
        {act.error ? <Notice kind="error">{act.error}</Notice> : null}
        {act.ok ? <Notice kind="ok">{act.ok}</Notice> : null}
        <div className="row">
          {act.ok ? null : <button type="submit" className="primary" disabled={act.busy}>{act.busy ? 'Saving...' : 'Change password'}</button>}
          <button type="button" onClick={() => ref.current?.close()}>{act.ok ? 'Close' : 'Cancel'}</button>
        </div>
      </form>
    </dialog>
  );
}

export function App() {
  const [status, setStatus] = useState<'loading' | 'setup' | 'login' | 'ready'>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [branchId, setBranchId] = useState<number>(() => Number(localStorage.getItem('lms.branch') ?? 0));
  const [hash, setHash] = useState(window.location.hash);
  const [pwOpen, setPwOpen] = useState(false);
  const page = pageFromHash(hash);

  const loadMe = useCallback(async () => {
    try {
      const user = await get<Me>('/api/auth/me');
      setMe(user);
      setStatus('ready');
      setBranchId((current) => {
        const valid = user.branches.some((b) => b.id === current);
        const next = valid ? current : user.branches[0]?.id ?? 0;
        localStorage.setItem('lms.branch', String(next));
        return next;
      });
    } catch {
      const setup = await get<{ needsSetup: boolean }>('/api/setup/status').catch(() => ({ needsSetup: false }));
      setStatus(setup.needsSetup ? 'setup' : 'login');
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void loadMe();
    const onExpired = () => {
      setMe(null);
      setStatus('login');
    };
    const onHash = () => setHash(window.location.hash);
    window.addEventListener(SESSION_EXPIRED, onExpired);
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener(SESSION_EXPIRED, onExpired);
      window.removeEventListener('hashchange', onHash);
    };
  }, [loadMe]);

  const verifyCode = /^#\/verify\/([A-Za-z0-9]+)/.exec(hash)?.[1];
  if (verifyCode) return <Verify code={verifyCode} />;
  const invoiceCode = /^#\/verify-invoice\/([A-Za-z0-9]+)/.exec(hash)?.[1];
  if (invoiceCode) return <Verify code={invoiceCode} kind="invoice" />;
  if (status === 'loading') return <div className="center muted">Loading...</div>;
  if (status === 'setup') return <Setup onDone={() => void loadMe()} />;
  if (status === 'login' || !me) return <Login onDone={() => void loadMe()} />;

  const session: Session = {
    me,
    branchId,
    setBranch: (id) => {
      localStorage.setItem('lms.branch', String(id));
      setBranchId(id);
    },
    can: (perm) => me.permissions.includes(perm),
    reload: loadMe,
    go: (p) => {
      window.location.hash = `#/${p}`;
    },
  };

  const visible = PAGES.filter((p) => p.perm.some((x) => session.can(x)));
  const current = visible.find((p) => p.id === page) ?? visible[0];

  async function signOut() {
    await post('/api/auth/logout').catch(() => undefined);
    setMe(null);
    setStatus('login');
  }

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <strong>Amna Lab LMS</strong>
          <span className="muted small">{me.fullName}</span>
        </div>
        <nav>
          {visible.map((p) => (
            <a key={p.id} href={`#/${p.id}`} className={current?.id === p.id ? 'active' : ''} aria-current={current?.id === p.id ? 'page' : undefined}>
              {p.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <label className="field">
            <span className="field-label small">Branch</span>
            <select value={branchId} onChange={(e) => session.setBranch(Number(e.target.value))}>
              {me.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </select>
          </label>
          <button className="ghost" onClick={() => setPwOpen(true)}>Change password</button>
          <button className="ghost" onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <main className="content">
        {current ? <div key={hash}>{current.render(session)}</div> : <p>You do not have access to any screen. Ask an administrator.</p>}
      </main>
      {pwOpen ? <ChangePassword onClose={() => setPwOpen(false)} /> : null}
    </div>
  );
}
