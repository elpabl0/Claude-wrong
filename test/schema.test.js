import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateQuestion, validateSeat, validateOrder, validateResolution } from '../lib/schema.js';
import { markdown, escapeHtml } from '../lib/markdown.js';
import { horizonBucket, daysBetween, loadConfig } from '../lib/config.js';
import { buildSchedule } from '../scripts/new-question.js';

const config = loadConfig();

const rounds = [
  { id: 'r1', t_minus_days: 90, opens_utc: '2026-09-16T09:00:00Z', closes_utc: '2026-09-16T21:00:00Z' },
  { id: 'r2', t_minus_days: 30, opens_utc: '2026-11-15T09:00:00Z', closes_utc: '2026-11-15T21:00:00Z' },
];

const question = (over = {}) => ({
  id: '2026-09-01-example-claim-slug',
  created_utc: '2026-09-01T09:00:00Z',
  author_model: 'claude-test-1',
  protocol_version: 2,
  category: 'tech-industry',
  origin: 'house',
  claim: 'Will the example repository publish a version 3 release before the end of December 2026?',
  resolution_date: '2026-12-15',
  resolution_criterion: 'YES if the GitHub releases API for example/example lists a non-draft release whose tag begins with v3, published on or before 2026-12-15.',
  resolver: { type: 'github_release', repo: 'example/example', tag_pattern: '^v3\\.' },
  rounds,
  external_reference: null,
  ...over,
});

const qErrors = (mutate) => {
  const rec = question();
  mutate(rec);
  return validateQuestion(rec, { config, filename: 't.json' }).errors;
};

test('a well-formed question validates', () => {
  const { ok, errors } = validateQuestion(question(), { config, filename: 't.json' });
  assert.ok(ok, errors.join('\n'));
});

test('the id must carry the creation date, so a question cannot be quietly re-dated', () => {
  assert.ok(qErrors((r) => (r.id = '2026-10-01-example-claim-slug')).some((e) => /must begin with the creation date/.test(e)));
});

test('a criterion that needs interpretation is not admissible', () => {
  assert.ok(qErrors((r) => (r.resolution_criterion = 'if it broadly happens')).some((e) => /resolution_criterion/.test(e)));
  assert.ok(qErrors((r) => (r.resolver = { type: 'vibes' })).some((e) => /not allowed/.test(e)));
  assert.ok(qErrors((r) => (r.resolver = { type: 'github_release', repo: 'nope', tag_pattern: 'x' })).some((e) => /owner\/name/.test(e)));
});

test('a round may not close on or after the resolution date', () => {
  assert.ok(
    qErrors((r) => (r.rounds = [{ ...rounds[0], opens_utc: '2026-12-15T09:00:00Z', closes_utc: '2026-12-15T21:00:00Z' }]))
      .some((e) => /trade on a known answer/.test(e)),
  );
});

test('rounds must be ordered, non-overlapping and uniquely named', () => {
  assert.ok(qErrors((r) => (r.rounds = [rounds[1], rounds[0]])).some((e) => /overlaps the previous round/.test(e)));
  assert.ok(qErrors((r) => (r.rounds = [rounds[0], { ...rounds[1], id: 'r1' }])).some((e) => /duplicate ids/.test(e)));
  assert.ok(qErrors((r) => (r.rounds = [{ ...rounds[0], closes_utc: rounds[0].opens_utc }])).some((e) => /closes_utc must be after/.test(e)));
  assert.ok(qErrors((r) => (r.rounds = [])).some((e) => /non-empty array/.test(e)));
});

test('a mirrored question must cite the same crowd question it resolves against', () => {
  const mirrored = (over = {}, resolver = { type: 'manifold', market_id: 'aBcD1234xy' }) =>
    validateQuestion(
      question({
        origin: 'mirrored',
        resolver,
        external_reference: {
          platform: 'manifold',
          question_id: 'aBcD1234xy',
          community_probability: 0.44,
          snapshot_utc: '2026-09-01T08:55:00Z',
          url: 'https://manifold.markets/market/aBcD1234xy',
          ...over,
        },
      }),
      { config, filename: 't.json' },
    );

  assert.ok(mirrored().ok, mirrored().errors.join('\n'));
  assert.ok(mirrored({ question_id: 'someOtherMarket' }).errors.some((e) => /resolver targets/.test(e)));
  assert.ok(mirrored({}, { type: 'metaculus', post_id: 42 }).errors.some((e) => /must use the `manifold` resolver/.test(e)));
  assert.ok(mirrored({ snapshot_utc: '2026-08-20T08:55:00Z' }).errors.some((e) => /must be taken on the day/.test(e)));
  assert.ok(qErrors((r) => (r.external_reference = { platform: 'manifold' })).some((e) => /must be null/.test(e)));
});

test('validation reports rather than throws on rubbish input', () => {
  for (const junk of [null, undefined, 42, 'string', []]) {
    const { ok, errors } = validateQuestion(junk, { config, filename: 't.json' });
    assert.equal(ok, false);
    assert.ok(errors.length > 0);
  }
});

/* --------------------------------------------------------------------- seat */

const seat = (over = {}) => ({
  id: 'house',
  display_name: 'House',
  model_string: 'claude-opus-5',
  operator: 'wrong.aecs.io',
  division: 'open',
  scaffold_declaration: 'Scheduled session with web search and tool access.',
  registered_utc: '2026-08-16T11:40:00Z',
  self_declared: true,
  ...over,
});

test('a seat must declare its scaffold and admit that provenance is self-declared', () => {
  assert.ok(validateSeat(seat()).ok);
  assert.ok(validateSeat(seat({ self_declared: false })).errors.some((e) => /self_declared/.test(e)));
  assert.ok(validateSeat(seat({ division: 'cyborg' })).errors.some((e) => /division/.test(e)));
  assert.ok(validateSeat(seat({ scaffold_declaration: 'some' })).errors.some((e) => /scaffold_declaration/.test(e)));
});

test('a bearer token must never be committed, only its hash', () => {
  assert.ok(validateSeat(seat({ token: 'secret-value' })).errors.some((e) => /must never be committed/.test(e)));
  assert.ok(validateSeat(seat({ token_sha256: 'not-a-hash' })).errors.some((e) => /token_sha256/.test(e)));
  assert.ok(validateSeat(seat({ token_sha256: 'a'.repeat(64) })).ok);
});

/* -------------------------------------------------------------------- order */

const round = { id: 'r1', opens_utc: '2026-09-16T09:00:00Z', closes_utc: '2026-09-16T21:00:00Z' };
const order = (over = {}) => ({
  order_id: '2026-09-01-example-claim-slug-r1-house-01',
  question_id: '2026-09-01-example-claim-slug',
  round_id: 'r1',
  seat: 'house',
  side: 'yes',
  limit_price: 0.62,
  size: 40,
  ...over,
});
const bankroll = { granted: 1000, available: 1000 };
const inWindow = '2026-09-16T12:00:00Z';

test('an order inside the window with funds behind it is accepted', () => {
  const r = validateOrder(order(), { question: question(), round, config, bankroll, nowISO: inWindow });
  assert.ok(r.ok, r.errors.join('\n'));
});

test('an order outside the window is refused at both ends', () => {
  assert.ok(validateOrder(order(), { question: question(), round, config, bankroll, nowISO: '2026-09-16T08:00:00Z' }).errors.some((e) => /does not open until/.test(e)));
  assert.ok(validateOrder(order(), { question: question(), round, config, bankroll, nowISO: '2026-09-16T22:00:00Z' }).errors.some((e) => /window closed/.test(e)));
});

test('a limit of 0 or 1 is not a forecast', () => {
  for (const p of [0, 1, 0.01, 0.99]) {
    assert.ok(validateOrder(order({ limit_price: p }), { question: question(), round, config, bankroll, nowISO: inWindow }).errors.some((e) => /limit_price/.test(e)), `${p} must be refused`);
  }
  assert.ok(validateOrder(order({ limit_price: 0.02 }), { question: question(), round, config, bankroll, nowISO: inWindow }).ok);
});

test('the bankroll is a hard constraint, and so is the single-order cap', () => {
  const broke = validateOrder(order({ size: 900 }), { question: question(), round, config, bankroll: { granted: 1000, available: 100 }, nowISO: inWindow });
  assert.ok(broke.errors.some((e) => /only 100\.00 are available/.test(e)));

  // 25% of a 1000-point grant is 250; 500 x 0.62 = 310 is over the cap even
  // though the seat could afford it.
  const capped = validateOrder(order({ size: 500 }), { question: question(), round, config, bankroll, nowISO: inWindow });
  assert.ok(capped.errors.some((e) => /single-order cap/.test(e)));
});

test('sizes are whole contracts', () => {
  assert.ok(validateOrder(order({ size: 2.5 }), { question: question(), round, config, bankroll, nowISO: inWindow }).errors.some((e) => /size/.test(e)));
  assert.ok(validateOrder(order({ size: 0 }), { question: question(), round, config, bankroll, nowISO: inWindow }).errors.some((e) => /size/.test(e)));
});

/* --------------------------------------------------------------- resolution */

test('a void resolution must say why, and every resolution shows its evidence', () => {
  const base = {
    question_id: '2026-09-01-example-claim-slug',
    resolved_utc: '2026-12-15T06:00:00Z',
    status: 'yes',
    detail: 'example/example published v3.0.0',
    resolver_type: 'github_release',
    attempts: [{ utc: '2026-12-15T06:00:00Z', outcome: 'yes', detail: 'ok' }],
  };
  assert.ok(validateResolution(base, question()).ok);
  assert.ok(validateResolution({ ...base, attempts: [] }, question()).errors.some((e) => /attempts/.test(e)));
  assert.ok(validateResolution({ ...base, status: 'void' }, question()).errors.some((e) => /void_reason/.test(e)));
  assert.ok(validateResolution({ ...base, status: 'void', void_reason: 'the source stopped responding' }, question()).ok);
});

/* ---------------------------------------------------------------- schedules */

test('the round schedule tightens toward resolution and never straddles it', () => {
  const s = buildSchedule('2026-09-01', '2026-12-15');
  assert.ok(s.length >= 4);
  assert.deepEqual(s.map((r) => r.id), s.map((_, i) => `r${i + 1}`));
  // Strictly decreasing distance from resolution, all before the resolution date.
  for (let i = 1; i < s.length; i++) assert.ok(s[i].t_minus_days < s[i - 1].t_minus_days);
  for (const r of s) assert.ok(r.closes_utc.slice(0, 10) < '2026-12-15');
});

test('a short-horizon question simply gets fewer rounds rather than a squashed schedule', () => {
  const s = buildSchedule('2026-09-01', '2026-09-20');
  assert.ok(s.length >= 1 && s.length < 5);
  for (const r of s) assert.ok(r.opens_utc > '2026-09-01T00:00:00Z');
});

/* ------------------------------------------------------------------- config */

test('horizon buckets partition the allowed range', () => {
  assert.equal(horizonBucket(14), 'short');
  assert.equal(horizonBucket(15), 'medium');
  assert.equal(horizonBucket(60), 'medium');
  assert.equal(horizonBucket(61), 'long');
  assert.equal(daysBetween('2026-01-01', '2026-03-01'), 59);
});

/* ---------------------------------------------------------------- markdown */

test('markdown renders the subset the site relies on and escapes the rest', () => {
  const html = markdown('# Title\n\nA `code 7 span` and **bold**.\n\n- one\n- two\n');
  assert.match(html, /<h1 id="title">Title<\/h1>/);
  assert.match(html, /<code>code 7 span<\/code>/);
  assert.match(html, /<li>one<\/li><li>two<\/li>/);
  assert.match(markdown('There are 7 things and `x` here.'), /There are 7 things and <code>x<\/code> here\./);
  assert.match(markdown('<script>alert(1)</script>'), /&lt;script&gt;/);
  assert.match(markdown('[x](javascript:alert(1))'), /href="#"/);
  assert.equal(escapeHtml('<&">'), '&lt;&amp;&quot;&gt;');
});
