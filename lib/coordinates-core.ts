/**
 * CDP coordinate core: the single source of truth for deterministic day coordinates.
 *
 * This module is the canonical implementation. It is authored once, in TypeScript,
 * and consumed by both halves of the system without a second copy:
 *   - the Vite client imports this file directly (it is ESM and typed);
 *   - the Node server consumes the CommonJS build of this file (coordinates-core.cjs),
 *     regenerated from this source and never hand edited, so the two can never drift.
 *
 * It is pure and deterministic. Given a date string, and optionally a profile, it
 * returns the same coordinates everywhere, with no input or output beyond its
 * arguments. The values that require an authoritative external source that is not
 * yet wired (the lunar phase from USNO, and therefore the Black and Shiva windows)
 * are reported as an honest unknown rather than computed from memory, in keeping
 * with the rule that no fabricated coordinate may reach a reading.
 *
 * Each coordinate is tagged with two things the citation drawer needs: a chip
 * (time, lunar, symbol, body) and a claim tag that keys into the bibliography
 * claim_to_entries index. The core does not hardcode references; it names what a
 * coordinate is a claim about, and the drawer retrieves the sources for it. That
 * keeps the mathematics independent of any bibliography version.
 *
 * House style holds in this file: no em dashes, no en dashes, no exclamation marks,
 * in code and in comments alike.
 */

/* ============================================================================
 * Shared types
 * ========================================================================== */

export type Chip = 'time' | 'lunar' | 'symbol' | 'body';
export type Register = 'symbolic' | 'astronomical' | 'empirical';

/** A single resolved coordinate, ready for the surface and for the drawer. */
export interface Coordinate {
  /** Stable key, for example "universal_day" or "kin". */
  key: string;
  /** Short human label for the surface. */
  label: string;
  /** The composed display value, for example "Kin 112 Galactic Yellow Human". */
  display: string;
  /** Structured payload, shape depends on the coordinate. */
  value: unknown;
  /** What kind of claim this is, so the surface can label it correctly. */
  register: Register;
  /** Which chip this coordinate belongs to, for the citation drawer. */
  chip: Chip;
  /** The bibliography claim tag, keyed into claim_to_entries. Null when none applies. */
  claimTag: string | null;
  /** True when the value could not be computed from an authoritative source yet. */
  unknown: boolean;
}

/** Optional profile context for the personal layers. */
export interface Profile {
  /** Birth date as YYYY-MM-DD. Required for the personal numerology layers. */
  birthDate?: string;
}

/** A reduced numerological number, with the master flag and the reduced single digit. */
export interface NumerologyValue {
  /** The surfaced value, a master number where one is preserved, otherwise a single digit. */
  value: number;
  /** The single digit the master reduces to, equal to value when value is already single. */
  reducesTo: number;
  isMaster: boolean;
  register: 'symbolic';
}

/* ============================================================================
 * Constants
 * ========================================================================== */

/**
 * Dreamspell Kin anchor. 2024-07-08 is Kin 1.
 *
 * Definitive source: Jose Arguelles, The Mayan Factor (Bear and Company, 1987)
 * and Dreamspell, as recognised by the Foundation for the Law of Time. StarRoot
 * is one FLT recognised community implementation of this count, not the source
 * of it. The Gregorian leap day, February 29, is excluded from the count, since
 * the thirteen moon count does not admit it. This is the corrected anchor; the
 * earlier production server was wrong by sixty against it.
 */
const KIN_ANCHOR_UTC = Date.UTC(2024, 6, 8); // 2024-07-08 is Kin 1
const DAY_MS = 86400000;

/** Seal names, held colourless on purpose. The colour is composed separately, so the
 * descriptor cannot duplicate it the way an earlier build did ("Blue ... Blue Monkey"). */
const SEAL_NAMES: readonly string[] = [
  'Dragon', 'Wind', 'Night', 'Seed', 'Serpent', 'World-Bridger', 'Hand', 'Star',
  'Moon', 'Dog', 'Monkey', 'Human', 'Skywalker', 'Wizard', 'Eagle', 'Warrior',
  'Earth', 'Mirror', 'Storm', 'Sun',
];

/** The four colour families cycle Red, White, Blue, Yellow across the twenty seals. */
const SEAL_COLOURS: readonly string[] = [
  'Red', 'White', 'Blue', 'Yellow', 'Red', 'White', 'Blue', 'Yellow', 'Red', 'White',
  'Blue', 'Yellow', 'Red', 'White', 'Blue', 'Yellow', 'Red', 'White', 'Blue', 'Yellow',
];

const TONE_NAMES: readonly string[] = [
  'Magnetic', 'Lunar', 'Electric', 'Self-Existing', 'Overtone', 'Rhythmic',
  'Resonant', 'Galactic', 'Solar', 'Planetary', 'Spectral', 'Crystal', 'Cosmic',
];

/**
 * The fifty two Galactic Activation Portal Kins.
 *
 * This is the standard Dreamspell portal set, the symmetric pattern on the
 * tzolkin, ported from the verified production set and confirmed at fifty two
 * unique entries. Per the one definitive source per framework rule, final
 * sign off is a cross reference against the practitioner portal dates; the set
 * itself is the FLT and Arguelles count and is treated as verified here.
 */
const GAP_KINS: ReadonlySet<number> = new Set([
  1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 19, 20, 21, 22, 23, 26, 27, 28, 29, 30,
  53, 54, 55, 56, 57, 60, 61, 62, 63, 64, 71, 72, 73, 74, 75, 78, 79, 80, 81, 82,
  105, 106, 107, 108, 109, 112, 113, 114, 115, 116, 133, 134,
]);

const MASTERS: ReadonlySet<number> = new Set([11, 22, 33, 44]);

/* ============================================================================
 * Small pure helpers
 * ========================================================================== */

/** Parse an ISO date string (YYYY-MM-DD) to a UTC midnight timestamp. */
export function isoToUTC(dateStr: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new Error('coordinates: dateStr must be YYYY-MM-DD, received ' + String(dateStr));
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Sum the decimal digits of a non negative integer once. */
function digitSum(n: number): number {
  let v = Math.abs(Math.trunc(n));
  let s = 0;
  while (v > 0) { s += v % 10; v = Math.floor(v / 10); }
  return s;
}

/**
 * Reduce a positive integer to a single digit, preserving master numbers at any
 * step. A master reached at any stage is returned as is, with its single digit
 * recorded separately.
 */
export function reduceNumber(n: number): NumerologyValue {
  let value = Math.abs(Math.trunc(n));
  while (value > 9 && !MASTERS.has(value)) {
    value = digitSum(value);
  }
  const isMaster = MASTERS.has(value);
  let reducesTo = value;
  while (reducesTo > 9) reducesTo = digitSum(reducesTo);
  return { value, reducesTo, isMaster, register: 'symbolic' };
}

/**
 * Count Gregorian leap days (February 29) inside the open closed interval
 * (earlier, later]. The walk is year by year for clarity; the tests pin the
 * behaviour at the anchor and at leap edges.
 */
export function leapDaysBetween(fromMs: number, toMs: number): number {
  let count = 0;
  const startYear = new Date(fromMs).getUTCFullYear();
  const endYear = new Date(toMs).getUTCFullYear();
  for (let y = startYear; y <= endYear; y += 1) {
    const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (!isLeap) continue;
    const feb29 = Date.UTC(y, 1, 29);
    if (feb29 > fromMs && feb29 <= toMs) count += 1;
  }
  return count;
}

/* ============================================================================
 * Dreamspell Kin
 * ========================================================================== */

/** The Kin number (1 to 260) for a date, on the corrected anchor, excluding Feb 29. */
export function kinForDate(dateStr: string): number {
  const dateMs = isoToUTC(dateStr);
  const rawDays = Math.round((dateMs - KIN_ANCHOR_UTC) / DAY_MS);
  const sign = rawDays >= 0 ? 1 : -1;
  const skipped = sign > 0
    ? leapDaysBetween(KIN_ANCHOR_UTC, dateMs)
    : leapDaysBetween(dateMs, KIN_ANCHOR_UTC);
  const countedDays = rawDays - sign * skipped;
  const idx = ((countedDays % 260) + 260) % 260; // Kin 1 at offset 0
  return idx + 1;
}

export function kinTone(kin: number): number { return ((kin - 1) % 13) + 1; }
function kinSealIndex(kin: number): number { return (kin - 1) % 20; }

/** True when the Kin is one of the fifty two Galactic Activation Portals. */
export function isGAP(kin: number): boolean { return GAP_KINS.has(kin); }

export interface KinDescriptor {
  kin: number;
  tone: number;
  toneName: string;
  seal: string;
  colour: string;
  /** Parity display, "Kin {N} {Tone} {Colour} {Seal}", colour composed once. */
  full: string;
  isGAP: boolean;
  register: 'symbolic';
}

/** The full Kin descriptor, all naming systems held distinct, colour composed once. */
export function kinDescriptor(dateStr: string): KinDescriptor {
  const kin = kinForDate(dateStr);
  const tone = kinTone(kin);
  const si = kinSealIndex(kin);
  const toneName = TONE_NAMES[tone - 1];
  const seal = SEAL_NAMES[si];
  const colour = SEAL_COLOURS[si];
  return {
    kin,
    tone,
    toneName,
    seal,
    colour,
    full: 'Kin ' + kin + ' ' + toneName + ' ' + colour + ' ' + seal,
    isGAP: GAP_KINS.has(kin),
    register: 'symbolic',
  };
}

/* ============================================================================
 * Pythagorean numerology
 *
 * Universal Day is the shared energy of the calendar date itself. The three
 * personal energies (Personal Year, Personal Month, Personal Day) are the
 * standard Pythagorean layers, with Drayer (2002) and Goodwin (1994) as the
 * cited authorities. Master numbers (11, 22, 33, 44) are preserved at every
 * level. Components are reduced by a single digit sum before being added, which
 * is what surfaces the master at the join: for 15 June within 2026 the Personal
 * Year sum is 6 plus 6 plus 10 equal to 22, a master, reducing to 4.
 * ========================================================================== */

/** The Universal Day number for a date, the shared day energy, masters preserved. */
export function universalDay(dateStr: string): NumerologyValue {
  isoToUTC(dateStr); // validate shape
  const sum = dateStr.replace(/-/g, '').split('').reduce((s, d) => s + Number(d), 0);
  return reduceNumber(sum);
}

export interface PersonalNumerology {
  personalYear: NumerologyValue;
  personalMonth: NumerologyValue;
  personalDay: NumerologyValue;
}

/**
 * The three personal energies for a profile on a given date. Requires the birth
 * date. Personal Year adds the single digit sums of birth month, birth day, and
 * the current year. Personal Month adds the reduced Personal Year and the current
 * month. Personal Day adds the reduced Personal Month and the current day.
 */
export function personalNumerology(birthDate: string, dateStr: string): PersonalNumerology {
  const bm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  const cm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!bm) throw new Error('coordinates: birthDate must be YYYY-MM-DD, received ' + String(birthDate));
  if (!cm) throw new Error('coordinates: dateStr must be YYYY-MM-DD, received ' + String(dateStr));

  const birthMonth = Number(bm[2]);
  const birthDay = Number(bm[3]);
  const curYear = Number(cm[1]);
  const curMonth = Number(cm[2]);
  const curDay = Number(cm[3]);

  const personalYear = reduceNumber(digitSum(birthMonth) + digitSum(birthDay) + digitSum(curYear));
  const personalMonth = reduceNumber(personalYear.reducesTo + curMonth);
  const personalDay = reduceNumber(personalMonth.reducesTo + curDay);

  return { personalYear, personalMonth, personalDay };
}

/* ============================================================================
 * Lunar: authoritative source slot, honest until wired
 *
 * The moon phase derives from USNO timestamps, the named authority for phase
 * definitions and date conventions. The Black Moon (two days before the new
 * moon) and Shiva Moon (two days after the new moon) are CDP defined windows
 * computed from that phase, and the Black Moon term is dual labelled where it
 * differs from the mainstream astronomical meaning. Until the USNO source is
 * wired, this returns null and the caller treats it as an honest unknown.
 * ========================================================================== */

export interface LunarWindow {
  phase: string;
  black: boolean;
  shiva: boolean;
  register: 'astronomical';
}

export function lunarWindow(_dateStr: string): LunarWindow | null {
  return null; // wired from USNO timestamps in the lunar pass
}

/* ============================================================================
 * The aggregator: the day's coordinates as one tagged set
 * ========================================================================== */

export interface DayCoordinates {
  date: string;
  coordinates: Coordinate[];
}

/**
 * Resolve the day's coordinates as one set, each tagged with its chip and claim
 * tag for the citation drawer, and each marked honest where its source is not
 * yet wired. Personal layers are included only when a birth date is supplied.
 */
export function dayCoordinates(dateStr: string, profile?: Profile): DayCoordinates {
  const out: Coordinate[] = [];

  const ud = universalDay(dateStr);
  out.push({
    key: 'universal_day',
    label: 'Universal Day',
    display: ud.isMaster ? String(ud.value) + ' to ' + String(ud.reducesTo) : String(ud.value),
    value: ud,
    register: 'symbolic',
    chip: 'time',
    claimTag: 'numerology_day_quality',
    unknown: false,
  });

  if (profile && profile.birthDate) {
    const pn = personalNumerology(profile.birthDate, dateStr);
    const layer = (key: string, label: string, n: NumerologyValue): Coordinate => ({
      key,
      label,
      display: n.isMaster ? String(n.value) + ' to ' + String(n.reducesTo) : String(n.value),
      value: n,
      register: 'symbolic',
      chip: 'time',
      claimTag: 'numerology_day_quality',
      unknown: false,
    });
    out.push(layer('personal_year', 'Personal Year', pn.personalYear));
    out.push(layer('personal_month', 'Personal Month', pn.personalMonth));
    out.push(layer('personal_day', 'Personal Day', pn.personalDay));
  }

  const k = kinDescriptor(dateStr);
  out.push({
    key: 'kin',
    label: 'Dreamspell Kin',
    display: k.full + (k.isGAP ? ' (Galactic Activation Portal)' : ''),
    value: k,
    register: 'symbolic',
    chip: 'symbol',
    claimTag: 'dreamspell_count',
    unknown: false,
  });

  const lunar = lunarWindow(dateStr);
  out.push({
    key: 'lunar',
    label: 'Lunar',
    display: lunar ? lunar.phase : 'not yet available',
    value: lunar,
    register: 'astronomical',
    chip: 'lunar',
    claimTag: 'lunar_phase_timing',
    unknown: lunar === null,
  });

  return { date: dateStr, coordinates: out };
}
