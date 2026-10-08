import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { config, loadFileConfig } from '../config.ts';
import { audit } from '../audit.ts';
import { conflict, notFound } from '../http.ts';
import type { AuthUser } from '../security.ts';
import { ageInYears, nextSequence, pad, nowIso } from '../util.ts';
import { readIfExists, sha256Hex, writeFileAtomic } from './files.ts';
import { renderReportPdf, type ReportData, type ReportLine } from './report-pdf.tsx';
import { rangeLabel } from './results-core.ts';

const BASE32 = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function verificationCode(): string {
  const bytes = randomBytes(10);
  return [...bytes].map((b) => BASE32[b % BASE32.length]).join('');
}

const stamp = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

function dataUri(path: string | null, fallbackMime: string): string | null {
  const buf = readIfExists(path);
  if (!buf) return null;
  const mime = path!.endsWith('.png') ? 'image/png' : fallbackMime;
  return `data:${mime};base64,${buf.toString('base64')}`;
}

export interface ReportRecord {
  id: number;
  reportNo: string;
  version: number;
  pdfPath: string;
  verificationCode: string;
  sha256: string;
  issuedAt: string;
}

// Renders the authorized results of an order into a new report version. Previous versions are kept, marked superseded.
export async function generateReportForOrder(
  db: DatabaseSync,
  actor: AuthUser | null,
  orderId: number,
  reason: string | null,
): Promise<ReportRecord> {
  const order = db
    .prepare(
      `SELECT o.id, o.order_no, o.priority, o.created_at, o.branch_id, p.full_name, p.mrn, p.gender, p.dob, p.age_years_at_registration,
              pr.name AS practitioner_name, p.allergies,
              b.code AS branch_code, b.name AS branch_name, b.address, b.phone, b.email, b.motto, b.header_text, b.footer_text,
              b.logo_path, b.background_path
       FROM orders o
       JOIN patients p ON p.id = o.patient_id
       JOIN branches b ON b.id = o.branch_id
       LEFT JOIN practitioners pr ON pr.id = o.practitioner_id
       WHERE o.id = ?`,
    )
    .get(orderId) as Record<string, any> | undefined;
  if (!order) throw notFound('Order not found');

  const rows = db
    .prepare(
      `SELECT r.id AS result_id, r.value_numeric, r.value_text, r.ref_low, r.ref_high, r.ref_text, r.unit, r.flag, r.critical, r.comment,
              tp.name AS parameter_name, tp.decimals, tp.result_type, t.name AS test_name, d.name AS department_name
       FROM results r
       JOIN test_parameters tp ON tp.id = r.parameter_id
       JOIN order_items oi ON oi.id = r.order_item_id
       JOIN tests t ON t.id = oi.test_id
       JOIN departments d ON d.id = t.department_id
       WHERE oi.order_id = ? AND r.status = 'authorized'
       ORDER BY d.display_order, d.name, t.display_order, t.name, tp.display_order, tp.id`,
    )
    .all(orderId) as Array<Record<string, any>>;
  if (rows.length === 0) throw conflict('No authorized results to report yet');

  const sections = new Map<string, Map<string, ReportLine[]>>();
  for (const r of rows) {
    const dept = String(r.department_name);
    const test = String(r.test_name);
    if (!sections.has(dept)) sections.set(dept, new Map());
    const tests = sections.get(dept)!;
    if (!tests.has(test)) tests.set(test, []);
    const decimals = Number(r.decimals);
    const value =
      r.value_numeric != null ? Number(r.value_numeric).toFixed(Math.max(0, decimals)) : String(r.value_text ?? '');
    const range = rangeLabel(
      { low: r.ref_low as number | null, high: r.ref_high as number | null, text_range: r.ref_text as string | null, sex: 'A', age_min_days: 0, age_max_days: 0, version: 0 },
      (r.unit as string | null) ?? null,
    );
    const flagText =
      r.flag === 'LL' ? 'LOW (critical)' : r.flag === 'HH' ? 'HIGH (critical)' : r.flag === 'L' ? 'Low' : r.flag === 'H' ? 'High' : r.flag === 'N' ? 'Normal' : '';
    tests.get(test)!.push({
      parameter: String(r.parameter_name),
      value,
      unit: String(r.unit ?? ''),
      reference: range ?? '',
      flag: flagText,
      critical: r.critical === 1,
      comment: (r.comment as string | null) ?? null,
    });
  }

  const specimens = db
    .prepare('SELECT accession_no FROM specimens WHERE order_id = ? ORDER BY id')
    .all(orderId) as Array<{ accession_no: string }>;
  const signerRows = db
    .prepare(
      `SELECT DISTINCT u.full_name AS name, u.role FROM results r JOIN order_items oi ON oi.id = r.order_item_id
       JOIN users u ON u.id = r.authorized_by WHERE oi.order_id = ? AND r.status = 'authorized' ORDER BY u.full_name`,
    )
    .all(orderId) as Array<{ name: string; role: string }>;
  const amendments = db
    .prepare(
      `SELECT rv.reason FROM result_revisions rv JOIN results r ON r.id = rv.result_id JOIN order_items oi ON oi.id = r.order_item_id
       WHERE oi.order_id = ? AND rv.reason IS NOT NULL AND rv.reason <> 'entry correction' ORDER BY rv.changed_at`,
    )
    .all(orderId) as Array<{ reason: string }>;

  const version = (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM reports WHERE order_id = ?').get(orderId) as { v: number }).v;
  const reportNo = `${order.branch_code}-RPT-${pad(nextSequence(db, `report:${order.branch_code}`), 7)}`;
  const code = verificationCode();
  const base = loadFileConfig().publicBaseUrl ?? `http://${config.host}:${config.port}`;
  const issuedAt = nowIso();
  const dob = (order.dob as string | null) ?? null;
  const ageLabel = dob
    ? `${ageInYears(dob, new Date(issuedAt))} years`
    : `${order.age_years_at_registration} years (at registration)`;

  const data: ReportData = {
    reportNo,
    version,
    issuedAt: stamp(issuedAt),
    verificationUrl: `${base}/verify/${code}`,
    amended: version > 1,
    amendmentReasons: amendments.map((a) => a.reason),
    branch: {
      name: String(order.branch_name),
      address: (order.address as string | null) ?? null,
      phone: (order.phone as string | null) ?? null,
      email: (order.email as string | null) ?? null,
      motto: (order.motto as string | null) ?? null,
      headerText: (order.header_text as string | null) ?? null,
      footerText: (order.footer_text as string | null) ?? null,
      logoDataUri: dataUri(order.logo_path as string | null, 'image/jpeg'),
      backgroundDataUri: dataUri(order.background_path as string | null, 'image/jpeg'),
    },
    patient: {
      name: String(order.full_name),
      mrn: String(order.mrn),
      gender: String(order.gender),
      age: ageLabel,
      practitioner: (order.practitioner_name as string | null) ?? null,
      allergies: (order.allergies as string | null) ?? null,
    },
    order: {
      orderNo: String(order.order_no),
      priority: String(order.priority),
      createdAt: stamp(String(order.created_at)),
      accessions: specimens.map((s) => s.accession_no),
    },
    sections: [...sections.entries()].map(([department, tests]) => ({
      department,
      tests: [...tests.entries()].map(([name, lines]) => ({ name, lines })),
    })),
    signers: signerRows.map((s) => ({ name: s.name, title: s.role.replace(/_/g, ' ') })),
  };

  // Rendering is async and must happen outside any open database transaction.
  const pdf = Buffer.from(await renderReportPdf(data));
  const pdfPath = join(config.reportsDir, `${reportNo}.pdf`);
  writeFileAtomic(pdfPath, pdf);
  const sha = sha256Hex(pdf);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE reports SET status = 'superseded' WHERE order_id = ? AND status = 'final'").run(orderId);
    const row = db
      .prepare(
        `INSERT INTO reports (order_id, branch_id, report_no, verification_code, version, status, pdf_path, sha256, reason, issued_by, issued_at)
         VALUES (?, ?, ?, ?, ?, 'final', ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(orderId, order.branch_id, reportNo, code, version, pdfPath, sha, reason, actor?.id ?? null, issuedAt) as { id: number };
    audit(db, {
      actor,
      branchId: Number(order.branch_id),
      action: 'report.issue',
      entity: 'report',
      entityId: row.id,
      after: { reportNo, version, sha256: sha, amendments: amendments.length },
    });
    db.exec('COMMIT');
    return { id: row.id, reportNo, version, pdfPath, verificationCode: code, sha256: sha, issuedAt };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
