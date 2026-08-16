import { httpGetJson, SourceError, CriterionError } from './util.js';

const POST_URL = (id) => `https://www.metaculus.com/api/posts/${id}/`;
const LEGACY_URL = (id) => `https://www.metaculus.com/api2/questions/${id}/`;

/** Fetch a Metaculus post, falling back to the legacy endpoint if the current one moves. */
export async function fetchMetaculusPost(id, ctx = {}) {
  try {
    return await httpGetJson(POST_URL(id), ctx);
  } catch (err) {
    if (!(err instanceof SourceError)) throw err;
    return await httpGetJson(LEGACY_URL(id), ctx);
  }
}

/**
 * Pull the binary question body out of whichever response shape we got.
 * Metaculus has changed this structure before and may again, so we probe rather
 * than assume - a shape we do not recognise is a SourceError (retry, then void),
 * never a silent NO.
 */
export function extractQuestion(post) {
  if (post && typeof post === 'object') {
    if (post.question && typeof post.question === 'object') return post.question;
    if (post.resolution !== undefined || post.possibilities) return post;
  }
  throw new SourceError('unrecognised Metaculus response shape: no question body found');
}

/** Normalise Metaculus' several resolution encodings into our four states. */
export function normaliseResolution(raw) {
  if (raw === null || raw === undefined || raw === '') return { status: 'pending', label: 'unresolved' };
  if (typeof raw === 'number') {
    if (raw === 1) return { status: 'yes', label: '1' };
    if (raw === 0) return { status: 'no', label: '0' };
    if (raw === -1) return { status: 'void', label: 'ambiguous (-1)' };
    return { status: 'void', label: `unexpected numeric resolution ${raw}` };
  }
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'yes' || v === 'true') return { status: 'yes', label: raw };
    if (v === 'no' || v === 'false') return { status: 'no', label: raw };
    if (['annulled', 'ambiguous', 'void', 'cancelled', 'canceled'].includes(v)) {
      return { status: 'void', label: raw };
    }
    return { status: 'void', label: `non-binary resolution "${raw}"` };
  }
  return { status: 'void', label: `unhandled resolution type ${typeof raw}` };
}

/** Current community probability, if the response carries one. Used for mirrors. */
export function communityProbability(question) {
  const paths = [
    () => question?.aggregations?.recency_weighted?.latest?.centers?.[0],
    () => question?.aggregations?.recency_weighted?.latest?.center,
    () => question?.community_prediction?.full?.q2,
    () => question?.aggregations?.metaculus_prediction?.latest?.centers?.[0],
  ];
  for (const get of paths) {
    let v;
    try {
      v = get();
    } catch {
      continue;
    }
    if (typeof v === 'number' && v >= 0 && v <= 1) return v;
  }
  return null;
}

export default {
  type: 'metaculus',

  validateConfig(cfg) {
    const errors = [];
    if (!Number.isInteger(cfg.post_id) || cfg.post_id < 1) {
      errors.push('`post_id` must be a positive integer (the numeric id in the Metaculus URL)');
    }
    if (cfg.expect !== undefined && !['yes', 'no'].includes(cfg.expect)) {
      errors.push('`expect`, if present, must be "yes" or "no"');
    }
    return errors;
  },

  /**
   * YES when the Metaculus question resolves the way `expect` says (default "yes").
   * Pending until Metaculus itself resolves it; void if Metaculus annuls it.
   */
  async resolve(cfg, ctx = {}) {
    const post = await fetchMetaculusPost(cfg.post_id, ctx);
    const question = extractQuestion(post);
    const raw = question.resolution ?? post.resolution ?? null;
    const norm = normaliseResolution(raw);
    const url = `https://www.metaculus.com/questions/${cfg.post_id}/`;

    if (norm.status === 'pending') {
      return { status: 'pending', observed: null, detail: `Metaculus question ${cfg.post_id} is still open (${url})` };
    }
    if (norm.status === 'void') {
      return { status: 'void', observed: norm.label, detail: `Metaculus resolved question ${cfg.post_id} as ${norm.label} - not a binary outcome (${url})` };
    }
    const expect = cfg.expect ?? 'yes';
    const matched = norm.status === expect;
    return {
      status: matched ? 'yes' : 'no',
      observed: norm.status,
      detail: `Metaculus resolved question ${cfg.post_id} as ${norm.status.toUpperCase()}; criterion expected ${expect.toUpperCase()} (${url})`,
    };
  },

  /** Reachability probe used before the resolution date to catch dead sources early. */
  async probe(cfg, ctx = {}) {
    const post = await fetchMetaculusPost(cfg.post_id, ctx);
    extractQuestion(post);
    return `Metaculus post ${cfg.post_id} readable`;
  },
};

export { CriterionError };
