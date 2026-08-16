import { httpGetJson, SourceError, requireString } from './util.js';

/**
 * Manifold Markets: the second crowd reference.
 *
 * Metaculus is the better benchmark - real forecasters, real reputations - but
 * its API refuses datacenter traffic without a token, and a scheduled ledger
 * cannot depend on a source that returns 403 to its own runner. Manifold's API
 * is open, its crowd is large, and its play-money markets are calibrated well
 * enough to be a meaningful opponent. Both are supported; the slate takes
 * whichever answers.
 */

const MARKET_URL = (id) => `https://api.manifold.markets/v0/market/${encodeURIComponent(id)}`;

/** Normalise Manifold's resolution strings into our four states. */
export function normaliseResolution(market) {
  if (!market || typeof market !== 'object') {
    throw new SourceError('unrecognised Manifold response shape');
  }
  if (!market.isResolved) return { status: 'pending', label: 'open' };
  const raw = String(market.resolution ?? '').trim().toUpperCase();
  if (raw === 'YES') return { status: 'yes', label: 'YES' };
  if (raw === 'NO') return { status: 'no', label: 'NO' };
  if (raw === 'CANCEL' || raw === 'N/A') return { status: 'void', label: raw };
  // MKT means the market resolved to a probability rather than an outcome. That
  // is not a binary answer, so it cannot score a binary forecast.
  if (raw === 'MKT') return { status: 'void', label: `MKT (${market.resolutionProbability ?? '?'})` };
  return { status: 'void', label: `unhandled resolution "${market.resolution}"` };
}

/** The crowd's current probability, for the snapshot recorded at authoring time. */
export function communityProbability(market) {
  const p = market?.probability;
  return typeof p === 'number' && p >= 0 && p <= 1 ? p : null;
}

export default {
  type: 'manifold',

  validateConfig(cfg) {
    const errors = [];
    requireString(cfg, 'market_id', errors, { pattern: /^[A-Za-z0-9_-]{4,64}$/ });
    if (cfg.expect !== undefined && !['yes', 'no'].includes(cfg.expect)) {
      errors.push('`expect`, if present, must be "yes" or "no"');
    }
    return errors;
  },

  async resolve(cfg, ctx = {}) {
    const market = await httpGetJson(MARKET_URL(cfg.market_id), ctx);
    const norm = normaliseResolution(market);
    const url = market.url ?? MARKET_URL(cfg.market_id);

    if (norm.status === 'pending') {
      return { status: 'pending', observed: null, detail: `Manifold market ${cfg.market_id} is still open (${url})` };
    }
    if (norm.status === 'void') {
      return { status: 'void', observed: norm.label, detail: `Manifold resolved market ${cfg.market_id} as ${norm.label} - not a binary outcome (${url})` };
    }
    const expect = cfg.expect ?? 'yes';
    const matched = norm.status === expect;
    return {
      status: matched ? 'yes' : 'no',
      observed: norm.status,
      detail: `Manifold resolved market ${cfg.market_id} as ${norm.status.toUpperCase()}; criterion expected ${expect.toUpperCase()} (${url})`,
    };
  },

  async probe(cfg, ctx = {}) {
    const market = await httpGetJson(MARKET_URL(cfg.market_id), ctx);
    if (typeof market?.id !== 'string') throw new SourceError(`Manifold market ${cfg.market_id} returned no id`);
    return `Manifold market ${cfg.market_id} readable`;
  },
};
