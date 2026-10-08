import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { config, loadFileConfig, type FileConfig } from '../config.ts';
import { audit } from '../audit.ts';
import { badRequest, conflict, notFound } from '../http.ts';
import type { AuthUser } from '../security.ts';
import { nowIso } from '../util.ts';

export type Channel = 'email' | 'sms' | 'whatsapp';
const MAX_ATTEMPTS = 8;

// ---- Phone numbers: Pakistani mobile formats to international digits (03xx -> 923xx).

export function normalizePkPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = `92${d.slice(1)}`;
  if (!/^92\d{9,10}$/.test(d)) return null;
  return d;
}

export function whatsappLink(phoneDigits: string, message: string): string {
  return `https://wa.me/${phoneDigits}?text=${encodeURIComponent(message)}`;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? '');
}

// ---- Queueing

interface ReportForSend {
  id: number;
  report_no: string;
  pdf_path: string;
  order_id: number;
  branch_id: number;
  patient_id: number;
  branch_name: string;
  branch_phone: string | null;
  patient_name: string;
  patient_phone: string | null;
  patient_whatsapp: string | null;
  patient_email: string | null;
  consent_whatsapp: number;
  consent_email: number;
  consent_sms: number;
}

export function loadReportForSend(db: DatabaseSync, reportId: number): ReportForSend {
  const row = db
    .prepare(
      `SELECT r.id, r.report_no, r.pdf_path, r.order_id, r.branch_id, o.patient_id,
              b.name AS branch_name, b.phone AS branch_phone,
              p.full_name AS patient_name, p.phone AS patient_phone, p.whatsapp AS patient_whatsapp, p.email AS patient_email,
              p.consent_whatsapp, p.consent_email, p.consent_sms
       FROM reports r
       JOIN orders o ON o.id = r.order_id
       JOIN patients p ON p.id = o.patient_id
       JOIN branches b ON b.id = r.branch_id
       WHERE r.id = ?`,
    )
    .get(reportId) as unknown as ReportForSend | undefined;
  if (!row) throw notFound('Report not found');
  return row;
}

export function queueReport(
  db: DatabaseSync,
  actor: AuthUser,
  reportId: number,
  channel: Channel,
  overrideDestination?: string,
): { id: number; status: string; waUrl?: string; pdfFolder?: string } {
  const rep = loadReportForSend(db, reportId);
  const firstName = rep.patient_name.split(' ')[0] ?? rep.patient_name;
  const vars = {
    name: firstName,
    report: rep.report_no,
    branch: rep.branch_name,
    phone: rep.branch_phone ?? '',
  };

  if (channel === 'email') {
    if (!rep.consent_email) throw conflict('Patient has not consented to email reports');
    const to = overrideDestination?.trim() || rep.patient_email;
    if (!to || !to.includes('@')) throw badRequest('Patient has no valid email address');
    const row = db
      .prepare(
        `INSERT INTO outbox (branch_id, patient_id, report_id, channel, destination, subject, body, attachment_path, status, next_attempt_at, created_by)
         VALUES (?, ?, ?, 'email', ?, ?, ?, ?, 'queued', ?, ?) RETURNING id, status`,
      )
      .get(
        rep.branch_id,
        rep.patient_id,
        rep.id,
        to,
        `Lab report ${rep.report_no} - ${rep.branch_name}`,
        `Dear ${firstName},\n\nYour laboratory report ${rep.report_no} from ${rep.branch_name} is attached.\n` +
          `If you have questions, please call ${rep.branch_phone ?? 'the laboratory'}.\n\n${rep.branch_name}`,
        rep.pdf_path,
        nowIso(),
        actor.id,
      ) as { id: number; status: string };
    audit(db, { actor, branchId: rep.branch_id, action: 'notify.queue', entity: 'outbox', entityId: row.id, after: { channel, report: rep.report_no } });
    return row;
  }

  if (channel === 'sms') {
    if (!rep.consent_sms) throw conflict('Patient has not consented to SMS');
    const to = normalizePkPhone(overrideDestination ?? rep.patient_phone);
    if (!to) throw badRequest('Patient has no valid mobile number');
    // Short, no clinical detail: the patient collects the report or asks the lab.
    const body = fill('Dear {name}, your lab report {report} from {branch} is ready. Call {phone} for details.', vars);
    const row = db
      .prepare(
        `INSERT INTO outbox (branch_id, patient_id, report_id, channel, destination, body, status, next_attempt_at, created_by)
         VALUES (?, ?, ?, 'sms', ?, ?, 'queued', ?, ?) RETURNING id, status`,
      )
      .get(rep.branch_id, rep.patient_id, rep.id, to, body, nowIso(), actor.id) as { id: number; status: string };
    audit(db, { actor, branchId: rep.branch_id, action: 'notify.queue', entity: 'outbox', entityId: row.id, after: { channel, report: rep.report_no } });
    return row;
  }

  // WhatsApp: staff-operated. The app opens a chat with the message prefilled and copies the PDF
  // to a folder, because web links cannot attach files. Staff attach the PDF and press send.
  if (!rep.consent_whatsapp) throw conflict('Patient has not consented to WhatsApp reports');
  const to = normalizePkPhone(overrideDestination ?? rep.patient_whatsapp ?? rep.patient_phone);
  if (!to) throw badRequest('Patient has no valid WhatsApp number');
  const message = fill(
    'Dear {name},\n\nYour laboratory report {report} from {branch} is ready. The PDF is attached to this message.\n\nFor questions please call {phone}.\n\n{branch}',
    vars,
  );
  const pdfFolder = join(config.outboxDir, rep.report_no.replace(/[^A-Za-z0-9-]/g, '_'));
  const pdfCopy = join(pdfFolder, basename(rep.pdf_path));
  mkdirSync(pdfFolder, { recursive: true });
  copyFileSync(rep.pdf_path, pdfCopy);
  const row = db
    .prepare(
      `INSERT INTO outbox (branch_id, patient_id, report_id, channel, destination, body, attachment_path, status, next_attempt_at, created_by)
       VALUES (?, ?, ?, 'whatsapp', ?, ?, ?, 'awaiting_staff', NULL, ?) RETURNING id, status`,
    )
    .get(rep.branch_id, rep.patient_id, rep.id, to, message, pdfCopy, actor.id) as { id: number; status: string };
  audit(db, { actor, branchId: rep.branch_id, action: 'notify.queue', entity: 'outbox', entityId: row.id, after: { channel, report: rep.report_no } });
  return { ...row, waUrl: whatsappLink(to, message), pdfFolder };
}

export function staffWhatsapp(db: DatabaseSync, actor: AuthUser, id: number, action: 'open' | 'confirm'): unknown {
  const row = db
    .prepare("SELECT id, channel, destination, body, attachment_path, status FROM outbox WHERE id = ?")
    .get(id) as
    | { id: number; channel: string; destination: string; body: string; attachment_path: string | null; status: string }
    | undefined;
  if (!row || row.channel !== 'whatsapp') throw notFound('WhatsApp message not found');
  if (action === 'open') {
    if (row.status !== 'awaiting_staff') throw conflict('This message was already sent');
    if (row.attachment_path && existsSync(row.attachment_path) && process.platform === 'win32') {
      spawn('explorer.exe', ['/select,', row.attachment_path], { detached: true, stdio: 'ignore' }).unref();
    }
    return { waUrl: whatsappLink(row.destination, row.body), attachment: row.attachment_path };
  }
  if (row.status !== 'awaiting_staff') throw conflict('This message is not waiting for staff');
  db.prepare("UPDATE outbox SET status = 'sent_manual', sent_at = ?, confirmed_by = ?, updated_at = ? WHERE id = ?").run(
    nowIso(),
    actor.id,
    nowIso(),
    id,
  );
  audit(db, { actor, action: 'notify.confirm_sent', entity: 'outbox', entityId: id, after: { channel: 'whatsapp' } });
  return { ok: true, status: 'sent_manual' };
}

// ---- Sending (email via Gmail API, SMS via configured HTTP gateway)

async function gmailAccessToken(g: NonNullable<FileConfig['gmail']>): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: g.clientId,
      client_secret: g.clientSecret,
      refresh_token: g.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Gmail token refresh failed (${res.status}). Sign in again and update data/config.json`);
  return ((await res.json()) as { access_token: string }).access_token;
}

function mimeMessage(from: string, to: string, subject: string, text: string, attachment: { name: string; data: Buffer } | null): string {
  const boundary = `lms_${Date.now().toString(36)}`;
  const enc = (s: string) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
  const head = [`From: ${from}`, `To: ${to}`, `Subject: ${enc(subject)}`, 'MIME-Version: 1.0'];
  if (!attachment) {
    return [...head, 'Content-Type: text/plain; charset=UTF-8', '', text].join('\r\n');
  }
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    text,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${attachment.name}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachment.name}"`,
    '',
    attachment.data.toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}--`,
  ].join('\r\n');
}

async function sendEmail(row: { destination: string; subject: string; body: string; attachment_path: string | null }): Promise<string> {
  const g = loadFileConfig().gmail;
  if (!g?.clientId || !g.refreshToken) throw new Error('Gmail is not configured in data/config.json');
  const token = await gmailAccessToken(g);
  const attachment = row.attachment_path && existsSync(row.attachment_path)
    ? { name: basename(row.attachment_path), data: readFileSync(row.attachment_path) }
    : null;
  const raw = Buffer.from(mimeMessage(g.from, row.destination, row.subject, row.body, attachment)).toString('base64url');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail send failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { id: string }).id;
}

async function sendSms(row: { destination: string; body: string }): Promise<string> {
  const sms = loadFileConfig().sms;
  if (!sms?.url) throw new Error('No SMS gateway configured in data/config.json (sms.url)');
  const vars = { to: row.destination, message: row.body, sender: sms.senderId ?? '' };
  // URL placeholders are percent-encoded; JSON placeholders are escaped so quotes and newlines stay valid.
  const url = sms.url.replace(/\{(\w+)\}/g, (_m, k: string) => encodeURIComponent(vars[k as keyof typeof vars] ?? ''));
  const template = sms.bodyTemplate ?? '{"to":"{to}","message":"{message}"}';
  const payload = template.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = vars[k as keyof typeof vars] ?? '';
    return template.trimStart().startsWith('{') ? JSON.stringify(v).slice(1, -1) : v;
  });
  const res = await fetch(url, {
    method: sms.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(sms.headers ?? {}) },
    body: (sms.method ?? 'POST') === 'GET' ? undefined : payload,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SMS gateway returned ${res.status}: ${text.slice(0, 200)}`);
  return text.slice(0, 80);
}

// Called on a timer. Sends due email/SMS items, retries with backoff, and marks them failed after MAX_ATTEMPTS.
export async function processOutbox(db: DatabaseSync): Promise<number> {
  const due = db
    .prepare(
      `SELECT id, channel, destination, subject, body, attachment_path, attempts FROM outbox
       WHERE status IN ('queued','retrying') AND channel IN ('email','sms')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY id LIMIT 20`,
    )
    .all(nowIso()) as Array<{
    id: number;
    channel: Channel;
    destination: string;
    subject: string | null;
    body: string;
    attachment_path: string | null;
    attempts: number;
  }>;
  let sent = 0;
  for (const item of due) {
    try {
      const providerId =
        item.channel === 'email'
          ? await sendEmail({ destination: item.destination, subject: item.subject ?? 'Lab report', body: item.body, attachment_path: item.attachment_path })
          : await sendSms({ destination: item.destination, body: item.body });
      db.prepare("UPDATE outbox SET status = 'sent', provider_message_id = ?, sent_at = ?, updated_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?").run(
        providerId,
        nowIso(),
        nowIso(),
        item.id,
      );
      sent++;
    } catch (err) {
      const attempts = item.attempts + 1;
      const backoffMinutes = Math.min(5 * 2 ** attempts, 360);
      const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'retrying';
      const next = attempts >= MAX_ATTEMPTS ? null : new Date(Date.now() + backoffMinutes * 60_000).toISOString();
      db.prepare('UPDATE outbox SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?').run(
        status,
        attempts,
        next,
        (err as Error).message.slice(0, 500),
        nowIso(),
        item.id,
      );
    }
  }
  return sent;
}

export function retryOutbox(db: DatabaseSync, actor: AuthUser, id: number): void {
  const row = db.prepare('SELECT status, channel FROM outbox WHERE id = ?').get(id) as { status: string; channel: string } | undefined;
  if (!row) throw notFound('Message not found');
  if (row.channel === 'whatsapp') throw conflict('WhatsApp messages are sent by staff, not retried');
  if (!['failed', 'retrying', 'queued'].includes(row.status)) throw conflict('Only failed or waiting messages can be retried');
  db.prepare("UPDATE outbox SET status = 'queued', attempts = 0, next_attempt_at = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(
    nowIso(),
    nowIso(),
    id,
  );
  audit(db, { actor, action: 'notify.retry', entity: 'outbox', entityId: id });
}

export function cancelOutbox(db: DatabaseSync, actor: AuthUser, id: number): void {
  const row = db.prepare('SELECT status FROM outbox WHERE id = ?').get(id) as { status: string } | undefined;
  if (!row) throw notFound('Message not found');
  if (!['queued', 'retrying', 'awaiting_staff'].includes(row.status)) throw conflict('This message can no longer be cancelled');
  db.prepare("UPDATE outbox SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(), id);
  audit(db, { actor, action: 'notify.cancel', entity: 'outbox', entityId: id });
}
