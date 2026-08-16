import { loadConfig, daysBetween } from './config.js';
import { getResolver } from './resolvers/index.js';

const ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{2,60}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const CLAIM_TYPES = ['change', 'continuity'];
const ORIGINS = ['self', 'metaculus-mirror'];
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
    const v = obj[key];
    if (typeof v !== 'string') return this.fail(`\`${key}\` must be a string`);
    if (v.length < min) return this.fail(`\`${key}\` must be at least ${min} characters (got ${v.length})`);
    if (v.length > max) return this.fail(`\`${key}\` must be at most ${max} characters (got ${v.length})`);
    if (pattern && !pattern.test(v)) return this.fail(`\`${key}\` does not match ${pattern}`);
    return true;
  }
  num(obj, key, { min = -Infinity, max = Infinity, integer = false } = {}) {
    const v = obj[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return this.fail(`\`${key}\` must be a finite number`);
    if (integer && !Number.isInteger(v)) return this.fail(`\`${key}\` must be an integer`);
    if (v < min || v > max) return this.fail(`\`${key}\` must be within [${min}, ${max}] (got ${v})`);
    return true;
  }
  oneOf(obj, key, allowed) {
    if (!allowed.includes(obj[key])) return this.fail(`\`${key}\` must be one of ${allowed.join(', ')} (got ${JSON.stringify(obj[key])})`);
    return true;
  }
  arrOfStr(obj, key, { minItems = 1, minLen = 1 } = {}) {
    const v = obj[key];
    if (!Array.isArray(v)) return this.fail(`\`${key}\` must be an array`);
    if (v.length < minItems) return this.fail(`\`${key}\` needs at least ${minItems} entries (got ${v.length})`);
    for (const [i, s] of v.entries()) {
      if (typeof s !== 'string' || s.length < minLen) {
        return this.fail(`\`${key}[${i}]\` must be a string of at least ${minLen} characters`);
      }
    }
    return true;
  }
}

/**
 * Validate one prediction record.
 * Returns { ok, errors }. Never throws on bad input - callers report, they don't crash.
 */
export function validatePrediction(rec, { config = loadConfig(), filename = null } = {}) {
  const c = new Check(filename ?? rec?.id ?? '<unknown>');
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    c.fail('record must be a JSON object');
    return { ok: false, errors: c.errors };
  }

  c.str(rec, 'id', { pattern: ID_RE });
  c.str(rec, 'batch', { pattern: DATE_RE });
  c.str(rec, 'created_utc', { pattern: DATETIME_RE });
  c.str(rec, 'model', { min: 3 });
  c.num(rec, 'protocol_version', { min: 1, integer: true });
  c.str(rec, 'question', { min: 25, max: 500 });
  c.str(rec, 'resolution_date', { pattern: DATE_RE });
  c.str(rec, 'resolution_criterion', { min: 40, max: 2000 });
  c.str(rec, 'reasoning', { min: 150, max: 6000 });
  c.arrOfStr(rec, 'evidence_that_would_move_me', { minItems: 2, minLen: 15 });
  c.oneOf(rec, 'claim_type', CLAIM_TYPES);
  c.oneOf(rec, 'origin', ORIGINS);

  if (!Object.prototype.hasOwnProperty.call(config.categories, rec.category)) {
    c.fail(`\`category\` must be one of ${Object.keys(config.categories).join(', ')} (got ${JSON.stringify(rec.category)})`);
  }

  const ext = config.quotas.forbid_probability_extremes;
  c.num(rec, 'probability', { min: ext.min, max: ext.max });

  // The id must carry the batch date, so a file cannot be silently re-dated.
  if (typeof rec.id === 'string' && typeof rec.batch === 'string' && !rec.id.startsWith(rec.batch + '-')) {
    c.fail(`\`id\` must begin with \`batch\` (${rec.batch})`);
  }
  if (typeof rec.created_utc === 'string' && typeof rec.batch === 'string'
      && rec.created_utc.slice(0, 10) !== rec.batch) {
    c.fail('`created_utc` must fall on the `batch` date');
  }

  if (typeof rec.batch === 'string' && typeof rec.resolution_date === 'string'
      && DATE_RE.test(rec.batch) && DATE_RE.test(rec.resolution_date)) {
    const span = daysBetween(rec.batch, rec.resolution_date);
    const maxDays = config.horizon_buckets[config.horizon_buckets.length - 1].max_days;
    if (span < 1) c.fail('`resolution_date` must be after `batch`');
    else if (span > maxDays) c.fail(`horizon of ${span} days exceeds the maximum of ${maxDays}`);
  }

  // Resolver must be one of the allowed types and its own config must be valid.
  const r = rec.resolver;
  if (!r || typeof r !== 'object' || typeof r.type !== 'string') {
    c.fail('`resolver` must be an object with a `type`');
  } else if (!config.resolution.allowed_resolver_types.includes(r.type)) {
    c.fail(`resolver type \`${r.type}\` is not allowed (${config.resolution.allowed_resolver_types.join(', ')})`);
  } else {
    const impl = getResolver(r.type);
    if (!impl) c.fail(`no implementation for resolver type \`${r.type}\``);
    else for (const e of impl.validateConfig(r)) c.fail(`resolver: ${e}`);
  }

  // A mirrored question is only a reference point if the community's number is
  // captured at creation time, on the same question, from the same day.
  if (rec.origin === 'metaculus-mirror') {
    const x = rec.external_reference;
    if (!x || typeof x !== 'object') {
      c.fail('`external_reference` is required when `origin` is metaculus-mirror');
    } else {
      const xc = new Check(`${c.label}.external_reference`);
      xc.num(x, 'metaculus_post_id', { min: 1, integer: true });
      xc.num(x, 'community_probability', { min: 0, max: 1 });
      xc.str(x, 'snapshot_utc', { pattern: DATETIME_RE });
      xc.str(x, 'url', { min: 10 });
      c.errors.push(...xc.errors);
      if (rec.resolver?.type !== 'metaculus') {
        c.fail('a metaculus-mirror prediction must use the `metaculus` resolver');
      }
      if (typeof x.snapshot_utc === 'string' && typeof rec.batch === 'string'
          && x.snapshot_utc.slice(0, 10) !== rec.batch) {
        c.fail('`external_reference.snapshot_utc` must be taken on the batch date');
      }
    }
  } else if (rec.external_reference != null) {
    c.fail('`external_reference` must be null unless `origin` is metaculus-mirror');
  }

  return { ok: c.errors.length === 0, errors: c.errors };
}

/** Validate one resolution record against its prediction. */
export function validateResolution(rec, prediction = null, { filename = null } = {}) {
  const c = new Check(filename ?? rec?.id ?? '<unknown>');
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    c.fail('record must be a JSON object');
    return { ok: false, errors: c.errors };
  }
  c.str(rec, 'id', { pattern: ID_RE });
  c.str(rec, 'resolved_utc', { pattern: DATETIME_RE });
  c.oneOf(rec, 'status', RESOLUTION_STATUSES);
  c.str(rec, 'detail', { min: 1, max: 4000 });
  c.str(rec, 'resolver_type', { min: 2 });

  if (!Array.isArray(rec.attempts) || rec.attempts.length < 1) {
    c.fail('`attempts` must be a non-empty array - the resolution log is the evidence');
  }

  if (rec.status === 'void') {
    if (rec.brier !== null) c.fail('a void prediction must have `brier: null`');
    c.str(rec, 'void_reason', { min: 10 });
  } else {
    if (typeof rec.brier !== 'number') c.fail('`brier` must be a number for a resolved prediction');
    if (prediction) {
      const outcome = rec.status === 'yes' ? 1 : 0;
      const expected = (prediction.probability - outcome) ** 2;
      if (typeof rec.brier === 'number' && Math.abs(rec.brier - expected) > 1e-9) {
        c.fail(`\`brier\` is ${rec.brier} but (p - outcome)^2 is ${expected}`);
      }
    }
  }

  if (prediction && rec.id !== prediction.id) c.fail('`id` does not match its prediction');
  return { ok: c.errors.length === 0, errors: c.errors };
}

export { ID_RE, DATE_RE, DATETIME_RE, CLAIM_TYPES, ORIGINS, RESOLUTION_STATUSES };
