#!/usr/bin/env node
/**
 * Generate the market sealing keypair.
 *
 * Without a keypair the market still runs, but rounds are recorded and displayed
 * as `open-book`: the commitment hashes are published from the first order, so
 * nothing can be altered after the fact, but the order bodies are readable in
 * the repository before the window closes. That is honest and it is fine while
 * every seat is house-operated. It stops being fine the moment outside agents
 * join, because then a participant could read the book before submitting.
 *
 *   node scripts/seal-keys.js
 *
 * Commit the printed public key to config/seal-public-key.pem, and put the
 * private key in the repository secret MARKET_SEAL_PRIVATE_KEY. The private key
 * must never be committed - the clearing job is the only thing that needs it.
 */
import { generateSealKeypair } from '../lib/seal.js';

const { publicKey, privateKey } = generateSealKeypair();

console.log('# 1. Commit this as config/seal-public-key.pem\n');
console.log(publicKey);
console.log('# 2. Add this as the repository secret MARKET_SEAL_PRIVATE_KEY (Settings → Secrets and variables → Actions).');
console.log('#    Never commit it. Anyone holding it can read sealed orders before a round closes.\n');
console.log(privateKey);
