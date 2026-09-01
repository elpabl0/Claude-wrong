import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createHmac } from 'node:crypto';
import { verifyGithubOidc, claimsMatchSeat, looksLikeJwt, _resetJwksCache } from '../lib/oidc.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const AUD = 'wrong.aecs.io';
const NOW = 1_800_000_000_000;

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign(claims, { alg = 'RS256', kid = KID, key = privateKey } = {}) {
  const h = enc({ alg, kid, typ: 'JWT' });
  const p = enc(claims);
  const s = createSign('RSA-SHA256');
  s.update(`${h}.${p}`);
  s.end();
  return `${h}.${p}.${s.sign(key).toString('base64url')}`;
}

const baseClaims = (over = {}) => ({
  iss: 'https://token.actions.githubusercontent.com',
  aud: AUD,
  repository: 'elpabl0/Claude-wrong',
  job_workflow_ref: 'elpabl0/Claude-wrong/.github/workflows/seats.yml@refs/heads/main',
  ref: 'refs/heads/main',
  iat: Math.floor(NOW / 1000) - 5,
  nbf: Math.floor(NOW / 1000) - 5,
  exp: Math.floor(NOW / 1000) + 600,
  ...over,
});

/** A stand-in JWKS endpoint, so no test touches the network. */
const fetchImpl = async () => ({
  ok: true,
  json: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, kty: 'RSA', use: 'sig', alg: 'RS256' }] }),
});
const verify = (token, over = {}) => verifyGithubOidc(token, { audience: AUD, now: NOW, fetchImpl, ...over });

test('a well-formed GitHub token verifies and returns its claims', async () => {
  _resetJwksCache();
  const claims = await verify(sign(baseClaims()));
  assert.equal(claims.repository, 'elpabl0/Claude-wrong');
});

test('a token signed by the wrong key is refused', async () => {
  _resetJwksCache();
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(verify(sign(baseClaims(), { key: other })), /signed by a key GitHub does not publish|signature does not verify/);
});

test('alg:none is refused', async () => {
  // The classic JWT hole: trust the token's own claim about how to check it.
  _resetJwksCache();
  const h = enc({ alg: 'none', kid: KID, typ: 'JWT' });
  const p = enc(baseClaims());
  await assert.rejects(verify(`${h}.${p}.`), /unsupported algorithm/);
});

test('an HMAC token verified against the public key is refused', async () => {
  // The other classic: sign HS256 using the RSA public key as the shared secret.
  _resetJwksCache();
  const h = enc({ alg: 'HS256', kid: KID, typ: 'JWT' });
  const p = enc(baseClaims());
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const sig = createHmac('sha256', pub).update(`${h}.${p}`).digest('base64url');
  await assert.rejects(verify(`${h}.${p}.${sig}`), /unsupported algorithm/);
});

test('a token for another audience is refused', async () => {
  _resetJwksCache();
  await assert.rejects(verify(sign(baseClaims({ aud: 'sts.amazonaws.com' }))), /not minted for this service/);
});

test('a token from another issuer is refused', async () => {
  _resetJwksCache();
  await assert.rejects(verify(sign(baseClaims({ iss: 'https://evil.example' }))), /unexpected issuer/);
});

test('expired, future-dated and stale tokens are all refused', async () => {
  _resetJwksCache();
  const s = Math.floor(NOW / 1000);
  await assert.rejects(verify(sign(baseClaims({ exp: s - 1 }))), /expired/);
  await assert.rejects(verify(sign(baseClaims({ nbf: s + 600 }))), /not valid yet/);
  await assert.rejects(verify(sign(baseClaims({ iat: s + 600 }))), /issued in the future/);
  // Signed an hour ago: still unexpired, but far too old to be this job's token.
  await assert.rejects(verify(sign(baseClaims({ iat: s - 3600, exp: s + 600 }))), /too old/);
});

test('a token with no repository claim is refused', async () => {
  _resetJwksCache();
  const { repository, ...noRepo } = baseClaims();
  await assert.rejects(verify(sign(noRepo)), /no repository claim/);
});

/* ------------------------------------------------------- binding to a seat */

test('a seat is bound to its repository exactly, never by prefix', () => {
  const claims = { repository: 'elpabl0/Claude-wrong', job_workflow_ref: 'w', ref: 'refs/heads/main' };
  assert.equal(claimsMatchSeat(claims, { repository: 'elpabl0/Claude-wrong' }), true);
  // The attack this blocks: a repository whose name merely starts the same way.
  assert.equal(claimsMatchSeat(claims, { repository: 'elpabl0/Claude' }), false);
  assert.equal(claimsMatchSeat({ ...claims, repository: 'evil/Claude-wrong-fork' }, { repository: 'elpabl0/Claude-wrong' }), false);
  assert.equal(claimsMatchSeat(claims, {}), false, 'a seat with no declared repository matches nothing');
  assert.equal(claimsMatchSeat(claims, null), false);
});

test('a seat may narrow itself to one workflow and branch', () => {
  const claims = { repository: 'r/r', job_workflow_ref: 'r/r/.github/workflows/seats.yml@refs/heads/main', ref: 'refs/heads/main' };
  assert.equal(claimsMatchSeat(claims, { repository: 'r/r', workflow_ref: claims.job_workflow_ref }), true);
  assert.equal(claimsMatchSeat(claims, { repository: 'r/r', workflow_ref: 'r/r/.github/workflows/other.yml@refs/heads/main' }), false);
  assert.equal(claimsMatchSeat(claims, { repository: 'r/r', ref: 'refs/heads/other' }), false);
});

test('routing only looks at shape, never at trust', () => {
  assert.equal(looksLikeJwt('eyJa.eyJb.sig'), true);
  assert.equal(looksLikeJwt('seat_abc123'), false);
  assert.equal(looksLikeJwt(null), false);
});
