import { httpGetJson, compileRegex, SourceError } from './util.js';

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function authHeaders(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

export default {
  type: 'github_release',

  validateConfig(cfg) {
    const errors = [];
    if (typeof cfg.repo !== 'string' || !REPO_RE.test(cfg.repo)) {
      errors.push('`repo` must be "owner/name"');
    }
    if (typeof cfg.tag_pattern !== 'string' || cfg.tag_pattern.length === 0) {
      errors.push('`tag_pattern` must be a regular expression matched against release tag names');
    } else {
      try {
        compileRegex(cfg.tag_pattern);
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (cfg.include_prereleases !== undefined && typeof cfg.include_prereleases !== 'boolean') {
      errors.push('`include_prereleases`, if present, must be a boolean');
    }
    if (cfg.published_before !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(cfg.published_before)) {
      errors.push('`published_before`, if present, must be a YYYY-MM-DD date');
    }
    return errors;
  },

  /**
   * YES if the repository has published a release whose tag matches the pattern,
   * on or before the cutoff. Paginates so that a busy repo cannot hide an early
   * release behind a wall of later ones.
   */
  async resolve(cfg, ctx = {}) {
    const cutoff = cfg.published_before ? Date.parse(`${cfg.published_before}T23:59:59Z`) : Infinity;
    const re = compileRegex(cfg.tag_pattern);
    const headers = { ...authHeaders(ctx.env ?? process.env), 'x-github-api-version': '2022-11-28' };
    const seen = [];

    for (let page = 1; page <= 5; page++) {
      const url = `https://api.github.com/repos/${cfg.repo}/releases?per_page=100&page=${page}`;
      const list = await httpGetJson(url, { ...ctx, headers });
      if (!Array.isArray(list)) throw new SourceError(`unexpected response listing releases for ${cfg.repo}`);
      for (const rel of list) {
        if (rel.draft) continue;
        if (rel.prerelease && !cfg.include_prereleases) continue;
        const tag = String(rel.tag_name ?? '');
        seen.push(tag);
        const published = Date.parse(rel.published_at ?? rel.created_at ?? '');
        if (re.test(tag) && Number.isFinite(published) && published <= cutoff) {
          return {
            status: 'yes',
            observed: tag,
            detail: `${cfg.repo} published release \`${tag}\` at ${rel.published_at} matching /${cfg.tag_pattern}/`,
          };
        }
      }
      if (list.length < 100) break;
    }

    return {
      status: 'no',
      observed: seen.slice(0, 5),
      detail: `no release of ${cfg.repo} matched /${cfg.tag_pattern}/${cfg.published_before ? ` on or before ${cfg.published_before}` : ''}; most recent tags seen: ${seen.slice(0, 5).join(', ') || 'none'}`,
    };
  },

  async probe(cfg, ctx = {}) {
    const headers = { ...authHeaders(ctx.env ?? process.env), 'x-github-api-version': '2022-11-28' };
    await httpGetJson(`https://api.github.com/repos/${cfg.repo}`, { ...ctx, headers });
    return `${cfg.repo} readable on the GitHub API`;
  },
};
