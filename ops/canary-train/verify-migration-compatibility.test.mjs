import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { assertInventoryBinding, assertMigrationExtension, assertMigrationExtensionShape, assertPreparedSource, assertSourceInventoryMatchesCandidate, canonicalInventoryHash, makeReceipt, MIGRATION_INVENTORY_PREFIX, resolvePackageDependency, tarEntry, verifySRI } from './verify-migration-compatibility.mjs';

const oldSRI = 'sha512-ben+ng50+SxXKmXD8MCUit6yZf20i0CQBWG6ZZq44AGvnX8GF5OvLH/F9ogzXFAgEW/Kc2LXCf3qvPolcoagCg==';
const candidateSRI = 'sha512-Ub4gzp005JhteAMeDsOxUXDjbSA7OUg+dqiQ1CGaqqxB+xZpJS+x5ke5N/GkqL3f/a+DOQMDp/ZJzNC6//Uo3Q==';
const candidateVersion = '2026.1024.0-canary.14';
const hashes = { oldJournalHash: 'a'.repeat(64), oldMigrationInventoryHash: 'd'.repeat(64), candidateJournalHash: 'b'.repeat(64), candidateMigrationHash: 'c'.repeat(64), sourceMigrationHash: 'c'.repeat(64), sourceMigrationCount: 375, sourceCommit: 'a'.repeat(40), patchCommit: 'f'.repeat(40), patchTree: 'e'.repeat(40) };
const assertionIds = ['migration-engine-upgrade', 'task-retry-row-preserved', 'candidate-schema-current', 'migration-specific-invariants', 'secret-scope-data-preserved', 'restore-point-checkout-migrations', 'migration-inventory-extension'];

test('SRI verifier accepts the exact tarball and rejects altered bytes', () => {
  const bytes = Buffer.from('fixture');
  const sri = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(verifySRI(bytes, sri), sri.slice(7));
  assert.throws(() => verifySRI(Buffer.from('changed'), sri), /did not match/);
});

test('verified tar reader extracts the exact packaged hydration script path', () => {
  const content = Buffer.from('export const safe = true;');
  const header = Buffer.alloc(512);
  header.write('package/scripts/hydrate-symlinks.js', 0, 'utf8');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header[156] = '0'.charCodeAt(0);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  const tarball = gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(512)]));
  assert.deepEqual(tarEntry(tarball, 'package/scripts/hydrate-symlinks.js'), content);
  assert.throws(() => tarEntry(tarball, 'package/scripts/other.js'), /missing/);
});

test('receipt is bound to exact package, migration hashes, and passing evidence', () => {
  const assertions = assertionIds.map((id) => ({ id, passed: true }));
  const receipt = makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, candidateVersion, candidateSRI, ...hashes, assertions });
  assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.candidate.migrationInventorySha256, hashes.candidateMigrationHash);
  assert.throws(() => makeReceipt({ oldVersion: 'other', oldSRI, candidateVersion, candidateSRI, ...hashes, assertions }), /Unapproved old package/);
  assert.throws(() => makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, candidateVersion, candidateSRI, ...hashes, assertions: assertions.map((a, i) => ({ ...a, passed: i !== 2 })) }), /every successful migration invariant/);
  assert.throws(() => makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, candidateVersion, candidateSRI, ...hashes, candidateMigrationHash: 'bad', assertions }), /SHA-256/);
  assert.throws(() => makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, candidateVersion, candidateSRI, ...hashes, assertions: [{ id: 'unrelated', passed: true }] }), /every successful migration invariant/);
  assert.throws(() => makeReceipt({ oldVersion: '2026.1017.0-canary.6', oldSRI, candidateVersion: 'other', candidateSRI, ...hashes, assertions }), /Invalid prepared candidate package identity/);
});

test('prepared source migration files must exactly match the pinned npm candidate', () => {
  const source = { [`${MIGRATION_INVENTORY_PREFIX}0001_init.sql`]: 'a'.repeat(64) };
  assert.equal(assertSourceInventoryMatchesCandidate(source, { ...source }, { expectedCount: 1, expectedSha256: canonicalInventoryHash(source) }), true);
  assert.throws(() => assertSourceInventoryMatchesCandidate(source, { ...source, [`${MIGRATION_INVENTORY_PREFIX}0002_extra.sql`]: 'b'.repeat(64) }, { expectedCount: 1, expectedSha256: canonicalInventoryHash(source) }), /differ from the pinned candidate/);
  assert.throws(() => assertSourceInventoryMatchesCandidate({ 'outside.sql': 'a'.repeat(64) }, { 'outside.sql': 'a'.repeat(64) }, { expectedCount: 1, expectedSha256: canonicalInventoryHash({ 'outside.sql': 'a'.repeat(64) }) }), /prefix, count, and hash/);
});

test('prepared source must be a clean provenance-bound patch commit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paperclip-prepared-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-b', 'deploy/canary-patched');
  git('config', 'user.name', 'Migration test');
  git('config', 'user.email', 'migration-test@example.invalid');
  const migrations = path.join(root, 'packages', 'db', 'src', 'migrations');
  await mkdir(path.join(migrations, 'meta'), { recursive: true });
  await writeFile(path.join(migrations, '0001_base.sql'), 'select 1;\n');
  await writeFile(path.join(migrations, 'meta', '_journal.json'), '{"entries":[]}\n');
  git('add', '.'); git('commit', '-m', 'upstream');
  const sourceCommit = git('rev-parse', 'HEAD');
  const sourceTree = git('rev-parse', 'HEAD^{tree}');
  const sourceInventory = {
    [`${MIGRATION_INVENTORY_PREFIX}0001_base.sql`]: createHash('sha256').update('select 1;\n').digest('hex'),
    [`${MIGRATION_INVENTORY_PREFIX}meta/_journal.json`]: createHash('sha256').update('{"entries":[]}\n').digest('hex'),
  };
  const marker = { schemaVersion: 1, version: candidateVersion, sourceCommit, patches: [] };
  await writeFile(path.join(root, '.canary-train.json'), JSON.stringify(marker));
  git('add', '.canary-train.json'); git('commit', '-m', 'canary-train: assemble candidate');
  const provenance = {
    schemaVersion: 1, version: marker.version, sourceCommit, sourceTree,
    branch: 'deploy/canary-patched', patchCommit: git('rev-parse', 'HEAD'), patchTree: git('rev-parse', 'HEAD^{tree}'), patches: [],
    npmPackages: { '@paperclipai/db': { version: marker.version, integrity: candidateSRI } },
  };
  const provenancePath = path.join(path.dirname(root), `${path.basename(root)}.provenance.json`);
  t.after(() => rm(provenancePath, { force: true }));
  await writeFile(provenancePath, JSON.stringify(provenance));
  assert.deepEqual(await assertPreparedSource(root, provenancePath, sourceInventory, {
    expectedInventoryCount: 2, expectedInventorySha256: canonicalInventoryHash(sourceInventory),
  }), {
    sourceCommit, patchCommit: provenance.patchCommit, patchTree: provenance.patchTree,
    migrationInventoryCount: 2, migrationInventorySha256: canonicalInventoryHash(sourceInventory),
  });
  const wrongBranch = { ...provenance, branch: 'wrong-branch' };
  await writeFile(provenancePath, JSON.stringify(wrongBranch));
  await assert.rejects(assertPreparedSource(root, provenancePath, sourceInventory, {
    expectedInventoryCount: 2, expectedInventorySha256: canonicalInventoryHash(sourceInventory),
  }), /provenance-branch/);
  await writeFile(provenancePath, JSON.stringify(provenance));
  await assert.rejects(assertPreparedSource(root, provenancePath, sourceInventory, {
    expectedSourceCommit: 'f'.repeat(40), expectedInventoryCount: 2, expectedInventorySha256: canonicalInventoryHash(sourceInventory),
  }), /clean immutable provenance/);
  await writeFile(path.join(root, 'untracked.txt'), 'dirty');
  await assert.rejects(assertPreparedSource(root, provenancePath, sourceInventory, {
    expectedSourceCommit: sourceCommit, expectedInventoryCount: 2, expectedInventorySha256: canonicalInventoryHash(sourceInventory),
  }), /clean immutable provenance/);
});

test('prepared source patch binding ignores canonical JSON object key order but preserves patch data', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paperclip-prepared-source-patches-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-b', 'deploy/canary-patched');
  git('config', 'user.name', 'Migration test');
  git('config', 'user.email', 'migration-test@example.invalid');
  const migrations = path.join(root, 'packages', 'db', 'src', 'migrations');
  await mkdir(path.join(migrations, 'meta'), { recursive: true });
  await writeFile(path.join(migrations, '0001_base.sql'), 'select 1;\n');
  await writeFile(path.join(migrations, 'meta', '_journal.json'), '{"entries":[]}\n');
  git('add', '.'); git('commit', '-m', 'upstream');
  const sourceCommit = git('rev-parse', 'HEAD');
  const sourceTree = git('rev-parse', 'HEAD^{tree}');
  const sourceInventory = {
    [`${MIGRATION_INVENTORY_PREFIX}0001_base.sql`]: createHash('sha256').update('select 1;\n').digest('hex'),
    [`${MIGRATION_INVENTORY_PREFIX}meta/_journal.json`]: createHash('sha256').update('{"entries":[]}\n').digest('hex'),
  };
  const patch = {
    number: 16678,
    repository: 'copystring/paperclip',
    head: 'a'.repeat(40),
    state: 'merged',
    integrationPatch: { sha256: 'b'.repeat(64), path: 'outputs/patch.patch' },
  };
  const marker = { schemaVersion: 1, version: candidateVersion, sourceCommit, patches: [{
    head: patch.head,
    integrationPatch: { path: patch.integrationPatch.path, sha256: patch.integrationPatch.sha256 },
    number: patch.number,
    repository: patch.repository,
    state: patch.state,
  }] };
  await writeFile(path.join(root, '.canary-train.json'), JSON.stringify(marker));
  git('add', '.canary-train.json'); git('commit', '-m', 'canary-train: assemble candidate');
  const provenance = {
    schemaVersion: 1, version: marker.version, sourceCommit, sourceTree,
    branch: 'deploy/canary-patched', patchCommit: git('rev-parse', 'HEAD'), patchTree: git('rev-parse', 'HEAD^{tree}'), patches: [patch],
    npmPackages: { '@paperclipai/db': { version: marker.version, integrity: candidateSRI } },
  };
  const provenancePath = path.join(path.dirname(root), `${path.basename(root)}.provenance.json`);
  t.after(() => rm(provenancePath, { force: true }));
  await writeFile(provenancePath, JSON.stringify(provenance));
  assert.deepEqual(await assertPreparedSource(root, provenancePath, sourceInventory, {
    expectedInventoryCount: 2, expectedInventorySha256: canonicalInventoryHash(sourceInventory),
  }), {
    sourceCommit, patchCommit: provenance.patchCommit, patchTree: provenance.patchTree,
    migrationInventoryCount: 2, migrationInventorySha256: canonicalInventoryHash(sourceInventory),
  });

  const changedPatch = structuredClone(provenance);
  changedPatch.patches[0].integrationPatch.sha256 = 'c'.repeat(64);
  await writeFile(provenancePath, JSON.stringify(changedPatch));
  await assert.rejects(assertPreparedSource(root, provenancePath, sourceInventory, {
    expectedInventoryCount: 2, expectedInventorySha256: canonicalInventoryHash(sourceInventory),
  }), /marker-patches/);
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
