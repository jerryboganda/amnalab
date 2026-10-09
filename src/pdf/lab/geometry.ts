// Pure helpers for the document design (no JSX, so unit tests can import them).

// Mixes a hex colour with white; t=0 keeps the colour, t=1 is white.
export function tint(hex: string, t: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const mix = (c: number) => Math.round(c + (255 - c) * t);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export const safeColor = (v: string | null | undefined, fallback: string) => (v && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback);

export interface RangeGeometry {
  bandStart: number;
  bandEnd: number;
  marker: number;
  clamped: 'low' | 'high' | null;
}

/** Positions (0..width) of the normal band and the value marker. Values outside the scale are clamped to the edge. */
export function rangeGeometry(value: number, low: number | null, high: number | null, width: number): RangeGeometry | null {
  if (!Number.isFinite(value) || (low == null && high == null)) return null;
  let min: number;
  let max: number;
  if (low != null && high != null && high > low) {
    const span = high - low;
    min = low - span * 0.6;
    max = high + span * 0.6;
    if (low >= 0 && min < 0) min = 0;
  } else if (high != null) {
    min = 0;
    max = high * 1.6 || 1;
  } else {
    min = 0;
    max = (low as number) * 2 || 1;
  }
  const x = (v: number) => ((v - min) / (max - min)) * width;
  const bandStart = low != null ? Math.max(0, x(low)) : 0;
  const bandEnd = high != null ? Math.min(width, x(high)) : width;
  const raw = x(value);
  const clamped = raw < 0 ? 'low' : raw > width ? 'high' : null;
  return { bandStart, bandEnd, marker: Math.min(width, Math.max(0, raw)), clamped };
}

