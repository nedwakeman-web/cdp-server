'use strict';

/**
 * CDP coordinates engine.
 *
 * Pure, deterministic day coordinates for the Tradition lens. Two engines are
 * implemented and tested here: the Dreamspell Kin on the corrected anchor, and
 * Pythagorean numerology with master numbers preserved. The lunar windows and
 * the Galactic Activation Portal set are scaffolded against their authoritative
 * sources and are wired in the next pass, because each has a correctness rule
 * that must not be guessed: the moon phase is taken from USNO timestamps, and
 * the fifty-two portal Kins are taken from the verified portal set rather than
 * reconstructed from memory. Where a value is not yet computed, the caller is
 * told so plainly rather than shown a fabricated number.
 *
 * All date construction is UTC, to match the date discipline everywhere else.
 * CommonJS, so it drops into the existing cdp-server without a module change.
 */

/* --------------------------------------------------------------------------
 * Dreamspell Kin
 *
 * Correct anchor: 2024-07-08 is Kin 1 (Law of Time, StarRoot reference). The
 * Gregorian leap day, February 29, is excluded from the count, because the
 * thirteen-moon count does not admit it. The production server was wrong by
 * sixty against this anchor; this function is the fix, proven by the tests.
 * ------------------------------------------------------------------------ */

const KIN_ANCHOR_UTC = Date.UTC(2024, 6, 8); // 2024-07-08, Kin 1
const DAY_MS = 86400000;

const SEAL_NAMES = [
  'Dragon', 'Wind', 'Night', 'Seed', 'Serpent', 'World-Bridger', 'Hand', 'Star',
  'Moon', 'Dog', 'Monkey', 'Human', 'Skywalker', 'Wizard', 'Eagle', 'Warrior',
  'Earth', 'Mirror', 'Storm', 'Sun',
];

const TONE_NAMES = [
  'Magnetic', 'Lunar', 'Electric', 'Self-Existing', 'Overtone', 'Rhythmic',
  'Resonant', 'Galactic', 'Solar', 'Planetary', 'Spectral', 'Crystal', 'Cosmic',
];

/** Count Gregorian leap days (February 29) strictly between two UTC day numbers, inclusive of the later date's own Feb 29. */
function leapDaysBetween(fromMs, toMs) {
  // Walk year by year and add a Feb 29 only when it falls inside the open-closed
  // interval (anchor, date]. The interval is small in practice; clarity beats
  // cleverness here, and the tests pin the behaviour.
  let count = 0;
  const start = new Date(fromMs);
  const end = new Date(toMs);
  const startYear = start.getUTCFullYear();
  const endYear = end.getUTCFullYear();
  for (let y = startYear; y <= endYear; y += 1) {
    const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (!isLeap) continue;
    const feb29 = Date.UTC(y, 1, 29);
    if (feb29 > fromMs && feb29 <= toMs) count += 1;
  }
  return count;
}

/** Parse an ISO date string (YYYY-MM-DD) to a UTC midnight timestamp. */
function isoToUTC(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new Error('coordinates: dateStr must be YYYY-MM-DD, received ' + String(dateStr));
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** The Kin number (1 to 260) for a date, on the corrected anchor, excluding Feb 29. */
function kinForDate(dateStr) {
  const dateMs = isoToUTC(dateStr);
  const rawDays = Math.round((dateMs - KIN_ANCHOR_UTC) / DAY_MS);
  const sign = rawDays >= 0 ? 1 : -1;
  const skipped =
    sign > 0
      ? leapDaysBetween(KIN_ANCHOR_UTC, dateMs)
      : leapDaysBetween(dateMs, KIN_ANCHOR_UTC);
  const countedDays = rawDays - sign * skipped;
  // Kin 1 at offset 0; positive modulo so dates before the anchor also resolve.
  const idx = ((countedDays % 260) + 260) % 260;
  return idx + 1;
}

function kinTone(kin) {
  return ((kin - 1) % 13) + 1;
}

function kinSealIndex(kin) {
  return (kin - 1) % 20; // 0 to 19
}

/** A full descriptor of the Kin, all three naming systems held distinct. */
function kinDescriptor(dateStr) {
  const kin = kinForDate(dateStr);
  const tone = kinTone(kin);
  const sealIndex = kinSealIndex(kin);
  return {
    kin,
    tone,
    toneName: TONE_NAMES[tone - 1],
    sealName: SEAL_NAMES[sealIndex],
    full: TONE_NAMES[tone - 1] + ' ' + SEAL_NAMES[sealIndex] + ' (Kin ' + kin + ')',
    register: 'symbolic',
  };
}

/* --------------------------------------------------------------------------
 * Pythagorean numerology
 *
 * Master numbers (11, 22, 33, 44) are preserved and never reduced. The
 * Universal Day is the digit sum of the full date, reduced under that rule.
 * ------------------------------------------------------------------------ */

const MASTERS = new Set([11, 22, 33, 44]);

/** Reduce a positive integer to a single digit, preserving master numbers at any step. */
function reduceNumber(n) {
  let value = Math.abs(Math.trunc(n));
  while (value > 9 && !MASTERS.has(value)) {
    value = String(value).split('').reduce((s, d) => s + Number(d), 0);
  }
  return value;
}

/** The Universal Day number for a date, master numbers preserved. */
function universalDay(dateStr) {
  isoToUTC(dateStr); // validate shape
  const digits = dateStr.replace(/-/g, '').split('').reduce((s, d) => s + Number(d), 0);
  const value = reduceNumber(digits);
  return { value, isMaster: MASTERS.has(value), register: 'symbolic' };
}

/* --------------------------------------------------------------------------
 * Lunar windows and Galactic Activation Portals: authoritative-source slots
 *
 * These are deliberately not computed from memory. The moon phase and the
 * Black and Shiva windows derive from USNO timestamps, the authoritative
 * source named in canon. The portal set is the fifty-two verified Kins
 * cross-referenced against the practitioner portal dates. Until those sources
 * are wired in the next pass, these report that the value is not yet computed,
 * so the Tradition lens speaks symbolically without inventing a number.
 * ------------------------------------------------------------------------ */

/** True when kin is one of the fifty-two Galactic Activation Portals. Populated from the verified set. */
const GAP_KINS = new Set(/* verified fifty-two portal Kins wired in the coordinates pass */);

function isGAP(kin) {
  if (GAP_KINS.size === 0) return null; // not yet wired; caller treats null as unknown
  return GAP_KINS.has(kin);
}

/** Placeholder for the USNO-sourced lunar window. Returns null until wired. */
function lunarWindow(_dateStr) {
  return null; // wired from USNO timestamps in the coordinates pass
}

module.exports = {
  KIN_ANCHOR_UTC,
  SEAL_NAMES,
  TONE_NAMES,
  isoToUTC,
  leapDaysBetween,
  kinForDate,
  kinTone,
  kinDescriptor,
  reduceNumber,
  universalDay,
  isGAP,
  lunarWindow,
};
