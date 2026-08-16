import { httpGetJson, jsonPointer, compare, requireHttpsUrl, OPS, SourceError, CriterionError } from './util.js';

const TRANSFORMS = {
  identity: (v) => v,
  length: (v) => {
    if (Array.isArray(v) || typeof v === 'string') return v.length;
    if (v && typeof v === 'object') return Object.keys(v).length;
    throw new SourceError(`cannot take the length of ${typeof v}`);
  },
  number: (v) => {
    const n = typeof v === 'string' ? Number(v.replace(/[, ]/g, '')) : Number(v);
    if (!Number.isFinite(n)) throw new SourceError(`value ${JSON.stringify(v)} is not numeric`);
    return n;
  },
  count_matching: null, // handled specially below
};

export default {
  type: 'json',

  validateConfig(cfg) {
    const errors = [];
    requireHttpsUrl(cfg, 'url', errors);
    if (typeof cfg.pointer !== 'string') errors.push('`pointer` must be an RFC 6901 JSON pointer string, e.g. "/data/0/value"');
    else if (cfg.pointer !== '' && !cfg.pointer.startsWith('/')) errors.push('`pointer` must start with "/" (or be "" for the whole document)');
    if (!Object.keys(OPS).includes(cfg.op)) errors.push(`\`op\` must be one of ${Object.keys(OPS).join(' ')}`);
    if (cfg.value === undefined) errors.push('`value` (the threshold, fixed in advance) is required');
    if (cfg.transform !== undefined && !Object.keys(TRANSFORMS).includes(cfg.transform)) {
      errors.push(`\`transform\`, if present, must be one of ${Object.keys(TRANSFORMS).join(', ')}`);
    }
    if (cfg.transform === 'count_matching' && typeof cfg.match_pointer !== 'string') {
      errors.push('`count_matching` requires `match_pointer` and `match_value`');
    }
    return errors;
  },

  /**
   * Read one value out of a JSON endpoint and compare it to a threshold that was
   * written down before the question was asked.
   */
  async resolve(cfg, ctx = {}) {
    const doc = await httpGetJson(cfg.url, { ...ctx, headers: cfg.headers ?? {} });
    const { found, value } = jsonPointer(doc, cfg.pointer);
    if (!found) {
      throw new SourceError(`pointer ${cfg.pointer} not present in the response from ${cfg.url}`);
    }

    let observed;
    if (cfg.transform === 'count_matching') {
      if (!Array.isArray(value)) throw new SourceError(`count_matching needs an array at ${cfg.pointer}`);
      observed = value.filter((item) => {
        const got = jsonPointer(item, cfg.match_pointer);
        return got.found && got.value === cfg.match_value;
      }).length;
    } else {
      const t = TRANSFORMS[cfg.transform ?? 'identity'];
      if (typeof t !== 'function') throw new CriterionError(`unusable transform ${cfg.transform}`);
      observed = t(value);
    }

    const matched = compare(observed, cfg.op, cfg.value);
    return {
      status: matched ? 'yes' : 'no',
      observed,
      detail: `${cfg.url} → ${cfg.pointer}${cfg.transform && cfg.transform !== 'identity' ? ` (${cfg.transform})` : ''} = ${JSON.stringify(observed)}; criterion was ${cfg.op} ${JSON.stringify(cfg.value)} → ${matched ? 'YES' : 'NO'}`,
    };
  },

  async probe(cfg, ctx = {}) {
    const doc = await httpGetJson(cfg.url, { ...ctx, headers: cfg.headers ?? {} });
    const { found } = jsonPointer(doc, cfg.pointer);
    if (!found) throw new SourceError(`pointer ${cfg.pointer} not present at ${cfg.url}`);
    return `${cfg.url} reachable and ${cfg.pointer} present`;
  },
};
