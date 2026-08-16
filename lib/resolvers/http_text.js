import { httpGet, compileRegex, requireHttpsUrl, SourceError } from './util.js';

/** Strip tags and collapse whitespace so a criterion is not defeated by markup. */
export function textContent(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export default {
  type: 'http_text',

  validateConfig(cfg) {
    const errors = [];
    requireHttpsUrl(cfg, 'url', errors);
    const hasPattern = typeof cfg.pattern === 'string' && cfg.pattern.length > 0;
    const hasContains = typeof cfg.contains === 'string' && cfg.contains.length > 0;
    if (hasPattern === hasContains) errors.push('exactly one of `pattern` (regex) or `contains` (literal) is required');
    if (hasPattern) {
      try {
        compileRegex(cfg.pattern, 'i');
      } catch (err) {
        errors.push(err.message);
      }
    }
    // A page that already satisfies the criterion is not a forecast about anything.
    if (cfg.absent_at_creation !== true) {
      errors.push('`absent_at_creation` must be true: confirm at authoring time that the pattern is NOT yet present, otherwise the question is already decided');
    }
    return errors;
  },

  /** YES if the pattern appears in the page's visible text. */
  async resolve(cfg, ctx = {}) {
    const { text } = await httpGet(cfg.url, { ...ctx, accept: 'text/html,application/xhtml+xml,*/*' });
    if (text.length === 0) throw new SourceError(`${cfg.url} returned an empty body`);
    const body = textContent(text);

    let matched, needle;
    if (cfg.pattern) {
      const re = compileRegex(cfg.pattern, 'i');
      matched = re.test(body);
      needle = `/${cfg.pattern}/i`;
    } else {
      matched = body.toLowerCase().includes(cfg.contains.toLowerCase());
      needle = JSON.stringify(cfg.contains);
    }
    return {
      status: matched ? 'yes' : 'no',
      observed: matched,
      detail: `${needle} ${matched ? 'found in' : 'absent from'} the visible text of ${cfg.url} (${body.length} characters read)`,
    };
  },

  async probe(cfg, ctx = {}) {
    const { text } = await httpGet(cfg.url, { ...ctx, accept: 'text/html,application/xhtml+xml,*/*' });
    if (textContent(text).length < 50) throw new SourceError(`${cfg.url} has almost no readable text - likely a client-rendered page this resolver cannot read`);
    return `${cfg.url} reachable with readable text`;
  },
};
