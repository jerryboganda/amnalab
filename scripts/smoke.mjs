// End-to-end smoke test. Starts the built server on a temporary database and walks the whole lab workflow:
// setup -> patient -> order -> specimen -> results -> review -> authorization -> PDF -> payment -> stock -> WhatsApp.
// Run after `npm run build`:  npm run smoke
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const PORT = 8197;
const BASE = `http://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), 'lms-smoke-'));
const server = spawn(process.execPath, ['dist/server/index.js'], {
  env: { ...process.env, LMS_ROOT: root, LMS_DB_FILE: join(root, 'data', 'lms.db'), LMS_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

let passed = 0;
const step = (name) => console.log(`- ${name}`);

// Each user gets its own cookie jar so different people can review, authorize and approve.
function client() {
  let cookie = '';
  return async function call(method, path, body, { raw = false } = {}) {
    const headers = { 'X-Requested-With': 'lms' };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not start:\n${serverLog}`);
}

try {
  await waitForServer();
  const admin = client();
  const tech = client();
  const pathologist = client();
  const reception = client();
  const collector = client();

  step('health and first-run setup');
  assert.equal((await admin('GET', '/api/health')).json.status, 'ok');
  assert.equal((await admin('GET', '/api/setup/status')).json.needsSetup, true);
  const setup = await admin('POST', '/api/setup', {
    organizationName: 'Smoke Lab',
    branchName: 'Main Branch',
    branchCode: 'MAIN',
    adminName: 'Site Admin',
    username: 'admin',
    password: 'Admin-Pass-2026',
  });
  assert.equal(setup.status, 201);
  assert.equal((await admin('POST', '/api/setup', {})).status, 409, 'setup must run once only');
  passed++;

  step('login, CSRF and authorization guards');
  assert.equal((await admin('POST', '/api/auth/login', { username: 'admin', password: 'wrong-password-1' })).status, 401);
  const login = await admin('POST', '/api/auth/login', { username: 'admin', password: 'Admin-Pass-2026' });
  assert.equal(login.status, 200);
  assert.equal((await client()('GET', '/api/patients')).status, 401, 'anonymous access must be refused');
  const noHeader = await fetch(`${BASE}/api/patients`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403, 'state change without the custom header must be refused');
  passed++;

  step('staff accounts');
  const branches = (await admin('GET', '/api/branches')).json;
  const branchId = branches[0].id;
  for (const u of [
    { username: 'techno', fullName: 'Lab Technician', role: 'technician', password: 'Tech-Pass-2026', branchIds: [branchId] },
    { username: 'drali', fullName: 'Dr Ali', role: 'pathologist', password: 'Path-Pass-2026', branchIds: [branchId] },
    { username: 'reception1', fullName: 'Front Desk', role: 'reception', password: 'Rec-Pass-2026', branchIds: [branchId] },
    { username: 'collector1', fullName: 'Bilal Collector', role: 'collector', password: 'Col-Pass-2026', branchIds: [branchId] },
  ]) {
    assert.equal((await admin('POST', '/api/admin/users', u)).status, 201);
  }
  assert.equal((await tech('POST', '/api/auth/login', { username: 'techno', password: 'Tech-Pass-2026' })).status, 200);
  assert.equal((await pathologist('POST', '/api/auth/login', { username: 'drali', password: 'Path-Pass-2026' })).status, 200);
  assert.equal((await reception('POST', '/api/auth/login', { username: 'reception1', password: 'Rec-Pass-2026' })).status, 200);
  assert.equal((await collector('POST', '/api/auth/login', { username: 'collector1', password: 'Col-Pass-2026' })).status, 200);
  passed++;

  step('catalog: starter Pakistan-market tests with approved starter ranges');
  const tests = (await admin('GET', '/api/catalog/tests')).json;
  const find = (code) => tests.find((t) => t.code === code);
  const cbc = find('CBC');
  const fbs = find('FBS');
  assert.ok(cbc && fbs, 'starter catalog should contain CBC and FBS');
  const cbcDetail = (await admin('GET', `/api/catalog/tests/${cbc.id}`)).json;
  assert.ok(cbcDetail.parameters.length >= 10);
  assert.ok(cbcDetail.parameters.find((p) => p.code === 'HGB').ranges.length >= 2);
  passed++;

  step('patient registration with duplicate check');
  const patientBody = { branchId, fullName: 'Ayesha Khan', gender: 'F', dob: '1988-03-14', phone: '0300 1234567', consent: { whatsapp: true, email: false, sms: false } };
  const pat = await reception('POST', '/api/patients', patientBody);
  assert.equal(pat.status, 201);
  assert.match(pat.json.mrn, /^MAIN-\d{6}$/);
  const dupe = await reception('POST', '/api/patients', { ...patientBody, fullName: 'Ayesha Khan' });
  assert.equal(dupe.status, 409, 'same phone must trigger duplicate warning');
  const patientId = pat.json.id;
  passed++;

  step('order with discount approval and partial payment');
  const order = await reception('POST', '/api/orders', {
    branchId,
    patientId,
    priority: 'urgent',
    testIds: [cbc.id, fbs.id],
    payment: { method: 'cash', amountPkr: 500 },
  });
  assert.equal(order.status, 201, JSON.stringify(order.json));
  const orderId = order.json.id;
  assert.equal(order.json.items.length, 2);
  assert.ok(order.json.specimens.length >= 1);
  assert.equal(order.json.invoice.status, 'partially_paid');
  const bigDiscount = await reception('POST', '/api/orders', {
    branchId,
    patientId,
    testIds: [fbs.id],
    discount: { type: 'percent', value: 50, reason: 'Staff welfare' },
  });
  assert.equal(bigDiscount.status, 400, 'a 50 percent discount above the reception cap must need an approver');
  passed++;

  step('specimen collection and receipt');
  const specimens = order.json.specimens;
  for (const sp of specimens) {
    assert.equal((await collector('POST', `/api/specimens/${sp.id}/collect`, { collectorName: 'Bilal' })).status, 200);
    assert.equal((await tech('POST', `/api/specimens/${sp.id}/receive`)).status, 200);
  }
  const labelRes = await tech('GET', `/api/specimens/${specimens[0].id}/label`, undefined, { raw: true });
  assert.equal(labelRes.status, 200);
  assert.match(labelRes.headers.get('content-security-policy') ?? '', /script-src 'unsafe-inline'/);
  passed++;

  step('results entry: technician enters, pathologist reviews and authorizes');
  const itemIds = order.json.items.map((i) => i.id);
  const cbcItem = order.json.items.find((i) => i.test_id === cbc.id);
  const fbsItem = order.json.items.find((i) => i.test_id === fbs.id);
  const cbcView = (await tech('GET', `/api/order-items/${cbcItem.id}`)).json;
  const values = cbcView.parameters
    .filter((p) => p.resultType === 'numeric')
    .map((p) => ({ parameterId: p.id, valueNumeric: p.code === 'HGB' ? 12.5 : p.code === 'WBC' ? 7.2 : p.code === 'PLT' ? 250 : (p.range?.low ?? 1) + 0.1 }));
  assert.equal((await tech('POST', `/api/order-items/${cbcItem.id}/results`, { values })).status, 200);
  const fbsView = (await tech('GET', `/api/order-items/${fbsItem.id}`)).json;
  const glucose = fbsView.parameters.find((p) => p.code === 'FBS');
  assert.equal((await tech('POST', `/api/order-items/${fbsItem.id}/results`, { values: [{ parameterId: glucose.id, valueNumeric: 92 }] })).status, 200);
  assert.equal((await tech('POST', `/api/order-items/${cbcItem.id}/authorize`)).status, 403, 'technician cannot authorize');
  assert.equal((await tech('POST', `/api/order-items/${cbcItem.id}/review`)).status, 409, 'the person who entered a result cannot review it');
  assert.equal((await pathologist('POST', `/api/order-items/${cbcItem.id}/review`)).status, 200);
  assert.equal((await pathologist('POST', `/api/order-items/${fbsItem.id}/review`)).status, 200);
  assert.equal((await tech('POST', `/api/order-items/${cbcItem.id}/authorize`)).status, 403);
  assert.equal((await pathologist('POST', `/api/order-items/${cbcItem.id}/authorize`)).status, 200);
  const last = await pathologist('POST', `/api/order-items/${fbsItem.id}/authorize`);
  assert.equal(last.status, 200);
  assert.equal(last.json.orderCompleted, true);
  assert.ok(last.json.report?.reportNo, 'authorizing the last test must issue a report');
  passed++;

  step('report PDF and public verification');
  const reports = (await admin('GET', `/api/orders/${orderId}/reports`)).json;
  assert.equal(reports.length, 1);
  const pdf = await admin('GET', `/api/reports/${reports[0].id}/pdf`, undefined, { raw: true });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.buffer.subarray(0, 4).toString(), '%PDF');
  const verify = await client()('GET', `/api/verify/${reports[0].verification_code}`);
  assert.equal(verify.status, 200);
  assert.equal(verify.json.valid, true);
  passed++;

  step('billing: balance, payment, receipt and daily closing');
  const inv = (await admin('GET', `/api/invoices/${order.json.invoice.id}`)).json;
  assert.ok(inv.balancePkr > 0);
  const pay = await reception('POST', `/api/invoices/${inv.id}/payments`, { method: 'jazzcash', amountPkr: inv.balancePkr, reference: 'JC-778812' });
  assert.equal(pay.status, 201);
  assert.equal(pay.json.status, 'paid');
  const receipt = await reception('GET', `/api/invoices/${inv.id}/receipt`, undefined, { raw: true });
  assert.equal(receipt.status, 200);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
  const closing = (await admin('GET', `/api/billing/closing?branchId=${branchId}&date=${today}`)).json;
  assert.ok(closing.expectedCashPkr >= 500);
  passed++;

  step('inventory: receipt, issue and approval-gated adjustment');
  const item = (await admin('POST', '/api/inventory/items', { code: 'EDTA-TUBE', name: 'EDTA tubes', unit: 'pcs', reorderLevel: 20 })).json;
  const future = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  assert.equal((await admin('POST', '/api/inventory/receipts', { branchId, itemId: item.id, qty: 100, lotNo: 'EDT-01', expiryDate: future })).status, 201);
  assert.equal((await admin('POST', '/api/inventory/issues', { branchId, itemId: item.id, qty: 30, reason: 'Collection drive' })).status, 201);
  const stock = (await admin('GET', `/api/inventory/stock?branchId=${branchId}`)).json.find((s) => s.code === 'EDTA-TUBE');
  assert.equal(stock.onHand, 70);
  const lotId = stock.lots[0].lotId;
  assert.equal((await admin('POST', '/api/inventory/adjustments', { branchId, lotId, qty: -2, reason: 'Count correction' })).status, 201);
  assert.equal((await admin('POST', '/api/inventory/adjustments', { branchId, lotId, qty: -40, reason: 'Count correction big' })).status, 400, 'large adjustment needs approver');
  passed++;

  step('messages: WhatsApp is staff-operated and needs consent');
  const reportId = reports[0].id;
  const wa = await reception('POST', `/api/reports/${reportId}/send`, { channel: 'whatsapp' });
  assert.equal(wa.status, 201, JSON.stringify(wa.json));
  assert.match(wa.json.waUrl, /^https:\/\/wa\.me\/92300/);
  assert.equal((await reception('POST', `/api/notifications/${wa.json.id}/whatsapp`, { action: 'confirm' })).json.status, 'sent_manual');
  const emailNoConsent = await reception('POST', `/api/reports/${reportId}/send`, { channel: 'email' });
  assert.equal(emailNoConsent.status, 409, 'email needs consent');
  passed++;

  step('dashboard and audit trail');
  const dash = (await admin('GET', `/api/dashboard?branchId=${branchId}`)).json;
  assert.ok(dash.operations.ordersToday >= 1);
  const audit = (await admin('GET', '/api/admin/audit?limit=500')).json;
  for (const action of ['order.create', 'result.authorize', 'report.issue', 'payment.receive']) {
    assert.ok(audit.some((a) => a.action === action), `audit should contain ${action}`);
  }
  passed++;

  console.log(`\nSmoke test passed: ${passed} checkpoints.`);
} catch (err) {
  console.error('\nSmoke test FAILED:', err.message);
  console.error('--- server log ---\n' + serverLog.slice(-4000));
  process.exitCode = 1;
} finally {
  server.kill();
  if (!process.env.SMOKE_KEEP) rmSync(root, { recursive: true, force: true });
}
