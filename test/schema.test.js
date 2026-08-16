import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePrediction, validateResolution } from '../lib/schema.js';
import { markdown, escapeHtml } from '../lib/markdown.js';
import { horizonBucket, daysBetween } from '../lib/config.js';

const valid = () => ({
  id: '2026-08-24-example-question-slug',
  batch: '2026-08-24',
  created_utc: '2026-08-24T09:00:00Z',
  model: 'claude-test-1',
  protocol_version: 1,
  category: 'ai-capability',
  claim_type: 'change',
  origin: 'self',
  question: 'Will the example repository publish a version 3 release before the end of November 2026?',
  probability: 0.4,
  resolution_date: '2026-11-24',
  resolution_criterion: 'YES if the GitHub releases API for example/example lists a non-draft release whose tag begins with v3, published on or before 2026-11-24.',
  resolver: { type: 'github_release', repo: 'example/example', tag_pattern: '^v3\\.' },
  reasoning: 'The maintainers have signalled a major release in their public roadmap, but the last two majors each slipped by roughly a quarter, and the outstanding blocker list has not shortened in six weeks. That history is the dominant consideration here, so this sits below an even chance.',
  evidence_that_would_move_me: [
    'A release candidate tagged in the repository before the end of September.',
    'The blocker milestone dropping below five open issues.',
  ],
  external_reference: null,
});

const errorsFor = (mutate) => {
  const rec = valid();
  mutate(rec);
  return validatePrediction(rec, { filename: 't.json' }).errors;
};

test('a well-formed prediction validates', () => {
  const { ok, errors } = validatePrediction(valid(), { filename: 't.json' });
  assert.ok(ok, errors.join('\n'));
});

test('probabilities of 0 and 1 are refused', () => {
  assert.ok(errorsFor((r) => (r.probability = 0)).some((e) => /probability/.test(e)));
  assert.ok(errorsFor((r) => (r.probability = 1)).some((e) => /probability/.test(e)));
  assert.ok(errorsFor((r) => (r.probability = 0.99)).some((e) => /probability/.test(e)));
  assert.equal(errorsFor((r) => (r.probability = 0.98)).length, 0);
});

test('the id must carry the batch date, so a record cannot be quietly re-dated', () => {
  assert.ok(errorsFor((r) => (r.id = '2026-09-01-example-question-slug')).some((e) => /must begin with/.test(e)));
  assert.ok(errorsFor((r) => (r.created_utc = '2026-08-25T09:00:00Z')).some((e) => /created_utc/.test(e)));
});

test('the resolution date must be in the future of the batch and inside the maximum horizon', () => {
  assert.ok(errorsFor((r) => (r.resolution_date = '2026-08-24')).some((e) => /after/.test(e)));
  assert.ok(errorsFor((r) => (r.resolution_date = '2026-08-23')).some((e) => /after/.test(e)));
  assert.ok(errorsFor((r) => (r.resolution_date = '2028-08-24')).some((e) => /exceeds/.test(e)));
});

test('a broken resolver configuration fails the record, not just the run', () => {
  assert.ok(errorsFor((r) => (r.resolver = { type: 'json', url: 'https://x.com/' })).some((e) => /resolver/.test(e)));
  assert.ok(errorsFor((r) => (r.resolver = { type: 'astrology', sign: 'leo' })).some((e) => /not allowed/.test(e)));
  assert.ok(errorsFor((r) => (r.resolver = { type: 'github_release', repo: 'nope', tag_pattern: 'x' })).some((e) => /owner\/name/.test(e)));
});

test('reasoning and falsifiers cannot be skipped', () => {
  assert.ok(errorsFor((r) => (r.reasoning = 'because')).some((e) => /reasoning/.test(e)));
  assert.ok(errorsFor((r) => (r.evidence_that_would_move_me = ['one thing only'])).some((e) => /evidence_that_would_move_me/.test(e)));
  assert.ok(errorsFor((r) => (r.evidence_that_would_move_me = ['a', 'b'])).some((e) => /evidence_that_would_move_me/.test(e)));
  assert.ok(errorsFor((r) => (r.resolution_criterion = 'it happens')).some((e) => /resolution_criterion/.test(e)));
});

test('a mirrored prediction must carry a same-day community snapshot on the same question', () => {
  const mirrored = (over = {}, resolver = { type: 'metaculus', post_id: 4242 }) => {
    const r = valid();
    r.origin = 'crowd-mirror';
    r.resolver = resolver;
    r.external_reference = {
      platform: 'metaculus',
      question_id: '4242',
      community_probability: 0.37,
      snapshot_utc: '2026-08-24T08:55:00Z',
      url: 'https://www.metaculus.com/questions/4242/',
      ...over,
    };
    return validatePrediction(r, { filename: 't.json' });
  };
  assert.ok(mirrored().ok, mirrored().errors.join('\n'));
  assert.ok(mirrored({ snapshot_utc: '2026-08-20T08:55:00Z' }).errors.some((e) => /snapshot_utc/.test(e)));
  assert.ok(mirrored({ community_probability: 1.5 }).errors.some((e) => /community_probability/.test(e)));
  assert.ok(mirrored({ platform: 'astrology' }).errors.some((e) => /platform/.test(e)));

  // Mirroring one market and resolving against another would be invisible to a reader.
  assert.ok(mirrored({}, { type: 'metaculus', post_id: 9999 }).errors.some((e) => /resolver targets/.test(e)));
  assert.ok(mirrored({}, { type: 'manifold', market_id: 'abcd1234' }).errors.some((e) => /must use the `metaculus` resolver/.test(e)));

  const manifold = (over = {}) => {
    const r = valid();
    r.origin = 'crowd-mirror';
    r.resolver = { type: 'manifold', market_id: 'aBcD1234xy' };
    r.external_reference = {
      platform: 'manifold',
      question_id: 'aBcD1234xy',
      community_probability: 0.44,
      snapshot_utc: '2026-08-24T08:55:00Z',
      url: 'https://manifold.markets/market/aBcD1234xy',
      ...over,
    };
    return validatePrediction(r, { filename: 't.json' });
  };
  assert.ok(manifold().ok, manifold().errors.join('\n'));
  assert.ok(manifold({ question_id: 'someOtherId' }).errors.some((e) => /resolver targets/.test(e)));

  assert.ok(errorsFor((r) => (r.external_reference = { platform: 'metaculus' })).some((e) => /must be null/.test(e)));
});

test('validation reports rather than throws on rubbish input', () => {
  for (const junk of [null, undefined, 42, 'string', []]) {
    const { ok, errors } = validatePrediction(junk, { filename: 't.json' });
    assert.equal(ok, false);
    assert.ok(errors.length > 0);
  }
});

/* ------------------------------------------------------------- resolutions */

const resolution = (over = {}) => ({
  id: '2026-08-24-example-question-slug',
  resolved_utc: '2026-11-24T06:00:00Z',
  status: 'yes',
  observed: 'v3.0.0',
  detail: 'example/example published release v3.0.0',
  resolver_type: 'github_release',
  brier: 0.36,
  attempts: [{ utc: '2026-11-24T06:00:00Z', outcome: 'yes', detail: 'ok' }],
  ...over,
});

test('a resolution must show its arithmetic', () => {
  const pred = valid();
  assert.ok(validateResolution(resolution(), pred, { filename: 'r.json' }).ok);
  const wrong = validateResolution(resolution({ brier: 0.1 }), pred, { filename: 'r.json' });
  assert.ok(wrong.errors.some((e) => /\(p - outcome\)\^2/.test(e)));
});

test('a void resolution carries no score and must say why', () => {
  assert.ok(validateResolution(resolution({ status: 'void', brier: null, void_reason: 'the source stopped responding for 14 days' }), valid(), { filename: 'r.json' }).ok);
  assert.ok(validateResolution(resolution({ status: 'void', brier: 0.2 }), valid(), { filename: 'r.json' }).errors.some((e) => /brier: null/.test(e)));
  assert.ok(validateResolution(resolution({ status: 'void', brier: null }), valid(), { filename: 'r.json' }).errors.some((e) => /void_reason/.test(e)));
});

test('a resolution with no attempt log is not evidence', () => {
  assert.ok(validateResolution(resolution({ attempts: [] }), valid(), { filename: 'r.json' }).errors.some((e) => /attempts/.test(e)));
});

/* ------------------------------------------------------------------ config */

test('horizon buckets partition the allowed range', () => {
  assert.equal(horizonBucket(1), 'short');
  assert.equal(horizonBucket(30), 'short');
  assert.equal(horizonBucket(31), 'medium');
  assert.equal(horizonBucket(120), 'medium');
  assert.equal(horizonBucket(121), 'long');
  assert.equal(horizonBucket(400), 'long');
  assert.equal(daysBetween('2026-01-01', '2026-03-01'), 59);
  assert.equal(daysBetween('2026-03-01', '2026-01-01'), -59);
});

/* ---------------------------------------------------------------- markdown */

test('markdown renders the subset the site relies on', () => {
  const html = markdown('# Title\n\nA `code 7 span` and **bold**.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  assert.match(html, /<h1 id="title">Title<\/h1>/);
  assert.match(html, /<code>code 7 span<\/code>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<li>one<\/li><li>two<\/li>/);
  assert.match(html, /<th>a<\/th>/);
});

test('markdown does not let a digit in prose eat a code span', () => {
  const html = markdown('There are 7 things and `x` here.');
  assert.match(html, /There are 7 things and <code>x<\/code> here\./);
});

test('markdown escapes html and refuses javascript: links', () => {
  assert.match(markdown('<script>alert(1)</script>'), /&lt;script&gt;/);
  assert.match(markdown('[x](javascript:alert(1))'), /href="#"/);
  assert.equal(escapeHtml('<&">'), '&lt;&amp;&quot;&gt;');
});
