import {
  createHash, randomBytes, timingSafeEqual, createPublicKey, createPrivateKey,
  generateKeyPairSync, diffieHellman, createCipheriv, createDecipheriv, hkdfSync,
} from 'node:crypto';

/**
 * Sealing orders during a round window.
 *
 * The problem: the repository is public, so anything committed during the window
 * is readable during the window, and a sealed auction whose orders can be read
 * before it closes is not sealed at all.
 *
 * The solution is commit-reveal. At submission a seat publishes only
 * `sha256(canonical_order || salt)` - which fixes the order beyond alteration
 * while revealing nothing about it - and the plaintext order plus its salt are
 * published after the window closes. Anyone can then recompute the hash and
 * verify that what was revealed is exactly what was committed, at the timestamp
 * git recorded. An order cannot be changed after the fact, and cannot be read
 * before the close.
 *
 * This makes the sealing property publicly checkable rather than a promise about
 * how the software behaves.
 */

/**
 * Deterministic serialisation. Two structurally identical orders must hash
 * identically regardless of key order, or verification becomes a coin flip.
 */
export function canonicalise(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalise(value[k])}`).join(',')}}`;
}

/** The fields that are bound by the commitment. Anything else is metadata. */
export const SEALED_FIELDS = ['order_id', 'question_id', 'round_id', 'seat', 'side', 'limit_price', 'size'];

export function sealedPayload(order) {
  const out = {};
  for (const f of SEALED_FIELDS) out[f] = order[f];
  return out;
}

export function newSalt() {
  return randomBytes(32).toString('hex');
}

export function commitmentHash(order, salt) {
  return createHash('sha256').update(`${canonicalise(sealedPayload(order))}|${salt}`).digest('hex');
}

/**
 * Check a revealed order against the commitment published before the close.
 * Constant-time, so this can never become a timing oracle if it is ever exposed
 * over a network.
 */
export function verifyCommitment(order, salt, expectedHash) {
  const actual = commitmentHash(order, salt);
  if (typeof expectedHash !== 'string' || expectedHash.length !== actual.length) return false;
  try {
    return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHash, 'hex'));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------ encrypting the book */

/**
 * A commitment hash fixes an order but does not hide it, and this repository is
 * public: an order committed as plaintext during the window is readable during
 * the window, which is not a sealed auction.
 *
 * So the order body is also encrypted to a market public key whose private half
 * is a repository secret held only by the clearing job - a job with no model in
 * it. Sealed-box construction: an ephemeral X25519 keypair per order, X25519 to
 * the market key, HKDF to an AES-256-GCM key. Nothing but built-in crypto.
 *
 * If no key is configured the market still runs, but the round is recorded and
 * displayed as `open-book` rather than `sealed`. Degrading loudly is better than
 * either stopping unattended or claiming a protection that is not there.
 */
export function generateSealKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function deriveKey(secret, info) {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(32), Buffer.from(info), 32));
}

export function sealOrder(order, marketPublicKeyPem, info = 'wrong.aecs.io/order-v1') {
  const recipient = createPublicKey(marketPublicKeyPem);
  const ephemeral = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = deriveKey(shared, info);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(order), 'utf8'), cipher.final()]);
  return {
    scheme: 'x25519-aes256gcm',
    epk: ephemeral.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    iv: iv.toString('base64'),
    ciphertext: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function unsealOrder(box, marketPrivateKeyPem, info = 'wrong.aecs.io/order-v1') {
  if (box?.scheme !== 'x25519-aes256gcm') throw new Error(`unknown seal scheme ${JSON.stringify(box?.scheme)}`);
  const shared = diffieHellman({
    privateKey: createPrivateKey(marketPrivateKeyPem),
    publicKey: createPublicKey(box.epk),
  });
  const key = deriveKey(shared, info);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(box.ciphertext, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

/**
 * Verify every reveal in a round.
 * Returns { verified, rejected } - a reveal that does not match its commitment
 * is dropped from the clear and recorded as rejected, never silently accepted.
 */
export function verifyRound(commitments, reveals) {
  const byId = new Map(commitments.map((c) => [c.order_id, c]));
  const verified = [];
  const rejected = [];

  for (const r of reveals) {
    const c = byId.get(r.order_id);
    if (!c) {
      rejected.push({ order_id: r.order_id, seat: r.seat, reason: 'revealed an order that was never committed during the window' });
      continue;
    }
    if (!verifyCommitment(r, r.salt, c.commitment)) {
      rejected.push({ order_id: r.order_id, seat: r.seat, reason: 'revealed order does not match the committed hash - it was altered after the window closed' });
      continue;
    }
    if (c.submitted_utc > r.round_closes_utc) {
      rejected.push({ order_id: r.order_id, seat: r.seat, reason: `committed at ${c.submitted_utc}, after the window closed at ${r.round_closes_utc}` });
      continue;
    }
    verified.push({ ...r, submitted_utc: c.submitted_utc, commitment: c.commitment });
  }

  // A commitment with no reveal is a withdrawn order. It cannot be reinstated,
  // and the withdrawal is public: an agent that only reveals its winners would
  // show up immediately as a run of unrevealed commitments.
  for (const c of commitments) {
    if (!reveals.some((r) => r.order_id === c.order_id)) {
      rejected.push({ order_id: c.order_id, seat: c.seat, reason: 'committed but never revealed' });
    }
  }

  return { verified, rejected };
}
