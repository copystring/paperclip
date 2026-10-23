import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertMigrationExtension, canonicalInventoryHash, makeReceipt, verifySRI } from './verify-migration-compatibility.mjs';

const oldSRI = 'sha512-ben+ng50+SxXKmXD8MCUit6yZf20i0CQBWG6ZZq44AGvnX8GF5OvLH/F9ogzXFAgEW/Kc2LXCf3qvPolcoagCg==';
const hashes = { oldJournalHash: 'a'.repeat(64), oldMigrationInventoryHash: 'd'.repeat(64), candidateJournalHash: 'b'.repeat(64), candidateMigrationHash: 'c'.repeat(64) };

test('SRI verifier accepts the exact tarball and rejects altered bytes', () => {
  const bytes = Buffer.from('fixture');
  const sri = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(verifySRI(bytes, sri), sri.slice(7));
  assert.throws(() => verifySRI(Buffer.from('changed'), sri), /did not match/);
});

test('receipt is bound to exact package, migration hashes, and passing evidence', () => {
  const receipt = makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, ...hashes, assertions: [{ id: 'upgrade', passed: true }, { id: 'data', passed: true }, { id: 'schema', passed: true }] });
  assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.candidate.migrationInventorySha256, hashes.candidateMigrationHash);
  assert.throws(() => makeReceipt({ oldVersion: 'other', oldSRI, ...hashes, assertions: [{ id: 'x', passed: true }, { id: 'y', passed: true }, { id: 'z', passed: true }] }), /Unapproved old package/);
  assert.throws(() => makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, ...hashes, assertions: [{ id: 'x', passed: true }, { id: 'y', passed: false }, { id: 'z', passed: true }] }), /successful invariants/);
  assert.throws(() => makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, ...hashes, candidateMigrationHash: 'bad', assertions: [{ id: 'x', passed: true }, { id: 'y', passed: true }, { id: 'z', passed: true }] }), /SHA-256/);
});

test('migration inventory hash is canonical and wrong old baselines fail closed', () => {
  assert.equal(canonicalInventoryHash({ 'b.sql': '2', 'a.sql': '1' }), canonicalInventoryHash({ 'a.sql': '1', 'b.sql': '2' }));
  assert.throws(() => assertMigrationExtension({ 'old.sql': 'a'.repeat(64) }, {}, { entries: [] }, { entries: [] }), /reviewed 0354 baseline/);
});
