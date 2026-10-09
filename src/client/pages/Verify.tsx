import { useEffect, useState } from 'react';
import { when } from '../api.ts';

interface Result {
  valid: boolean;
  message?: string;
  reportNo?: string;
  version?: number;
  currentVersion?: boolean;
  invoiceNo?: string;
  status?: string;
  totalPkr?: number;
  paidPkr?: number;
  issuedAt?: string;
  branch?: string;
}

const INVOICE_STATUS: Record<string, string> = { paid: 'Paid in full', partially_paid: 'Partially paid', issued: 'Payment due', void: 'Void (cancelled)' };
const pkr = (n: number | undefined) => `PKR ${(n ?? 0).toLocaleString('en-PK', { minimumFractionDigits: 2 })}`;

// Public page opened from the QR code on a report or invoice. Shows no patient details.
export function Verify({ code, kind = 'report' }: { code: string; kind?: 'report' | 'invoice' }) {
  const [res, setRes] = useState<Result | null>(null);
  useEffect(() => {
    fetch(kind === 'invoice' ? `/api/verify/invoice/${encodeURIComponent(code)}` : `/api/verify/${encodeURIComponent(code)}`)
      .then((r) => r.json() as Promise<Result>)
      .then(setRes)
      .catch(() => setRes({ valid: false, message: 'Could not reach the laboratory server' }));
  }, [code, kind]);

  return (
    <div className="auth">
      <div className="auth-card">
        <h1>{kind === 'invoice' ? 'Invoice verification' : 'Report verification'}</h1>
        {!res ? (
          <p className="muted">Checking...</p>
        ) : !res.valid ? (
          <div className="notice notice-error">{res.message ?? `No ${kind} matches this code.`}</div>
        ) : kind === 'invoice' ? (
          <>
            <div className={`notice ${res.status === 'void' ? 'notice-warn' : 'notice-ok'}`}>
              {res.status === 'void' ? 'This invoice is genuine but has been voided.' : 'This is a genuine invoice issued by the laboratory.'}
            </div>
            <dl className="kv">
              <dt>Invoice</dt><dd>{res.invoiceNo}</dd>
              <dt>Laboratory</dt><dd>{res.branch}</dd>
              <dt>Issued</dt><dd>{when(res.issuedAt)}</dd>
              <dt>Total</dt><dd>{pkr(res.totalPkr)}</dd>
              <dt>Paid</dt><dd>{pkr(res.paidPkr)}</dd>
              <dt>Status</dt><dd>{INVOICE_STATUS[res.status ?? ''] ?? res.status}</dd>
            </dl>
          </>
        ) : (
          <>
            <div className={`notice ${res.currentVersion ? 'notice-ok' : 'notice-warn'}`}>
              {res.currentVersion
                ? 'This is a genuine report and the current version.'
                : 'This report is genuine but has been replaced by a newer version. Ask the laboratory for the latest copy.'}
            </div>
            <dl className="kv">
              <dt>Report</dt><dd>{res.reportNo} (version {res.version})</dd>
              <dt>Laboratory</dt><dd>{res.branch}</dd>
              <dt>Issued</dt><dd>{when(res.issuedAt)}</dd>
            </dl>
          </>
        )}
      </div>
    </div>
  );
}
