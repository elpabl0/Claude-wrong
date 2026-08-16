import { execFileSync } from 'node:child_process';
import { paths } from './config.js';

/**
 * The commit in which each ledger file first appeared, keyed by repo-relative
 * path. This is the provenance the site links to: the public commit hash and
 * timestamp are what make a prediction a record rather than an assertion.
 * One `git log` pass for the whole tree, not one per file.
 */
export function addCommits(dirs = ['ledger/predictions', 'ledger/resolutions']) {
  const map = new Map();
  let out;
  try {
    out = execFileSync(
      'git',
      ['log', '--no-renames', '--reverse', '--diff-filter=A', '--date=iso-strict', '--format=%x00%H%x1f%ad', '--name-only', '--', ...dirs],
      { cwd: paths.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return map; // No git history available (shallow checkout, tarball). Provenance links are simply omitted.
  }
  let commit = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('\0')) {
      const [hash, date] = line.slice(1).split('\x1f');
      commit = { hash, date };
    } else if (line.trim() && commit && !map.has(line.trim())) {
      map.set(line.trim(), commit);
    }
  }
  return map;
}

export function headCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: paths.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}
