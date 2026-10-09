// 80 mm thermal counter slip. Thermal printers print black only, so the layout relies on weight,
// rules and an inverted status block rather than colour; the brand colour shows on screen only.
import { fmtPkr } from '../util.ts';

export interface ReceiptData {
  lab: { name: string; motto: string | null; address: string | null; phone: string | null; timings: string | null; brand: string };
  invoiceNo: string;
  orderNo: string;
  issuedAt: string;
  printedAt: string;
  status: string;
  patient: { name: string; mrn: string; practitioner: string | null };
  lines: Array<{ description: string; amountPaisa: number }>;
  subtotalPaisa: number;
  discountPaisa: number;
  discountReason: string | null;
  taxPaisa: number;
  totalPaisa: number;
  payments: Array<{ when: string; kind: string; method: string; reference: string | null; amountPaisa: number }>;
  balancePaisa: number;
  verifyCode: string;
  qrSvg: string;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const METHOD: Record<string, string> = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank', jazzcash: 'JazzCash', easypaisa: 'Easypaisa' };
const STATUS: Record<string, string> = { paid: 'PAID IN FULL', partially_paid: 'PARTIALLY PAID', issued: 'PAYMENT DUE', void: 'VOID' };

export function receiptHtml(d: ReceiptData, autoPrint = true): string {
  const row = (k: string, v: string, cls = '') => `<tr class="${cls}"><td>${k}</td><td class="r">${v}</td></tr>`;
  const due = d.status === 'void' ? 0 : d.balancePaisa;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${esc(d.invoiceNo)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:'Inter','Segoe UI',Roboto,Arial,sans-serif;width:72mm;margin:0 auto;padding:3mm 2mm;font-size:11px;line-height:1.35;color:#000;font-variant-numeric:tabular-nums}
  .c{text-align:center}.r{text-align:right;white-space:nowrap}.m{color:#444}.s{font-size:9.5px}
  h1{margin:0;font-size:15px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;text-align:center;color:var(--brand)}
  .motto{margin:2px auto 3px;display:table;border:1px solid #000;border-radius:9px;padding:0 7px;font-size:8.5px;font-weight:700;letter-spacing:1px;text-transform:uppercase}
  .rule{border-top:1px dashed #000;margin:6px 0}.rule2{border-top:2px solid #000;margin:6px 0 4px}
  .title{display:flex;justify-content:space-between;align-items:baseline;margin-top:2px}
  .title b{font-size:12px;letter-spacing:1.5px}
  table{width:100%;border-collapse:collapse}td{padding:1.5px 0;vertical-align:top}
  .meta td:first-child{color:#444;width:30%}
  .items th{font-size:9px;letter-spacing:.8px;text-transform:uppercase;text-align:left;border-bottom:1px solid #000;padding-bottom:2px}
  .items th:last-child{text-align:right}.items td{padding:2.5px 0}
  .total td{font-size:15px;font-weight:800;padding-top:3px}
  .due td{font-size:13px;font-weight:800}
  .status{margin:7px 0 2px;background:#000;color:#fff;text-align:center;font-weight:800;letter-spacing:2px;padding:4px 0;border-radius:3px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .status.void{background:#fff;color:#000;border:2px solid #000}
  .qr{width:30mm;margin:6px auto 0}.qr svg{width:100%;height:auto;display:block}
  @media screen{body{--brand:${esc(d.lab.brand)};background:#fff;margin:16px auto;box-shadow:0 2px 14px rgba(0,0,0,.14);border-radius:4px}html{background:#eef1f5}}
  @media print{@page{size:80mm auto;margin:0}body{--brand:#000}}
</style></head><body>
<h1>${esc(d.lab.name)}</h1>
${d.lab.motto ? `<div class="motto">${esc(d.lab.motto)}</div>` : ''}
${d.lab.address ? `<div class="c s m">${esc(d.lab.address)}</div>` : ''}
${d.lab.phone ? `<div class="c s m">Ph: ${esc(d.lab.phone)}</div>` : ''}
<div class="rule2"></div>
<div class="title"><b>RECEIPT</b><span class="s">${esc(d.invoiceNo)}</span></div>
<div class="rule"></div>
<table class="meta">
${row('Date', esc(d.issuedAt))}
${row('Order', esc(d.orderNo))}
${row('Patient', `<b>${esc(d.patient.name)}</b><br><span class="s m">${esc(d.patient.mrn)}</span>`)}
${row('Ref. by', esc(d.patient.practitioner ?? 'Self'))}
</table>
<div class="rule"></div>
<table class="items"><tr><th>Test</th><th>PKR</th></tr>
${d.lines.map((l) => row(esc(l.description), fmtPkr(l.amountPaisa))).join('')}
</table>
<div class="rule"></div>
<table>
${row('Subtotal', fmtPkr(d.subtotalPaisa), 'm')}
${d.discountPaisa > 0 ? row(`Discount${d.discountReason ? ` <span class="s">(${esc(d.discountReason)})</span>` : ''}`, `-${fmtPkr(d.discountPaisa)}`, 'm') : ''}
${d.taxPaisa > 0 ? row('Tax', fmtPkr(d.taxPaisa), 'm') : ''}
</table>
<div class="rule2"></div>
<table>${row('TOTAL', `PKR ${fmtPkr(d.totalPaisa)}`, 'total')}</table>
${
  d.payments.length
    ? `<div class="rule"></div><table>${d.payments
        .map((p) =>
          row(
            `${p.kind === 'refund' ? 'Refund' : 'Paid'} &middot; ${esc(METHOD[p.method] ?? p.method)}${p.reference ? ` <span class="s m">${esc(p.reference)}</span>` : ''}<br><span class="s m">${esc(p.when)}</span>`,
            `${p.kind === 'refund' ? '-' : ''}${fmtPkr(p.amountPaisa)}`,
          ),
        )
        .join('')}</table>`
    : ''
}
<div class="rule"></div>
<table>${row('Balance due', `PKR ${fmtPkr(due)}`, 'due')}</table>
<div class="status ${d.status === 'void' ? 'void' : ''}">${esc(STATUS[d.status] ?? d.status.toUpperCase())}</div>
<div class="qr">${d.qrSvg}</div>
<div class="c s m">Scan to verify &middot; <b>${esc(d.verifyCode)}</b></div>
<div class="rule"></div>
${d.lab.timings ? `<div class="c s">${esc(d.lab.timings)}</div>` : ''}
<div class="c s" style="margin-top:3px"><b>Thank you for choosing ${esc(d.lab.name)}</b></div>
<div class="c s m">Printed ${esc(d.printedAt)}</div>
${autoPrint ? '<script>window.onload=()=>window.print()</script>' : ''}
</body></html>`;
}
