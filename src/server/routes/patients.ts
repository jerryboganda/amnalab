import type { DatabaseSync } from 'node:sqlite';
import type { Router } from '../http.ts';
import { bool, forbidden, int, intParam, invalid, json, notFound, oneOf, optStr, str, badRequest } from '../http.ts';
import { audit } from '../audit.ts';
import { can, requirePerm, type AuthUser } from '../security.ts';
import { ageInYears, nextSequence, pad } from '../util.ts';
import { normalizePkPhone } from '../services/notify.ts';

export function patientVisible(db: DatabaseSync, user: AuthUser, patientId: number): boolean {
  if (user.branchIds === 'all') return true;
  if (user.branchIds.length === 0) return false;
  const ph = user.branchIds.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM patients p WHERE p.id = ? AND (p.branch_id IN (${ph})
         OR EXISTS (SELECT 1 FROM orders o WHERE o.patient_id = p.id AND o.branch_id IN (${ph})))`,
    )
    .get(patientId, ...user.branchIds, ...user.branchIds);
  return row !== undefined;
}

function latestReportFor(db: DatabaseSync, patientId: number): number | null {
  const row = db
    .prepare(
      `SELECT rp.id FROM reports rp JOIN orders o ON o.id = rp.order_id
       WHERE o.patient_id = ? AND rp.status = 'final' ORDER BY rp.id DESC LIMIT 1`,
    )
    .get(patientId) as { id: number } | undefined;
  return row?.id ?? null;
}

function requireVisible(db: DatabaseSync, user: AuthUser, patientId: number): void {
  if (!patientVisible(db, user, patientId)) throw notFound('Patient not found');
}

function patientDto(row: Record<string, any>) {
  return {
    id: row.id,
    branchId: row.branch_id,
    mrn: row.mrn,
    fullName: row.full_name,
    dob: row.dob,
    ageYears: row.dob ? ageInYears(String(row.dob)) : row.age_years_at_registration,
    gender: row.gender,
    phone: row.phone,
    whatsapp: row.whatsapp,
    email: row.email,
    address: row.address,
    allergies: row.allergies,
    practitionerId: row.practitioner_id,
    practitionerName: row.practitioner_name ?? null,
    consent: {
      whatsapp: row.consent_whatsapp === 1,
      email: row.consent_email === 1,
      sms: row.consent_sms === 1,
    },
    createdAt: row.created_at,
  };
}

const PATIENT_SELECT = `SELECT p.*, pr.name AS practitioner_name FROM patients p LEFT JOIN practitioners pr ON pr.id = p.practitioner_id`;

export function registerPatients(r: Router, db: DatabaseSync) {
  r.get('/api/patients', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'patients.read');
    const q = (ctx.query.get('q') ?? '').trim();
    const where: string[] = [];
    const vals: Array<string | number> = [];
    if (user.branchIds !== 'all') {
      if (user.branchIds.length === 0) return [];
      const ph = user.branchIds.map(() => '?').join(',');
      where.push(`(p.branch_id IN (${ph}) OR EXISTS (SELECT 1 FROM orders o WHERE o.patient_id = p.id AND o.branch_id IN (${ph})))`);
      vals.push(...user.branchIds, ...user.branchIds);
    }
    if (q) {
      where.push('(p.full_name LIKE ? OR p.mrn LIKE ? OR p.phone LIKE ? OR p.whatsapp LIKE ?)');
      const like = `%${q}%`;
      vals.push(like, like, like, like);
    }
    const sql = `${PATIENT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.id DESC LIMIT 200`;
    return (db.prepare(sql).all(...vals) as Array<Record<string, any>>).map((row) => ({
      ...patientDto(row),
      latestReportId: latestReportFor(db, Number(row.id)),
    }));
  });

  r.post('/api/patients', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'patients.write');
    const b = ctx.body;
    const branchId = int(b, 'branchId', { min: 1 });
    if (user.branchIds !== 'all' && !user.branchIds.includes(branchId)) throw forbidden('this branch');
    const branch = db.prepare('SELECT id, code FROM branches WHERE id = ? AND is_active = 1').get(branchId) as
      | { id: number; code: string }
      | undefined;
    if (!branch) throw badRequest('Branch not found');

    const fullName = str(b, 'fullName', { max: 120, min: 2 });
    const gender = oneOf(b, 'gender', ['M', 'F', 'O'] as const);
    const dob = optStr(b, 'dob', 10);
    if (dob && (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(`${dob}T00:00:00Z`)))) {
      throw invalid('dob must be YYYY-MM-DD');
    }
    if (dob && Date.parse(`${dob}T00:00:00Z`) > Date.now()) throw invalid('dob cannot be in the future');
    const ageYears = dob ? null : int(b, 'ageYears', { min: 0, max: 120 });
    const phone = optStr(b, 'phone', 40);
    const whatsapp = optStr(b, 'whatsapp', 40);
    const email = optStr(b, 'email', 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('Email address looks invalid');
    if (phone && !normalizePkPhone(phone)) throw invalid('Phone must be a valid Pakistani mobile number, e.g. 0300 1234567');
    if (whatsapp && !normalizePkPhone(whatsapp)) throw invalid('WhatsApp must be a valid Pakistani mobile number');
    const practitionerId = b.practitionerId == null ? null : int(b, 'practitionerId', { min: 1 });
    if (practitionerId && !db.prepare('SELECT id FROM practitioners WHERE id = ?').get(practitionerId)) {
      throw badRequest('Referring doctor not found');
    }
    const consent = (b.consent ?? {}) as Record<string, any>;

    // Duplicate check: same phone, or same name with the same date of birth / age.
    const dupes = db
      .prepare(
        `${PATIENT_SELECT}
         WHERE (? IS NOT NULL AND (p.phone = ? OR p.whatsapp = ?))
            OR (lower(p.full_name) = lower(?) AND ((? IS NOT NULL AND p.dob = ?) OR (? IS NULL AND p.age_years_at_registration = ?)))
         LIMIT 10`,
      )
      .all(phone, phone, whatsapp ?? phone, fullName, dob, dob, dob, ageYears) as Array<Record<string, any>>;
    if (dupes.length > 0 && !bool(b, 'force')) {
      return json(
        {
          error: 'possible_duplicate',
          message: 'A patient with the same phone or name and date of birth already exists. Confirm to register anyway.',
          duplicates: dupes.map((d) =>
            patientVisible(db, user, Number(d.id)) ? patientDto(d) : { id: null, mrn: d.mrn, fullName: d.full_name, phone: null },
          ),
        },
        409,
      );
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const mrn = `${branch.code}-${pad(nextSequence(db, `mrn:${branch.code}`), 6)}`;
      const row = db
        .prepare(
          `INSERT INTO patients (branch_id, mrn, full_name, dob, age_years_at_registration, gender, phone, whatsapp, email, address,
                                 allergies, practitioner_id, consent_whatsapp, consent_email, consent_sms, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          branchId,
          mrn,
          fullName,
          dob,
          ageYears ?? ageInYears(dob ?? '1900-01-01'),
          gender,
          phone,
          whatsapp,
          email,
          optStr(b, 'address', 300),
          optStr(b, 'allergies', 500),
          practitionerId,
          consent.whatsapp === true ? 1 : 0,
          consent.email === true ? 1 : 0,
          consent.sms === true ? 1 : 0,
          user.id,
          user.id,
        ) as { id: number };
      audit(db, { actor: user, branchId, action: 'patient.create', entity: 'patient', entityId: row.id, after: { mrn } });
      db.exec('COMMIT');
      const created = db.prepare(`${PATIENT_SELECT} WHERE p.id = ?`).get(row.id) as Record<string, any>;
      return json(patientDto(created), 201);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });

  r.get('/api/patients/:id', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'patients.read');
    const id = intParam(ctx.params.id!, 'id');
    requireVisible(db, user, id);
    const row = db.prepare(`${PATIENT_SELECT} WHERE p.id = ?`).get(id) as Record<string, any> | undefined;
    if (!row) throw notFound('Patient not found');
    // Previous investigations: this laboratory's orders for the patient, with authorized results only.
    const orders = db
      .prepare(
        `SELECT o.id, o.order_no, o.created_at, o.status, o.priority, b.code AS branch_code
         FROM orders o JOIN branches b ON b.id = o.branch_id WHERE o.patient_id = ? ORDER BY o.id DESC LIMIT 50`,
      )
      .all(id) as Array<Record<string, any>>;
    const history = orders.map((o) => {
      const tests = db
        .prepare(
          `SELECT t.name, oi.status FROM order_items oi JOIN tests t ON t.id = oi.test_id WHERE oi.order_id = ? ORDER BY oi.id`,
        )
        .all(o.id);
      return { ...o, tests };
    });
    return { patient: patientDto(row), history, canWhatsApp: can(user, 'reports.send') };
  });

  r.patch('/api/patients/:id', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'patients.write');
    const id = intParam(ctx.params.id!, 'id');
    requireVisible(db, user, id);
    const before = db.prepare('SELECT * FROM patients WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!before) throw notFound('Patient not found');
    const b = ctx.body;
    const next = {
      full_name: b.fullName !== undefined ? str(b, 'fullName', { max: 120, min: 2 }) : before.full_name,
      phone: b.phone !== undefined ? optStr(b, 'phone', 40) : before.phone,
      whatsapp: b.whatsapp !== undefined ? optStr(b, 'whatsapp', 40) : before.whatsapp,
      email: b.email !== undefined ? optStr(b, 'email', 120) : before.email,
      address: b.address !== undefined ? optStr(b, 'address', 300) : before.address,
      allergies: b.allergies !== undefined ? optStr(b, 'allergies', 500) : before.allergies,
      practitioner_id: b.practitionerId !== undefined ? (b.practitionerId == null ? null : int(b, 'practitionerId', { min: 1 })) : before.practitioner_id,
      consent_whatsapp: b.consentWhatsapp !== undefined ? (bool(b, 'consentWhatsapp') ? 1 : 0) : before.consent_whatsapp,
      consent_email: b.consentEmail !== undefined ? (bool(b, 'consentEmail') ? 1 : 0) : before.consent_email,
      consent_sms: b.consentSms !== undefined ? (bool(b, 'consentSms') ? 1 : 0) : before.consent_sms,
    };
    if (next.phone && !normalizePkPhone(String(next.phone))) throw invalid('Phone must be a valid Pakistani mobile number');
    if (next.whatsapp && !normalizePkPhone(String(next.whatsapp))) throw invalid('WhatsApp must be a valid Pakistani mobile number');
    if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(next.email))) throw invalid('Email address looks invalid');
    if (next.practitioner_id && !db.prepare('SELECT id FROM practitioners WHERE id = ?').get(next.practitioner_id)) throw badRequest('Referring doctor not found');
    db.prepare(
      `UPDATE patients SET full_name = ?, phone = ?, whatsapp = ?, email = ?, address = ?, allergies = ?, practitioner_id = ?,
              consent_whatsapp = ?, consent_email = ?, consent_sms = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
    ).run(
      next.full_name,
      next.phone,
      next.whatsapp,
      next.email,
      next.address,
      next.allergies,
      next.practitioner_id,
      next.consent_whatsapp,
      next.consent_email,
      next.consent_sms,
      user.id,
      id,
    );
    audit(db, {
      actor: user,
      branchId: Number(before.branch_id),
      action: 'patient.update',
      entity: 'patient',
      entityId: id,
      before: { phone: before.phone, email: before.email, allergies: before.allergies, consent_whatsapp: before.consent_whatsapp, consent_email: before.consent_email, consent_sms: before.consent_sms },
      after: { phone: next.phone, email: next.email, allergies: next.allergies, consent_whatsapp: next.consent_whatsapp, consent_email: next.consent_email, consent_sms: next.consent_sms },
    });
    const row = db.prepare(`${PATIENT_SELECT} WHERE p.id = ?`).get(id) as Record<string, any>;
    return patientDto(row);
  });

  // Trend of one numeric parameter across this patient's authorized results (same test, same unit).
  r.get('/api/patients/:id/trends', (ctx) => {
    const user = ctx.user!;
    requirePerm(user, 'patients.read');
    const id = intParam(ctx.params.id!, 'id');
    requireVisible(db, user, id);
    const code = ctx.query.get('parameter');
    if (!code) {
      // No parameter given: list the numeric parameters this patient has authorized results for.
      const parameters = db
        .prepare(
          `SELECT tp.code, tp.name, r.unit, COUNT(*) AS n
           FROM results r JOIN test_parameters tp ON tp.id = r.parameter_id
           JOIN order_items oi ON oi.id = r.order_item_id JOIN orders o ON o.id = oi.order_id
           WHERE o.patient_id = ? AND r.status = 'authorized' AND r.value_numeric IS NOT NULL
           GROUP BY tp.code, tp.name, r.unit ORDER BY tp.name`,
        )
        .all(id);
      return { parameters };
    }
    const rows = db
      .prepare(
        `SELECT o.created_at AS date, r.value_numeric AS value, r.unit, r.flag, t.code AS test_code, tp.code AS parameter_code
         FROM results r
         JOIN test_parameters tp ON tp.id = r.parameter_id
         JOIN tests t ON t.id = tp.test_id
         JOIN order_items oi ON oi.id = r.order_item_id
         JOIN orders o ON o.id = oi.order_id
         WHERE o.patient_id = ? AND tp.code = ? AND r.status = 'authorized' AND r.value_numeric IS NOT NULL
         ORDER BY o.created_at ASC LIMIT 200`,
      )
      .all(id, code);
    return { parameter: code, points: rows };
  });

  r.get('/api/practitioners', (ctx) => {
    requirePerm(ctx.user!, 'patients.read');
    return db.prepare('SELECT id, name, specialty, phone FROM practitioners WHERE is_active = 1 ORDER BY name').all();
  });

  r.post('/api/practitioners', (ctx) => {
    requirePerm(ctx.user!, 'patients.write');
    const name = str(ctx.body, 'name', { max: 120 });
    const row = db
      .prepare('INSERT INTO practitioners (name, specialty, phone) VALUES (?, ?, ?) RETURNING id')
      .get(name, optStr(ctx.body, 'specialty', 120), optStr(ctx.body, 'phone', 40)) as { id: number };
    audit(db, { actor: ctx.user!, action: 'practitioner.create', entity: 'practitioner', entityId: row.id, after: { name } });
    return json({ id: row.id, name }, 201);
  });
}
