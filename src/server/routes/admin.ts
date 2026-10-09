import { existsSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Router } from '../http.ts';
import { RawResponse, arr, badRequest, bool, conflict, forbidden, int, intParam, json, notFound, oneOf, optStr, str } from '../http.ts';
import { audit } from '../audit.ts';
import { hashPassword, passwordProblem, ROLES, requirePerm, type AuthUser, type Role } from '../security.ts';
import { getSettings, setSetting, type Settings } from '../services/settings.ts';
import { readIfExists, saveBrandingImage, saveUserSignature } from '../services/files.ts';
import { branchDesign } from '../services/doc-branch.ts';
import { sampleInvoice, sampleReport } from '../services/sample-docs.ts';
import { renderReportPdf } from '../services/report-pdf.tsx';
import { renderInvoicePdf } from '../services/invoice-pdf.tsx';
import { toCsv } from '../services/csv.ts';
import { createBackup, listBackups } from '../services/backup.ts';
import { config } from '../config.ts';
import { dayEndUtc, dayStartUtc, isValidTimezone, nowIso } from '../util.ts';

function validTz(tz: string): string {
  if (!isValidTimezone(tz)) throw badRequest(`Unknown timezone: ${tz}. Use e.g. Asia/Karachi`);
  return tz;
}
import { branchesFor } from './auth.ts';

function userRow(db: DatabaseSync, id: number) {
  const u = db
    .prepare('SELECT id, username, full_name, role, is_active, locked_until, created_at, qualifications, signature_path FROM users WHERE id = ?')
    .get(id) as
    | { id: number; username: string; full_name: string; role: string; is_active: number; locked_until: string | null; created_at: string; qualifications: string | null; signature_path: string | null }
    | undefined;
  if (!u) return null;
  const branches = db
    .prepare(
      `SELECT b.id, b.name, b.code FROM user_branches ub JOIN branches b ON b.id = ub.branch_id WHERE ub.user_id = ? ORDER BY b.code`,
    )
    .all(id);
  return {
    id: u.id,
    username: u.username,
    fullName: u.full_name,
    role: u.role,
    isActive: u.is_active === 1,
    lockedUntil: u.locked_until,
    createdAt: u.created_at,
    qualifications: u.qualifications,
    hasSignature: !!u.signature_path,
    branches,
  };
}

function assertBranchIdsExist(db: DatabaseSync, ids: number[]): void {
  for (const id of ids) {
    const row = db.prepare('SELECT id FROM branches WHERE id = ?').get(id);
    if (!row) throw badRequest(`Branch ${id} does not exist`);
  }
}

export function registerAdmin(r: Router, db: DatabaseSync) {
  // ---- Users (admin.users)
  r.get('/api/admin/users', (ctx) => {
    requirePerm(ctx.user!, 'admin.users');
    const rows = db.prepare('SELECT id FROM users ORDER BY username').all() as Array<{ id: number }>;
    return rows.map((r) => userRow(db, r.id));
  });

  r.post('/api/admin/users', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'admin.users');
    const b = ctx.body;
    const username = str(b, 'username', { max: 40, min: 3 });
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) throw badRequest('Username may use letters, digits, dot, dash and underscore');
    const fullName = str(b, 'fullName', { max: 120 });
    const role = oneOf<Role>(b, 'role', ROLES);
    const password = str(b, 'password', { max: 200 });
    const problem = passwordProblem(password);
    if (problem) throw badRequest(problem);
    const branchIds = (Array.isArray(b.branchIds) ? (b.branchIds as unknown[]) : []).map((x) => Number(x)).filter((x) => Number.isInteger(x));
    if (role !== 'admin' && role !== 'qa_auditor' && branchIds.length === 0) {
      throw badRequest('Assign at least one branch to this user');
    }
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) throw conflict('Username already exists');
    assertBranchIdsExist(db, branchIds);

    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db
        .prepare('INSERT INTO users (username, full_name, role, password_hash) VALUES (?, ?, ?, ?) RETURNING id')
        .get(username, fullName, role, hashPassword(password)) as { id: number };
      for (const bid of branchIds) db.prepare('INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)').run(row.id, bid);
      audit(db, { actor, action: 'user.create', entity: 'user', entityId: row.id, after: { username, role, branchIds } });
      db.exec('COMMIT');
      return json(userRow(db, row.id), 201);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });

  r.patch('/api/admin/users/:id', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'admin.users');
    const id = intParam(ctx.params.id!, 'id');
    const before = userRow(db, id);
    if (!before) throw notFound('User not found');
    const b = ctx.body;
    if (id === actor.id && (b.isActive === false || (b.role !== undefined && b.role !== before.role))) {
      throw conflict('You cannot disable or change the role of your own account');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      if (b.fullName !== undefined) {
        db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(str(b, 'fullName', { max: 120 }), id);
      }
      if (b.role !== undefined) {
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(oneOf<Role>(b, 'role', ROLES), id);
      }
      if (b.isActive !== undefined) {
        db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(bool(b, 'isActive') ? 1 : 0, id);
        if (!bool(b, 'isActive')) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      }
      if (b.unlock === true) db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(id);
      if (b.qualifications !== undefined) db.prepare('UPDATE users SET qualifications = ? WHERE id = ?').run(optStr(b, 'qualifications', 200), id);
      if (b.signature) db.prepare('UPDATE users SET signature_path = ? WHERE id = ?').run(saveUserSignature(id, str(b, 'signature', { max: 6_000_000 })), id);
      else if (b.signature === null) db.prepare('UPDATE users SET signature_path = NULL WHERE id = ?').run(id);
      if (b.password !== undefined) {
        const pw = str(b, 'password', { max: 200 });
        const problem = passwordProblem(pw);
        if (problem) throw badRequest(problem);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      }
      if (b.branchIds !== undefined) {
        const ids = arr(b, 'branchIds', 50).map((x) => Number(x));
        assertBranchIdsExist(db, ids);
        db.prepare('DELETE FROM user_branches WHERE user_id = ?').run(id);
        for (const bid of ids) db.prepare('INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)').run(id, bid);
      }
      audit(db, {
        actor,
        action: 'user.update',
        entity: 'user',
        entityId: id,
        before: { role: before.role, isActive: before.isActive, branches: before.branches },
        after: { changed: Object.keys(b).filter((k) => k !== 'password') },
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return userRow(db, id);
  });

  // ---- Branches
  r.get('/api/branches', (ctx) => branchesFor(db, ctx.user!));

  r.get('/api/admin/branches', (ctx) => {
    requirePerm(ctx.user!, 'admin.branches');
    return db
      .prepare(
        `SELECT id, name, code, address, phone, email, whatsapp, motto, header_text, footer_text, timezone, currency, is_active,
                logo_path IS NOT NULL AS has_logo, background_path IS NOT NULL AS has_background
         FROM branches ORDER BY code`,
      )
      .all();
  });

  r.post('/api/admin/branches', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'admin.branches');
    const b = ctx.body;
    const name = str(b, 'name', { max: 120 });
    const code = str(b, 'code', { max: 12 }).toUpperCase();
    if (!/^[A-Z0-9]+$/.test(code)) throw badRequest('Branch code may use letters and digits only');
    if (db.prepare('SELECT id FROM branches WHERE code = ?').get(code)) throw conflict('Branch code already exists');
    const org = db.prepare('SELECT id FROM organizations ORDER BY id LIMIT 1').get() as { id: number };
    const row = db
      .prepare(
        `INSERT INTO branches (organization_id, name, code, address, phone, email, whatsapp, motto, timezone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        org.id,
        name,
        code,
        optStr(b, 'address', 300),
        optStr(b, 'phone', 40),
        optStr(b, 'email', 120),
        optStr(b, 'whatsapp', 40),
        optStr(b, 'motto', 200),
        validTz(optStr(b, 'timezone', 60) ?? 'Asia/Karachi'),
      ) as { id: number };
    audit(db, { actor, branchId: row.id, action: 'branch.create', entity: 'branch', entityId: row.id, after: { name, code } });
    return json({ id: row.id }, 201);
  });

  r.patch('/api/admin/branches/:id', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'admin.branches');
    const id = intParam(ctx.params.id!, 'id');
    const exists = db.prepare('SELECT id FROM branches WHERE id = ?').get(id);
    if (!exists) throw notFound('Branch not found');
    const b = ctx.body;
    const sets: string[] = [];
    const vals: Array<string | number | null> = [];
    const text: Array<[string, string, number]> = [
      ['name', 'name', 120],
      ['address', 'address', 300],
      ['phone', 'phone', 40],
      ['email', 'email', 120],
      ['whatsapp', 'whatsapp', 40],
      ['motto', 'motto', 200],
      ['timezone', 'timezone', 60],
    ];
    for (const [key, col, max] of text) {
      if (b[key] !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(key === 'name' ? str(b, key, { max }) : key === 'timezone' ? validTz(str(b, key, { max })) : optStr(b, key, max));
      }
    }
    if (b.isActive !== undefined) {
      sets.push('is_active = ?');
      vals.push(bool(b, 'isActive') ? 1 : 0);
    }
    if (sets.length) {
      db.prepare(`UPDATE branches SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
      audit(db, { actor, branchId: id, action: 'branch.update', entity: 'branch', entityId: id, after: { fields: sets } });
    }
    return { ok: true };
  });

  // ---- Report template and branding (reports.template)
  r.get('/api/branches/:id/template', (ctx) => {
    const id = intParam(ctx.params.id!, 'id');
    if (ctx.user!.branchIds !== 'all' && !ctx.user!.branchIds.includes(id)) throw forbidden('this branch');
    const row = db
      .prepare(
        `SELECT id, name, code, address, phone, email, whatsapp, motto, header_text, footer_text,
                logo_path IS NOT NULL AS has_logo, background_path IS NOT NULL AS has_background,
                brand_primary, brand_secondary, timings, disclaimer, incharge_name, incharge_title,
                incharge_signature_path IS NOT NULL AS has_incharge_signature, letterhead_mode, letterhead_top_mm,
                letterhead_bottom_mm, payment_details
         FROM branches WHERE id = ?`,
      )
      .get(id);
    if (!row) throw notFound('Branch not found');
    return row;
  });

  r.put('/api/branches/:id/template', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'reports.template');
    const id = intParam(ctx.params.id!, 'id');
    if (actor.branchIds !== 'all' && !actor.branchIds.includes(id)) throw forbidden('this branch');
    const b = ctx.body;
    const before = db.prepare('SELECT header_text, footer_text, motto FROM branches WHERE id = ?').get(id);
    if (!before) throw notFound('Branch not found');
    // Every field is validated first and only changed when sent, so a partial or rejected save never wipes the others.
    const color = (key: string) => {
      const v = str(b, key, { max: 7 });
      if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw badRequest(`${key} must be a colour like #1F5FAE`);
      return v.toUpperCase();
    };
    const sets: Array<[string, string | number | null]> = [];
    if (b.headerText !== undefined) sets.push(['header_text', optStr(b, 'headerText', 600)]);
    if (b.footerText !== undefined) sets.push(['footer_text', optStr(b, 'footerText', 600)]);
    if (b.motto !== undefined) sets.push(['motto', optStr(b, 'motto', 200)]);
    if (b.brandPrimary !== undefined) sets.push(['brand_primary', color('brandPrimary')]);
    if (b.brandSecondary !== undefined) sets.push(['brand_secondary', color('brandSecondary')]);
    if (b.timings !== undefined) sets.push(['timings', optStr(b, 'timings', 300)]);
    if (b.disclaimer !== undefined) sets.push(['disclaimer', optStr(b, 'disclaimer', 800)]);
    if (b.inchargeName !== undefined) sets.push(['incharge_name', optStr(b, 'inchargeName', 120)]);
    if (b.inchargeTitle !== undefined) sets.push(['incharge_title', optStr(b, 'inchargeTitle', 160)]);
    if (b.paymentDetails !== undefined) sets.push(['payment_details', optStr(b, 'paymentDetails', 600)]);
    if (b.letterheadMode !== undefined) sets.push(['letterhead_mode', bool(b, 'letterheadMode') ? 1 : 0]);
    if (b.letterheadTopMm !== undefined) sets.push(['letterhead_top_mm', int(b, 'letterheadTopMm', { min: 0, max: 120 })]);
    if (b.letterheadBottomMm !== undefined) sets.push(['letterhead_bottom_mm', int(b, 'letterheadBottomMm', { min: 0, max: 120 })]);
    for (const [col, v] of sets) db.prepare(`UPDATE branches SET ${col} = ? WHERE id = ?`).run(v, id);
    if (b.logo) {
      const path = saveBrandingImage(id, 'logo', str(b, 'logo', { max: 6_000_000 }));
      db.prepare('UPDATE branches SET logo_path = ? WHERE id = ?').run(path, id);
    } else if (b.logo === null) {
      db.prepare('UPDATE branches SET logo_path = NULL WHERE id = ?').run(id);
    }
    if (b.inchargeSignature) {
      const path = saveBrandingImage(id, 'incharge-signature', str(b, 'inchargeSignature', { max: 6_000_000 }));
      db.prepare('UPDATE branches SET incharge_signature_path = ? WHERE id = ?').run(path, id);
    } else if (b.inchargeSignature === null) {
      db.prepare('UPDATE branches SET incharge_signature_path = NULL WHERE id = ?').run(id);
    }
    if (b.background) {
      const path = saveBrandingImage(id, 'background', str(b, 'background', { max: 6_000_000 }));
      db.prepare('UPDATE branches SET background_path = ? WHERE id = ?').run(path, id);
    } else if (b.background === null) {
      db.prepare('UPDATE branches SET background_path = NULL WHERE id = ?').run(id);
    }
    audit(db, { actor, branchId: id, action: 'template.update', entity: 'branch', entityId: id, before, after: Object.fromEntries(sets) });
    return { ok: true };
  });

  // Sample report or invoice in this branch's current design, for the template screen.
  r.get('/api/branches/:id/template/preview.pdf', async (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'reports.template');
    const id = intParam(ctx.params.id!, 'id');
    if (actor.branchIds !== 'all' && !actor.branchIds.includes(id)) throw forbidden('this branch');
    if (!db.prepare('SELECT id FROM branches WHERE id = ?').get(id)) throw notFound('Branch not found');
    const d = branchDesign(db, id);
    const doc = ctx.query.get('doc') === 'invoice' ? 'invoice' : 'report';
    const variant = ctx.query.get('variant') === 'print' ? 'print' : 'digital';
    const pdf =
      doc === 'invoice'
        ? await renderInvoicePdf(sampleInvoice(d.branch, d.brand, d.paymentDetails))
        : await renderReportPdf(sampleReport(d.branch, d.brand, d.incharge, variant));
    return new RawResponse('application/pdf', Buffer.from(pdf), { 'Content-Disposition': `inline; filename="sample-${doc}.pdf"` });
  });

  // Branch images are served only to signed-in users who can see the branch.
  r.get('/api/branches/:id/branding/:kind', (ctx) => {
    const id = intParam(ctx.params.id!, 'id');
    const user = ctx.user!;
    if (user.branchIds !== 'all' && !user.branchIds.includes(id)) throw forbidden('this branch');
    const kind = ctx.params.kind;
    if (kind !== 'logo' && kind !== 'background' && kind !== 'incharge-signature') throw notFound();
    const col = kind === 'logo' ? 'logo_path' : kind === 'background' ? 'background_path' : 'incharge_signature_path';
    const row = db.prepare(`SELECT ${col} AS path FROM branches WHERE id = ?`).get(id) as { path: string | null } | undefined;
    const data = readIfExists(row?.path);
    if (!data) throw notFound('No image');
    const type = row!.path!.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return new RawResponse(type, data);
  });

  // ---- Audit log (admin.audit)
  const auditRows = (ctx: { query: URLSearchParams; user: AuthUser }) => {
    const q = ctx.query;
    const where: string[] = [];
    const vals: Array<string | number> = [];
    if (q.get('entity')) {
      where.push('e.entity = ?');
      vals.push(q.get('entity')!);
    }
    if (q.get('action')) {
      where.push('e.action LIKE ?');
      vals.push(`%${q.get('action')}%`);
    }
    if (q.get('actor')) {
      where.push('u.username = ?');
      vals.push(q.get('actor')!);
    }
    if (q.get('from')) {
      where.push('e.occurred_at >= ?');
      vals.push(/^\d{4}-\d{2}-\d{2}$/.test(q.get('from')!) ? dayStartUtc(q.get('from')!) : q.get('from')!);
    }
    if (q.get('to')) {
      where.push('e.occurred_at < ?');
      vals.push(/^\d{4}-\d{2}-\d{2}$/.test(q.get('to')!) ? dayEndUtc(q.get('to')!) : q.get('to')!);
    }
    // Branch managers and other branch-bound auditors see only their branches' events (plus unbranched system events they caused).
    if (ctx.user.branchIds !== 'all') {
      const ids = ctx.user.branchIds.length ? ctx.user.branchIds : [-1];
      where.push(`(e.branch_id IN (${ids.map(() => '?').join(',')}) OR (e.branch_id IS NULL AND e.actor_user_id = ?))`);
      vals.push(...ids, ctx.user.id);
    }
    const limit = Math.min(Number(q.get('limit') ?? 200) || 200, 5000);
    const sql = `SELECT e.id, e.occurred_at, u.username AS actor, e.branch_id, e.action, e.entity, e.entity_id,
                        e.before_json, e.after_json, e.source
                 FROM audit_events e LEFT JOIN users u ON u.id = e.actor_user_id
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY e.id DESC LIMIT ${limit}`;
    return db.prepare(sql).all(...vals);
  };

  r.get('/api/admin/audit', (ctx) => {
    requirePerm(ctx.user!, 'admin.audit');
    return auditRows({ query: ctx.query, user: ctx.user! });
  });

  r.get('/api/admin/audit.csv', (ctx) => {
    requirePerm(ctx.user!, 'admin.audit');
    const rows = auditRows({ query: ctx.query, user: ctx.user! }) as Array<Record<string, any>>;
    const header = ['id', 'occurred_at', 'actor', 'branch_id', 'action', 'entity', 'entity_id', 'before_json', 'after_json', 'source'];
    const csv = toCsv([header, ...rows.map((r) => header.map((h) => r[h] as string | number | null))]);
    return new RawResponse('text/csv; charset=utf-8', csv, {
      'Content-Disposition': `attachment; filename="audit-${nowIso().slice(0, 10)}.csv"`,
    });
  });

  // ---- Settings (admin.users)
  r.get('/api/admin/settings', (ctx) => {
    requirePerm(ctx.user!, 'admin.users');
    return getSettings(db);
  });

  r.put('/api/admin/settings', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'admin.users');
    const before = getSettings(db);
    const b = ctx.body;
    if (b.discount_caps !== undefined) {
      const caps = b.discount_caps as Record<string, any>;
      for (const [role, pct] of Object.entries(caps)) {
        if (!(ROLES as readonly string[]).includes(role)) throw badRequest(`Unknown role: ${role}`);
        if (typeof pct !== 'number' || pct < 0 || pct > 100) throw badRequest(`Discount cap for ${role} must be 0-100`);
      }
      setSetting(db, 'discount_caps', caps);
    }
    if (b.adjustment_approval_threshold !== undefined) {
      setSetting(db, 'adjustment_approval_threshold', int(b, 'adjustment_approval_threshold', { min: 0, max: 1_000_000 }));
    }
    const after: Settings = getSettings(db);
    audit(db, { actor, action: 'settings.update', entity: 'settings', before, after });
    return after;
  });

  // ---- Operations (ops.backup)
  r.get('/api/ops/health', (ctx) => {
    const user = ctx.user!;
    if (!user.perms.has('ops.backup') && !user.perms.has('admin.audit')) throw forbidden('ops.backup');
    const dbSize = existsSync(config.dbFile) ? statSync(config.dbFile).size : 0;
    const outbox = db
      .prepare(`SELECT status, COUNT(*) AS n FROM outbox WHERE status IN ('queued','retrying','failed','awaiting_staff') GROUP BY status`)
      .all();
    const lastBackup = db.prepare('SELECT file, size, created_at FROM backups ORDER BY id DESC LIMIT 1').get() ?? null;
    return { status: 'ok', version: config.version, dbBytes: dbSize, outbox, lastBackup, now: nowIso() };
  });

  r.post('/api/ops/backup', (ctx) => {
    const actor = ctx.user!;
    requirePerm(actor, 'ops.backup');
    return json(createBackup(db, 'manual', actor), 201);
  });

  r.get('/api/ops/backups', (ctx) => {
    requirePerm(ctx.user!, 'ops.backup');
    return listBackups(db);
  });
}
