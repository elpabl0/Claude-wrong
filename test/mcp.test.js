import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler, hashToken, toolDefinitions } from '../lib/mcp.js';
import { loadConfig } from '../lib/config.js';

const config = loadConfig();
const NOW = '2026-09-16T12:00:00Z';

/** An in-memory stand-in for the GitHub-backed store. */
function fakeStore(files = {}) {
  const store = {
    files: { ...files },
    writable: true,
    flush() {},
    async getFile(path) {
      return this.files[path] === undefined ? null : { content: this.files[path], sha: 'sha', path };
    },
    async getJson(path) {
      const f = await this.getFile(path);
      return f ? JSON.parse(f.content) : null;
    },
    async listDir(path) {
      const prefix = `${path}/`;
      return Object.keys(this.files)
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map((p) => ({ name: p.slice(prefix.length), type: 'file', path: p }));
    },
    async readJsonDir(path) {
      const entries = (await this.listDir(path)).filter((e) => e.name.endsWith('.json'));
      return Promise.all(entries.map(async (e) => ({ name: e.name, record: await this.getJson(e.path) })));
    },
    async createFile(path, content) {
      if (this.files[path] !== undefined) throw new Error(`${path} already exists`);
      this.files[path] = content;
    },
    async appendLine(path, line) {
      this.files[path] = (this.files[path] ?? '') + line + '\n';
    },
  };
  return store;
}

const question = {
  id: '2026-09-01-example-claim',
  created_utc: '2026-09-01T09:00:00Z',
  author_model: 'claude-opus-5',
  protocol_version: 2,
  category: 'tech-industry',
  origin: 'house',
  claim: 'Will the example project publish a version 3 release before December 2026?',
  resolution_date: '2026-12-15',
  resolution_criterion: 'YES if the GitHub releases API lists a non-draft release tagged v3 on or before 2026-12-15.',
  resolver: { type: 'github_release', repo: 'example/example', tag_pattern: '^v3\\.' },
  rounds: [
    { id: 'r1', t_minus_days: 90, opens_utc: '2026-09-16T09:00:00Z', closes_utc: '2026-09-16T21:00:00Z' },
    { id: 'r2', t_minus_days: 30, opens_utc: '2026-11-15T09:00:00Z', closes_utc: '2026-11-15T21:00:00Z' },
  ],
  external_reference: null,
};

const TOKEN = 'wrong_testtoken';
const seat = {
  id: 'tester', display_name: 'Tester', model_string: 'test-model-1', operator: 'test harness',
  division: 'open', scaffold_declaration: 'A test harness with no retrieval at all, used only in unit tests.',
  registered_utc: '2026-09-01T00:00:00Z', self_declared: true, token_sha256: hashToken(TOKEN), status: 'active',
};

function harness(extra = {}) {
  const store = fakeStore({
    'questions/2026-09-01-example-claim.json': JSON.stringify(question),
    'seats/tester.json': JSON.stringify(seat),
    ...extra,
  });
  return { store, handle: createMcpHandler({ store, config, now: () => NOW }) };
}

const call = (handle, name, args = {}, token = null) =>
  handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { token });
const parse = (reply) => JSON.parse(reply.result.content[0].text);

test('initialize advertises the protocol and every tool has a schema', async () => {
  const { handle } = harness();
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.match(init.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(init.result.instructions.length > 100);

  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_my_calibration', 'get_my_positions', 'get_question', 'get_scoreboard', 'list_open_questions', 'register_seat', 'submit_order']);
  for (const t of list.result.tools) {
    assert.ok(t.description.length > 30, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, 'object');
  }
  assert.deepEqual(toolDefinitions(config).length, 7);
});

test('notifications get no reply and unknown methods are refused', async () => {
  const { handle } = harness();
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const bad = await handle({ jsonrpc: '2.0', id: 3, method: 'sudo/make_me_rich' });
  assert.equal(bad.error.code, -32601);
});

test('a tool that needs a seat refuses an absent or wrong token', async () => {
  const { handle } = harness();
  for (const token of [null, 'wrong_nope']) {
    const r = await call(handle, 'get_my_positions', {}, token);
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /token/i);
  }
  assert.ok(!(await call(handle, 'get_my_positions', {}, TOKEN)).result.isError);
});

test('reading questions needs no token, so an agent can look before it registers', async () => {
  const { handle } = harness();
  const open = parse(await call(handle, 'list_open_questions', { only_open_rounds: true }));
  assert.equal(open.questions.length, 1);
  assert.equal(open.questions[0].open_round.round_id, 'r1');
  assert.equal(open.questions[0].current_price, config.rounds.opening_price);
});

test('no tool exposes the live book, which is the whole point of sealing', async () => {
  // A round that is open, with an order already committed and its body present.
  const { handle } = harness({
    'rounds/2026-09-01-example-claim/r1/commitments.jsonl': JSON.stringify({ order_id: 'x', seat: 'rival', commitment: 'abc', submitted_utc: NOW }) + '\n',
    'rounds/2026-09-01-example-claim/r1/reveals.jsonl': JSON.stringify({ order_id: 'x', seat: 'rival', open_book: { side: 'yes', limit_price: 0.81, size: 99 } }) + '\n',
  });
  const detail = JSON.stringify(parse(await call(handle, 'get_question', { question_id: question.id })));
  assert.ok(!detail.includes('0.81'), 'a live limit price leaked');
  assert.ok(!detail.includes('rival'), 'a live participant leaked');
  assert.ok(!detail.includes('99'), 'a live size leaked');
  assert.deepEqual(parse(await call(handle, 'get_question', { question_id: question.id })).published_books, []);

  const mine = parse(await call(handle, 'get_my_positions', {}, TOKEN));
  assert.equal(mine.pending_orders.length, 0, 'another seat’s pending order must not appear in mine');
});

test('a published book from a closed round IS visible', async () => {
  const { handle } = harness({
    'rounds/2026-09-01-example-claim/r1/clearing.json': JSON.stringify({
      cleared: true, clearing_price: 0.44, volume: 20, orders: 2,
      fills: [{ order_id: 'a', seat: 'tester', side: 'yes', limit_price: 0.6, size: 20, filled: 20, fill_price: 0.44, stake: 8.8 }],
      book: [{ order_id: 'a', seat: 'tester', side: 'yes', limit_price: 0.6, size: 20 }],
      pairs: [],
    }),
  });
  const q = parse(await call(handle, 'get_question', { question_id: question.id }));
  assert.equal(q.published_books.length, 1);
  assert.equal(q.price_path[0].price, 0.44);
  assert.equal(q.current_price, 0.44);
});

test('registration issues a token once and refuses a taken seat id', async () => {
  const { store, handle } = harness();
  const reg = parse(await call(handle, 'register_seat', {
    seat_id: 'newcomer', display_name: 'Newcomer', model_string: 'gpt-5', operator: 'somebody',
    division: 'bare', scaffold_declaration: 'A single forward pass with no retrieval and no tools whatsoever.',
  }));
  assert.match(reg.token, /^wrong_[0-9a-f]{48}$/);
  assert.equal(reg.seat_id, 'newcomer');

  const written = JSON.parse(store.files['seats/newcomer.json']);
  assert.equal(written.token_sha256, hashToken(reg.token));
  assert.ok(!JSON.stringify(written).includes(reg.token), 'the raw token must never be written to the repository');
  assert.equal(written.self_declared, true);

  const dupe = await call(handle, 'register_seat', {
    seat_id: 'newcomer', display_name: 'x', model_string: 'y', operator: 'z',
    division: 'open', scaffold_declaration: 'A duplicate registration attempt used only in tests.',
  });
  assert.equal(dupe.result.isError, true);
  assert.match(dupe.result.content[0].text, /taken/);

  // The new token authenticates immediately.
  assert.ok(!(await call(handle, 'get_my_positions', {}, reg.token)).result.isError);
});

test('registration rejects a malformed seat id or an undeclared scaffold', async () => {
  const { handle } = harness();
  const bad = await call(handle, 'register_seat', { seat_id: 'Bad Id!', display_name: 'x', model_string: 'y', operator: 'z', division: 'open', scaffold_declaration: 'A perfectly adequate scaffold declaration.' });
  assert.equal(bad.result.isError, true);
  const thin = await call(handle, 'register_seat', { seat_id: 'thin-seat', display_name: 'x', model_string: 'y', operator: 'z', division: 'open', scaffold_declaration: 'too short' });
  assert.equal(thin.result.isError, true);
});

test('an order is committed by hash and the body is written separately', async () => {
  const { store, handle } = harness();
  const out = parse(await call(handle, 'submit_order', { question_id: question.id, round_id: 'r1', side: 'yes', limit_price: 0.62, size: 40, rationale: 'because' }, TOKEN));
  assert.match(out.commitment, /^[0-9a-f]{64}$/);
  assert.equal(out.reserved_points, 24.8);

  const commitments = store.files['rounds/2026-09-01-example-claim/r1/commitments.jsonl'].trim().split('\n').map(JSON.parse);
  assert.equal(commitments.length, 1);
  assert.equal(commitments[0].seat, 'tester');
  assert.ok(!('limit_price' in commitments[0]), 'the commitment log must not carry the price');
  assert.ok(!JSON.stringify(commitments[0]).includes('0.62'));

  const reveals = store.files['rounds/2026-09-01-example-claim/r1/reveals.jsonl'].trim().split('\n').map(JSON.parse);
  assert.equal(reveals[0].open_book.limit_price, 0.62);
  assert.equal(reveals[0].open_book.rationale, 'because');
});

test('orders outside the window, over the cap, or at an impossible price are refused', async () => {
  const { handle } = harness();
  const closed = await call(handle, 'submit_order', { question_id: question.id, round_id: 'r2', side: 'yes', limit_price: 0.5, size: 10 }, TOKEN);
  assert.equal(closed.result.isError, true);
  assert.match(closed.result.content[0].text, /scheduled/);

  const huge = await call(handle, 'submit_order', { question_id: question.id, round_id: 'r1', side: 'yes', limit_price: 0.9, size: 900 }, TOKEN);
  assert.equal(huge.result.isError, true);
  assert.match(huge.result.content[0].text, /cap|available/);

  const certain = await call(handle, 'submit_order', { question_id: question.id, round_id: 'r1', side: 'yes', limit_price: 1, size: 5 }, TOKEN);
  assert.equal(certain.result.isError, true);

  const nowhere = await call(handle, 'submit_order', { question_id: 'no-such-question', round_id: 'r1', side: 'yes', limit_price: 0.5, size: 5 }, TOKEN);
  assert.equal(nowhere.result.isError, true);
});

test('a seat cannot overdraw by splitting one bet across several orders in a window', async () => {
  const { handle } = harness();
  // Each order reserves 240 points. Keep going until the bankroll refuses one,
  // and check it refused for the right reason rather than at an arbitrary count.
  let refusal = null;
  let accepted = 0;
  let lastAvailable = Infinity;
  for (let i = 0; i < 12 && !refusal; i++) {
    const r = await call(handle, 'submit_order', { question_id: question.id, round_id: 'r1', side: 'yes', limit_price: 0.6, size: 400 }, TOKEN);
    if (r.result.isError) refusal = r.result.content[0].text;
    else {
      accepted += 1;
      const left = parse(r).points_available_after;
      assert.ok(left < lastAvailable, 'each accepted order must reduce what is left');
      lastAvailable = left;
    }
  }
  assert.ok(refusal, 'the bankroll must eventually refuse');
  assert.match(refusal, /available|cap/);
  assert.ok(accepted >= 1 && accepted <= 6, `accepted ${accepted} orders before refusing`);
});

test('a seat only ever sees its own positions', async () => {
  const { handle } = harness();
  await call(handle, 'submit_order', { question_id: question.id, round_id: 'r1', side: 'no', limit_price: 0.4, size: 10 }, TOKEN);
  const mine = parse(await call(handle, 'get_my_positions', {}, TOKEN));
  assert.equal(mine.seat, 'tester');
  assert.equal(mine.pending_orders.length, 1);
  assert.ok(mine.bankroll.granted >= config.bankroll.initial_points, 'grant includes weekly top-ups since registration');
  assert.equal(mine.bankroll.realised_pnl, 0, 'nothing has settled, so nothing is realised');
});

test('the scoreboard says so plainly when nothing has settled', async () => {
  const { handle } = harness();
  const empty = parse(await call(handle, 'get_scoreboard'));
  assert.deepEqual(empty.leaderboard, []);
  const cal = parse(await call(handle, 'get_my_calibration', {}, TOKEN));
  assert.equal(cal.settled, 0);
});
