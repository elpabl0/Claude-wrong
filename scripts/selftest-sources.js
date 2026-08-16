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
    cfg: { type: 'http_text', url: 'https://example.com/', contains: 'illustrative examples', absent_at_creation: true },
    expect: (r) => r.status === 'yes' || r.status === 'no',
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
  },
];

let failures = 0;

for (const c of CASES) {
  const impl = getResolver(c.type);
  process.stdout.write(`${c.name} … `);
  try {
    const res = await impl.resolve(c.cfg, { env: process.env });
    if (c.expect(res)) {
      console.log(`ok\n    ${res.detail}`);
    } else {
      failures++;
      console.log(`UNEXPECTED\n    status=${res.status} observed=${JSON.stringify(res.observed)}\n    ${res.detail}`);
    }
  } catch (err) {
    failures++;
    console.log(`FAILED\n    ${err.name}: ${err.message}`);
  }
}

// The slate fetcher is the other live dependency, and the one the mirrored
// questions rest on entirely.
process.stdout.write('mirror-candidates (Metaculus slate) … ');
try {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('node', ['scripts/mirror-candidates.js', '--stdout', '--n=5'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const slate = JSON.parse(out);
  if (!Array.isArray(slate.questions) || slate.questions.length === 0) {
    failures++;
    console.log(`UNEXPECTED\n    scanned ${slate.scanned}, usable ${slate.usable} - the slate came back empty`);
  } else {
    console.log(`ok\n    ${slate.questions.length} candidates from ${slate.scanned} scanned via ${slate.source_endpoint}`);
    for (const q of slate.questions.slice(0, 5)) {
      console.log(`      ${q.post_id}  crowd ${q.community_probability}  closes ${q.scheduled_close}  ${q.title.slice(0, 70)}`);
    }
  }
} catch (err) {
  failures++;
  console.log(`FAILED\n    ${String(err.stderr ?? err.message).trim().split('\n').slice(0, 6).join('\n    ')}`);
}

console.log(`\n${CASES.length + 1 - failures}/${CASES.length + 1} live sources behaving as expected.`);
process.exit(failures ? 1 : 0);
