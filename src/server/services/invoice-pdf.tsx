import { Document, Page, Text, View } from '@formepdf/react';
import { renderDocument } from '@formepdf/core';
import {
  FAINT,
  FONT,
  GUTTER,
  INK,
  KV,
  LINE,
  LabFooter,
  LabHeader,
  Label,
  MUTED,
  SOFT,
  VerifyQr,
  registerFonts,
  tint,
  type Brand,
} from '../../pdf/lab/kit.tsx';
import type { SampleBranch } from './sample-docs.ts';

export interface InvoiceData {
  brand: Brand;
  branch: SampleBranch;
  invoiceNo: string;
  orderNo: string;
  issuedAt: string;
  status: string;
  voidReason: string | null;
  patient: { name: string; mrn: string; phone: string | null; practitioner: string | null };
  lines: Array<{ description: string; price: number; tax: number; total: number }>;
  subtotal: number;
  discount: number;
  discountReason: string | null;
  tax: number;
  total: number;
  paid: number;
  refunded: number;
  balance: number;
  payments: Array<{ when: string; kind: string; method: string; reference: string | null; amount: number }>;
  paymentDetails: string | null;
  verificationUrl: string;
  verificationCode: string;
}

const pkr = (n: number) => n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const STATUS: Record<string, { label: string; fg: string; bg: string; sym: string }> = {
  paid: { label: 'PAID', fg: '#047857', bg: '#ECFDF5', sym: '●' },
  partially_paid: { label: 'PARTIALLY PAID', fg: '#B45309', bg: '#FFFBEB', sym: '●' },
  issued: { label: 'PAYMENT DUE', fg: '#B91C1C', bg: '#FEF2F2', sym: '●' },
  void: { label: 'VOID', fg: '#475569', bg: '#F1F5F9', sym: '●' },
};

const METHOD: Record<string, string> = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', jazzcash: 'JazzCash', easypaisa: 'Easypaisa' };

function SectionTitle({ children, brand, right }: { children: string; brand: Brand; right?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
      <Text style={{ fontSize: 8, fontWeight: 800, color: brand.primary, letterSpacing: 1 }}>{children.toUpperCase()}</Text>
      <View style={{ flexGrow: 1, height: 0.6, backgroundColor: tint(brand.primary, 0.8), marginLeft: 6 }} />
      {right ? <Text style={{ fontSize: 6.8, color: FAINT, marginLeft: 6 }}>{right}</Text> : null}
    </View>
  );
}

function SummaryRow({ k, v, color, strong }: { k: string; v: string; color?: string; strong?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2.2 }}>
      <Text style={{ fontSize: strong ? 9 : 7.8, fontWeight: strong ? 800 : 500, color: color ?? (strong ? INK : MUTED) }}>{k}</Text>
      <View style={{ flexGrow: 1 }} />
      <Text style={{ fontSize: strong ? 10 : 8.2, fontWeight: strong ? 800 : 600, color: color ?? INK }}>{v}</Text>
    </View>
  );
}

const PAY_COLS = [86, 44, 60, 80] as const;

function InvoiceDocument({ d }: { d: InvoiceData }) {
  const b = d.brand;
  const st = STATUS[d.status] ?? STATUS.issued!;
  const isVoid = d.status === 'void';
  const due = isVoid ? 0 : d.balance;
  const showTax = d.tax > 0 || d.lines.some((l) => l.tax > 0);
  // Columns sum to the 539pt content width; the description takes the tax column's space when there is no tax.
  const C = { n: 24, price: 80, tax: showTax ? 66 : 0, total: 96 };
  const desc = 539 - 8 - C.n - C.price - C.tax - C.total;
  const heroLabel = isVoid ? 'INVOICE VOIDED' : due > 0 ? 'BALANCE DUE' : 'AMOUNT PAID';
  const heroAmount = isVoid ? d.total : due > 0 ? due : d.paid - d.refunded;
  const heroBg = isVoid ? '#64748B' : due > 0 ? b.primary : '#047857';
  const head = { fontSize: 6.4, fontWeight: 700, color: b.primary, letterSpacing: 0.8 } as const;
  return (
    <Document title={`Invoice ${d.invoiceNo}`} author={d.branch.name} style={{ fontFamily: FONT, fontSize: 8, color: INK }}>
      <Page size="A4" margin={{ top: 0, bottom: 0, left: 0, right: 0 } as never}>
        <LabHeader b={d.branch} brand={b} docTitle="Invoice / receipt" docMeta={[d.invoiceNo, d.issuedAt]} blankHeightPt={null} />
        <LabFooter brand={b} timings={d.branch.timings} disclaimer={null} docNo={`${d.invoiceNo} • Order ${d.orderNo} • ${d.patient.name}`} blankHeightPt={null} />

        <View style={{ paddingHorizontal: GUTTER }}>
          <View style={{ flexDirection: 'row' }}>
            <View style={{ flexGrow: 1, flexShrink: 1, borderWidth: 0.8, borderColor: tint(b.primary, 0.75), backgroundColor: tint(b.primary, 0.96), borderRadius: 7, paddingVertical: 9, paddingHorizontal: 11, marginRight: 8 }}>
              <Label>Billed to</Label>
              <Text style={{ fontSize: 13, fontWeight: 800, marginTop: 2, marginBottom: 6 }}>{d.patient.name}</Text>
              <View style={{ flexDirection: 'row' }}>
                <KV k="MRN" v={d.patient.mrn} width={86} strong />
                <KV k="Order no." v={d.orderNo} width={86} strong />
                <KV k="Mobile" v={d.patient.phone ?? '-'} width={86} />
                <KV k="Referred by" v={d.patient.practitioner ?? 'Self'} width={86} />
              </View>
            </View>
            <View style={{ width: 172, borderRadius: 7, backgroundColor: heroBg, paddingVertical: 9, paddingHorizontal: 11 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={{ fontSize: 6.5, fontWeight: 700, color: tint(heroBg, 0.6), letterSpacing: 1 }}>{heroLabel}</Text>
                <View style={{ flexGrow: 1 }} />
                <View style={{ backgroundColor: '#FFFFFF', borderRadius: 9999, paddingHorizontal: 6, paddingVertical: 1.5 }}>
                  <Text style={{ fontSize: 6.4, fontWeight: 800, color: st.fg, letterSpacing: 0.6 }}>{`${st.sym} ${st.label}`}</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginTop: 7 }}>
                <Text style={{ fontSize: 9, fontWeight: 700, color: tint(heroBg, 0.55), marginRight: 4, marginBottom: 3 }}>PKR</Text>
                <Text style={{ fontSize: 21, fontWeight: 800, color: '#FFFFFF' }}>{pkr(heroAmount)}</Text>
              </View>
              <Text style={{ fontSize: 6.8, color: tint(heroBg, 0.65), marginTop: 4 }}>{`Total ${pkr(d.total)}   •   Paid ${pkr(d.paid - d.refunded)}`}</Text>
            </View>
          </View>
          {isVoid && d.voidReason ? (
            <View style={{ marginTop: 6, borderLeftWidth: 3, borderLeftColor: st.fg, backgroundColor: st.bg, borderRadius: 4, paddingVertical: 4, paddingHorizontal: 7 }}>
              <Text style={{ fontSize: 7.4, color: st.fg, fontWeight: 600 }}>{`This invoice was voided: ${d.voidReason}. No payment is due.`}</Text>
            </View>
          ) : null}

          <View style={{ marginTop: 12 }}>
            <SectionTitle brand={b} right={`${d.lines.length} ${d.lines.length === 1 ? 'item' : 'items'}`}>Tests and services</SectionTitle>
            <View style={{ borderWidth: 0.6, borderColor: LINE, borderRadius: 5, overflow: 'hidden' }}>
              <View style={{ flexDirection: 'row', backgroundColor: tint(b.primary, 0.92), paddingVertical: 4, paddingHorizontal: 4 }}>
                <Text style={{ ...head, width: C.n }}>#</Text>
                <Text style={{ ...head, width: desc }}>DESCRIPTION</Text>
                <Text style={{ ...head, width: C.price, textAlign: 'right' }}>PRICE</Text>
                {showTax ? <Text style={{ ...head, width: C.tax, textAlign: 'right' }}>TAX</Text> : null}
                <Text style={{ ...head, width: C.total, textAlign: 'right' }}>AMOUNT (PKR)</Text>
              </View>
              {d.lines.map((l, i) => (
                <View key={i} wrap={false} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 4.2, paddingHorizontal: 4, backgroundColor: i % 2 ? SOFT : '#FFFFFF' }}>
                  <Text style={{ width: C.n, fontSize: 7.4, color: FAINT }}>{String(i + 1).padStart(2, '0')}</Text>
                  <Text style={{ width: desc, fontSize: 8.4, fontWeight: 500 }}>{l.description}</Text>
                  <Text style={{ width: C.price, fontSize: 8.2, textAlign: 'right', color: MUTED }}>{pkr(l.price)}</Text>
                  {showTax ? <Text style={{ width: C.tax, fontSize: 8.2, textAlign: 'right', color: MUTED }}>{pkr(l.tax)}</Text> : null}
                  <Text style={{ width: C.total, fontSize: 8.6, fontWeight: 700, textAlign: 'right' }}>{pkr(l.total)}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={{ flexDirection: 'row', marginTop: 12 }} wrap={false}>
            <View style={{ flexGrow: 1, flexShrink: 1, marginRight: 14 }}>
              <SectionTitle brand={b}>Payments</SectionTitle>
              {d.payments.length ? (
                <View style={{ borderWidth: 0.6, borderColor: LINE, borderRadius: 5, overflow: 'hidden' }}>
                  <View style={{ flexDirection: 'row', backgroundColor: SOFT, paddingVertical: 3, paddingHorizontal: 5, borderBottomWidth: 0.6, borderBottomColor: LINE }}>
                    {(['Date', 'Type', 'Method', 'Reference'] as const).map((h, i) => (
                      <Text key={h} style={{ width: PAY_COLS[i], fontSize: 6, fontWeight: 700, color: FAINT, letterSpacing: 0.7 }}>{h.toUpperCase()}</Text>
                    ))}
                    <View style={{ flexGrow: 1 }} />
                    <Text style={{ fontSize: 6, fontWeight: 700, color: FAINT, letterSpacing: 0.7 }}>AMOUNT</Text>
                  </View>
                  {d.payments.map((p, i) => (
                    <View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 3.2, paddingHorizontal: 5, backgroundColor: i % 2 ? SOFT : '#FFFFFF' }}>
                      <Text style={{ width: PAY_COLS[0], fontSize: 7.2, color: MUTED }}>{p.when}</Text>
                      <Text style={{ width: PAY_COLS[1], fontSize: 7.2, fontWeight: 700, color: p.kind === 'refund' ? '#B91C1C' : '#047857' }}>{p.kind === 'refund' ? 'Refund' : 'Payment'}</Text>
                      <Text style={{ width: PAY_COLS[2], fontSize: 7.2 }}>{METHOD[p.method] ?? p.method}</Text>
                      <Text style={{ width: PAY_COLS[3], fontSize: 7, color: MUTED }}>{p.reference ?? ''}</Text>
                      <View style={{ flexGrow: 1 }} />
                      <Text style={{ fontSize: 7.8, fontWeight: 700, color: p.kind === 'refund' ? '#B91C1C' : INK }}>{`${p.kind === 'refund' ? '-' : ''}${pkr(p.amount)}`}</Text>
                    </View>
                  ))}
                </View>
              ) : (
                <View style={{ borderWidth: 0.6, borderColor: LINE, borderRadius: 5, paddingVertical: 8, paddingHorizontal: 8 }}>
                  <Text style={{ fontSize: 7.4, color: MUTED }}>No payments recorded yet.</Text>
                </View>
              )}
              {d.paymentDetails && due > 0 ? (
                <View style={{ borderLeftWidth: 3, borderLeftColor: b.secondary, backgroundColor: tint(b.secondary, 0.95), borderRadius: 4, paddingVertical: 6, paddingHorizontal: 8, marginTop: 8 }}>
                  <Text style={{ fontSize: 7.4, fontWeight: 800, color: b.secondary, letterSpacing: 0.8 }}>HOW TO PAY THE BALANCE</Text>
                  <Text style={{ fontSize: 7.6, color: INK, marginTop: 2, lineHeight: 1.45 }}>{d.paymentDetails}</Text>
                </View>
              ) : null}
            </View>
            <View style={{ width: 196 }}>
              <SectionTitle brand={b}>Summary</SectionTitle>
              <View style={{ borderWidth: 0.6, borderColor: LINE, borderRadius: 5, overflow: 'hidden' }}>
                <View style={{ paddingHorizontal: 8, paddingTop: 4, paddingBottom: 3 }}>
                  <SummaryRow k="Subtotal" v={pkr(d.subtotal)} />
                  {d.discount > 0 ? <SummaryRow k={`Discount${d.discountReason ? ` (${d.discountReason})` : ''}`} v={`-${pkr(d.discount)}`} color="#047857" /> : null}
                  {showTax ? <SummaryRow k="Tax" v={pkr(d.tax)} /> : null}
                  <View style={{ height: 0.6, backgroundColor: LINE, marginVertical: 2 }} />
                  <SummaryRow k="Total" v={pkr(d.total)} strong />
                  <SummaryRow k="Paid" v={pkr(d.paid)} />
                  {d.refunded > 0 ? <SummaryRow k="Refunded" v={`-${pkr(d.refunded)}`} color="#B91C1C" /> : null}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: due > 0 ? '#FEF2F2' : '#ECFDF5', paddingVertical: 5, paddingHorizontal: 8 }}>
                  <Text style={{ fontSize: 8.6, fontWeight: 800, color: due > 0 ? '#B91C1C' : '#047857' }}>Balance due</Text>
                  <View style={{ flexGrow: 1 }} />
                  <Text style={{ fontSize: 11, fontWeight: 800, color: due > 0 ? '#B91C1C' : '#047857' }}>{`PKR ${pkr(due)}`}</Text>
                </View>
              </View>
            </View>
          </View>

          <View wrap={false} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 14, borderTopWidth: 0.6, borderTopColor: LINE, paddingTop: 10 }}>
            <View style={{ flexGrow: 1, flexShrink: 1, marginRight: 12 }}>
              <Text style={{ fontSize: 6.8, color: MUTED, lineHeight: 1.4 }}>
                {`This is a computer-generated invoice and needs no signature. Please keep it for your records and quote ${d.invoiceNo} for any query.`}
              </Text>
              {d.branch.footerText ? <Text style={{ fontSize: 6.8, color: MUTED, marginTop: 2 }}>{d.branch.footerText}</Text> : null}
            </View>
            <VerifyQr url={d.verificationUrl} code={d.verificationCode} brand={b} size={58} />
          </View>
        </View>
      </Page>
    </Document>
  );
}

export async function renderInvoicePdf(d: InvoiceData): Promise<Uint8Array> {
  registerFonts();
  return renderDocument(<InvoiceDocument d={d} />);
}
