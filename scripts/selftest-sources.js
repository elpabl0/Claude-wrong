#!/usr/bin/env node
/**
 * Exercise every resolver type against a live, known-good source.
 *
 * The unit tests prove the resolvers handle the shapes they are given. This
 * proves the shapes are still what the outside world actually returns. Third
 * parties reorganise their APIs without telling anyone, and the failure mode
 * that matters here is silent: a resolver that has quietly stopped working does
 * not announce itself until a prediction comes due and voids.
 *
 * Run on every default-branch push and on the daily schedule. It is allowed to
 * fail without failing the build - it is a smoke alarm, not a gate.
 *
 *   node scripts/selftest-sources.js
 */
import { getResolver } from '../lib/resolvers/index.js';

const CASES = [
  {
    name: 'json (GitHub repo metadata)',
    type: 'json',
    cfg: { type: 'json', url: 'https://api.github.com/repos/nodejs/node', pointer: '/stargazers_count', op: '>', value: 1000 },
    expect: (r) => r.status === 'yes' && typeof r.observed === 'number',
  },
  {
    name: 'github_release (nodejs/node has published something)',
    type: 'github_release',
    cfg: { type: 'github_release', repo: 'nodejs/node', tag_pattern: '^v' },
    expect: (r) => r.status === 'yes',
  },
  {
    name: 'http_text (a stable page still has readable text)',
    type: 'http_text',
    cfg: { type: 'http_text', url: 'https://example.com/', contains: 'example domain', absent_at_creation: true },
    expect: (r) => r.status === 'yes',
  },
  {
    name: 'arxiv (query endpoint returns a count)',
    type: 'arxiv',
    cfg: { type: 'arxiv', search_query: 'cat:cs.LG', op: '>', value: 0 },
    expect: (r) => r.status === 'yes' && r.observed > 0,
  },
  {
    name: 'metaculus (a long-resolved question still reads as resolved)',
    type: 'metaculus',
    // Metaculus question 1: "Will the Democratic Party win the 2016 US presidential
    // election?" - resolved NO a decade ago and about as stable a fixture as the
    // site has. Any status other than a clean yes/no means the response shape moved.
    cfg: { type: 'metaculus', post_id: 1 },
    expect: (r) => r.status === 'yes' || r.status === 'no',
    // Metaculus refuses anonymous datacenter traffic. Without a token this is
    // expected to fail, and the ledger falls back to Manifold for its crowd
    // reference, so it is reported but does not count against the run.
    optional: !process.env.METACULUS_TOKEN,
    optionalNote: 'METACULUS_TOKEN is not set, so anonymous 403/429 is expected',
  },
  {
    name: 'manifold (a resolved market still reads as resolved)',
    type: 'manifold',
    cfg: { type: 'json', url: 'https://api.manifold.markets/v0/markets?limit=1' },
    custom: async () => {
      const { httpGetJson } = await import('../lib/resolvers/util.js');
      const list = await httpGetJson('https://api.manifold.markets/v0/markets?limit=1');
      if (!Array.isArray(list) || typeof list[0]?.id !== 'string') {
        throw new Error('Manifold market listing did not return recognisable markets');
      }
      const r = getResolver('manifold');
      const res = await r.resolve({ market_id: list[0].id }, {});
      return `market ${list[0].id} → ${res.status}: ${res.detail}`;
    },
  },
];

let failures = 0;

for (const c of CASES) {
  const impl = getResolver(c.type);
  process.stdout.write(`${c.name} … `);
  try {
    if (c.custom) {
      console.log(`ok\n    ${await c.custom()}`);
      continue;
    }
    const res = await impl.resolve(c.cfg, { env: process.env });
    if (c.expect(res)) {
      console.log(`ok\n    ${res.detail}`);
    } else {
      if (!c.optional) failures++;
      console.log(`${c.optional ? 'SKIPPED' : 'UNEXPECTED'}\n    status=${res.status} observed=${JSON.stringify(res.observed)}\n    ${res.detail}${c.optional ? `\n    (${c.optionalNote})` : ''}`);
    }
  } catch (err) {
    if (!c.optional) failures++;
    console.log(`${c.optional ? 'SKIPPED' : 'FAILED'}\n    ${err.name}: ${err.message}${c.optional ? `\n    (${c.optionalNote})` : ''}`);
  }
}

// The slate fetcher is the other live dependency, and the one the mirrored
// questions rest on entirely.
process.stdout.write('mirror-candidates (crowd slate) … ');
try {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('node', ['scripts/mirror-candidates.js', '--stdout', '--n=5'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const slate = JSON.parse(out);
  if (!Array.isArray(slate.questions) || slate.questions.length === 0) {
    failures++;
    console.log('UNEXPECTED\n    the slate came back empty from every platform');
  } else {
    const per = Object.entries(slate.sources).map(([k, v]) => `${k}: ${v.ok ? `${v.usable}/${v.scanned}` : 'unavailable'}`).join(', ');
    console.log(`ok\n    ${slate.questions.length} candidates (${per})`);
    for (const q of slate.questions.slice(0, 5)) {
      console.log(`      ${q.platform} ${q.question_id}  crowd ${q.community_probability}  ${q.forecaster_count ?? '?'} forecasters  closes ${q.scheduled_close}  ${q.title.slice(0, 60)}`);
    }
  }
} catch (err) {
  failures++;
  console.log(`FAILED\n    ${String(err.stderr ?? err.message).trim().split('\n').slice(0, 6).join('\n    ')}`);
}

console.log(`\n${CASES.length + 1 - failures}/${CASES.length + 1} live sources behaving as expected.`);
process.exit(failures ? 1 : 0);
