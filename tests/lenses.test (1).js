'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSystemPrompt } = require('../lib/lenses');
const { traditionCoordinateLines, parseComposed, extractText } = require('../lib/compose-depth');

const DATE = '2026-05-28';

test('the Science lens grounds in the salience network and forbids the lazy citation phrase', () => {
  const p = buildSystemPrompt({ lens: 'science', dateStr: DATE });
  assert.match(p, /salience network/);
  assert.match(p, /anterior insula/);
  assert.match(p, /Menon and Uddin 2010/);
  assert.match(p, /do not say "research shows"/i);
});

test('the Tradition lens states only the coordinates provided and marks them symbolic', () => {
  const coords = traditionCoordinateLines(DATE);
  const p = buildSystemPrompt({ lens: 'tradition', dateStr: DATE, coordinates: coords });
  assert.match(p, /Kin 170/);
  assert.match(p, /Universal Day number 7/);
  assert.match(p, /symbolic/);
  assert.match(p, /Do not invent any coordinate that is not provided/);
});

test('the Tradition lens with no coordinates refuses to state any number', () => {
  const p = buildSystemPrompt({ lens: 'tradition', dateStr: DATE });
  assert.match(p, /without stating any numerology, Kin, or moon value/);
  assert.doesNotMatch(p, /Kin 1\d\d/);
});

test('the Everyday lens carries no tradition or neuroscience vocabulary', () => {
  const p = buildSystemPrompt({ lens: 'everyday', dateStr: DATE });
  assert.doesNotMatch(p, /salience/);
  assert.doesNotMatch(p, /Kin/);
  assert.doesNotMatch(p, /numerology/);
});

test('the three lenses produce genuinely different prompts', () => {
  const sci = buildSystemPrompt({ lens: 'science', dateStr: DATE });
  const trad = buildSystemPrompt({ lens: 'tradition', dateStr: DATE, coordinates: traditionCoordinateLines(DATE) });
  const ev = buildSystemPrompt({ lens: 'everyday', dateStr: DATE });
  assert.notEqual(sci, trad);
  assert.notEqual(trad, ev);
  assert.notEqual(sci, ev);
});

test('continuity is injected when present and absent when empty', () => {
  const withC = buildSystemPrompt({ lens: 'everyday', dateStr: DATE, continuity: [{ label: 'Work', summary: 'An open thread.' }] });
  assert.match(withC, /What this person has been carrying/);
  const withoutC = buildSystemPrompt({ lens: 'everyday', dateStr: DATE, continuity: [] });
  assert.doesNotMatch(withoutC, /What this person has been carrying/);
});

test('every built prompt is clean of em dashes, en dashes, and exclamation marks', () => {
  for (const lens of ['science', 'everyday', 'tradition']) {
    const coords = lens === 'tradition' ? traditionCoordinateLines(DATE) : undefined;
    const p = buildSystemPrompt({
      lens, dateStr: DATE, coordinates: coords,
      continuity: [{ label: 'Work', summary: 'An open thread.' }],
      recentTouches: [{ role: 'person', text: 'a note' }],
    });
    assert.equal(p.includes('\u2014'), false, 'no em dash in ' + lens);
    assert.equal(p.includes('\u2013'), false, 'no en dash in ' + lens);
    assert.equal(p.includes('!'), false, 'no exclamation in ' + lens);
  }
});

test('parseComposed reads clean JSON, fenced JSON, and falls back to raw text', () => {
  const clean = parseComposed('{"text":"A reading.","summary":"A living read."}');
  assert.equal(clean.text, 'A reading.');
  assert.equal(clean.summary, 'A living read.');
  const fenced = parseComposed('```json\n{"text":"B."}\n```');
  assert.equal(fenced.text, 'B.');
  const raw = parseComposed('Just prose, no JSON.');
  assert.equal(raw.text, 'Just prose, no JSON.');
  assert.equal(raw.summary, undefined);
});

test('extractText joins the text blocks of an Anthropic response', () => {
  const data = { content: [{ type: 'text', text: 'one' }, { type: 'tool_use' }, { type: 'text', text: 'two' }] };
  assert.equal(extractText(data), 'one\ntwo');
});
