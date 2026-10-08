export type Sex = 'M' | 'F' | 'O';

export interface RangeRow {
  sex: 'A' | 'M' | 'F';
  age_min_days: number;
  age_max_days: number;
  low: number | null;
  high: number | null;
  text_range: string | null;
  version: number;
}

export type Flag = 'N' | 'L' | 'H' | 'LL' | 'HH' | null;

// Pick the approved range for a patient. Sex-specific beats 'any'; then the narrowest age band wins.
export function selectRange(ranges: RangeRow[], sex: Sex, ageDays: number): RangeRow | null {
  const candidates = ranges.filter(
    (r) => (r.sex === 'A' || r.sex === sex) && ageDays >= r.age_min_days && ageDays <= r.age_max_days,
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const sexScore = (b.sex === 'A' ? 0 : 1) - (a.sex === 'A' ? 0 : 1);
    if (sexScore !== 0) return sexScore;
    return a.age_max_days - a.age_min_days - (b.age_max_days - b.age_min_days);
  });
  return candidates[0]!;
}

export interface FlagResult {
  flag: Flag;
  critical: boolean;
}

// LL/HH are critical (beyond the critical limits). L/H are outside the reference range only.
export function flagNumeric(
  value: number,
  range: { low: number | null; high: number | null } | null,
  critical: { low: number | null; high: number | null },
): FlagResult {
  if (critical.low != null && value <= critical.low) return { flag: 'LL', critical: true };
  if (critical.high != null && value >= critical.high) return { flag: 'HH', critical: true };
  if (range?.low != null && value < range.low) return { flag: 'L', critical: false };
  if (range?.high != null && value > range.high) return { flag: 'H', critical: false };
  return { flag: range ? 'N' : null, critical: false };
}

export function ageSexFromPatient(dob: string | null, ageAtReg: number | null, gender: string): { ageDays: number; sex: Sex } {
  const sex: Sex = gender === 'M' || gender === 'F' ? gender : 'O';
  if (dob) {
    const days = Math.floor((Date.now() - Date.parse(`${dob}T00:00:00Z`)) / 86_400_000);
    return { ageDays: Math.max(0, days), sex };
  }
  return { ageDays: Math.max(0, (ageAtReg ?? 30) * 365), sex };
}
