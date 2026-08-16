import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalise, commitmentHash, verifyCommitment, newSalt, verifyRound,
  generateSealKeypair, sealOrder, unsealOrder, sealedPayload,
} from '../lib/seal.js';

const order = (over = {}) => ({
  order_id: 'q1-r1-house-01',
  question_id: '2026-09-01-example',
  round_id: 'r1',
  seat: 'house',
  side: 'yes',
  limit_price: 0.62,
  size: 40,
  ...over,
});

test('canonicalisation does not depend on key order', () => {
  assert.equal(canonicalise({ b: 1, a: 2 }), canonicalise({ a: 2, b: 1 }));
  assert.equal(canonicalise([1, { z: 1, a: 2 }]), '[1,{"a":2,"z":1}]');
  assert.notEqual(canonicalise({ a: 1 }), canonicalise({ a: '1' }));
});

test('a commitment fixes exactly the fields that matter and ignores metadata', () => {
  const salt = newSalt();
  const h = commitmentHash(order(), salt);
  assert.match(h, /^[0-9a-f]{64}$/);
  // Reordering keys or adding metadata must not change the commitment...
  assert.equal(commitmentHash({ note: 'irrelevant', ...order() }, salt), h);
  // ...but changing any sealed field must.
  for (const [k, v] of [['limit_price', 0.63], ['size', 41], ['side', 'no'], ['seat', 'other']]) {
    assert.notEqual(commitmentHash(order({ [k]: v }), salt), h, `${k} must be bound by the commitment`);
  }
  assert.deepEqual(Object.keys(sealedPayload(order())).sort(), ['limit_price', 'order_id', 'question_id', 'round_id', 'seat', 'side', 'size']);
});

test('a commitment cannot be verified with the wrong salt or a tampered order', () => {
  const salt = newSalt();
  const h = commitmentHash(order(), salt);
  assert.equal(verifyCommitment(order(), salt, h), true);
  assert.equal(verifyCommitment(order(), newSalt(), h), false);
  assert.equal(verifyCommitment(order({ limit_price: 0.9 }), salt, h), false);
  assert.equal(verifyCommitment(order(), salt, 'not-a-hash'), false);
  assert.equal(verifyCommitment(order(), salt, null), false);
});

test('a round rejects reveals that were altered after the close', () => {
  const salt = newSalt();
  const good = order();
  const commitments = [{ order_id: good.order_id, seat: 'house', commitment: commitmentHash(good, salt), submitted_utc: '2026-09-01T08:00:00Z' }];

  const honest = verifyRound(commitments, [{ ...good, salt, round_closes_utc: '2026-09-01T20:00:00Z' }]);
  assert.equal(honest.verified.length, 1);
  assert.equal(honest.rejected.length, 0);

  // The seat lost, and tries to reveal a better price than it committed to.
  const cheat = verifyRound(commitments, [{ ...good, limit_price: 0.2, salt, round_closes_utc: '2026-09-01T20:00:00Z' }]);
  assert.equal(cheat.verified.length, 0);
  assert.match(cheat.rejected[0].reason, /does not match the committed hash/);
});

test('an order committed after the window closed is refused', () => {
  const salt = newSalt();
  const o = order();
  const late = verifyRound(
    [{ order_id: o.order_id, seat: 'house', commitment: commitmentHash(o, salt), submitted_utc: '2026-09-02T09:00:00Z' }],
    [{ ...o, salt, round_closes_utc: '2026-09-01T20:00:00Z' }],
  );
  assert.equal(late.verified.length, 0);
  assert.match(late.rejected[0].reason, /after the window closed/);
});

test('a commitment with no reveal is recorded as withdrawn, never quietly dropped', () => {
  const salt = newSalt();
  const o = order();
  const r = verifyRound([{ order_id: o.order_id, seat: 'house', commitment: commitmentHash(o, salt), submitted_utc: '2026-09-01T08:00:00Z' }], []);
  assert.equal(r.verified.length, 0);
  assert.match(r.rejected[0].reason, /committed but never revealed/);
});

test('a reveal with no commitment cannot be smuggled in after the close', () => {
  const r = verifyRound([], [{ ...order(), salt: newSalt(), round_closes_utc: '2026-09-01T20:00:00Z' }]);
  assert.equal(r.verified.length, 0);
  assert.match(r.rejected[0].reason, /never committed/);
});

test('an order sealed to the market key is unreadable without the private half', () => {
  const { publicKey, privateKey } = generateSealKeypair();
  const box = sealOrder(order(), publicKey);
  assert.equal(box.scheme, 'x25519-aes256gcm');
  assert.ok(!JSON.stringify(box).includes('0.62'), 'the limit price must not appear in the sealed box');

  assert.deepEqual(unsealOrder(box, privateKey), order());

  const other = generateSealKeypair();
  assert.throws(() => unsealOrder(box, other.privateKey));

  // Tampering with the ciphertext must fail the authentication tag, not decrypt
  // to something plausible.
  const bytes = Buffer.from(box.ciphertext, 'base64');
  bytes[0] ^= 0xff;
  assert.throws(() => unsealOrder({ ...box, ciphertext: bytes.toString('base64') }, privateKey));
  assert.throws(() => unsealOrder({ ...box, scheme: 'rot13' }, privateKey));
});
