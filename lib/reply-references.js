'use strict';

/**
 * CDP reply references.
 *
 * Selects a small, relevant set of bibliography entries for a Compass reply,
 * so the reflection can draw on the reference library by name rather than
 * floating free. Voice aware: the Everyday voice never cites, so it receives
 * no reference block. Tradition and Science receive a short, bounded list.
 *
 * Pure and self contained. Loads bibliography.json once from the repo root. If
 * the file is missing or malformed, every call returns an empty string, so a
 * data problem degrades the reply and never breaks it.
 */

let BIB = null;
try { BIB = require('../bibliography.json'); }
catch (_e) {
  try { BIB = require('./bibliography.json'); } catch (_e2) { BIB = null; }
}

const ENTRIES = (BIB && BIB.entries && typeof BIB.entries === 'object') ? BIB.entries : {};
const CLAIM_TO_ENTRIES = (BIB && BIB.claim_to_entries && typeof BIB.claim_to_entries === 'object') ? BIB.claim_to_entries : {};

const STOP = new Set((
  'the a an and or but if then of to in on at for with from into over under is are was were be been being ' +
  'this that these those i me my we our you your it its as by about not no do does did can could should ' +
  'would will just have has had so what how why when where which who whom today day really very much also'
).split(/\s+/));

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));
}

function surname(name) {
  const head = String(name || '').split(',')[0].trim();
  return head || String(name || '').trim();
}

function entryLine(id) {
  const e = ENTRIES[id];
  if (!e) return '';
  const authors = Array.isArray(e.authors) ? e.authors : [];
  let who = '';
  if (authors.length === 1) who = surname(authors[0]);
  else if (authors.length === 2) who = surname(authors[0]) + ' and ' + surname(authors[1]);
  else if (authors.length > 2) who = surname(authors[0]) + ' et al.';
  else if (e.publisher) who = String(e.publisher);
  const year = e.year ? ' ' + e.year : '';
  const title = e.title ? ', ' + e.title : '';
  const line = (who + year + title).trim();
  return line;
}

/** Gather candidate entry ids from the day context and from intention keywords. */
function selectIds(intention, context) {
  const toks = new Set(tokens(intention));
  const ids = [];
  const seen = new Set();
  const add = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const id of arr) {
      if (!seen.has(id) && ENTRIES[id]) { seen.add(id); ids.push(id); }
    }
  };

  const ctx = (context && typeof context === 'object') ? context : {};
  if (ctx.kin != null || ctx.is_gap) {
    add(CLAIM_TO_ENTRIES['dreamspell_count']);
    add(CLAIM_TO_ENTRIES['maya_astronomy']);
  }
  if (ctx.moon != null || ctx.is_black_moon || ctx.is_shiva_moon) {
    add(CLAIM_TO_ENTRIES['lunar_phase_timing']);
    add(CLAIM_TO_ENTRIES['lunar_sleep_effect']);
    add(CLAIM_TO_ENTRIES['circadian_cognition']);
  }
  if (ctx.personal_day != null || ctx.personal_year != null) {
    add(CLAIM_TO_ENTRIES['numerology_day_quality']);
    add(CLAIM_TO_ENTRIES['pythagorean_lineage']);
  }

  for (const tag of Object.keys(CLAIM_TO_ENTRIES)) {
    const tagWords = tag.split('_').filter((w) => w.length >= 4);
    if (tagWords.some((w) => toks.has(w))) add(CLAIM_TO_ENTRIES[tag]);
  }

  return ids;
}

/**
 * Build a bounded, voice aware reference clause to append to the system prompt.
 * Returns an empty string for the Everyday voice, when the library is absent,
 * or when nothing relevant is found.
 */
function referencesClause(voice, intention, context) {
  if (voice === 'everyday') return '';
  if (!BIB) return '';
  const ids = selectIds(intention, context).slice(0, 4);
  const lines = ids.map(entryLine).filter((x) => x.length > 0);
  if (lines.length === 0) return '';
  const intro = voice === 'science'
    ? '\n\nReference library, drawn for this reflection. These are the named authorities behind the mechanisms you may speak to. Name one only where it genuinely bears on what the person raised, label empirical claims as empirical, and never invent or stretch a source.'
    : '\n\nReference library, drawn for this reflection. These are the named sources behind the symbolic frame. You may name one where it genuinely bears on what the person raised, keep symbolic claims labelled as symbolic, and never invent a source.';
  return intro + '\n' + lines.join('\n');
}

module.exports = { referencesClause, selectIds, entryLine, tokens };
