import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, validateFormula } from '../../src/server/services/formula.ts';
import { flagNumeric, selectRange, type RangeRow } from '../../src/server/services/flags.ts';
import { parseCsv, toCsv } from '../../src/server/services/csv.ts';
import { hashPassword, passwordProblem, verifyPassword } from '../../src/server/security.ts';
import { encryptBuffer, decryptBuffer, packArchive, unpackArchive, restoreArchive } from '../../src/server/services/backup.ts';
import { ageInYears, toPaisa, fmtPkr } from '../../src/server/util.ts';
import { normalizePkPhone, whatsappLink } from '../../src/server/services/notify.ts';

test('formula: LDL = TC - HDL - TG/5 with precedence', () => {
  assert.equal(evaluate('TC - HDL - TG / 5', { TC: 200, HDL: 50, TG: 150 }), 120);
  assert.equal(evaluate('(TP - ALB) * 2', { TP: 7, ALB: 4 }), 6);
});

test('formula: missing input or divide by zero gives null, not NaN', () => {
  assert.equal(evaluate('A / B', { A: 1, B: 0 }), null);
  assert.equal(evaluate('A + B', { A: 1 }), null);
});

test('formula: rejects code and unknown names', () => {
  assert.throws(() => evaluate('process.exit()', {}));
  assert.match(validateFormula('X + Y', ['X']) ?? '', /Unknown parameter/);
  assert.equal(validateFormula('X + 1', ['X']), null);
});

const RANGES: RangeRow[] = [
  { sex: 'A', age_min_days: 0, age_max_days: 36500, low: 4, high: 11, text_range: null, version: 1 },
  { sex: 'M', age_min_days: 0, age_max_days: 36500, low: 13, high: 17, text_range: null, version: 1 },
  { sex: 'F', age_min_days: 0, age_max_days: 36500, low: 12, high: 15.5, text_range: null, version: 1 },
];

test('ranges: sex-specific beats any-sex', () => {
  assert.equal(selectRange(RANGES, 'M', 9000)?.low, 13);
  assert.equal(selectRange(RANGES, 'F', 9000)?.high, 15.5);
  assert.equal(selectRange(RANGES, 'O', 9000)?.low, 4);
});

test('flags: L/H outside range, LL/HH beyond critical limits', () => {
  const range = { low: 13, high: 17 };
  assert.deepEqual(flagNumeric(15, range, { low: 7, high: 20 }), { flag: 'N', critical: false });
  assert.deepEqual(flagNumeric(12, range, { low: 7, high: 20 }), { flag: 'L', critical: false });
  assert.deepEqual(flagNumeric(18, range, { low: 7, high: 20 }), { flag: 'H', critical: false });
  assert.deepEqual(flagNumeric(6, range, { low: 7, high: 20 }), { flag: 'LL', critical: true });
  assert.deepEqual(flagNumeric(21, range, { low: 7, high: 20 }), { flag: 'HH', critical: true });
});

test('csv: quoted commas, quotes and CRLF round-trip', () => {
  const rows = parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\r\n');
  assert.deepEqual(rows, [['a', 'b, c', 'say "hi"'], ['1', '2', '3']]);
  assert.equal(toCsv([['x', 'y,z']]), 'x,"y,z"');
});

test('passwords: hash verifies and rejects wrong password; policy enforced', () => {
  const h = hashPassword('Lab-Pass-2026');
  assert.equal(verifyPassword('Lab-Pass-2026', h), true);
  assert.equal(verifyPassword('wrong-Pass-1', h), false);
  assert.ok(passwordProblem('short1'));
  assert.ok(passwordProblem('onlyletters'));
  assert.equal(passwordProblem('longenough1'), null);
});

test('backup: encrypt/decrypt round-trip; wrong passphrase is refused', () => {
  const data = Buffer.from('SQLite format 3\0 sample payload');
  const enc = encryptBuffer(data, 'twelve-chars-x');
  assert.ok(!enc.includes(Buffer.from('sample payload')));
  assert.deepEqual(decryptBuffer(enc, 'twelve-chars-x'), data);
  assert.throws(() => decryptBuffer(enc, 'another-pass-1'), /wrong or the file is damaged/);
});

test('money and dates', () => {
  assert.equal(toPaisa(12.345), 1235);
  assert.equal(fmtPkr(123456), '1,234.56');
  assert.equal(ageInYears('1990-06-15', new Date('2026-06-14T00:00:00Z')), 35);
  assert.equal(ageInYears('1990-06-15', new Date('2026-06-15T00:00:00Z')), 36);
});

test('phones: Pakistani mobile formats normalise to 92...', () => {
  assert.equal(normalizePkPhone('0300 1234567'), '923001234567');
  assert.equal(normalizePkPhone('+92 300 1234567'), '923001234567');
  assert.equal(normalizePkPhone('12345'), null);
  assert.equal(whatsappLink('923001234567', 'Hi there'), 'https://wa.me/923001234567?text=Hi%20there');
});

test('lab day boundaries use Pakistan time and timezones are validated', async () => {
  const { dayStartUtc, dayEndUtc, isValidTimezone } = await import('../../src/server/util.ts');
  assert.equal(dayStartUtc('2026-10-08'), '2026-10-07T19:00:00.000Z');
  assert.equal(dayEndUtc('2026-10-08'), '2026-10-08T19:00:00.000Z');
  assert.equal(isValidTimezone('Asia/Karachi'), true);
  assert.equal(isValidTimezone('Mars/Olympus'), false);
});

test('backup archive: files round-trip and unsafe paths are refused', () => {
  const entries = [
    { path: 'lms.db', data: Buffer.from('db-bytes') },
    { path: 'files/reports/R1.pdf', data: Buffer.from('%PDF-x') },
  ];
  const back = unpackArchive(packArchive(entries));
  assert.deepEqual(back.map((e) => [e.path, e.data.toString()]), entries.map((e) => [e.path, e.data.toString()]));
  const evil = packArchive([{ path: 'lms.db', data: Buffer.from('x') }, { path: 'files/../../escape.txt', data: Buffer.from('x') }]);
  assert.throws(() => restoreArchive(evil, false), /unsafe file path/);
});

test('range bar geometry: band inside the scale, out-of-scale values clamp to the edge', async () => {
  const { rangeGeometry } = await import('../../src/pdf/lab/geometry.ts');
  const g = rangeGeometry(13, 12, 15, 100)!;
  assert.ok(g.bandStart > 0 && g.bandEnd < 100 && g.marker > g.bandStart && g.marker < g.bandEnd && g.clamped === null);
  assert.deepEqual(rangeGeometry(2, 12, 15, 100)!.clamped, 'low');
  assert.equal(rangeGeometry(2, 12, 15, 100)!.marker, 0);
  assert.equal(rangeGeometry(99, 12, 15, 100)!.clamped, 'high');
  assert.equal(rangeGeometry(150, null, 200, 100)!.bandStart, 0);
  assert.equal(rangeGeometry(10, null, null, 100), null);
});
