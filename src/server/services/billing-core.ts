import type { DatabaseSync } from 'node:sqlite';
import { badRequest, conflict, forbidden, invalid } from '../http.ts';
import { getSettings } from './settings.ts';
import { priceFor } from './pricing.ts';
import { verifyApprover } from './approval.ts';
import type { AuthUser } from '../security.ts';
import { nextSequence, pad, businessDate } from '../util.ts';

export interface LineInput {
  testId: number;
  description: string;
  unitPricePaisa: number;
  taxRateBp: number;
}

export interface DiscountInput {
  type: 'none' | 'percent' | 'fixed';
  value: number;
  reason: string | null;
  approver?: { username?: unknown; password?: unknown };
}

export function invoiceNumber(db: DatabaseSync, branchCode: string): string {
  return `INV-${branchCode}-${pad(nextSequence(db, `invoice:${branchCode}`), 6)}`;
}

// Works out discount and tax. Discounts above the user's role cap need a second approver.
export function computeInvoice(
  db: DatabaseSync,
  actor: AuthUser,
  lines: LineInput[],
  discount: DiscountInput,
): { subtotal: number; discount: number; tax: number; total: number; approvedBy: number | null; taxByLine: number[] } {
  const subtotal = lines.reduce((s, l) => s + l.unitPricePaisa, 0);
  if (subtotal <= 0 && discount.type !== 'none') throw badRequest('Discounts apply only to a priced order');

  let discountPaisa = 0;
  let approvedBy: number | null = null;
  if (discount.type !== 'none') {
    if (!(discount.value > 0)) throw invalid('Discount value must be positive');
    discountPaisa =
      discount.type === 'percent'
        ? Math.round((subtotal * Math.min(discount.value, 100)) / 100)
        : Math.min(Math.round(discount.value * 100), subtotal);
    if (!discount.reason || discount.reason.trim().length < 3) throw invalid('A reason is required for every discount');
    const percentEquivalent = subtotal === 0 ? 0 : (discountPaisa / subtotal) * 100;
    const caps = getSettings(db).discount_caps;
    const cap = caps[actor.role] ?? 0;
    if (percentEquivalent > cap + 0.0001) {
      const approver = verifyApprover(db, actor, discount.approver, 'billing.discount_override');
      approvedBy = approver.id;
    }
  }

  const share = (line: LineInput) => (subtotal === 0 ? 0 : (line.unitPricePaisa * discountPaisa) / subtotal);
  const taxByLine = lines.map((l) => Math.round(((l.unitPricePaisa - share(l)) * l.taxRateBp) / 10000));
  const tax = taxByLine.reduce((s, t) => s + t, 0);
  return { subtotal, discount: discountPaisa, tax, total: subtotal - discountPaisa + tax, approvedBy, taxByLine };
}

export function linePriceFor(db: DatabaseSync, branchId: number, testId: number, onDate: string): number {
  return priceFor(db, branchId, testId, onDate);
}

export function todayIn(branchTimezone: string): string {
  return businessDate(branchTimezone || 'Asia/Karachi');
}

export function ensureCanWrite(actor: AuthUser, perm: 'billing.write' | 'billing.close'): void {
  if (!actor.perms.has(perm)) throw forbidden(perm);
}

// Once a cash day is closed, no more money can be recorded against it (a manager can reopen it).
export function assertDayOpen(db: DatabaseSync, branchId: number, date: string): void {
  if (db.prepare('SELECT id FROM cash_closings WHERE branch_id = ? AND business_date = ?').get(branchId, date)) {
    throw conflict('The cash for this day has already been closed for this branch. A branch manager can reopen the day.');
  }
}
