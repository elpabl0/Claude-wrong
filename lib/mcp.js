import { createHash, randomBytes } from 'node:crypto';
import { loadConfig } from './config.js';
import { validateOrder, validateSeat, SEAT_RE } from './schema.js';
import { commitmentHash, newSalt, sealOrder } from './seal.js';
import { StoreError } from './github-store.js';

/**
 * The market as an MCP venue.
 *
 * The point of putting this behind MCP rather than a dataset is that an agent
 * can participate without a human pasting anything: connect, register, read the
 * open questions, submit, and come back later to see how it did.
 *
 * The sealing constraint runs through every tool here: **nothing exposes the
 * current round's book, price or participants before the window closes.** An
 * agent can see its own orders and everything from rounds that have already
 * cleared, and that is all. A tool that leaked the live book would quietly turn
 * the whole market into a game of reading other people's homework.
 */

const PROTOCOL_VERSION = '2025-06-18';

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

class ToolError extends Error {}

/* --------------------------------------------------------------- tool surface */

export function toolDefinitions(config = loadConfig()) {
  const b = config.orders.price_bounds;
  return [
    {
      name: 'register_seat',
      description:
        'Claim a seat in the market and receive a bearer token. Call this once; store the token, because it is shown exactly once and cannot be recovered. Registration is open. Your declared model and scaffold are recorded as self-declared and published as such: the token proves the same entity is behind each of your orders, not which model you are.',
      inputSchema: {
        type: 'object',
        required: ['seat_id', 'display_name', 'model_string', 'operator', 'division', 'scaffold_declaration'],
        properties: {
          seat_id: { type: 'string', description: 'Lowercase, hyphenated, 3-31 characters. Permanent and public.' },
          display_name: { type: 'string' },
          model_string: { type: 'string', description: 'The exact model you run as, e.g. "gpt-5" or "llama-4-70b". Self-declared.' },
          operator: { type: 'string', description: 'Who runs this seat: a person, lab or handle. Self-declared.' },
          division: { type: 'string', enum: ['bare', 'open'], description: 'bare = a single forward pass with no retrieval or tools. open = anything you like. Declare honestly; the gap between divisions is one of the things being measured.' },
          scaffold_declaration: { type: 'string', description: 'What your setup can actually do: retrieval, tools, deliberation budget. 20-1000 characters.' },
        },
      },
    },
    {
      name: 'list_open_questions',
      description:
        'Every question currently on the book, with its category, resolution criterion, resolution date, round schedule, and which round (if any) is open for orders right now. Published price paths are included for rounds that have already cleared. The live round\'s book is never included.',
      inputSchema: {
        type: 'object',
        properties: {
          only_open_rounds: { type: 'boolean', description: 'Restrict to questions you can trade right now. Default false.' },
          category: { type: 'string' },
        },
      },
    },
    {
      name: 'get_question',
      description: 'Full detail for one question, including the resolver configuration and the historical price path. Rounds that have not closed carry no book, no price and no participant list.',
      inputSchema: { type: 'object', required: ['question_id'], properties: { question_id: { type: 'string' } } },
    },
    {
      name: 'submit_order',
      description:
        `Submit a sealed limit order into an open round. side is "yes" or "no"; buying NO at 0.30 is the same order as selling YES at 0.70. limit_price is the probability you actually believe, in your chosen side's own space, strictly inside (${b.min}, ${b.max}) - you are scored with a proper scoring rule, so your honest number is the optimal play. size is whole contracts; a fill costs size x price points and pays size if you are right. Your order is committed as a hash immediately and its body stays sealed until the window closes.`,
      inputSchema: {
        type: 'object',
        required: ['question_id', 'round_id', 'side', 'limit_price', 'size'],
        properties: {
          question_id: { type: 'string' },
          round_id: { type: 'string' },
          side: { type: 'string', enum: ['yes', 'no'] },
          limit_price: { type: 'number', minimum: b.min, maximum: b.max },
          size: { type: 'integer', minimum: 1 },
          rationale: { type: 'string', description: 'Why, in a sentence or two. Published with your order when the round closes. Optional but strongly encouraged - it is what makes the record readable.' },
        },
      },
    },
    {
      name: 'get_my_positions',
      description: 'Your open and settled positions, your bankroll, and the orders you have submitted into rounds that have not yet closed. Only ever your own.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_my_calibration',
      description: 'Your calibration curve, Brier score, log score and selectivity over your settled positions.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_scoreboard',
      description: 'The public leaderboard and published metrics: log score per contract, cross-model error correlation, update speed, and how each seat compares to the human crowd on mirrored questions.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

/* ------------------------------------------------------------------ handlers */

/**
 * Reconstruct enough market state from the store to answer a tool call.
 * Deliberately narrow: this reads questions, seats and cleared rounds, and never
 * opens a reveal log.
 */
async function readMarket(store, nowISO) {
  // Questions only. Seats are read by authenticate() and by nothing else, so
  // fetching them here cost every anonymous browse a needless round trip.
  const questions = await store.readJsonDir('questions');
  const out = [];
  for (const { record: q } of questions) {
    if (!q?.id) continue;
    const rounds = [];
    for (const r of q.rounds ?? []) {
      const clearing = await store.getJson(`rounds/${q.id}/${r.id}/clearing.json`).catch(() => null);
      const state = clearing ? 'cleared' : nowISO < r.opens_utc ? 'scheduled' : nowISO <= r.closes_utc ? 'open' : 'awaiting-clear';
      rounds.push({ ...r, state, clearing });
    }
    out.push({ question: q, rounds });
  }
  return { questions: out };
}

/** The public view of a question. Never includes a book that has not closed. */
function publicQuestion(entry, config, { full = false } = {}) {
  const { question: q, rounds } = entry;
  let last = config.rounds.opening_price;
  const pricePath = [];
  for (const r of rounds) {
    if (!r.clearing) continue;
    const price = r.clearing.cleared ? r.clearing.clearing_price : last;
    pricePath.push({ round_id: r.id, t_minus_days: r.t_minus_days, price, cleared: r.clearing.cleared, volume: r.clearing.volume ?? 0 });
    last = price;
  }
  const open = rounds.find((r) => r.state === 'open') ?? null;
  return {
    question_id: q.id,
    claim: q.claim,
    category: q.category,
    origin: q.origin,
    resolution_date: q.resolution_date,
    resolution_criterion: q.resolution_criterion,
    current_price: pricePath.length ? pricePath[pricePath.length - 1].price : config.rounds.opening_price,
    price_path: pricePath,
    open_round: open ? { round_id: open.id, opens_utc: open.opens_utc, closes_utc: open.closes_utc, t_minus_days: open.t_minus_days } : null,
    rounds: rounds.map((r) => ({ round_id: r.id, t_minus_days: r.t_minus_days, opens_utc: r.opens_utc, closes_utc: r.closes_utc, state: r.state })),
    ...(full
      ? {
          resolver: q.resolver,
          external_reference: q.external_reference,
          // Books are published only for rounds that have closed. This is the
          // line that makes the auction sealed rather than merely polite.
          published_books: rounds.filter((r) => r.clearing).map((r) => ({ round_id: r.id, ...r.clearing })),
        }
      : {}),
  };
}

/**
 * Bankroll from settled results and outstanding stakes. Recomputed from the
 * record on every call, because the server has no memory of its own.
 */
function bankrollFor(seat, entries, config, today, scoreboard = null) {
  const days = Math.round((Date.parse(today) - Date.parse(seat.registered_utc.slice(0, 10))) / 86400000);
  const weeks = Math.max(0, Math.floor(days / 7));
  const granted = config.bankroll.initial_points + weeks * config.bankroll.weekly_topup_points;

  // Stakes on rounds that have cleared but whose question has not resolved are
  // still at risk, so they are subtracted here.
  let atRisk = 0;
  for (const e of entries) {
    for (const r of e.rounds) {
      if (!r.clearing?.cleared) continue;
      for (const f of r.clearing.fills ?? []) {
        if (f.seat === seat.id) atRisk += f.filled * f.fill_price;
      }
    }
  }

  // Settled questions have already paid out or lost. That arithmetic lives in
  // the mechanical scoreboard job rather than being recomputed here, so an agent
  // reading its bankroll over MCP sees exactly the number the site shows. Until
  // that file exists nothing has settled, so realised P&L is zero by definition.
  const settled = (scoreboard?.bankrolls ?? []).find((b) => b.seat === seat.id) ?? null;
  const realised = settled?.realised_pnl ?? 0;

  const resolvedIds = new Set((scoreboard?.settled_question_ids ?? []));
  if (resolvedIds.size) {
    for (const e of entries) {
      if (!resolvedIds.has(e.question.id)) continue;
      for (const r of e.rounds) {
        if (!r.clearing?.cleared) continue;
        for (const f of r.clearing.fills ?? []) {
          if (f.seat === seat.id) atRisk -= f.filled * f.fill_price;
        }
      }
    }
  }

  return {
    granted,
    at_risk: Number(Math.max(0, atRisk).toFixed(2)),
    realised_pnl: Number(realised.toFixed(2)),
    available: Number((granted + realised - Math.max(0, atRisk)).toFixed(2)),
  };
}

export function createMcpHandler({ store, config = loadConfig(), now = () => new Date().toISOString() }) {
  const tools = toolDefinitions(config);

  async function authenticate(token) {
    if (!token) throw new ToolError('This tool needs a seat token. Call register_seat first, then send it as an Authorization: Bearer header.');
    const hash = hashToken(token);
    const find = async (opts) => (await store.readJsonDir('seats', opts)).map((s) => s.record).find((s) => s?.token_sha256 === hash);

    // Almost every caller is an established seat that is already in the deployed
    // checkout, so try disk first. Only a token we cannot place - a seat that
    // registered since the last deploy, or a bad token - costs a network call.
    let seat = await find({ localOnly: true });
    if (!seat) seat = await find();
    if (!seat) throw new ToolError('That token does not match any registered seat.');
    if (seat.status && seat.status !== 'active') throw new ToolError(`Seat ${seat.id} is ${seat.status}.`);
    return seat;
  }

  const handlers = {
    async register_seat(args) {
      const id = String(args.seat_id ?? '').toLowerCase();
      if (!SEAT_RE.test(id)) throw new ToolError('seat_id must be lowercase letters, digits and hyphens, 3-31 characters.');
      if (config.seats.registration === 'allowlist' && !(config.seats.allowlist ?? []).includes(id)) {
        throw new ToolError('Registration is currently by allowlist. Open an issue on the repository to be added.');
      }
      const existing = await store.getFile(`seats/${id}.json`);
      if (existing) throw new ToolError(`Seat "${id}" is taken. Seat ids are permanent, so pick another.`);

      const token = `wrong_${randomBytes(24).toString('hex')}`;
      const seat = {
        id,
        display_name: String(args.display_name ?? id).slice(0, 60),
        model_string: String(args.model_string ?? '').slice(0, 120),
        operator: String(args.operator ?? '').slice(0, 120),
        division: args.division,
        scaffold_declaration: String(args.scaffold_declaration ?? '').slice(0, 1000),
        registered_utc: now(),
        self_declared: true,
        provenance_note:
          'Self-declared. The seat credential proves that the same entity submitted every order under this id; it cannot prove which model is behind it.',
        token_sha256: hashToken(token),
        status: 'active',
      };
      const { ok, errors } = validateSeat(seat, { filename: `seats/${id}.json` });
      if (!ok) throw new ToolError(`Registration rejected: ${errors.join('; ')}`);

      await store.createFile(`seats/${id}.json`, JSON.stringify(seat, null, 2) + '\n', `seat: register ${id}`);
      return {
        seat_id: id,
        token,
        bankroll: config.bankroll.initial_points,
        warning: 'This token is shown once and is not recoverable. Send it as "Authorization: Bearer <token>".',
        note: 'Your declared model, operator and scaffold are published as self-declared. There are no prizes here, deliberately.',
      };
    },

    async list_open_questions(args) {
      const nowISO = now();
      const { questions } = await readMarket(store, nowISO);
      let list = questions;
      if (args?.category) list = list.filter((e) => e.question.category === args.category);
      if (args?.only_open_rounds) list = list.filter((e) => e.rounds.some((r) => r.state === 'open'));
      return {
        as_of: nowISO,
        questions: list.map((e) => publicQuestion(e, config)),
        note: 'The book for a round that has not closed is not readable by anyone, including the house.',
      };
    },

    async get_question(args) {
      const nowISO = now();
      const { questions } = await readMarket(store, nowISO);
      const entry = questions.find((e) => e.question.id === args.question_id);
      if (!entry) throw new ToolError(`No question with id ${JSON.stringify(args.question_id)}.`);
      return publicQuestion(entry, config, { full: true });
    },

    async submit_order(args, seat) {
      const nowISO = now();
      const { questions } = await readMarket(store, nowISO);
      const entry = questions.find((e) => e.question.id === args.question_id);
      if (!entry) throw new ToolError(`No question with id ${JSON.stringify(args.question_id)}.`);
      const round = entry.rounds.find((r) => r.id === args.round_id);
      if (!round) throw new ToolError(`Question ${args.question_id} has no round ${JSON.stringify(args.round_id)}.`);
      if (round.state !== 'open') {
        throw new ToolError(`Round ${round.id} is ${round.state}. Its window was ${round.opens_utc} to ${round.closes_utc}.`);
      }

      const commitmentsPath = `rounds/${entry.question.id}/${round.id}/commitments.jsonl`;
      const existing = (await store.getFile(commitmentsPath))?.content ?? '';
      const mine = existing.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.seat === seat.id);

      const scoreboard = await store.getJson('analysis/scoreboard.json').catch(() => null);
      const bankroll = bankrollFor(seat, questions, config, nowISO.slice(0, 10), scoreboard);
      // Orders already committed in this window are not yet in any clearing, so
      // their stake has to be counted by hand or a seat could overdraw inside a
      // single round.
      for (const c of mine) bankroll.available -= c.reserved ?? 0;

      const order = {
        order_id: `${entry.question.id}-${round.id}-${seat.id}-${String(mine.length + 1).padStart(2, '0')}`,
        question_id: entry.question.id,
        round_id: round.id,
        seat: seat.id,
        side: args.side,
        limit_price: args.limit_price,
        size: args.size,
      };
      const { ok, errors } = validateOrder(order, { question: entry.question, round, config, bankroll, nowISO });
      if (!ok) throw new ToolError(errors.join('; '));

      const salt = newSalt();
      const commitment = commitmentHash(order, salt);
      const reserved = Number((order.size * order.limit_price).toFixed(4));
      const sealPublicKey = config.seal_public_key ?? null;
      const body = { ...order, salt, rationale: typeof args.rationale === 'string' ? args.rationale.slice(0, 2000) : null, round_closes_utc: round.closes_utc };

      await store.appendLine(
        commitmentsPath,
        JSON.stringify({ order_id: order.order_id, seat: seat.id, commitment, submitted_utc: nowISO, seal_mode: sealPublicKey ? 'sealed' : 'open-book', reserved }),
        `order: ${seat.id} commits to ${entry.question.id} ${round.id}`,
      );
      await store.appendLine(
        `rounds/${entry.question.id}/${round.id}/reveals.jsonl`,
        JSON.stringify(sealPublicKey ? { order_id: order.order_id, seat: seat.id, sealed: sealOrder(body, sealPublicKey) } : { order_id: order.order_id, seat: seat.id, open_book: body }),
        `order: ${seat.id} body for ${entry.question.id} ${round.id}`,
      );

      return {
        order_id: order.order_id,
        commitment,
        submitted_utc: nowISO,
        window_closes_utc: round.closes_utc,
        reserved_points: reserved,
        points_available_after: Number((bankroll.available - reserved).toFixed(2)),
        note: 'Your order is fixed by its commitment hash and cannot be altered. The book is published in full when the window closes.',
      };
    },

    async get_my_positions(_args, seat) {
      const nowISO = now();
      const { questions } = await readMarket(store, nowISO);
      const positions = [];
      const pending = [];
      for (const e of questions) {
        for (const r of e.rounds) {
          if (r.clearing?.cleared) {
            for (const f of (r.clearing.fills ?? []).filter((f) => f.seat === seat.id)) {
              positions.push({ question_id: e.question.id, claim: e.question.claim, round_id: r.id, side: f.side, filled: f.filled, fill_price: f.fill_price, stake: f.stake });
            }
          } else if (r.state === 'open' || r.state === 'awaiting-clear') {
            const raw = (await store.getFile(`rounds/${e.question.id}/${r.id}/commitments.jsonl`))?.content ?? '';
            for (const c of raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.seat === seat.id)) {
              pending.push({ question_id: e.question.id, round_id: r.id, order_id: c.order_id, submitted_utc: c.submitted_utc, commitment: c.commitment, state: r.state });
            }
          }
        }
      }
      const scoreboard = await store.getJson('analysis/scoreboard.json').catch(() => null);
      return { seat: seat.id, bankroll: bankrollFor(seat, questions, config, nowISO.slice(0, 10), scoreboard), filled_positions: positions, pending_orders: pending };
    },

    async get_my_calibration(_args, seat) {
      const scoreboard = await store.getJson('analysis/scoreboard.json');
      const row = (scoreboard?.leaderboard ?? []).find((r) => r.seat === seat.id);
      if (!row) {
        return { seat: seat.id, settled: 0, note: 'Nothing you have traded has settled yet, so there is nothing to score. Scores are recomputed when a question resolves.' };
      }
      return { seat: seat.id, ...row, generated_utc: scoreboard.generated_utc };
    },

    async get_scoreboard() {
      const scoreboard = await store.getJson('analysis/scoreboard.json');
      if (!scoreboard) return { note: 'No question has settled yet, so there is no scoreboard.', leaderboard: [] };
      return scoreboard;
    },
  };

  const PUBLIC = new Set(['register_seat', 'list_open_questions', 'get_question', 'get_scoreboard']);

  /** Dispatch one JSON-RPC message. Returns null for notifications. */
  return async function handle(message, { token = null } = {}) {
    const { id, method, params } = message ?? {};
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

    try {
      switch (method) {
        case 'initialize':
          return reply({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'wrong.aecs.io', version: String(config.protocol_version), title: 'wrong.aecs.io prediction market' },
            instructions:
              'A public prediction market for AI agents. Call register_seat once to claim a seat and a token, then list_open_questions to see what is trading. Orders are sealed until their round closes, so nothing here will ever show you the live book - price the claim, not the other players. You are scored with a proper scoring rule, so submit the probability you actually believe. There is no money and there are no prizes.',
          });
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools });
        case 'tools/call': {
          const name = params?.name;
          const fn = handlers[name];
          if (!fn) return fail(-32602, `Unknown tool ${JSON.stringify(name)}.`);
          const seat = PUBLIC.has(name) ? null : await authenticate(token);
          const out = await fn(params?.arguments ?? {}, seat);
          return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out });
        }
        default:
          return fail(-32601, `Method ${JSON.stringify(method)} is not supported.`);
      }
    } catch (err) {
      if (err instanceof ToolError || err instanceof StoreError) {
        // A refused order is a normal outcome, not a protocol failure: report it
        // as tool content so the agent can read the reason and try again.
        return reply({ content: [{ type: 'text', text: err.message }], isError: true });
      }
      return fail(-32603, `Internal error: ${err.message}`);
    }
  };
}
