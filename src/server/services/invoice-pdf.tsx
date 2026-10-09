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

const STATUS: Record<string, { label: string; fg: string; bg: string }> = {
  paid: { label: 'PAID', fg: '#047857', bg: '#ECFDF5' },
  partially_paid: { label: 'PARTIALLY PAID', fg: '#B45309', bg: '#FFFBEB' },
  issued: { label: 'PAYMENT DUE', fg: '#B91C1C', bg: '#FEF2F2' },
  void: { label: 'VOID', fg: '#475569', bg: '#F1F5F9' },
};

function Stamp({ status }: { status: string }) {
  const s = STATUS[status] ?? STATUS.issued!;
  return (
    <View style={{ borderWidth: 2, borderColor: s.fg, borderRadius: 6, padding: 2, alignSelf: 'flex-end' }}>
      <View style={{ borderWidth: 0.8, borderColor: s.fg, borderRadius: 4, backgroundColor: s.bg, paddingHorizontal: 12, paddingVertical: 3 }}>
        <Text style={{ fontSize: 12, fontWeight: 800, color: s.fg, letterSpacing: 2, textAlign: 'center' }}>{s.label}</Text>
      </View>
    </View>
  );
}

const C = { n: 24, desc: 279, price: 78, tax: 66, total: 92 } as const; // 539

function TotalRow({ k, v, strong, color }: { k: string; v: string; strong?: boolean; color?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: strong ? 4 : 2, borderTopWidth: strong ? 0.8 : 0, borderTopColor: LINE }}>
      <Text style={{ fontSize: strong ? 9.5 : 8, fontWeight: strong ? 800 : 500, color: color ?? (strong ? INK : MUTED) }}>{k}</Text>
      <View style={{ flexGrow: 1 }} />
      <Text style={{ fontSize: strong ? 10.5 : 8.2, fontWeight: strong ? 800 : 600, color: color ?? INK }}>{v}</Text>
    </View>
  );
}

function InvoiceDocument({ d }: { d: InvoiceData }) {
  const b = d.brand;
  const s = STATUS[d.status] ?? STATUS.issued!;
  return (
    <Document title={`Invoice ${d.invoiceNo}`} author={d.branch.name} style={{ fontFamily: FONT, fontSize: 8, color: INK }}>
      <Page size="A4" margin={{ top: 0, bottom: 0, left: 0, right: 0 } as never}>
        <LabHeader b={d.branch} brand={b} docTitle="Invoice / receipt" docMeta={[d.invoiceNo, d.issuedAt]} blankHeightPt={null} />
        <LabFooter brand={b} timings={d.branch.timings} disclaimer={null} docNo={`${d.invoiceNo} • Order ${d.orderNo} • ${d.patient.name}`} blankHeightPt={null} />

        <View style={{ paddingHorizontal: GUTTER }}>
          <View style={{ flexDirection: 'row' }}>
            <View style={{ flexGrow: 1, borderWidth: 0.8, borderColor: tint(b.primary, 0.75), backgroundColor: tint(b.primary, 0.96), borderRadius: 7, padding: 8, marginRight: 8 }}>
              <Label>Billed to</Label>
              <Text style={{ fontSize: 13, fontWeight: 800, marginTop: 2, marginBottom: 5 }}>{d.patient.name}</Text>
              <View style={{ flexDirection: 'row' }}>
                <KV k="MRN" v={d.patient.mrn} width={86} strong />
                <KV k="Order no." v={d.orderNo} width={86} strong />
                <KV k="Mobile" v={d.patient.phone ?? '-'} width={86} />
                <KV k="Referred by" v={d.patient.practitioner ?? 'Self'} width={86} />
              </View>
            </View>
            <View style={{ width: 170, borderRadius: 7, backgroundColor: b.primary, padding: 10 }}>
              <Text style={{ fontSize: 6.5, fontWeight: 700, color: tint(b.primary, 0.6), letterSpacing: 1 }}>{d.balance > 0 && d.status !== 'void' ? 'BALANCE DUE' : 'TOTAL AMOUNT'}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginTop: 2 }}>
                <Text style={{ fontSize: 9, fontWeight: 700, color: tint(b.primary, 0.6), marginRight: 4, marginBottom: 3 }}>PKR</Text>
                <Text style={{ fontSize: 20, fontWeight: 800, color: '#FFFFFF' }}>{pkr(d.balance > 0 && d.status !== 'void' ? d.balance : d.total)}</Text>
              </View>
              <Text style={{ fontSize: 7, color: tint(b.primary, 0.7), marginTop: 3 }}>{`Total ${pkr(d.total)}  •  Paid ${pkr(d.paid - d.refunded)}`}</Text>
            </View>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 }}>
            <Text style={{ fontSize: 9.5, fontWeight: 800, color: b.primary, letterSpacing: 0.8 }}>TESTS AND SERVICES</Text>
            <View style={{ flexGrow: 1 }} />
            <Stamp status={d.status} />
          </View>
          {d.status === 'void' && d.voidReason ? <Text style={{ fontSize: 7.2, color: s.fg, marginTop: 2 }}>{`Voided: ${d.voidReason}`}</Text> : null}

          <View style={{ marginTop: 6, borderWidth: 0.6, borderColor: LINE, borderRadius: 5, overflow: 'hidden' }}>
            <View style={{ flexDirection: 'row', backgroundColor: tint(b.primary, 0.92), paddingVertical: 4, paddingHorizontal: 4 }}>
              {(['#', 'Description', 'Price', 'Tax', 'Amount (PKR)'] as const).map((h, i) => (
                <Text
                  key={h}
                  style={{ width: [C.n, C.desc, C.price, C.tax, C.total][i]! - (i === 4 ? 8 : 0), fontSize: 6.5, fontWeight: 700, color: b.primary, letterSpacing: 0.8, textAlign: i >= 2 ? 'right' : 'left' }}
                >
                  {h.toUpperCase()}
                </Text>
              ))}
            </View>
            {d.lines.map((l, i) => (
              <View key={i} wrap={false} style={{ flexDirection: 'row', paddingVertical: 4, paddingHorizontal: 4, backgroundColor: i % 2 ? SOFT : '#FFFFFF' }}>
                <Text style={{ width: C.n, fontSize: 7.5, color: FAINT }}>{String(i + 1).padStart(2, '0')}</Text>
                <Text style={{ width: C.desc, fontSize: 8.4, fontWeight: 500 }}>{l.description}</Text>
                <Text style={{ width: C.price, fontSize: 8.2, textAlign: 'right' }}>{pkr(l.price)}</Text>
                <Text style={{ width: C.tax, fontSize: 8.2, textAlign: 'right', color: MUTED }}>{pkr(l.tax)}</Text>
                <Text style={{ width: C.total - 8, fontSize: 8.6, fontWeight: 700, textAlign: 'right' }}>{pkr(l.total)}</Text>
              </View>
            ))}
          </View>

          <View style={{ flexDirection: 'row', marginTop: 8 }} wrap={false}>
            <View style={{ flexGrow: 1, marginRight: 14 }}>
              {d.payments.length ? (
                <View>
                  <Label>Payment history</Label>
                  <View style={{ marginTop: 3, borderWidth: 0.6, borderColor: LINE, borderRadius: 5, overflow: 'hidden' }}>
                    {d.payments.map((p, i) => (
                      <View key={i} style={{ flexDirection: 'row', paddingVertical: 3, paddingHorizontal: 5, backgroundColor: i % 2 ? SOFT : '#FFFFFF' }}>
                        <Text style={{ width: 92, fontSize: 7.2, color: MUTED }}>{p.when}</Text>
                        <Text style={{ width: 46, fontSize: 7.2, fontWeight: 700, color: p.kind === 'refund' ? '#B91C1C' : '#047857' }}>{p.kind === 'refund' ? 'Refund' : 'Payment'}</Text>
                        <Text style={{ width: 64, fontSize: 7.2 }}>{p.method === 'jazzcash' ? 'JazzCash' : p.method === 'easypaisa' ? 'Easypaisa' : p.method.charAt(0).toUpperCase() + p.method.slice(1).replace('_', ' ')}</Text>
                        <Text style={{ width: 70, fontSize: 7, color: MUTED }}>{p.reference ?? ''}</Text>
                        <View style={{ flexGrow: 1 }} />
                        <Text style={{ fontSize: 7.6, fontWeight: 700 }}>{`${p.kind === 'refund' ? '-' : ''}${pkr(p.amount)}`}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : (
                <Text style={{ fontSize: 7.4, color: MUTED }}>No payments recorded yet.</Text>
              )}
            </View>
            <View style={{ width: 190 }}>
              <TotalRow k="Subtotal" v={pkr(d.subtotal)} />
              {d.discount > 0 ? <TotalRow k={`Discount${d.discountReason ? ` (${d.discountReason})` : ''}`} v={`-${pkr(d.discount)}`} color="#047857" /> : null}
              <TotalRow k="Tax" v={pkr(d.tax)} />
              <TotalRow k="Total (PKR)" v={pkr(d.total)} strong />
              <TotalRow k="Paid" v={pkr(d.paid)} />
              {d.refunded > 0 ? <TotalRow k="Refunded" v={`-${pkr(d.refunded)}`} /> : null}
              <TotalRow k="Balance due" v={pkr(d.status === 'void' ? 0 : d.balance)} strong color={d.balance > 0 && d.status !== 'void' ? '#B91C1C' : '#047857'} />
            </View>
          </View>

          <View wrap={false} style={{ flexDirection: 'row', marginTop: 12, borderTopWidth: 0.6, borderTopColor: LINE, paddingTop: 8 }}>
            <View style={{ flexGrow: 1 }}>
              {d.paymentDetails ? (
                <View style={{ borderLeftWidth: 3, borderLeftColor: b.secondary, backgroundColor: tint(b.secondary, 0.95), borderRadius: 4, padding: 6, marginRight: 12 }}>
                  <Text style={{ fontSize: 7.4, fontWeight: 800, color: b.secondary, letterSpacing: 0.8 }}>HOW TO PAY</Text>
                  <Text style={{ fontSize: 7.6, color: INK, marginTop: 2, lineHeight: 1.45 }}>{d.paymentDetails}</Text>
                </View>
              ) : null}
              <Text style={{ fontSize: 6.8, color: MUTED, marginTop: 6 }}>
                {`This is a computer-generated invoice and does not need a signature. Keep it for your records; quote ${d.invoiceNo} for any query.`}
              </Text>
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
