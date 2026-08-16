import { httpGet, compare, OPS, SourceError } from './util.js';

const ENDPOINT = 'https://export.arxiv.org/api/query';

/** Pull the total-results count out of the arXiv Atom response. */
export function parseTotalResults(xml) {
  const m = xml.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/i);
  if (!m) throw new SourceError('arXiv response did not contain an opensearch:totalResults element');
  return Number(m[1]);
}

export default {
  type: 'arxiv',

  validateConfig(cfg) {
    const errors = [];
    if (typeof cfg.search_query !== 'string' || cfg.search_query.length < 3) {
      errors.push('`search_query` must be an arXiv API search_query string, e.g. `all:"chain of thought" AND cat:cs.LG`');
    }
    if (!Object.keys(OPS).includes(cfg.op)) errors.push(`\`op\` must be one of ${Object.keys(OPS).join(' ')}`);
    if (typeof cfg.value !== 'number') errors.push('`value` must be the numeric threshold on the result count');
    if (cfg.from_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(cfg.from_date)) {
      errors.push('`from_date`, if present, must be YYYY-MM-DD');
    }
    return errors;
  },

  /**
   * Count arXiv submissions matching a query fixed in advance and compare to a
   * threshold. `from_date`/`to_date` are folded into the query as a
   * submittedDate range so the count is stable however late it is run.
   */
  async resolve(cfg, ctx = {}) {
    let query = cfg.search_query;
    if (cfg.from_date || cfg.to_date) {
      const from = (cfg.from_date ?? '1991-01-01').replace(/-/g, '') + '0000';
      const to = (cfg.to_date ?? '2999-12-31').replace(/-/g, '') + '2359';
      query = `(${query}) AND submittedDate:[${from} TO ${to}]`;
    }
    const url = `${ENDPOINT}?search_query=${encodeURIComponent(query)}&start=0&max_results=1`;
    const { text } = await httpGet(url, { ...ctx, accept: 'application/atom+xml' });
    const total = parseTotalResults(text);
    const matched = compare(total, cfg.op, cfg.value);
    return {
      status: matched ? 'yes' : 'no',
      observed: total,
      detail: `arXiv reports ${total} results for \`${query}\`; criterion was ${cfg.op} ${cfg.value} → ${matched ? 'YES' : 'NO'}`,
    };
  },

  async probe(cfg, ctx = {}) {
    const url = `${ENDPOINT}?search_query=${encodeURIComponent(cfg.search_query)}&start=0&max_results=1`;
    const { text } = await httpGet(url, { ...ctx, accept: 'application/atom+xml' });
    parseTotalResults(text);
    return 'arXiv query endpoint reachable';
  },
};
