import { useEffect, useState } from 'react';
import { get, pkr } from '../api.ts';
import { Notice, Panel, Stat } from '../ui.tsx';
import type { Session } from '../App.tsx';

interface DashData {
  businessDate: string;
  operations: Record<string, number>;
  messaging: { outboxFailed: number; outboxWaiting: number };
  finance: { collectedTodayPkr: number; byMethodPkr: Record<string, number>; unpaidInvoices: number; unpaidDuePkr: number };
  inventory: { lowStockItems: number };
}

const LABELS: Record<string, string> = {
  ordersToday: 'Orders today',
  patientsToday: 'New patients today',
  awaitingCollection: 'Awaiting collection',
  awaitingReceipt: 'Awaiting receipt',
  awaitingReview: 'Results to review',
  awaitingAuthorization: 'Awaiting authorization',
  criticalPending: 'Critical values open',
  overdue: 'Past turnaround time',
  completedToday: 'Tests completed today',
};

export function Dashboard({ s }: { s: Session }) {
  const [data, setData] = useState<DashData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<DashData>(`/api/dashboard?branchId=${s.branchId}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [s.branchId]);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!data) return <p className="muted">Loading the dashboard...</p>;

  return (
    <>
      <h1>Dashboard <span className="muted small">business day {data.businessDate}</span></h1>
      <div className="stats">
        {Object.entries(LABELS).map(([key, label]) => (
          <Stat
            key={key}
            label={label}
            value={data.operations[key] ?? 0}
            tone={key === 'criticalPending' && (data.operations[key] ?? 0) > 0 ? 'danger' : key === 'overdue' && (data.operations[key] ?? 0) > 0 ? 'warn' : undefined}
          />
        ))}
      </div>
      <div className="grid-2">
        <Panel title="Money today">
          <Stat label="Collected (net of refunds), PKR" value={pkr(data.finance.collectedTodayPkr)} />
          <ul className="plain">
            {Object.entries(data.finance.byMethodPkr).map(([m, v]) => (
              <li key={m}>{m.replace('_', ' ')}: {pkr(v)}</li>
            ))}
          </ul>
          <p>Unpaid invoices: {data.finance.unpaidInvoices} (PKR {pkr(data.finance.unpaidDuePkr)})</p>
        </Panel>
        <Panel title="Messages and stock">
          <p>Waiting to send: {data.messaging.outboxWaiting}</p>
          {data.messaging.outboxFailed > 0 ? <Notice kind="error">{data.messaging.outboxFailed} messages failed. Open Messages to retry.</Notice> : <p>No failed messages.</p>}
          {data.inventory.lowStockItems > 0 ? <Notice kind="warn">{data.inventory.lowStockItems} items at or below reorder level.</Notice> : <p>Stock levels are fine.</p>}
        </Panel>
      </div>
    </>
  );
}
