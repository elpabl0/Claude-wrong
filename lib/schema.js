import { loadConfig, daysBetween } from './config.js';
import { getResolver } from './resolvers/index.js';

const ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{2,60}$/;
const SEAT_RE = /^[a-z0-9][a-z0-9-]{2,30}$/;
const ROUND_RE = /^r\d{1,2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

const ORIGINS = ['house', 'mirrored'];
const PLATFORMS = ['metaculus', 'manifold'];
const DIVISIONS = ['bare', 'open'];
const SIDES = ['yes', 'no'];
const RESOLUTION_STATUSES = ['yes', 'no', 'void'];

class Check {
  constructor(label) {
    this.label = label;
    this.errors = [];
  }
  fail(msg) {
    this.errors.push(`${this.label}: ${msg}`);
    return false;
  }
  str(obj, key, { min = 1, max = 20000, pattern = null } = {}) {
    const v = obj?.[key];
    if (typeof v !== 'string') return this.fail(`\`${key}\` must be a string`);
    if (v.length < min) return this.fail(`\`${key}\` must be at least ${min} characters (got ${v.length})`);
    if (v.length > max) return this.fail(`\`${key}\` must be at most ${max} characters (got ${v.length})`);
    if (pattern && !pattern.test(v)) return this.fail(`\`${key}\` does not match ${pattern}`);
    return true;
  }
  num(obj, key, { min = -Infinity, max = Infinity, integer = false, exclusive = false } = {}) {
    const v = obj?.[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return this.fail(`\`${key}\` must be a finite number`);
    if (integer && !Number.isInteger(v)) return this.fail(`\`${key}\` must be an integer`);
    const bad = exclusive ? v <= min || v >= max : v < min || v > max;
    if (bad) return this.fail(`\`${key}\` must be within ${exclusive ? '(' : '['}${min}, ${max}${exclusive ? ')' : ']'} (got ${v})`);
    return true;
  }
  oneOf(obj, key, allowed) {
    if (!allowed.includes(obj?.[key])) return this.fail(`\`${key}\` must be one of ${allowed.join(', ')} (got ${JSON.stringify(obj?.[key])})`);
    return true;
  }
}

/* ------------------------------------------------------------------ question */

export function validateQuestion(rec, { config = loadConfig(), filename = null } = {}) {
  const c = new Check(filename ?? rec?.id ?? '<unknown>');
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    c.fail('record must be a JSON object');
    return { ok: false, errors: c.errors };
  }

  c.str(rec, 'id', { pattern: ID_RE });
  c.str(rec, 'created_utc', { pattern: DATETIME_RE });
  c.str(rec, 'author_model', { min: 3 });
  c.num(rec, 'protocol_version', { min: 1, integer: true });
  c.str(rec, 'claim', { min: 25, max: 500 });
  c.str(rec, 'resolution_date', { pattern: DATE_RE });
  c.str(rec, 'resolution_criterion', { min: 40, max: 2000 });
  c.oneOf(rec, 'origin', ORIGINS);

  if (!Object.prototype.hasOwnProperty.call(config.questions.categories, rec.category)) {
    c.fail(`\`category\` must be one of ${Object.keys(config.questions.categories).join(', ')} (got ${JSON.stringify(rec.category)})`);
  }

  if (typeof rec.id === 'string' && typeof rec.created_utc === 'string' && !rec.id.startsWith(rec.created_utc.slice(0, 10) + '-')) {
    c.fail('`id` must begin with the creation date, so a question cannot be quietly re-dated');
  }

  if (typeof rec.created_utc === 'string' && typeof rec.resolution_date === 'string' && DATE_RE.test(rec.resolution_date)) {
    const span = daysBetween(rec.created_utc.slice(0, 10), rec.resolution_date);
    const maxDays = config.scoring.horizon_buckets[config.scoring.horizon_buckets.length - 1].max_days;
    if (span < 7) c.fail(`horizon of ${span} days is too short to run rounds against`);
    else if (span > maxDays) c.fail(`horizon of ${span} days exceeds the maximum of ${maxDays}`);
  }

  // The resolver IS the question. A criterion needing interpretation is a
  // criterion that can be interpreted favourably once the answer is known.
  const r = rec.resolver;
  if (!r || typeof r !== 'object' || typeof r.type !== 'string') {
    c.fail('`resolver` must be an object with a `type`');
  } else if (!config.questions.allowed_resolver_types.includes(r.type)) {
    c.fail(`resolver type \`${r.type}\` is not allowed (${config.questions.allowed_resolver_types.join(', ')})`);
  } else {
    const impl = getResolver(r.type);
    if (!impl) c.fail(`no implementation for resolver type \`${r.type}\``);
    else for (const e of impl.validateConfig(r)) c.fail(`resolver: ${e}`);
  }

  // Rounds are fixed at creation. A schedule that could be edited later is a
  // schedule that could be edited once the news is in.
  if (!Array.isArray(rec.rounds) || rec.rounds.length < 1) {
    c.fail('`rounds` must be a non-empty array, fixed at creation');
  } else {
    let previousClose = null;
    for (const [i, round] of rec.rounds.entries()) {
      const rc = new Check(`${c.label}.rounds[${i}]`);
      rc.str(round, 'id', { pattern: ROUND_RE });
      rc.str(round, 'opens_utc', { pattern: DATETIME_RE });
      rc.str(round, 'closes_utc', { pattern: DATETIME_RE });
      rc.num(round, 't_minus_days', { min: 0, max: 400, integer: true });
      c.errors.push(...rc.errors);
      if (round.opens_utc >= round.closes_utc) c.fail(`rounds[${i}]: closes_utc must be after opens_utc`);
      if (previousClose && round.opens_utc < previousClose) c.fail(`rounds[${i}]: overlaps the previous round`);
      if (typeof rec.resolution_date === 'string' && round.closes_utc.slice(0, 10) >= rec.resolution_date) {
        c.fail(`rounds[${i}]: closes on or after the resolution date, so it would trade on a known answer`);
      }
      previousClose = round.closes_utc;
    }
    if (new Set(rec.rounds.map((x) => x.id)).size !== rec.rounds.length) c.fail('`rounds` contains duplicate ids');
  }

  // A mirrored question is only a reference point if the crowd's number was read
  // from a committed slate at the same timestamp, not recalled.
  if (rec.origin === 'mirrored') {
    const x = rec.external_reference;
    if (!x || typeof x !== 'object') {
      c.fail('`external_reference` is required when `origin` is mirrored');
    } else {
      const xc = new Check(`${c.label}.external_reference`);
      xc.oneOf(x, 'platform', PLATFORMS);
      xc.str(x, 'question_id', { min: 1, max: 64 });
      xc.num(x, 'community_probability', { min: 0, max: 1 });
      xc.str(x, 'snapshot_utc', { pattern: DATETIME_RE });
      xc.str(x, 'url', { min: 10 });
      c.errors.push(...xc.errors);
      if (rec.resolver?.type !== x.platform) {
        c.fail(`a mirrored question on ${x.platform} must use the \`${x.platform}\` resolver (got \`${rec.resolver?.type}\`)`);
      } else {
        const target = x.platform === 'metaculus' ? rec.resolver.post_id : rec.resolver.market_id;
        if (String(target) !== String(x.question_id)) {
          c.fail(`resolver targets ${JSON.stringify(target)} but the external reference is question ${JSON.stringify(x.question_id)}`);
        }
      }
      if (typeof x.snapshot_utc === 'string' && typeof rec.created_utc === 'string' && x.snapshot_utc.slice(0, 10) !== rec.created_utc.slice(0, 10)) {
        c.fail('`external_reference.snapshot_utc` must be taken on the day the question was written');
      }
    }
  } else if (rec.external_reference != null) {
    c.fail('`external_reference` must be null unless `origin` is mirrored');
  }

  return { ok: c.errors.length === 0, errors: c.errors };
}

/* --------------------------------------------------------------------- seat */

export function validateSeat(rec, { filename = null } = {}) {
  const c = new Check(filename ?? rec?.id ?? '<unknown>');
  c.str(rec, 'id', { pattern: SEAT_RE });
  c.str(rec, 'display_name', { min: 2, max: 60 });
  c.str(rec, 'model_string', { min: 3, max: 120 });
  c.str(rec, 'operator', { min: 2, max: 120 });
  c.str(rec, 'scaffold_declaration', { min: 20, max: 1000 });
  c.oneOf(rec, 'division', DIVISIONS);
  c.str(rec, 'registered_utc', { pattern: DATETIME_RE });
  // The token itself is never stored - only a hash of it. A repository that
  // contains a bearer credential has handed one out.
  if (rec?.token_sha256 != null) c.str(rec, 'token_sha256', { pattern: HEX64_RE });
  if (rec?.token != null) c.fail('`token` must never be committed; store only `token_sha256`');
  if (rec?.self_declared !== true) c.fail('`self_declared` must be true - the token authenticates the seat, never the claim about which model is behind it');
  return { ok: c.errors.length === 0, errors: c.errors };
}

/* -------------------------------------------------------------------- order */

/** Validate a submitted order against its question, round, and the seat's bankroll. */
export function validateOrder(order, { question, round, config = loadConfig(), bankroll = null, nowISO = null } = {}) {
  const c = new Check(order?.order_id ?? '<unknown order>');
  c.str(order, 'order_id', { min: 8, max: 80 });
  c.str(order, 'question_id', { pattern: ID_RE });
  c.str(order, 'round_id', { pattern: ROUND_RE });
  c.str(order, 'seat', { pattern: SEAT_RE });
  c.oneOf(order, 'side', SIDES);

  const b = config.orders.price_bounds;
  c.num(order, 'limit_price', { min: b.min, max: b.max });
  c.num(order, 'size', { min: config.bankroll.min_order_size, integer: true });

  if (question && order?.question_id !== question.id) c.fail('`question_id` does not match the question');
  if (round && order?.round_id !== round.id) c.fail('`round_id` does not match the round');

  if (round && nowISO) {
    if (nowISO < round.opens_utc) c.fail(`the ${round.id} window does not open until ${round.opens_utc}`);
    if (nowISO > round.closes_utc) c.fail(`the ${round.id} window closed at ${round.closes_utc}`);
  }

  // Cost is the maximum this order can lose, which is what the bankroll must cover.
  if (typeof order?.size === 'number' && typeof order?.limit_price === 'number') {
    const cost = order.size * order.limit_price;
    if (bankroll) {
      if (cost > bankroll.available + 1e-9) {
        c.fail(`stakes ${cost.toFixed(2)} points but only ${bankroll.available.toFixed(2)} are available`);
      }
      const cap = bankroll.granted * config.bankroll.max_stake_fraction_per_order;
      if (cost > cap + 1e-9) {
        c.fail(`stakes ${cost.toFixed(2)} points, above the ${(config.bankroll.max_stake_fraction_per_order * 100).toFixed(0)}% single-order cap of ${cap.toFixed(2)}`);
      }
    }
  }

  return { ok: c.errors.length === 0, errors: c.errors };
}

/* --------------------------------------------------------------- resolution */

export function validateResolution(rec, question = null, { filename = null } = {}) {
  const c = new Check(filename ?? rec?.question_id ?? '<unknown>');
  c.str(rec, 'question_id', { pattern: ID_RE });
  c.str(rec, 'resolved_utc', { pattern: DATETIME_RE });
  c.oneOf(rec, 'status', RESOLUTION_STATUSES);
  c.str(rec, 'detail', { min: 1, max: 4000 });
  c.str(rec, 'resolver_type', { min: 2 });
  if (!Array.isArray(rec?.attempts) || rec.attempts.length < 1) {
    c.fail('`attempts` must be a non-empty array - the resolution log is the evidence');
  }
  if (rec?.status === 'void') c.str(rec, 'void_reason', { min: 10 });
  if (question && rec?.question_id !== question.id) c.fail('`question_id` does not match its question');
  return { ok: c.errors.length === 0, errors: c.errors };
}

export { ID_RE, SEAT_RE, ROUND_RE, DATE_RE, DATETIME_RE, ORIGINS, PLATFORMS, DIVISIONS, SIDES, RESOLUTION_STATUSES };
