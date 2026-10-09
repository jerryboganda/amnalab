// Amna Lab document design kit: fonts, colours and the graphical building blocks shared by
// the lab report and the invoice. Built on Forme primitives (the engine pdfcn uses).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { Fixed, Font, Image, QrCode, Text, View } from '@formepdf/react';
import { Svg } from '../lib/pdf-svg.tsx';
import { rangeGeometry, safeColor, tint } from './geometry.ts';
export { rangeGeometry, safeColor, tint };
export type { RangeGeometry } from './geometry.ts';

// ---- Fonts. Inter (SIL OFL) lives in assets/fonts; the path differs between source and the bundle.
let fontsReady = false;
export function registerFonts(): void {
  if (fontsReady) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = [join(here, '..', 'assets', 'fonts'), join(here, '..', '..', 'assets', 'fonts'), join(here, '..', '..', '..', 'assets', 'fonts')].find((d) =>
    existsSync(join(d, 'Inter-Regular.ttf')),
  );
  if (!dir) return; // falls back to Helvetica
  for (const [weight, file] of [
    [400, 'Regular'],
    [500, 'Medium'],
    [600, 'SemiBold'],
    [700, 'Bold'],
    [800, 'ExtraBold'],
  ] as const) {
    Font.register({ family: 'Inter', src: readFileSync(join(dir, `Inter-${file}.ttf`)), fontWeight: weight });
  }
  fontsReady = true;
}
export const FONT = 'Inter';

// ---- Colours
export const INK = '#0F172A';
export const MUTED = '#64748B';
export const FAINT = '#94A3B8';
export const LINE = '#E2E8F0';
export const SOFT = '#F8FAFC';
export const FLAG = {
  low: { fg: '#1D4ED8', bg: '#DBEAFE', sym: '▼' },
  high: { fg: '#B45309', bg: '#FEF3C7', sym: '▲' },
  critical: { fg: '#B91C1C', bg: '#FEE2E2', sym: '◆' },
  normal: { fg: '#64748B', bg: '#F1F5F9', sym: '●' },
};

export interface Brand {
  primary: string;
  secondary: string;
}

// ---- Flag helpers
export type FlagCode = 'LL' | 'L' | 'N' | 'H' | 'HH' | null;
export function flagStyle(code: FlagCode) {
  if (code === 'LL' || code === 'HH') return FLAG.critical;
  if (code === 'L') return FLAG.low;
  if (code === 'H') return FLAG.high;
  return FLAG.normal;
}
export const FLAG_LABEL: Record<string, string> = { LL: 'Critical low', HH: 'Critical high', L: 'Low', H: 'High', N: 'Normal' };

export function FlagChip({ code }: { code: FlagCode }) {
  if (!code) return null;
  const s = flagStyle(code);
  const label = code === 'N' ? 'N' : code;
  return (
    <View style={{ backgroundColor: s.bg, borderRadius: 9999, paddingHorizontal: 5, paddingVertical: 1, alignSelf: 'flex-start' }}>
      <Text style={{ color: s.fg, fontSize: 7, fontWeight: 700 }}>{`${s.sym} ${label}`}</Text>
    </View>
  );
}

// ---- Range bar: where the value sits against the reference interval.
export function RangeBar({
  value,
  low,
  high,
  code,
  width = 84,
  brand,
}: {
  value: number | null;
  low: number | null;
  high: number | null;
  code: FlagCode;
  width?: number;
  brand: Brand;
}) {
  if (value == null) return null;
  const g = rangeGeometry(value, low, high, width - 8);
  if (!g) return null;
  const s = flagStyle(code);
  const off = 4; // room for the marker at the edges
  const h = 12;
  return (
    <Svg width={width} height={h}>
      <rect x={off} y={4} width={width - 8} height={4} fill="#E5E7EB" />
      <rect x={off + g.bandStart} y={3} width={Math.max(1.5, g.bandEnd - g.bandStart)} height={6} fill={tint(brand.primary, 0.72)} />
      {g.clamped === 'low' ? (
        <path d={`M${off} 6 L${off + 6} 2 L${off + 6} 10 Z`} fill={s.fg} />
      ) : g.clamped === 'high' ? (
        <path d={`M${off + width - 8} 6 L${off + width - 14} 2 L${off + width - 14} 10 Z`} fill={s.fg} />
      ) : (
        <>
          <circle cx={off + g.marker} cy={6} r={3.6} fill="#FFFFFF" />
          <circle cx={off + g.marker} cy={6} r={2.8} fill={s.fg} />
        </>
      )}
    </Svg>
  );
}

// ---- Trend sparkline: earlier values plus the current one (highlighted).
export function Sparkline({
  points,
  current,
  code,
  brand,
  width = 40,
  height = 14,
}: {
  points: number[];
  current: number;
  code: FlagCode;
  brand: Brand;
  width?: number;
  height?: number;
}) {
  const all = [...points, current];
  if (all.length < 2) return null;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const pad = 2.5;
  const xs = (i: number) => pad + (i / (all.length - 1)) * (width - pad * 2);
  const ys = (v: number) => (max === min ? height / 2 : pad + (1 - (v - min) / (max - min)) * (height - pad * 2));
  const d = all.map((v, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)} ${ys(v).toFixed(1)}`).join(' ');
  const s = flagStyle(code);
  return (
    <Svg width={width} height={height}>
      <path d={d} fill="none" stroke={tint(brand.primary, 0.25)} stroke-width={1.2} />
      {points.map((v, i) => (
        <circle key={i} cx={xs(i)} cy={ys(v)} r={1.3} fill={tint(brand.primary, 0.35)} />
      ))}
      <circle cx={xs(all.length - 1)} cy={ys(current)} r={2.2} fill={code && code !== 'N' ? s.fg : brand.primary} />
    </Svg>
  );
}

// ---- Department icons (14x14 viewBox, drawn in white on a coloured disc)
const ICONS: Array<{ match: RegExp; color: string; path: string }> = [
  { match: /hemat|haemat|blood bank/i, color: '#C8102E', path: 'M7 1.2 L11 7.5 C12.6 10.2 10.6 13 7 13 C3.4 13 1.4 10.2 3 7.5 Z' },
  { match: /coag/i, color: '#DC2626', path: 'M7 1.2 L11 7.5 C12.6 10.2 10.6 13 7 13 C3.4 13 1.4 10.2 3 7.5 Z M5 9 H9 V10.4 H5 Z' },
  { match: /endocr|hormon/i, color: '#7C3AED', path: 'M7 1 L12.2 4 L12.2 10 L7 13 L1.8 10 L1.8 4 Z' },
  { match: /sero|immun/i, color: '#0D9488', path: 'M7 1 L12 3 V7 C12 10 9.8 12.2 7 13 C4.2 12.2 2 10 2 7 V3 Z' },
  { match: /micro|cultur/i, color: '#15803D', path: 'M1.5 5 H12.5 V6.5 H1.5 Z M2.5 6.5 H11.5 L10.5 12 H3.5 Z' },
  { match: /clinical path|urine|stool|fluid/i, color: '#B45309', path: 'M3 1.5 H11 V3 H10 L10.6 12.5 H3.4 L4 3 H3 Z' },
  { match: /tumou?r|onco|marker/i, color: '#BE185D', path: 'M7 1 C9.5 1 10 3.5 8.6 6 L12 12.5 H9.8 L7 7.6 L4.2 12.5 H2 L5.4 6 C4 3.5 4.5 1 7 1 Z' },
  { match: /.*/, color: '#1F5FAE', path: 'M5 1 H9 V2.4 H8.4 V5.2 L12.2 11.6 C12.6 12.4 12.1 13 11.3 13 H2.7 C1.9 13 1.4 12.4 1.8 11.6 L5.6 5.2 V2.4 H5 Z' },
];
export function deptStyle(name: string, brand: Brand) {
  const hit = ICONS.find((i) => i.match.test(name))!;
  return { color: hit.match.source === '.*' ? brand.primary : hit.color, path: hit.path };
}

export function DeptHeader({ name, count, brand }: { name: string; count: number; brand: Brand }) {
  const d = deptStyle(name, brand);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: tint(d.color, 0.9),
        borderLeftWidth: 3,
        borderLeftColor: d.color,
        borderRadius: 4,
        paddingVertical: 4,
        paddingHorizontal: 6,
        marginTop: 9,
        marginBottom: 3,
      }}
    >
      <Svg width={18} height={18} viewBox="-2 -2 18 18">
        <circle cx={7} cy={7} r={9} fill={d.color} />
        <path d={d.path} fill="#FFFFFF" />
      </Svg>
      <Text style={{ marginLeft: 6, fontSize: 9.5, fontWeight: 800, color: d.color, letterSpacing: 0.8, textTransform: 'uppercase' }}>{name}</Text>
      <View style={{ flexGrow: 1 }} />
      <Text style={{ fontSize: 7, color: MUTED }}>{`${count} ${count === 1 ? 'test' : 'tests'}`}</Text>
    </View>
  );
}

// ---- Vector "AC" monogram used when the branch has not uploaded a logo.
export function Monogram({ size = 52, brand, initials }: { size?: number; brand: Brand; initials: string }) {
  const s = size / 60;
  const first = initials.slice(0, 1).toUpperCase();
  if (first !== 'A') {
    return (
      <View style={{ width: size, height: size, borderRadius: 9999, backgroundColor: brand.primary, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#FFFFFF', fontWeight: 800, fontSize: size * 0.38 }}>{initials.slice(0, 2).toUpperCase()}</Text>
      </View>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 60 60">
      <rect x={0} y={0} width={60} height={60} fill="#FFFFFF" />
      <path d="M4 52 L22 8 L31 8 L46 45 L38 45 L26.5 16 L13 52 Z" fill={brand.primary} />
      <path d="M17 38 L37 38 L34.5 32 L19.5 32 Z" fill={brand.primary} />
      <path
        d={`M56 18 C51 9 39 6 31 12 L35 17 C40 13 48 14 51 21 Z M51 39 C48 46 40 47 35 43 L31 48 C39 54 51 51 56 42 Z`}
        fill={brand.secondary}
      />
      <path d="M42 30 C42 25 44 21 47 19 L51 21 C48 23 47 26 47 30 C47 34 48 37 51 39 L47 41 C44 39 42 35 42 30 Z" fill={brand.secondary} />
    </Svg>
  );
}

// ---- Letterhead. `blank` keeps the space for pre-printed paper.
export interface LetterheadBranch {
  name: string;
  motto: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  headerText: string | null;
  logoDataUri: string | null;
}

export const PAGE_W = 595;
export const GUTTER = 28;

export function LabHeader({
  b,
  brand,
  docTitle,
  docMeta,
  blankHeightPt,
}: {
  b: LetterheadBranch;
  brand: Brand;
  docTitle: string;
  docMeta: string[];
  blankHeightPt: number | null;
}) {
  if (blankHeightPt != null) {
    return (
      <Fixed position="header">
        <View style={{ height: blankHeightPt }} />
      </Fixed>
    );
  }
  const contact = [b.address, b.phone ? `Ph: ${b.phone}` : null, b.email].filter(Boolean).join('   •   ');
  return (
    <Fixed position="header">
      <View style={{ width: PAGE_W }}>
        <View style={{ height: 4, background: `linear-gradient(90deg, ${brand.primary}, ${brand.secondary})` }} />
        <Svg width={PAGE_W} height={34} style={{ position: 'absolute', top: 4, left: 0 }}>
          <path d="M0 0 L64 0 L0 30 Z" fill={tint(brand.primary, 0.55)} />
          <path d="M0 0 L28 0 L0 13 Z" fill={brand.primary} />
          <path d={`M${PAGE_W} 0 L${PAGE_W - 64} 0 L${PAGE_W} 30 Z`} fill={tint(brand.secondary, 0.6)} />
          <path d={`M${PAGE_W} 0 L${PAGE_W - 28} 0 L${PAGE_W} 13 Z`} fill={brand.secondary} />
        </Svg>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: GUTTER + 6, paddingTop: 12, paddingBottom: 8 }}>
          {b.logoDataUri ? <Image src={b.logoDataUri} height={52} style={{ maxWidth: 170 }} /> : <Monogram brand={brand} initials={b.name} />}
          <View style={{ marginLeft: 10, flexGrow: 1 }}>
            <Text style={{ fontSize: 19, fontWeight: 800, color: brand.primary, letterSpacing: 0.4 }}>{b.name.toUpperCase()}</Text>
            {b.motto ? (
              <View style={{ flexDirection: 'row', marginTop: 3 }}>
                <View style={{ borderWidth: 0.8, borderColor: brand.secondary, borderRadius: 9999, paddingHorizontal: 7, paddingVertical: 1 }}>
                  <Text style={{ fontSize: 6.8, fontWeight: 700, color: brand.secondary, letterSpacing: 1.1 }}>{b.motto.toUpperCase()}</Text>
                </View>
              </View>
            ) : null}
            {b.headerText ? <Text style={{ fontSize: 7, color: MUTED, marginTop: 3 }}>{b.headerText}</Text> : null}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ fontSize: 7, fontWeight: 700, color: MUTED, letterSpacing: 1.4 }}>{docTitle.toUpperCase()}</Text>
            {docMeta.map((m, i) => (
              <Text key={i} style={{ fontSize: i === 0 ? 10 : 7, fontWeight: i === 0 ? 800 : 500, color: i === 0 ? INK : MUTED, marginTop: 1 }}>
                {m}
              </Text>
            ))}
          </View>
        </View>
        {contact ? (
          <View style={{ backgroundColor: brand.secondary, paddingVertical: 3.5, paddingHorizontal: GUTTER + 6 }}>
            <Text style={{ fontSize: 7.4, fontWeight: 600, color: '#FFFFFF', textAlign: 'center' }}>{contact}</Text>
          </View>
        ) : (
          <View style={{ height: 2, backgroundColor: brand.secondary }} />
        )}
        <View style={{ height: 8 }} />
      </View>
    </Fixed>
  );
}

export function LabFooter({
  brand,
  timings,
  disclaimer,
  docNo,
  blankHeightPt,
}: {
  brand: Brand;
  timings: string | null;
  disclaimer: string | null;
  docNo: string;
  blankHeightPt: number | null;
}) {
  const pageLine = (
    <View style={{ flexDirection: 'row', paddingHorizontal: GUTTER + 6, paddingVertical: 3 }}>
      <Text style={{ fontSize: 6.5, color: FAINT }}>{docNo}</Text>
      <View style={{ flexGrow: 1 }} />
      <Text style={{ fontSize: 6.5, color: FAINT }}>{'Page {{pageNumber}} of {{totalPages}}'}</Text>
    </View>
  );
  if (blankHeightPt != null) {
    return (
      <Fixed position="footer">
        <View style={{ width: PAGE_W }}>
          {pageLine}
          <View style={{ height: blankHeightPt }} />
        </View>
      </Fixed>
    );
  }
  return (
    <Fixed position="footer">
      <View style={{ width: PAGE_W }}>
        {disclaimer ? (
          <View style={{ paddingHorizontal: GUTTER + 20, marginBottom: 3 }}>
            <Text style={{ fontSize: 6.2, color: MUTED, textAlign: 'center', lineHeight: 1.35 }}>{disclaimer}</Text>
          </View>
        ) : null}
        {timings ? (
          <View style={{ background: `linear-gradient(90deg, ${brand.primary}, ${tint(brand.primary, 0.2)})`, paddingVertical: 4, paddingHorizontal: GUTTER + 6 }}>
            <Text style={{ fontSize: 7.6, fontWeight: 700, color: '#FFFFFF', textAlign: 'center' }}>{timings}</Text>
          </View>
        ) : (
          <View style={{ height: 2, backgroundColor: brand.primary }} />
        )}
        {pageLine}
      </View>
    </Fixed>
  );
}

// ---- Small layout helpers
export function Label({ children }: { children: ReactNode }) {
  return <Text style={{ fontSize: 6.3, fontWeight: 700, color: FAINT, letterSpacing: 0.9, textTransform: 'uppercase' }}>{children}</Text>;
}

export function KV({ k, v, width, strong }: { k: string; v: string; width: number; strong?: boolean }) {
  return (
    <View style={{ width, marginBottom: 4 }}>
      <Label>{k}</Label>
      <Text style={{ fontSize: 8.3, fontWeight: strong ? 700 : 500, color: INK, marginTop: 0.5 }}>{v}</Text>
    </View>
  );
}

export function VerifyQr({ url, code, brand, size = 54 }: { url: string; code: string; brand: Brand; size?: number }) {
  return (
    <View style={{ alignItems: 'center', width: size + 10 }}>
      <QrCode data={url} size={size} color={INK} />
      <Text style={{ fontSize: 5.8, color: MUTED, marginTop: 2 }}>Scan to verify</Text>
      <Text style={{ fontSize: 6, fontWeight: 700, color: brand.primary }}>{code}</Text>
    </View>
  );
}

export interface SignerView {
  label: string;
  name: string;
  qualifications: string | null;
  signatureDataUri: string | null;
  note: string | null;
}

export function SignatureCard({ s, brand, align }: { s: SignerView; brand: Brand; align: 'left' | 'right' }) {
  const items = align === 'right' ? 'flex-end' : 'flex-start';
  return (
    <View style={{ width: 200, alignItems: items }}>
      <View style={{ height: 34, justifyContent: 'flex-end', alignItems: items }}>
        {s.signatureDataUri ? <Image src={s.signatureDataUri} height={32} /> : null}
      </View>
      <View style={{ width: 150, height: 0.8, backgroundColor: LINE, marginVertical: 2 }} />
      <Text style={{ fontSize: 9, fontWeight: 800, color: brand.primary }}>{s.name}</Text>
      {s.qualifications ? <Text style={{ fontSize: 6.8, color: INK, textAlign: align }}>{s.qualifications}</Text> : null}
      <Text style={{ fontSize: 6.3, fontWeight: 700, color: brand.secondary, letterSpacing: 0.8, marginTop: 1 }}>{s.label.toUpperCase()}</Text>
      {s.note ? <Text style={{ fontSize: 6, color: MUTED }}>{s.note}</Text> : null}
    </View>
  );
}
