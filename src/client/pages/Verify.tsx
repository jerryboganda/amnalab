import { useEffect, useState } from 'react';
import { when } from '../api.ts';

interface Result {
  valid: boolean;
  message?: string;
  reportNo?: string;
  version?: number;
  currentVersion?: boolean;
  issuedAt?: string;
  branch?: string;
}

// Public page opened from the QR code on a report. Shows no patient details.
export function Verify({ code }: { code: string }) {
  const [res, setRes] = useState<Result | null>(null);
  useEffect(() => {
    fetch(`/api/verify/${encodeURIComponent(code)}`)
      .then((r) => r.json() as Promise<Result>)
      .then(setRes)
      .catch(() => setRes({ valid: false, message: 'Could not reach the laboratory server' }));
  }, [code]);

  return (
    <div className="auth">
      <div className="auth-card">
        <h1>Report verification</h1>
        {!res ? (
          <p className="muted">Checking...</p>
        ) : res.valid ? (
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
        ) : (
          <div className="notice notice-error">{res.message ?? 'No report matches this code.'}</div>
        )}
      </div>
    </div>
  );
}
