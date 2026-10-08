import { useEffect, useState } from 'react';
import { get, post, when } from '../api.ts';
import { Badge, Notice, Panel, Table, useAction } from '../ui.tsx';
import type { Session } from '../App.tsx';

interface Message {
  id: number;
  channel: 'email' | 'sms' | 'whatsapp';
  destination: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
  subject: string | null;
  report_no: string | null;
  patient_name: string;
  mrn: string;
  attachment_path: string | null;
}

const TONE: Record<string, 'ok' | 'warn' | 'danger' | 'info' | 'neutral'> = {
  sent: 'ok',
  delivered: 'ok',
  sent_manual: 'ok',
  queued: 'info',
  retrying: 'warn',
  awaiting_staff: 'warn',
  failed: 'danger',
  cancelled: 'neutral',
};

export function Notifications({ s }: { s: Session }) {
  const [rows, setRows] = useState<Message[]>([]);
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const act = useAction();

  const load = () => {
    const p = new URLSearchParams({ branchId: String(s.branchId) });
    if (status) p.set('status', status);
    if (channel) p.set('channel', channel);
    return get<Message[]>(`/api/notifications?${p}`).then(setRows).catch((e: Error) => act.setError(e.message));
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.branchId, status, channel]);

  async function act2(fn: () => Promise<unknown>, ok: string) {
    await act.run(fn, ok);
    await load();
  }

  return (
    <>
      <div className="toolbar">
        <h1>Messages</h1>
        <div className="toolbar-right">
          <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel">
            <option value="">All channels</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">All statuses</option>
            <option value="queued">Queued</option>
            <option value="retrying">Retrying</option>
            <option value="awaiting_staff">Waiting for staff (WhatsApp)</option>
            <option value="sent">Sent</option>
            <option value="sent_manual">Sent by staff</option>
            <option value="failed">Failed</option>
          </select>
          {s.can('notifications.write') ? <button onClick={() => void act2(() => post('/api/notifications/process'), 'Queue processed')}>Send queued now</button> : null}
        </div>
      </div>
      {act.error ? <Notice kind="error">{act.error}</Notice> : null}
      {act.ok ? <Notice kind="ok">{act.ok}</Notice> : null}
      <Panel>
        <Table
          head={['When', 'Channel', 'Patient', 'Report', 'To', 'Status', 'Tries', 'Actions']}
          rows={rows.map((m) => [
            when(m.created_at),
            m.channel,
            `${m.patient_name} (${m.mrn})`,
            m.report_no ?? '-',
            <span key="d" className="small">{m.destination}</span>,
            <span key="s">
              <Badge tone={TONE[m.status] ?? 'neutral'}>{m.status.replace('_', ' ')}</Badge>
              {m.last_error ? <div className="small text-warn">{m.last_error}</div> : null}
            </span>,
            m.attempts,
            <span key="a" className="row-actions">
              {m.channel !== 'whatsapp' && ['failed', 'retrying', 'queued'].includes(m.status) && s.can('notifications.write') ? (
                <>
                  <button onClick={() => void act2(() => post(`/api/notifications/${m.id}/retry`), 'Queued again')}>Retry</button>
                  <button onClick={() => void act2(() => post(`/api/notifications/${m.id}/cancel`), 'Cancelled')}>Cancel</button>
                </>
              ) : null}
              {m.channel === 'whatsapp' && m.status === 'awaiting_staff' && s.can('notifications.write') ? (
                <>
                  <button onClick={() => void act2(() => post(`/api/notifications/${m.id}/whatsapp`, { action: 'open' }).then((r) => {
                    const url = (r as { waUrl?: string }).waUrl;
                    if (url) window.open(url, '_blank', 'noopener');
                  }), 'Chat opened')}>Open chat</button>
                  <button onClick={() => void act2(() => post(`/api/notifications/${m.id}/whatsapp`, { action: 'confirm' }), 'Recorded as sent')}>Mark sent</button>
                  <button onClick={() => void act2(() => post(`/api/notifications/${m.id}/cancel`), 'Cancelled')}>Cancel</button>
                </>
              ) : null}
            </span>,
          ])}
          empty="No messages. Send a report from Orders or Patients."
        />
      </Panel>
      <Panel title="How delivery works">
        <ul className="plain">
          <li><strong>Email</strong> goes through the owner's Gmail account once it is connected in <code>data/config.json</code>. Failed items retry automatically with back-off.</li>
          <li><strong>SMS</strong> goes through the configured gateway. Until one is set, SMS items wait in the queue.</li>
          <li><strong>WhatsApp</strong> is sent by staff from their own WhatsApp: the chat opens with the message, the PDF is saved in a folder, and staff attach and press send.</li>
        </ul>
      </Panel>
    </>
  );
}
