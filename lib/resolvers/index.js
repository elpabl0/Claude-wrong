import metaculus from './metaculus.js';
import json from './json.js';
import github_release from './github_release.js';
import http_text from './http_text.js';
import arxiv from './arxiv.js';

export const RESOLVERS = Object.fromEntries(
  [metaculus, json, github_release, http_text, arxiv].map((r) => [r.type, r]),
);

export function getResolver(type) {
  return RESOLVERS[type] ?? null;
}

export { SourceError, CriterionError } from './util.js';
