import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertInventoryBinding, assertMigrationExtension, assertMigrationExtensionShape, canonicalInventoryHash, makeReceipt, MIGRATION_INVENTORY_PREFIX, resolvePackageDependency, verifySRI } from './verify-migration-compatibility.mjs';

const oldSRI = 'sha512-ben+ng50+SxXKmXD8MCUit6yZf20i0CQBWG6ZZq44AGvnX8GF5OvLH/F9ogzXFAgEW/Kc2LXCf3qvPolcoagCg==';
const candidateSRI = 'sha512-Ub4gzp005JhteAMeDsOxUXDjbSA7OUg+dqiQ1CGaqqxB+xZpJS+x5ke5N/GkqL3f/a+DOQMDp/ZJzNC6//Uo3Q==';
const hashes = { oldJournalHash: 'a'.repeat(64), oldMigrationInventoryHash: 'd'.repeat(64), candidateJournalHash: 'b'.repeat(64), candidateMigrationHash: 'c'.repeat(64) };
const assertionIds = ['migration-engine-upgrade', 'task-retry-row-preserved', 'candidate-schema-current', 'migration-specific-invariants', 'secret-scope-data-preserved', 'restore-point-checkout-migrations', 'migration-inventory-extension'];

test('SRI verifier accepts the exact tarball and rejects altered bytes', () => {
  const bytes = Buffer.from('fixture');
  const sri = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(verifySRI(bytes, sri), sri.slice(7));
  assert.throws(() => verifySRI(Buffer.from('changed'), sri), /did not match/);
});

test('receipt is bound to exact package, migration hashes, and passing evidence', () => {
  const assertions = assertionIds.map((id) => ({ id, passed: true }));
  const receipt = makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, candidateVersion: '2026.1023.0-canary.13', candidateSRI, ...hashes, assertions });
  assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.candidate.migrationInventorySha256, hashes.candidateMigrationHash);
  assert.throws(() => makeReceipt({ oldVersion: 'other', oldSRI, candidateVersion: '2026.1023.0-canary.13', candidateSRI, ...hashes, assertions }), /Unapproved old package/);
  assert.throws(() => makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, candidateVersion: '2026.1023.0-canary.13', candidateSRI, ...hashes, assertions: assertions.map((a, i) => ({ ...a, passed: i !== 2 })) }), /every successful migration invariant/);
  assert.throws(() => makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, candidateVersion: '2026.1023.0-canary.13', candidateSRI, ...hashes, candidateMigrationHash: 'bad', assertions }), /SHA-256/);
  assert.throws(() => makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, candidateVersion: '2026.1023.0-canary.13', candidateSRI, ...hashes, assertions: [{ id: 'unrelated', passed: true }] }), /every successful migration invariant/);
  assert.throws(() => makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, candidateVersion: 'other', candidateSRI, ...hashes, assertions }), /Unapproved candidate package/);
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

test('exact reviewed candidate shape allows only the pinned 21-SQL extension', () => {
  const oldInventory = {};
  const oldEntries = [];
  for (let i = 0; i < 353; i += 1) {
    const tag = String(i).padStart(4, '0');
    oldInventory[`${MIGRATION_INVENTORY_PREFIX}${tag}_base.sql`] = String(i).padStart(64, '0');
    oldEntries.push({ idx: i, tag, when: i, breakpoints: true });
  }
  oldInventory[`${MIGRATION_INVENTORY_PREFIX}meta/_journal.json`] = 'f'.repeat(64);
  const candidateInventory = { ...oldInventory };
  const candidateEntries = [...oldEntries];
  for (let i = 0; i < 21; i += 1) {
    const tag = String(353 + i).padStart(4, '0');
    candidateInventory[`${MIGRATION_INVENTORY_PREFIX}${tag}_reviewed.sql`] = (i + 1).toString(16).padStart(64, '0');
    candidateEntries.push({ idx: 353 + i, tag, when: 353 + i, breakpoints: true });
  }
  const candidateJournal = { entries: candidateEntries };
  candidateInventory[`${MIGRATION_INVENTORY_PREFIX}meta/_journal.json`] = 'e'.repeat(64);
  const candidateSha256 = canonicalInventoryHash(candidateInventory);
  const result = assertMigrationExtensionShape(oldInventory, candidateInventory, { entries: oldEntries }, candidateJournal, { addedSqlCount: 21, candidateCount: 375, candidateSha256 });
  assert.equal(result.addedSql, 21);
  assert.throws(() => assertMigrationExtensionShape(oldInventory, candidateInventory, { entries: oldEntries }, candidateJournal, { addedSqlCount: 19, candidateCount: 375, candidateSha256 }), /add exactly 19 SQL migrations/);
  const changed = { ...candidateInventory, [`${MIGRATION_INVENTORY_PREFIX}0354_reviewed.sql`]: 'f'.repeat(64) };
  assert.throws(() => assertMigrationExtensionShape(oldInventory, changed, { entries: oldEntries }, candidateJournal, { addedSqlCount: 21, candidateCount: 375, candidateSha256 }), /exact reviewed package hash/);
});

test('old package dependency resolution finds bundled embedded-postgres and hoisted postgres', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paperclip-old-package-resolution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'node_modules', '@paperclipai', 'db');
  const entry = path.join(packageRoot, 'dist', 'index.js');
  const bundled = path.join(packageRoot, 'node_modules', 'embedded-postgres');
  const hoisted = path.join(root, 'node_modules', 'postgres');
  await mkdir(path.dirname(entry), { recursive: true });
  await mkdir(bundled, { recursive: true });
  await mkdir(hoisted, { recursive: true });
  await writeFile(entry, '');
  await writeFile(path.join(bundled, 'package.json'), JSON.stringify({ name: 'embedded-postgres', main: 'index.cjs' }));
  await writeFile(path.join(bundled, 'index.cjs'), 'module.exports = {};');
  await writeFile(path.join(hoisted, 'package.json'), JSON.stringify({ name: 'postgres', main: 'index.cjs' }));
  await writeFile(path.join(hoisted, 'index.cjs'), 'module.exports = {};');
  assert.equal(resolvePackageDependency(entry, 'embedded-postgres'), path.join(bundled, 'index.cjs'));
  assert.equal(resolvePackageDependency(entry, 'postgres'), path.join(hoisted, 'index.cjs'));
});

test('CLI cannot report success without a receipt or exit successfully on pending work', () => {
  const moduleUrl = new URL('./verify-migration-compatibility.mjs', import.meta.url).href;
  const missingReceipt = path.join(os.tmpdir(), `missing-migration-receipt-${process.pid}-${Date.now()}.json`);
  const missing = spawnSync(process.execPath, ['--input-type=module', '-e', `import { runCli } from ${JSON.stringify(moduleUrl)}; process.exitCode = await runCli(async () => {}, ${JSON.stringify(missingReceipt)});`], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /without producing its required receipt/);

  const pending = spawnSync(process.execPath, ['--input-type=module', '-e', `import { runCli } from ${JSON.stringify(moduleUrl)}; await runCli(() => new Promise(() => {}), ${JSON.stringify(missingReceipt)});`], { encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(pending.status, 0, 'an unsettled top-level migration promise must not become exit code 0');
});
