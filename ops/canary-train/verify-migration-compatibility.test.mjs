import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertInventoryBinding, assertMigrationExtension, canonicalInventoryHash, makeReceipt, MIGRATION_INVENTORY_PREFIX, verifySRI } from './verify-migration-compatibility.mjs';

const oldSRI = 'sha512-ben+ng50+SxXKmXD8MCUit6yZf20i0CQBWG6ZZq44AGvnX8GF5OvLH/F9ogzXFAgEW/Kc2LXCf3qvPolcoagCg==';
const hashes = { oldJournalHash: 'a'.repeat(64), oldMigrationInventoryHash: 'd'.repeat(64), candidateJournalHash: 'b'.repeat(64), candidateMigrationHash: 'c'.repeat(64) };
const assertionIds = ['migration-engine-upgrade', 'task-retry-row-preserved', 'candidate-schema-current', 'migration-specific-invariants', 'secret-scope-data-preserved', 'migration-inventory-extension'];

test('SRI verifier accepts the exact tarball and rejects altered bytes', () => {
  const bytes = Buffer.from('fixture');
  const sri = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(verifySRI(bytes, sri), sri.slice(7));
  assert.throws(() => verifySRI(Buffer.from('changed'), sri), /did not match/);
});

test('receipt is bound to exact package, migration hashes, and passing evidence', () => {
  const assertions = assertionIds.map((id) => ({ id, passed: true }));
  const receipt = makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, ...hashes, assertions });
  assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.candidate.migrationInventorySha256, hashes.candidateMigrationHash);
  assert.throws(() => makeReceipt({ oldVersion: 'other', oldSRI, ...hashes, assertions }), /Unapproved old package/);
  assert.throws(() => makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, ...hashes, assertions: assertions.map((a, i) => ({ ...a, passed: i !== 2 })) }), /every successful migration invariant/);
  assert.throws(() => makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, ...hashes, candidateMigrationHash: 'bad', assertions }), /SHA-256/);
  assert.throws(() => makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, ...hashes, assertions: [{ id: 'unrelated', passed: true }] }), /every successful migration invariant/);
});

test('migration inventory hash is canonical and package path prefixes are part of its binding', () => {
  assert.equal(canonicalInventoryHash({ 'b.sql': '2', 'a.sql': '1' }), canonicalInventoryHash({ 'a.sql': '1', 'b.sql': '2' }));
  const inventory = {};
  for (let i = 0; i < 353; i += 1) inventory[`${MIGRATION_INVENTORY_PREFIX}${String(i).padStart(4, '0')}_migration.sql`] = String(i).padStart(64, '0');
  inventory[`${MIGRATION_INVENTORY_PREFIX}meta/_journal.json`] = 'f'.repeat(64);
  const digest = canonicalInventoryHash(inventory);
  assert.equal(assertInventoryBinding(inventory, { expectedCount: 354, expectedSha256: digest, pathPrefix: MIGRATION_INVENTORY_PREFIX }), true);
  assert.throws(() => assertInventoryBinding({ '0000_migration.sql': '0'.repeat(64), ...inventory }, { expectedCount: 355, expectedSha256: canonicalInventoryHash({ '0000_migration.sql': '0'.repeat(64), ...inventory }), pathPrefix: MIGRATION_INVENTORY_PREFIX }), /prefix, count, and hash/);
  assert.throws(() => assertMigrationExtension({ 'old.sql': 'a'.repeat(64) }, {}, { entries: [] }, { entries: [] }), /reviewed 0354 baseline/);
});
