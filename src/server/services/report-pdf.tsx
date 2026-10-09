import { Document, Page, Text, View, Watermark } from '@formepdf/react';
import { renderDocument } from '@formepdf/core';
import {
  DeptHeader,
  FAINT,
  FLAG_LABEL,
  FONT,
  FlagChip,
  GUTTER,
  INK,
  KV,
  LINE,
  LabFooter,
  LabHeader,
  MUTED,
  RangeBar,
  SOFT,
  SignatureCard,
  Sparkline,
  VerifyQr,
  flagStyle,
  formatUnit,
  registerFonts,
  tint,
  type Brand,
  type FlagCode,
  type LetterheadBranch,
  type SignerView,
} from '../../pdf/lab/kit.tsx';

export interface ReportLine {
  parameter: string;
  value: string;
  valueNum: number | null;
  unit: string;
  reference: string;
  refLow: number | null;
  refHigh: number | null;
  flag: FlagCode;
  critical: boolean;
  comment: string | null;
  /** Earlier authorized values of the same parameter (oldest first), at most 3. */
  trend: number[];
  previous: { value: string; date: string } | null;
}

export interface ReportData {
  variant: 'digital' | 'print';
  reportNo: string;
  version: number;
  issuedAt: string;
  verificationUrl: string;
  verificationCode: string;
  amended: boolean;
  amendmentReasons: string[];
  brand: Brand;
  branch: LetterheadBranch & {
    footerText: string | null;
    timings: string | null;
    disclaimer: string | null;
    backgroundDataUri: string | null;
    letterhead: { enabled: boolean; topMm: number; bottomMm: number };
  };
  patient: { name: string; mrn: string; gender: string; age: string; practitioner: string | null; allergies: string | null };
  order: { orderNo: string; priority: string; createdAt: string; collectedAt: string | null; receivedAt: string | null; accessions: string[]; specimenTypes: string[] };
  sections: Array<{ department: string; tests: Array<{ name: string; lines: ReportLine[] }> }>;
  incharge: SignerView | null;
  signers: SignerView[];
}

const GENDER: Record<string, string> = { M: 'Male', F: 'Female', O: 'Other' };
const MM = 2.8346;
// Column widths in points; the content width is 595 - 2 x 28 = 539.
const C = { param: 146, result: 56, unit: 58, ref: 80, bar: 92, trend: 62, flag: 45 } as const;

function HeadCell({ w, children, align = 'left' }: { w: number; children: string; align?: 'left' | 'right' | 'center' }) {
  return <Text style={{ width: w, fontSize: 6.3, fontWeight: 700, color: FAINT, letterSpacing: 0.8, textAlign: align, textTransform: 'uppercase' }}>{children}</Text>;
}

function ResultRow({ l, i, brand }: { l: ReportLine; i: number; brand: Brand }) {
  const s = flagStyle(l.flag);
  const abnormal = l.flag != null && l.flag !== 'N';
  return (
    <View style={{ backgroundColor: i % 2 === 1 ? SOFT : '#FFFFFF', paddingVertical: 2.6, paddingHorizontal: 4 }} wrap={false}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={{ width: C.param, fontSize: 8.2, color: INK, fontWeight: abnormal ? 600 : 400 }}>{l.parameter}</Text>
        <View style={{ width: C.result, paddingRight: 7 }}>
          <Text style={{ fontSize: 8.8, fontWeight: 800, color: abnormal ? s.fg : INK, textAlign: 'right' }}>{l.value}</Text>
        </View>
        <Text style={{ width: C.unit, fontSize: 7, color: MUTED }}>{formatUnit(l.unit)}</Text>
        <Text style={{ width: C.ref, fontSize: 7.2, color: INK }}>{l.reference}</Text>
        <View style={{ width: C.bar }}>
          <RangeBar value={l.valueNum} low={l.refLow} high={l.refHigh} code={l.flag} brand={brand} width={C.bar - 6} />
        </View>
        <View style={{ width: C.trend, flexDirection: 'row', alignItems: 'center' }}>
          {l.valueNum != null && l.trend.length > 0 ? (
            <>
              <Sparkline points={l.trend} current={l.valueNum} code={l.flag} brand={brand} width={30} />
              {l.previous ? <Text style={{ fontSize: 5.8, color: MUTED, marginLeft: 2 }}>{`prev ${l.previous.value}`}</Text> : null}
            </>
          ) : null}
        </View>
        <View style={{ width: C.flag - 8, alignItems: 'flex-end' }}>
          <FlagChip code={l.flag} />
        </View>
      </View>
      {l.comment ? <Text style={{ fontSize: 6.8, color: MUTED, marginTop: 1, marginLeft: 6 }}>{`Note: ${l.comment}`}</Text> : null}
    </View>
  );
}

function TestBlock({ name, lines, brand }: { name: string | null; lines: ReportLine[]; brand: Brand }) {
  const graphic = lines.some((l) => l.valueNum != null);
  return (
    <View wrap={lines.length > 16} style={{ marginTop: 5, borderWidth: 0.6, borderColor: LINE, borderRadius: 5, overflow: 'hidden', paddingBottom: 1.5 }}>
      {name ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, paddingTop: 4, paddingBottom: 3 }}>
          <Text style={{ fontSize: 9, fontWeight: 700, color: INK }}>{name}</Text>
          <View style={{ flexGrow: 1 }} />
          <Text style={{ fontSize: 6.5, color: FAINT }}>{`${lines.length} ${lines.length === 1 ? 'parameter' : 'parameters'}`}</Text>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', paddingHorizontal: 4, paddingTop: name ? 0 : 4, paddingBottom: 2, borderBottomWidth: 0.6, borderBottomColor: LINE }}>
        <HeadCell w={C.param}>Parameter</HeadCell>
        <View style={{ width: C.result, paddingRight: 7 }}>
          <HeadCell w={C.result - 7} align="right">Result</HeadCell>
        </View>
        <HeadCell w={C.unit}>Unit</HeadCell>
        <HeadCell w={C.ref}>Reference</HeadCell>
        <HeadCell w={C.bar}>{graphic ? 'Position in range' : ''}</HeadCell>
        <HeadCell w={C.trend}>{graphic ? 'Trend' : ''}</HeadCell>
        <HeadCell w={C.flag - 8} align="right">Flag</HeadCell>
      </View>
      {lines.map((l, i) => (
        <ResultRow key={`${l.parameter}-${i}`} l={l} i={i} brand={brand} />
      ))}
    </View>
  );
}

// Consecutive single-parameter tests share one block (one column header) to keep the report dense.
// The row is labelled with the test name, which is more familiar than the parameter code.
function groupTests(tests: Array<{ name: string; lines: ReportLine[] }>): Array<{ name: string | null; lines: ReportLine[] }> {
  const out: Array<{ name: string | null; lines: ReportLine[] }> = [];
  let singles: ReportLine[] = [];
  const flush = () => {
    if (singles.length) out.push({ name: null, lines: singles });
    singles = [];
  };
  for (const t of tests) {
    if (t.lines.length === 1) singles.push({ ...t.lines[0]!, parameter: t.name });
    else {
      flush();
      out.push({ name: t.name, lines: t.lines });
    }
  }
  flush();
  return out;
}

function PatientCard({ d }: { d: ReportData }) {
  const b = d.brand;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 0.8, borderColor: tint(b.primary, 0.75), borderRadius: 7, backgroundColor: tint(b.primary, 0.96), paddingVertical: 9, paddingLeft: 11, paddingRight: 9 }}>
      <View style={{ flexGrow: 1, flexShrink: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 5 }}>
          <Text style={{ fontSize: 13, fontWeight: 800, color: INK }}>{d.patient.name}</Text>
          <View style={{ marginLeft: 7, backgroundColor: b.primary, borderRadius: 9999, paddingHorizontal: 6, paddingVertical: 1 }}>
            <Text style={{ fontSize: 7, fontWeight: 700, color: '#FFFFFF' }}>{`${GENDER[d.patient.gender] ?? d.patient.gender} • ${d.patient.age}`}</Text>
          </View>
          {d.order.priority !== 'routine' ? (
            <View style={{ marginLeft: 5, backgroundColor: b.secondary, borderRadius: 9999, paddingHorizontal: 6, paddingVertical: 1 }}>
              <Text style={{ fontSize: 7, fontWeight: 700, color: '#FFFFFF' }}>{d.order.priority.toUpperCase()}</Text>
            </View>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row' }}>
          <KV k="MRN" v={d.patient.mrn} width={108} strong />
          <KV k="Lab / order no." v={d.order.orderNo} width={108} strong />
          <KV k="Referred by" v={d.patient.practitioner ?? 'Self'} width={108} />
          <KV k="Specimen" v={d.order.specimenTypes.join(', ') || '-'} width={116} />
        </View>
        <View style={{ flexDirection: 'row', marginTop: 2 }}>
          <KV k="Registered" v={d.order.createdAt} width={108} />
          <KV k="Collected" v={d.order.collectedAt ?? '-'} width={108} />
          <KV k="Received" v={d.order.receivedAt ?? '-'} width={108} />
          <KV k="Reported" v={d.issuedAt} width={116} strong />
        </View>
        {d.patient.allergies ? <Text style={{ fontSize: 7, color: '#B91C1C', fontWeight: 600 }}>{`Known allergies: ${d.patient.allergies}`}</Text> : null}
      </View>
      <VerifyQr url={d.verificationUrl} code={d.verificationCode} brand={b} />
    </View>
  );
}

const rows = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

function AbnormalSummary({ d }: { d: ReportData }) {
  const items = d.sections.flatMap((s) => s.tests.flatMap((t) => t.lines)).filter((l) => l.flag && l.flag !== 'N');
  items.sort((a, z) => Number(z.critical) - Number(a.critical));
  if (items.length === 0) {
    return (
      <View style={{ marginTop: 6, flexDirection: 'row', alignItems: 'center', backgroundColor: '#ECFDF5', borderRadius: 5, paddingVertical: 4, paddingHorizontal: 8 }}>
        <Text style={{ fontSize: 8, fontWeight: 700, color: '#047857' }}>● All reported values are within their reference ranges.</Text>
      </View>
    );
  }
  const crit = items.filter((i) => i.critical).length;
  return (
    <View wrap={false} style={{ marginTop: 6, borderWidth: 0.8, borderColor: '#FECACA', backgroundColor: '#FFF7F7', borderRadius: 6, paddingVertical: 6, paddingHorizontal: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 5 }}>
        <Text style={{ fontSize: 8.4, fontWeight: 800, color: '#B91C1C', letterSpacing: 0.6 }}>ATTENTION</Text>
        <Text style={{ fontSize: 7.6, color: INK, marginLeft: 6 }}>
          {`${items.length} result${items.length === 1 ? '' : 's'} outside the reference range${crit ? `, ${crit} critical` : ''}`}
        </Text>
      </View>
      {rows(items, 3).map((row, r) => (
        <View key={r} style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: r ? 4 : 0 }}>
          {[...row, ...Array<null>(3 - row.length).fill(null)].map((l, i) => {
            if (!l) return <View key={i} style={{ width: 168 }} />;
            const s = flagStyle(l.flag);
            return (
              <View
                key={i}
                style={{ width: 168, flexDirection: 'row', backgroundColor: '#FFFFFF', borderWidth: 0.6, borderColor: tint(s.fg, 0.65), borderLeftWidth: 2.5, borderLeftColor: s.fg, borderRadius: 4, paddingVertical: 3, paddingHorizontal: 5 }}
              >
                <View style={{ flexGrow: 1, flexShrink: 1 }}>
                  <Text style={{ fontSize: 7.4, fontWeight: 700, color: INK }}>{l.parameter}</Text>
                  <Text style={{ fontSize: 6.2, color: MUTED, marginTop: 0.5 }}>{`${FLAG_LABEL[l.flag ?? ''] ?? ''}${l.reference ? `  •  ref ${l.reference}` : ''}`}</Text>
                </View>
                <View style={{ alignItems: 'flex-end', marginLeft: 4 }}>
                  <Text style={{ fontSize: 9, fontWeight: 800, color: s.fg }}>{`${s.sym} ${l.value}`}</Text>
                  <Text style={{ fontSize: 5.8, color: MUTED }}>{formatUnit(l.unit)}</Text>
                </View>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function ReportDocument({ d }: { d: ReportData }) {
  const lh = d.variant === 'print' && d.branch.letterhead.enabled;
  const top = lh ? d.branch.letterhead.topMm * MM : null;
  const bottom = lh ? d.branch.letterhead.bottomMm * MM : null;
  const b = d.brand;
  return (
    <Document
      title={`Laboratory report ${d.reportNo}`}
      author={d.branch.name}
      subject={`Report ${d.reportNo} version ${d.version}`}
      style={{ fontFamily: FONT, fontSize: 8, color: INK }}
    >
      <Page
        size="A4"
        margin={{ top: 0, bottom: 0, left: 0, right: 0 } as never}
        {...(!lh && d.branch.backgroundDataUri ? { backgroundImage: d.branch.backgroundDataUri, backgroundSize: 'cover' as const, backgroundOpacity: 0.12 } : {})}
      >
        {d.amended ? <Watermark text="AMENDED" fontSize={80} color="rgba(185,28,28,0.07)" angle={-35} /> : null}
        <LabHeader
          b={d.branch}
          brand={b}
          docTitle="Laboratory report"
          docMeta={[d.reportNo, `Version ${d.version}${d.amended ? ' • amended' : ''}`]}
          blankHeightPt={top}
        />

        <LabFooter brand={b} timings={d.branch.timings} disclaimer={d.branch.disclaimer} docNo={`${d.reportNo} • v${d.version} • ${d.patient.name} • ${d.patient.mrn}`} blankHeightPt={bottom} />

        <View style={{ paddingHorizontal: GUTTER }}>
          <PatientCard d={d} />
          <AbnormalSummary d={d} />

          {d.amended && d.amendmentReasons.length > 0 ? (
            <View wrap={false} style={{ marginTop: 6, borderLeftWidth: 3, borderLeftColor: '#D97706', backgroundColor: '#FFFBEB', borderRadius: 4, padding: 6 }}>
              <Text style={{ fontSize: 8, fontWeight: 800, color: '#B45309' }}>{`AMENDED REPORT • version ${d.version} replaces earlier versions`}</Text>
              {d.amendmentReasons.map((r, i) => (
                <Text key={i} style={{ fontSize: 7.2, color: INK, marginTop: 1 }}>{`• ${r}`}</Text>
              ))}
            </View>
          ) : null}

          {d.sections.map((dept) => (
            <View key={dept.department}>
              {groupTests(dept.tests).map((g, gi) =>
                gi === 0 ? (
                  // The department heading always travels with its first block, never alone at a page bottom.
                  <View key={gi} wrap={false}>
                    <DeptHeader name={dept.department} count={dept.tests.length} brand={b} />
                    <TestBlock name={g.name} lines={g.lines} brand={b} />
                  </View>
                ) : (
                  <TestBlock key={gi} name={g.name} lines={g.lines} brand={b} />
                ),
              )}
            </View>
          ))}

          <View wrap={false} style={{ marginTop: 14 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              {d.incharge ? <SignatureCard s={d.incharge} brand={b} align="left" /> : <View />}
              <View style={{ alignItems: 'flex-end' }}>
                {d.signers.map((s, i) => (
                  <View key={i} style={{ marginTop: i ? 8 : 0 }}>
                    <SignatureCard s={s} brand={b} align="right" />
                  </View>
                ))}
              </View>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 }}>
              <View style={{ flexGrow: 1, height: 0.6, backgroundColor: LINE }} />
              <Text style={{ fontSize: 6.8, color: FAINT, marginHorizontal: 8, letterSpacing: 1.2 }}>END OF REPORT</Text>
              <View style={{ flexGrow: 1, height: 0.6, backgroundColor: LINE }} />
            </View>
            <Text style={{ fontSize: 6.2, color: MUTED, textAlign: 'center', marginTop: 3 }}>
              {`Electronically authorized and issued ${d.issuedAt}. Verify authenticity by scanning the QR code or at ${d.verificationUrl}`}
            </Text>
            {d.branch.footerText ? <Text style={{ fontSize: 6.4, color: MUTED, textAlign: 'center', marginTop: 2 }}>{d.branch.footerText}</Text> : null}
          </View>
        </View>

      </Page>
    </Document>
  );
}

export async function renderReportPdf(data: ReportData): Promise<Uint8Array> {
  registerFonts();
  return renderDocument(<ReportDocument d={data} />);
}
