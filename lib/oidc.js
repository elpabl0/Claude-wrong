/**
 * Verify a GitHub Actions OIDC token.
 *
 * The house seats had a credential problem with no good answer. A bearer token
 * has to live somewhere: minted once into an agent session it is orphaned the
 * moment that session ends, which is how the first six seats died, and stored as
 * a repository secret it needs a human with admin rights to put it there, which
 * blocked the market for four days and cost four canary rounds.
 *
 * OIDC removes the credential rather than relocating it. GitHub signs a
 * short-lived assertion for a workflow run stating which repository it belongs
 * to. Nobody can mint one for a repository they do not control, so there is
 * nothing to store, nothing to leak, and nothing to lose. It also gives the
 * public record better provenance than a bearer token ever could: not "someone
 * holding a secret" but "this repository's workflow, at this commit".
 *
 * Everything here fails closed. This runs in the authentication path of a public
 * server, so every branch that cannot prove a token is good rejects it.
 */
import { createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const JWKS_TTL_MS = 60 * 60 * 1000;
// A token is minted for one job. Rejecting anything older bounds replay to the
// life of the run that made it, without needing to remember tokens already seen.
const MAX_AGE_SECONDS = 15 * 60;

let cache = { at: 0, keys: new Map() };

const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** GitHub's signing keys, cached. A rotated key misses the cache and refetches once. */
async function jwks({ force = false, fetchImpl = fetch } = {}) {
  if (!force && Date.now() - cache.at < JWKS_TTL_MS && cache.keys.size) return cache.keys;
  const res = await fetchImpl(JWKS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`could not fetch GitHub's OIDC keys: HTTP ${res.status}`);
  const doc = await res.json();
  const keys = new Map();
  for (const jwk of doc.keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    } catch {
      // A key we cannot parse is skipped rather than throwing: one malformed
      // entry must not take down verification for every other key.
    }
  }
  if (!keys.size) throw new Error("GitHub's OIDC key set contained no usable keys");
  cache = { at: Date.now(), keys };
  return keys;
}

/** Reset the key cache. Tests only. */
export function _resetJwksCache() {
  cache = { at: 0, keys: new Map() };
}

/** Does this look like a JWT at all? Used only to route, never to trust. */
export function looksLikeJwt(token) {
  return typeof token === 'string' && token.split('.').length === 3 && token.startsWith('eyJ');
}

/**
 * Verify and return the claims, or throw. `audience` must match exactly - it is
 * what stops a token minted for some other service being replayed at this one.
 */
export async function verifyGithubOidc(token, { audience, now = Date.now(), fetchImpl = fetch } = {}) {
  if (!looksLikeJwt(token)) throw new Error('not a JWT');
  if (!audience) throw new Error('an audience must be configured to verify OIDC tokens');

  const [h, p, s] = token.split('.');
  let header;
  let claims;
  try {
    header = JSON.parse(b64url(h).toString('utf8'));
    claims = JSON.parse(b64url(p).toString('utf8'));
  } catch {
    throw new Error('malformed token');
  }

  // Only RS256. Accepting the token's own choice of algorithm is the classic JWT
  // hole - "alg": "none", or an HMAC verified against the public key as a secret.
  if (header.alg !== 'RS256') throw new Error(`unsupported algorithm ${JSON.stringify(header.alg)}`);
  if (!header.kid) throw new Error('token has no key id');

  let keys = await jwks({ fetchImpl });
  let key = keys.get(header.kid);
  if (!key) {
    // Unknown kid usually means GitHub rotated. Refetch once, then give up.
    keys = await jwks({ force: true, fetchImpl });
    key = keys.get(header.kid);
  }
  if (!key) throw new Error('token was signed by a key GitHub does not publish');

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${h}.${p}`);
  verifier.end();
  if (!verifier.verify(key, b64url(s))) throw new Error('signature does not verify');

  // Signature is good; now the claims have to be right for THIS service.
  if (claims.iss !== ISSUER) throw new Error(`unexpected issuer ${JSON.stringify(claims.iss)}`);

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const wanted = Buffer.from(String(audience));
  const audienceOk = auds.some((a) => {
    const got = Buffer.from(String(a));
    return got.length === wanted.length && timingSafeEqual(got, wanted);
  });
  if (!audienceOk) throw new Error('token was not minted for this service');

  const nowSec = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || nowSec >= claims.exp) throw new Error('token has expired');
  if (typeof claims.nbf === 'number' && nowSec < claims.nbf) throw new Error('token is not valid yet');
  if (typeof claims.iat !== 'number') throw new Error('token has no issued-at');
  // A little tolerance for clock skew in one direction only.
  if (claims.iat - 60 > nowSec) throw new Error('token was issued in the future');
  if (nowSec - claims.iat > MAX_AGE_SECONDS) throw new Error('token is too old to accept');

  if (typeof claims.repository !== 'string' || !claims.repository.includes('/')) {
    throw new Error('token carries no repository claim');
  }
  return claims;
}

/**
 * Does a verified token satisfy what a seat declared?
 *
 * Matched exactly, never by prefix or pattern. `repository` is the claim that
 * actually binds a seat to an owner: nobody can obtain a token whose repository
 * is one they do not control, so an exact match is the whole security property.
 * A seat may pin the workflow as well, which narrows it further.
 */
export function claimsMatchSeat(claims, declared) {
  if (!declared || typeof declared !== 'object') return false;
  if (typeof declared.repository !== 'string') return false;
  if (claims.repository !== declared.repository) return false;
  if (declared.workflow_ref && claims.job_workflow_ref !== declared.workflow_ref) return false;
  if (declared.ref && claims.ref !== declared.ref) return false;
  return true;
}
