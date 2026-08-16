import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { paths } from './config.js';
import { StoreError } from './github-store.js';

/**
 * Reads from the local checkout, writes through GitHub.
 *
 * The API rate limit was never going to bind on writes - a round is twelve hours
 * long and an agent submits once or twice - but it would absolutely bind on
 * reads, because every agent listing the open questions was fetching every
 * question and every round over the network.
 *
 * Almost none of that needed to be a network call. A question and its round
 * schedule are **fixed at creation and never change**, so the copy in the
 * deployed checkout is not a cache that might be stale; it is the record. The
 * only things that move underneath a running server are the order logs of a
 * window that is currently open, and a seat registered since the last deploy.
 * Those two, and only those two, still go over the wire.
 *
 * So the split is not "fast path and slow path" - it is immutable data read
 * locally, mutable data read from the source of truth.
 */

// Written during a live window by this very server, so the checkout cannot have
// them. These must always come from GitHub or a seat could overdraw its bankroll
// by submitting twice into one round.
const REMOTE_ONLY = [/^rounds\/.+\/(commitments|reveals)\.jsonl$/];

// Immutable once committed, or refreshed by the mechanical job on redeploy.
const LOCAL_FIRST = [/^questions\//, /^analysis\//, /^rounds\/.+\/clearing\.json$/];

const matches = (patterns, path) => patterns.some((re) => re.test(path));

export class HybridStore {
  constructor({ github, root = paths.root } = {}) {
    if (!github) throw new StoreError('a GitHub store is required for writes');
    this.github = github;
    this.root = resolve(root);
    // Seats registered by this process, so an agent can register and immediately
    // trade without waiting for a redeploy or a consistent read.
    this.freshSeats = new Map();
    this.localReads = 0;
    this.remoteReads = 0;
  }

  get writable() {
    return this.github.writable;
  }

  flush() {
    this.github.flush();
  }

  checkCredential() {
    return this.github.checkCredential();
  }

  #localPath(path) {
    if (path.includes('..')) return null;
    const full = resolve(join(this.root, path));
    return full.startsWith(this.root + sep) ? full : null;
  }

  #readLocal(path) {
    const full = this.#localPath(path);
    if (!full || !existsSync(full)) return null;
    try {
      if (!statSync(full).isFile()) return null;
      this.localReads += 1;
      return { content: readFileSync(full, 'utf8'), sha: null, path };
    } catch {
      return null;
    }
  }

  async getFile(path) {
    if (matches(REMOTE_ONLY, path)) {
      this.remoteReads += 1;
      return this.github.getFile(path);
    }
    if (this.freshSeats.has(path)) return { content: this.freshSeats.get(path), sha: null, path };

    const local = this.#readLocal(path);
    if (local) return local;

    // A seat registered since this deploy, or a question written by the weekly
    // run since this deploy. Neither is in the checkout yet, so ask GitHub.
    this.remoteReads += 1;
    return this.github.getFile(path);
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

  async listDir(path, { localOnly = false } = {}) {
    const full = this.#localPath(path);
    const local = full && existsSync(full) ? readdirSync(full, { withFileTypes: true }) : null;

    // Directory listings for immutable trees come from disk. Anything else - and
    // anything missing locally - falls back, so a directory created after this
    // deploy is still visible.
    if (local && (localOnly || matches(LOCAL_FIRST, `${path}/`))) {
      this.localReads += 1;
      const entries = local.filter((d) => d.isFile()).map((d) => ({ name: d.name, type: 'file', path: `${path}/${d.name}` }));
      for (const key of this.freshSeats.keys()) {
        const name = key.slice(path.length + 1);
        if (key.startsWith(`${path}/`) && !name.includes('/') && !entries.some((e) => e.name === name)) {
          entries.push({ name, type: 'file', path: key });
        }
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (localOnly) return [];

    const remote = await this.github.listDir(path).catch(() => []);
    this.remoteReads += 1;
    if (!local) return remote;

    // Union, so a seat registered a minute ago and one committed last week both
    // appear exactly once.
    const seen = new Map(remote.map((e) => [e.name, e]));
    for (const d of local.filter((d) => d.isFile())) {
      if (!seen.has(d.name)) seen.set(d.name, { name: d.name, type: 'file', path: `${path}/${d.name}` });
    }
    for (const key of this.freshSeats.keys()) {
      const name = key.slice(path.length + 1);
      if (key.startsWith(`${path}/`) && !name.includes('/') && !seen.has(name)) seen.set(name, { name, type: 'file', path: key });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async readJsonDir(path, opts = {}) {
    const entries = (await this.listDir(path, opts)).filter((e) => e.name.endsWith('.json') && !e.name.startsWith('.'));
    return Promise.all(
      entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (e) => ({ name: e.name, record: await this.getJson(`${path}/${e.name}`) })),
    );
  }

  async createFile(path, content, message) {
    const out = await this.github.createFile(path, content, message);
    if (path.startsWith('seats/')) this.freshSeats.set(path, content);
    return out;
  }

  async appendLine(path, line, message, opts) {
    return this.github.appendLine(path, line, message, opts);
  }

  /** For the health endpoint: how much of the read load stayed off the network. */
  stats() {
    const total = this.localReads + this.remoteReads;
    return {
      local_reads: this.localReads,
      remote_reads: this.remoteReads,
      local_share: total ? Number((this.localReads / total).toFixed(3)) : null,
    };
  }
}

export { REMOTE_ONLY, LOCAL_FIRST };
