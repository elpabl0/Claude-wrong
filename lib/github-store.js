/**
 * The market's storage layer, backed by the GitHub Contents API.
 *
 * The MCP server runs on an ephemeral container, but the record has to stay
 * append-only and publicly auditable, so the server never keeps state of its
 * own: every read and every write goes through git. An order submitted over MCP
 * becomes a commit exactly like one submitted from a checkout, and gets the same
 * integrity checking in CI.
 *
 * Reads are cached briefly. Round windows are hours long, so a few seconds of
 * staleness cannot change whether a window is open, but it does stop a busy
 * agent from spending its rate limit re-reading the same question.
 */

const API = 'https://api.github.com';

export class StoreError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

/**
 * The only paths the market server is ever allowed to write.
 *
 * The credential it holds can write anywhere in the repository, so the server
 * refuses to use it for anything outside these three shapes. That keeps a
 * compromised or buggy server away from the workflow definitions, the protocol
 * config, the resolution records and the scoring code - which is to say, away
 * from everything that decides what the market means. Reads are unrestricted;
 * the repository is public.
 */
export const WRITABLE_PATHS = [
  /^seats\/[a-z0-9][a-z0-9-]{2,30}\.json$/,
  /^rounds\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\/r\d{1,2}\/commitments\.jsonl$/,
  /^rounds\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\/r\d{1,2}\/reveals\.jsonl$/,
];

export function isWritablePath(path) {
  return typeof path === 'string' && !path.includes('..') && WRITABLE_PATHS.some((re) => re.test(path));
}

export class GitHubStore {
  constructor({ repo, branch, token, fetchFn = globalThis.fetch, cacheMs = 20000 } = {}) {
    if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) throw new StoreError('repo must be "owner/name"');
    this.repo = repo;
    this.branch = branch || 'main';
    this.token = token || null;
    this.fetchFn = fetchFn;
    this.cacheMs = cacheMs;
    this.cache = new Map();
  }

  get writable() {
    return Boolean(this.token);
  }

  async #request(path, { method = 'GET', body = null, raw = false } = {}) {
    const headers = {
      accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'wrong.aecs.io market server',
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body) headers['content-type'] = 'application/json';

    const res = await this.fetchFn(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new StoreError(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`, { status: res.status });
    }
    return raw ? res.text() : res.json();
  }

  #cached(key, fn) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheMs) return hit.value;
    const value = fn().then(
      (v) => v,
      (err) => {
        this.cache.delete(key);
        throw err;
      },
    );
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Invalidate everything. Called after a write so the next read sees it. */
  flush() {
    this.cache.clear();
  }

  /** File contents and blob sha, or null if absent. */
  async getFile(path) {
    return this.#cached(`file:${path}`, async () => {
      const meta = await this.#request(`/repos/${this.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(this.branch)}`);
      if (!meta || Array.isArray(meta)) return null;
      const content = meta.encoding === 'base64' ? Buffer.from(meta.content, 'base64').toString('utf8') : (meta.content ?? '');
      return { content, sha: meta.sha, path: meta.path };
    });
  }

  async getJson(path) {
    const f = await this.getFile(path);
    if (!f) return null;
    try {
      return JSON.parse(f.content);
    } catch (err) {
      throw new StoreError(`${path} is not valid JSON: ${err.message}`);
    }
  }

  /** Names of files directly inside a directory. Empty when the directory is absent. */
  async listDir(path) {
    return this.#cached(`dir:${path}`, async () => {
      const items = await this.#request(`/repos/${this.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(this.branch)}`);
      return Array.isArray(items) ? items.map((i) => ({ name: i.name, type: i.type, path: i.path, sha: i.sha })) : [];
    });
  }

  /** Read every .json file in a directory. */
  async readJsonDir(path) {
    const entries = (await this.listDir(path)).filter((e) => e.type === 'file' && e.name.endsWith('.json') && !e.name.startsWith('.'));
    return Promise.all(
      entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (e) => ({ name: e.name, record: await this.getJson(e.path) })),
    );
  }

  async #put(path, content, { sha = null, message }) {
    if (!this.writable) throw new StoreError('the market server has no write credential configured, so it cannot accept orders');
    if (!isWritablePath(path)) throw new StoreError(`the market server is not permitted to write ${path}`);
    const body = { message, content: Buffer.from(content, 'utf8').toString('base64'), branch: this.branch };
    if (sha) body.sha = sha;
    const res = await this.fetchFn(`${API}/repos/${this.repo}/contents/${encodeURI(path)}`, {
      method: 'PUT',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'wrong.aecs.io market server',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 409 || res.status === 422) return { conflict: true };
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new StoreError(`GitHub PUT ${path} → ${res.status}: ${text.slice(0, 300)}`, { status: res.status });
    }
    this.flush();
    return { conflict: false, result: await res.json() };
  }

  /** Create a file that must not already exist. */
  async createFile(path, content, message) {
    // Checked before anything touches the network, so a forbidden path is
    // refused outright rather than after a read that reveals it was attempted.
    if (!isWritablePath(path)) throw new StoreError(`the market server is not permitted to write ${path}`);
    const existing = await this.getFile(path);
    if (existing) throw new StoreError(`${path} already exists`);
    const out = await this.#put(path, content, { message });
    if (out.conflict) throw new StoreError(`${path} was created by someone else at the same moment`);
    return out.result;
  }

  /**
   * Append a line to a .jsonl, re-reading and retrying if someone else appended
   * first. Two agents submitting into the same round in the same second is the
   * normal case, not the exceptional one, so this has to be lock-free and safe.
   * Existing bytes are never rewritten - the integrity check would reject that.
   */
  async appendLine(path, line, message, { attempts = 6 } = {}) {
    if (!isWritablePath(path)) throw new StoreError(`the market server is not permitted to write ${path}`);
    for (let i = 0; i < attempts; i++) {
      this.cache.delete(`file:${path}`);
      const existing = await this.getFile(path);
      const base = existing?.content ?? '';
      if (base && !base.endsWith('\n')) throw new StoreError(`${path} does not end in a newline; refusing to append`);
      const out = await this.#put(path, `${base}${line}\n`, { sha: existing?.sha ?? null, message });
      if (!out.conflict) return out.result;
      await new Promise((r) => setTimeout(r, 150 * 2 ** i));
    }
    throw new StoreError(`could not append to ${path} after ${attempts} attempts - too much contention`);
  }
}

/** Build a store from the environment, or null when nothing is configured. */
export function storeFromEnv(env = process.env) {
  const repo = env.MARKET_REPO;
  if (!repo) return null;
  return new GitHubStore({
    repo,
    branch: env.MARKET_BRANCH || 'main',
    token: env.MARKET_GITHUB_TOKEN || null,
  });
}
