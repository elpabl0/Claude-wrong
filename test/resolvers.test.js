import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getResolver, RESOLVERS } from '../lib/resolvers/index.js';
import { jsonPointer, compare, SourceError, CriterionError, httpGetJson } from '../lib/resolvers/util.js';
import { normaliseResolution, communityProbability, extractQuestion } from '../lib/resolvers/metaculus.js';
import { normaliseResolution as manifoldResolution, communityProbability as manifoldCrowd } from '../lib/resolvers/manifold.js';
import { authHeadersFor } from '../lib/resolvers/util.js';
import { textContent } from '../lib/resolvers/http_text.js';
import { parseTotalResults } from '../lib/resolvers/arxiv.js';
import { loadConfig } from '../lib/config.js';

/** A fetch stand-in. The resolvers never touch the network in tests. */
function stubFetch(body, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
}
const ctx = (body, opts) => ({ fetchFn: stubFetch(body, opts), retries: 0, timeoutMs: 1000 });

test('every resolver named in the config is implemented', () => {
  for (const type of loadConfig().questions.allowed_resolver_types) {
    assert.ok(getResolver(type), `missing resolver ${type}`);
  }
  assert.equal(Object.keys(RESOLVERS).length, loadConfig().questions.allowed_resolver_types.length);
});

test('every resolver exposes validateConfig, resolve and probe', () => {
  for (const [type, r] of Object.entries(RESOLVERS)) {
    assert.equal(typeof r.validateConfig, 'function', type);
    assert.equal(typeof r.resolve, 'function', type);
    assert.equal(typeof r.probe, 'function', type);
  }
});

/* ------------------------------------------------------------ json pointer */

test('json pointer walks objects, arrays and escapes', () => {
  const doc = { a: { 'b/c': [1, { 'd~e': 'x' }] } };
  assert.deepEqual(jsonPointer(doc, '/a/b~1c/0'), { found: true, value: 1 });
  assert.deepEqual(jsonPointer(doc, '/a/b~1c/1/d~0e'), { found: true, value: 'x' });
  assert.equal(jsonPointer(doc, '/a/missing').found, false);
  assert.equal(jsonPointer(doc, '/a/b~1c/9').found, false);
  assert.deepEqual(jsonPointer(doc, ''), { found: true, value: doc });
  assert.throws(() => jsonPointer(doc, 'a/b'), CriterionError);
});

test('comparison refuses to guess when a value is not numeric', () => {
  assert.equal(compare(5, '>=', 5), true);
  assert.equal(compare('12', '>', 10), true);
  assert.equal(compare('yes', '==', 'yes'), true);
  assert.throws(() => compare('nonsense', '>', 1), SourceError);
  assert.throws(() => compare(1, '~=', 1), CriterionError);
});

/* -------------------------------------------------------------------- json */

test('json resolver compares a pointed-at value to its committed threshold', async () => {
  const r = getResolver('json');
  const cfg = { type: 'json', url: 'https://example.com/x.json', pointer: '/data/count', op: '>=', value: 100 };
  assert.deepEqual(r.validateConfig(cfg), []);

  const yes = await r.resolve(cfg, ctx({ data: { count: 140 } }));
  assert.equal(yes.status, 'yes');
  assert.equal(yes.observed, 140);
  assert.match(yes.detail, /140/);

  const no = await r.resolve(cfg, ctx({ data: { count: 99 } }));
  assert.equal(no.status, 'no');
});

test('json resolver treats a missing pointer as an unreadable source, not a NO', async () => {
  const r = getResolver('json');
  const cfg = { type: 'json', url: 'https://example.com/x.json', pointer: '/data/count', op: '>=', value: 1 };
  await assert.rejects(() => r.resolve(cfg, ctx({ data: {} })), SourceError);
});

test('json resolver counts array members and rejects bad configuration', async () => {
  const r = getResolver('json');
  const cfg = { type: 'json', url: 'https://example.com/x.json', pointer: '/items', op: '>', value: 1, transform: 'length' };
  assert.equal((await r.resolve(cfg, ctx({ items: [1, 2, 3] }))).status, 'yes');

  const counting = { ...cfg, transform: 'count_matching', match_pointer: '/state', match_value: 'closed' };
  const res = await r.resolve(counting, ctx({ items: [{ state: 'closed' }, { state: 'open' }, { state: 'closed' }] }));
  assert.equal(res.observed, 2);

  assert.ok(r.validateConfig({ url: 'http://insecure.example.com', pointer: '/a', op: '>=', value: 1 }).some((e) => /https/.test(e)));
  assert.ok(r.validateConfig({ url: 'https://x.com', pointer: '/a', op: 'nope', value: 1 }).length > 0);
  assert.ok(r.validateConfig({ url: 'https://x.com', pointer: '/a', op: '>=' }).some((e) => /value/.test(e)));
});

test('an HTTP error is a source failure, never a resolution', async () => {
  const r = getResolver('json');
  const cfg = { type: 'json', url: 'https://example.com/x.json', pointer: '/a', op: '>=', value: 1 };
  await assert.rejects(() => r.resolve(cfg, ctx({}, { ok: false, status: 503 })), SourceError);
});

/* --------------------------------------------------------------- metaculus */

test('metaculus resolutions normalise across the encodings the API has used', () => {
  assert.equal(normaliseResolution('yes').status, 'yes');
  assert.equal(normaliseResolution('NO').status, 'no');
  assert.equal(normaliseResolution(1).status, 'yes');
  assert.equal(normaliseResolution(0).status, 'no');
  assert.equal(normaliseResolution(-1).status, 'void');
  assert.equal(normaliseResolution('annulled').status, 'void');
  assert.equal(normaliseResolution(null).status, 'pending');
  assert.equal(normaliseResolution('').status, 'pending');
});

test('metaculus resolver stays pending until the market itself resolves', async () => {
  const r = getResolver('metaculus');
  const cfg = { type: 'metaculus', post_id: 12345 };
  assert.deepEqual(r.validateConfig(cfg), []);
  assert.equal((await r.resolve(cfg, ctx({ question: { resolution: null } }))).status, 'pending');
  assert.equal((await r.resolve(cfg, ctx({ question: { resolution: 'yes' } }))).status, 'yes');
  assert.equal((await r.resolve(cfg, ctx({ question: { resolution: 'no' } }))).status, 'no');
  assert.equal((await r.resolve(cfg, ctx({ question: { resolution: 'annulled' } }))).status, 'void');
});

test('metaculus `expect: no` inverts the criterion', async () => {
  const r = getResolver('metaculus');
  const cfg = { type: 'metaculus', post_id: 1, expect: 'no' };
  assert.equal((await r.resolve(cfg, ctx({ question: { resolution: 'no' } }))).status, 'yes');
  assert.equal((await r.resolve(cfg, ctx({ question: { resolution: 'yes' } }))).status, 'no');
  assert.ok(r.validateConfig({ post_id: 1, expect: 'maybe' }).length > 0);
  assert.ok(r.validateConfig({ post_id: 'abc' }).length > 0);
});

test('an unrecognised metaculus response is a source failure, not a silent NO', () => {
  assert.throws(() => extractQuestion({ unexpected: true }), SourceError);
  assert.throws(() => extractQuestion(null), SourceError);
});

test('community probability is read from any of the shapes Metaculus has used', () => {
  assert.equal(communityProbability({ aggregations: { recency_weighted: { latest: { centers: [0.42] } } } }), 0.42);
  assert.equal(communityProbability({ community_prediction: { full: { q2: 0.31 } } }), 0.31);
  assert.equal(communityProbability({}), null);
  assert.equal(communityProbability({ aggregations: { recency_weighted: { latest: { centers: [1.4] } } } }), null);
});

/* ---------------------------------------------------------------- manifold */

test('manifold stays pending until the market resolves, and voids on a non-binary outcome', async () => {
  const r = getResolver('manifold');
  const cfg = { type: 'manifold', market_id: 'aBcD1234xy' };
  assert.deepEqual(r.validateConfig(cfg), []);

  assert.equal((await r.resolve(cfg, ctx({ id: 'aBcD1234xy', isResolved: false, probability: 0.4 }))).status, 'pending');
  assert.equal((await r.resolve(cfg, ctx({ isResolved: true, resolution: 'YES' }))).status, 'yes');
  assert.equal((await r.resolve(cfg, ctx({ isResolved: true, resolution: 'NO' }))).status, 'no');
  assert.equal((await r.resolve(cfg, ctx({ isResolved: true, resolution: 'CANCEL' }))).status, 'void');
  // MKT resolves to a probability, not an outcome, so it cannot score a binary forecast.
  assert.equal((await r.resolve(cfg, ctx({ isResolved: true, resolution: 'MKT', resolutionProbability: 0.6 }))).status, 'void');

  assert.equal((await r.resolve({ ...cfg, expect: 'no' }, ctx({ isResolved: true, resolution: 'NO' }))).status, 'yes');
  assert.ok(r.validateConfig({ market_id: 'no spaces allowed' }).length > 0);
  assert.ok(r.validateConfig({ market_id: 'ok1234', expect: 'perhaps' }).length > 0);
});

test('manifold resolution and crowd probability normalise as expected', () => {
  assert.equal(manifoldResolution({ isResolved: false }).status, 'pending');
  assert.equal(manifoldResolution({ isResolved: true, resolution: 'yes' }).status, 'yes');
  assert.throws(() => manifoldResolution(null), SourceError);
  assert.equal(manifoldCrowd({ probability: 0.62 }), 0.62);
  assert.equal(manifoldCrowd({ probability: 4 }), null);
  assert.equal(manifoldCrowd({}), null);
});

/* --------------------------------------------------------------------- auth */

test('credentials are attached only to the hosts that refuse anonymous traffic', () => {
  const env = { GITHUB_TOKEN: 'gh', METACULUS_TOKEN: 'mc' };
  assert.match(authHeadersFor('https://api.github.com/repos/a/b', env).authorization, /^Bearer gh$/);
  assert.match(authHeadersFor('https://www.metaculus.com/api/posts/1/', env).authorization, /^Token mc$/);
  assert.deepEqual(authHeadersFor('https://api.manifold.markets/v0/markets', env), {});
  assert.deepEqual(authHeadersFor('https://example.com/', env), {});
  assert.deepEqual(authHeadersFor('not a url', env), {});
  // Without credentials configured, nothing is sent and the call simply fails as a source error.
  assert.deepEqual(authHeadersFor('https://api.github.com/repos/a/b', {}), {});
});

/* ----------------------------------------------------------- github_release */

test('github_release finds a matching tag and reports the tags it saw when it does not', async () => {
  const r = getResolver('github_release');
  const cfg = { type: 'github_release', repo: 'nodejs/node', tag_pattern: '^v25\\.' };
  assert.deepEqual(r.validateConfig(cfg), []);

  const releases = [
    { tag_name: 'v24.9.0', published_at: '2026-07-01T00:00:00Z', draft: false, prerelease: false },
    { tag_name: 'v25.0.0', published_at: '2026-08-01T00:00:00Z', draft: false, prerelease: false },
  ];
  const yes = await r.resolve(cfg, ctx(releases));
  assert.equal(yes.status, 'yes');
  assert.equal(yes.observed, 'v25.0.0');

  const late = await r.resolve({ ...cfg, published_before: '2026-07-15' }, ctx(releases));
  assert.equal(late.status, 'no', 'a release after the cutoff must not count');
  assert.match(late.detail, /v24\.9\.0/);
});

test('github_release ignores drafts and, by default, prereleases', async () => {
  const r = getResolver('github_release');
  const cfg = { type: 'github_release', repo: 'a/b', tag_pattern: '^v2' };
  const list = [
    { tag_name: 'v2.0.0-rc1', published_at: '2026-01-01T00:00:00Z', draft: false, prerelease: true },
    { tag_name: 'v2.0.0-draft', published_at: '2026-01-01T00:00:00Z', draft: true, prerelease: false },
  ];
  assert.equal((await r.resolve(cfg, ctx(list))).status, 'no');
  assert.equal((await r.resolve({ ...cfg, include_prereleases: true }, ctx(list))).status, 'yes');
  assert.ok(r.validateConfig({ repo: 'not-a-repo', tag_pattern: 'x' }).length > 0);
});

/* -------------------------------------------------------------- http_text */

test('http_text reads visible text, ignoring markup and scripts', () => {
  const html = '<html><head><style>p{color:red}</style><script>var x="hidden phrase"</script></head><body><p>Hello  &amp; <b>welcome</b></p></body></html>';
  const text = textContent(html);
  assert.equal(text, 'Hello & welcome');
  assert.ok(!text.includes('hidden phrase'));
});

test('http_text matches a literal or a regex and demands the pattern be absent at authoring time', async () => {
  const r = getResolver('http_text');
  const cfg = { type: 'http_text', url: 'https://example.com/', contains: 'general availability', absent_at_creation: true };
  assert.deepEqual(r.validateConfig(cfg), []);
  assert.equal((await r.resolve(cfg, ctx('<p>Now in General Availability</p>'))).status, 'yes');
  assert.equal((await r.resolve(cfg, ctx('<p>Still in preview</p>'))).status, 'no');

  assert.ok(r.validateConfig({ ...cfg, absent_at_creation: false }).some((e) => /absent_at_creation/.test(e)));
  assert.ok(r.validateConfig({ url: 'https://x.com/', absent_at_creation: true }).some((e) => /exactly one/.test(e)));
  assert.ok(r.validateConfig({ url: 'https://x.com/', contains: 'a', pattern: 'b', absent_at_creation: true }).some((e) => /exactly one/.test(e)));
});

/* ------------------------------------------------------------------- arxiv */

test('arxiv counts results and refuses a response it cannot parse', async () => {
  const r = getResolver('arxiv');
  const cfg = { type: 'arxiv', search_query: 'all:"mechanistic interpretability"', op: '>=', value: 50 };
  assert.deepEqual(r.validateConfig(cfg), []);
  const xml = '<feed><opensearch:totalResults xmlns:opensearch="x">73</opensearch:totalResults></feed>';
  const res = await r.resolve(cfg, ctx(xml));
  assert.equal(res.status, 'yes');
  assert.equal(res.observed, 73);
  assert.throws(() => parseTotalResults('<feed></feed>'), SourceError);
});

test('arxiv folds a date range into the query so the count is stable however late it runs', async () => {
  const r = getResolver('arxiv');
  let seen = null;
  const capturing = {
    fetchFn: async (url) => {
      seen = url;
      return { ok: true, status: 200, text: async () => '<opensearch:totalResults>5</opensearch:totalResults>' };
    },
    retries: 0,
  };
  await r.resolve({ search_query: 'cat:cs.LG', op: '>', value: 1, from_date: '2026-01-01', to_date: '2026-06-30' }, capturing);
  assert.match(decodeURIComponent(seen), /submittedDate:\[202601010000 TO 202606302359\]/);
});

/* ------------------------------------------------------------------ shared */

test('httpGetJson turns unparseable bodies into source failures', async () => {
  await assert.rejects(() => httpGetJson('https://example.com/', ctx('not json')), SourceError);
});
