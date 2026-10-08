import { useState, type FormEvent } from 'react';
import { post } from '../api.ts';
import { Field, Notice, useAction } from '../ui.tsx';

export function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const act = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await act.run(() => post('/api/auth/login', { username, password }));
    if (ok) onDone();
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>Amna Lab LMS</h1>
        <p className="muted">Sign in to continue.</p>
        <Field label="Username">
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {act.error ? <Notice kind="error">{act.error}</Notice> : null}
        <button type="submit" className="primary" disabled={act.busy}>
          {act.busy ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

// First run only: creates the organization, the first branch and the administrator.
export function Setup({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ organizationName: '', branchName: '', branchCode: '', adminName: '', username: '', password: '', confirm: '' });
  const act = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.password !== f.confirm) {
      act.setError('The two passwords do not match');
      return;
    }
    const ok = await act.run(
      () =>
        post('/api/setup', {
          organizationName: f.organizationName,
          branchName: f.branchName,
          branchCode: f.branchCode,
          adminName: f.adminName,
          username: f.username,
          password: f.password,
        }),
      'Setup complete. Sign in with the administrator account.',
    );
    if (ok) onDone();
  }

  return (
    <div className="auth">
      <form className="auth-card wide" onSubmit={submit}>
        <h1>First-time setup</h1>
        <p className="muted">Create the laboratory, its first branch and the administrator account. This runs once.</p>
        <div className="grid-2">
          <Field label="Laboratory / organization name"><input required value={f.organizationName} onChange={set('organizationName')} /></Field>
          <Field label="Branch name"><input required value={f.branchName} onChange={set('branchName')} /></Field>
          <Field label="Branch code" hint="Letters and digits, e.g. LHR1. Used in MRN and report numbers."><input required value={f.branchCode} onChange={set('branchCode')} maxLength={12} /></Field>
          <Field label="Administrator full name"><input required value={f.adminName} onChange={set('adminName')} /></Field>
          <Field label="Administrator username"><input required value={f.username} onChange={set('username')} minLength={3} /></Field>
          <span />
          <Field label="Password" hint="At least 10 characters, with letters and digits."><input type="password" required minLength={10} value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
          <Field label="Confirm password"><input type="password" required value={f.confirm} onChange={set('confirm')} autoComplete="new-password" /></Field>
        </div>
        {act.error ? <Notice kind="error">{act.error}</Notice> : null}
        <button type="submit" className="primary" disabled={act.busy}>
          {act.busy ? 'Creating...' : 'Create laboratory'}
        </button>
      </form>
    </div>
  );
}
