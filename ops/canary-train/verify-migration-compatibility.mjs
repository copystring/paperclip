#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspect, isDeepStrictEqual } from 'node:util';
import { existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const EXPECTED_OLD_VERSION = '2026.1017.0-canary.6';
const EXPECTED_OLD_SRI = 'sha512-ben+ng50+SxXKmXD8MCUit6yZf20i0CQBWG6ZZq44AGvnX8GF5OvLH/F9ogzXFAgEW/Kc2LXCf3qvPolcoagCg==';
const EXPECTED_OLD_INVENTORY_COUNT = 354;
const EXPECTED_OLD_INVENTORY_SHA256 = '9cec6945b6dd1c38b80940e5246d500da8b5d506a4be68db20ab89136fc11ed9';
const EXPECTED_CANDIDATE_INVENTORY_COUNT = 377;
const EXPECTED_CANDIDATE_INVENTORY_SHA256 = 'cf72a4cb66052ff1c4d93f5ec4d29a291d08a28d2355e02e089d92e3052c9e3a';
const EXPECTED_ADDED_SQL_COUNT = 23;
const EXPECTED_DEFERRED_MIGRATIONS = ['0374_rare_wolfpack.sql', '0375_short_mercury.sql', '0376_clear_committed_native_recovery_state.sql', '0377_clear_settled_native_run_process_identity.sql'];
const EMBEDDED_POSTGRES_PLATFORM = '@embedded-postgres/linux-x64';
const EMBEDDED_POSTGRES_PLATFORM_VERSION = '18.1.0-beta.16';
const EMBEDDED_POSTGRES_PLATFORM_SRI = 'sha512-+GIabpHh7QV2AcYBuzyQC41AYczSFphxfHy4ccTPIPrp6OSthZXH+A9fymjQzOiDHg9+1UeYET00Aj7sScjXrg==';
export const MIGRATION_INVENTORY_PREFIX = 'node_modules/@paperclipai/db/dist/migrations/';
const REQUIRED_ASSERTIONS = ['migration-engine-upgrade', 'task-retry-row-preserved', 'candidate-schema-current', 'migration-specific-invariants', 'secret-scope-data-preserved', 'restore-point-checkout-migrations', 'committed-native-recovery-state-migration', 'settled-native-run-process-identity-migration', 'migration-inventory-extension'];

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function verifySRI(bytes, sri) {
  const m = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(sri ?? '');
  if (!m) throw new Error('Expected one exact sha512 SRI token');
  const actual = createHash('sha512').update(bytes).digest('base64');
  if (actual !== m[1]) throw new Error('Tarball SRI did not match the pinned package');
  return actual;
}
export function makeReceipt({ oldVersion, oldSRI, oldJournalHash, oldMigrationInventoryHash, candidateVersion, candidateSRI, candidateJournalHash, candidateMigrationHash, sourceMigrationHash, sourceMigrationCount, sourceCommit, patchCommit, patchTree, assertions }) {
  if (oldVersion !== EXPECTED_OLD_VERSION || oldSRI !== EXPECTED_OLD_SRI) throw new Error('Unapproved old package identity');
  if (typeof candidateVersion !== 'string' || !/^\d{4}\.\d+\.0-canary\.\d+$/.test(candidateVersion) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(candidateSRI ?? '')) throw new Error('Invalid prepared candidate package identity');
  if (![oldJournalHash, oldMigrationInventoryHash, candidateJournalHash, candidateMigrationHash, sourceMigrationHash].every((h) => /^[a-f0-9]{64}$/.test(h))) throw new Error('Receipt requires SHA-256 migration identities');
  if (sourceMigrationCount !== EXPECTED_CANDIDATE_INVENTORY_COUNT || ![sourceCommit, patchCommit, patchTree].every((value) => /^[a-f0-9]{40}$/.test(value))) throw new Error('Receipt requires exact prepared source identity and migration count');
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Prepared source commit is invalid');
  if (sourceMigrationHash !== candidateMigrationHash) throw new Error('Prepared source migration inventory differs from the pinned candidate package');
  if (!Array.isArray(assertions) || assertions.length !== REQUIRED_ASSERTIONS.length || assertions.some((a) => a.passed !== true) || REQUIRED_ASSERTIONS.some((id) => !assertions.some((a) => a.id === id))) throw new Error('Receipt must contain every successful migration invariant');
  const body = { schema: 1, candidateSourceCommit: sourceCommit, preparedSource: { sourceCommit, patchCommit, patchTree, migrationInventoryCount: sourceMigrationCount, migrationInventorySha256: sourceMigrationHash }, oldPackage: { name: '@paperclipai/db', version: oldVersion, integrity: oldSRI, migrationInventoryCount: EXPECTED_OLD_INVENTORY_COUNT, migrationInventorySha256: oldMigrationInventoryHash, journalSha256: oldJournalHash }, candidate: { name: '@paperclipai/db', version: candidateVersion, integrity: candidateSRI, migrationInventoryCount: EXPECTED_CANDIDATE_INVENTORY_COUNT, migrationInventorySha256: candidateMigrationHash, journalSha256: candidateJournalHash }, assertions };
  return { ...body, receiptSha256: sha256(Buffer.from(JSON.stringify(body))) };
}
export function canonicalInventoryHash(inventory) {
  const sorted = Object.fromEntries(Object.entries(inventory).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return sha256(Buffer.from(JSON.stringify(sorted)));
}
export function assertInventoryBinding(inventory, { expectedCount, expectedSha256, pathPrefix }) {
  const files = Object.keys(inventory);
  if (files.length !== expectedCount || files.some((name) => !name.startsWith(pathPrefix)) || canonicalInventoryHash(inventory) !== expectedSha256) throw new Error('Migration inventory does not match its bound prefix, count, and hash');
  return true;
}
export function assertSourceInventoryMatchesCandidate(sourceInventory, candidateInventory, { expectedCount = EXPECTED_CANDIDATE_INVENTORY_COUNT, expectedSha256 = EXPECTED_CANDIDATE_INVENTORY_SHA256 } = {}) {
  assertInventoryBinding(sourceInventory, { expectedCount, expectedSha256, pathPrefix: MIGRATION_INVENTORY_PREFIX });
  if (canonicalInventoryHash(sourceInventory) !== canonicalInventoryHash(candidateInventory)) throw new Error('Prepared source migrations differ from the pinned candidate npm package');
  return true;
}
export function resolvePackageDependency(packageEntryPath, dependency) {
  return createRequire(packageEntryPath).resolve(dependency);
}
export function tarEntry(tarball, wantedPath) {
  const archive = gunzipSync(tarball);
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').split('\0', 1)[0];
    const prefix = header.subarray(345, 500).toString('utf8').split('\0', 1)[0];
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString('ascii').split('\0', 1)[0].trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('Unsupported tar entry size while verifying platform package');
    const size = Number.parseInt(sizeText, 8);
    const start = offset + 512;
    const end = start + size;
    if (end > archive.length) throw new Error('Truncated platform package tarball');
    if (entryPath === wantedPath) return archive.subarray(start, end);
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Verified platform tarball is missing ${wantedPath}`);
}
function isContained(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
async function hydrateVerifiedPlatformPackage(dbEntryPath, installRoot, tarball, databaseUrl) {
  const embeddedPostgresEntry = resolvePackageDependency(dbEntryPath, 'embedded-postgres');
  const platformEntry = resolvePackageDependency(embeddedPostgresEntry, EMBEDDED_POSTGRES_PLATFORM);
  const packageRoot = path.dirname(path.dirname(platformEntry));
  const allowedRoot = await realpath(installRoot);
  const resolvedRoot = await realpath(packageRoot);
  const packageInfo = await lstat(packageRoot);
  if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink() || resolvedRoot !== packageRoot || !isContained(resolvedRoot, allowedRoot)) {
    throw new Error('Refusing to run platform package script outside its verified private npm installation');
  }
  const metadataPath = path.join(packageRoot, 'package.json');
  const scriptPath = path.join(packageRoot, 'scripts', 'hydrate-symlinks.js');
  const symlinksPath = path.join(packageRoot, 'native', 'pg-symlinks.json');
  for (const candidatePath of [metadataPath, platformEntry, scriptPath, symlinksPath]) {
    const info = await lstat(candidatePath);
    const resolved = await realpath(candidatePath);
    if (!info.isFile() || info.isSymbolicLink() || resolved !== candidatePath || !isContained(resolved, resolvedRoot)) {
      throw new Error('Refusing to run an uncontained or linked platform package script');
    }
  }
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (metadata.name !== EMBEDDED_POSTGRES_PLATFORM || metadata.version !== EMBEDDED_POSTGRES_PLATFORM_VERSION) {
    throw new Error('Installed embedded PostgreSQL platform package identity did not match the reviewed SRI package');
  }
  if (!Buffer.from(await readFile(scriptPath)).equals(tarEntry(tarball, 'package/scripts/hydrate-symlinks.js')) ||
      !Buffer.from(await readFile(symlinksPath)).equals(tarEntry(tarball, 'package/native/pg-symlinks.json'))) {
    throw new Error('Installed platform hydration inputs did not match the SRI-verified npm tarball');
  }
  runNode([scriptPath], packageRoot, databaseUrl);
  const links = JSON.parse(await readFile(symlinksPath, 'utf8'));
  for (const link of links) {
    const source = path.resolve(packageRoot, link.source);
    const target = path.resolve(packageRoot, link.target);
    if (!isContained(source, resolvedRoot) || !isContained(target, resolvedRoot)) throw new Error('Platform symlink manifest escapes its package root');
    const targetInfo = await lstat(target);
    if (!targetInfo.isSymbolicLink() || await realpath(target) !== await realpath(source)) throw new Error(`Platform dependency symlink was not hydrated: ${path.basename(target)}`);
  }
}
export function formatFailure(error, stage = 'migration compatibility run') {
  const detail = error instanceof Error ? error.stack ?? error.message : inspect(error, { depth: 4, breakLength: 120 });
  return `[migration-compat] ${stage} failed: ${String(detail).replace(/(postgres(?:ql)?:\/\/)[^\s@]+@/gi, '$1[redacted]@')}`;
}
export async function runCli(operation, receiptPath) {
  try {
    await operation();
    if (!receiptPath || !existsSync(receiptPath)) throw new Error('operation completed without producing its required receipt');
    return 0;
  } catch (error) {
    process.stderr.write(`${formatFailure(error)}\n`);
    return 1;
  }
}
export function assertMigrationExtensionShape(oldInventory, candidateInventory, oldJournal, candidateJournal, { addedSqlCount, candidateCount, candidateSha256 }) {
  const oldFiles = Object.keys(oldInventory).sort();
  const candidateFiles = Object.keys(candidateInventory).sort();
  if (candidateFiles.some((name) => !name.startsWith(MIGRATION_INVENTORY_PREFIX))) throw new Error('Candidate migration inventory has a path outside the package inventory');
  for (const name of oldFiles) {
    if (name === `${MIGRATION_INVENTORY_PREFIX}meta/_journal.json`) continue;
    if (candidateInventory[name] !== oldInventory[name]) throw new Error(`Candidate changed or removed baseline migration ${name}`);
  }
  const added = candidateFiles.filter((name) => !Object.hasOwn(oldInventory, name));
  if (added.length !== addedSqlCount || added.some((name) => !/\/\d{4}_.+\.sql$/.test(name))) throw new Error(`Candidate must add exactly ${addedSqlCount} SQL migrations`);
  if (candidateFiles.length !== candidateCount || canonicalInventoryHash(candidateInventory) !== candidateSha256) throw new Error('Candidate migration inventory did not match the exact reviewed package hash');
  const priorEntries = oldJournal.entries;
  if (!Array.isArray(priorEntries) || !Array.isArray(candidateJournal.entries) || candidateJournal.entries.length !== priorEntries.length + addedSqlCount) throw new Error(`Candidate migration journal is not an exact ${addedSqlCount}-entry extension`);
  if (JSON.stringify(candidateJournal.entries.slice(0, priorEntries.length)) !== JSON.stringify(priorEntries)) throw new Error('Candidate changed the pinned migration journal prefix');
  return { oldCount: oldFiles.length, candidateCount: candidateFiles.length, addedSql: added.length, oldInventorySha256: canonicalInventoryHash(oldInventory), candidateInventorySha256: canonicalInventoryHash(candidateInventory) };
}
export function assertMigrationExtension(oldInventory, candidateInventory, oldJournal, candidateJournal) {
  try {
    assertInventoryBinding(oldInventory, { expectedCount: EXPECTED_OLD_INVENTORY_COUNT, expectedSha256: EXPECTED_OLD_INVENTORY_SHA256, pathPrefix: MIGRATION_INVENTORY_PREFIX });
  } catch {
    throw new Error('Old package migration inventory did not match the reviewed 0354 baseline');
  }
  return assertMigrationExtensionShape(oldInventory, candidateInventory, oldJournal, candidateJournal, {
    addedSqlCount: EXPECTED_ADDED_SQL_COUNT,
    candidateCount: EXPECTED_CANDIDATE_INVENTORY_COUNT,
    candidateSha256: EXPECTED_CANDIDATE_INVENTORY_SHA256,
  });
}

function run(command, args, cwd) {
  const executable = process.platform === 'win32' && command === 'npm'
    ? process.execPath
    : command;
  const commandArgs = executable === process.execPath && command === 'npm'
    ? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args]
    : args;
  const result = spawnSync(executable, commandArgs, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr ?? result.stdout ?? 'no process output';
    throw new Error(`${command} failed (${result.status ?? 'spawn error'}): ${String(detail).slice(-3000)}`);
  }
  return result.stdout;
}
async function assertPrivateTempRoot(temp, expectedParent) {
  const info = await lstat(temp);
  const resolved = path.resolve(temp);
  const actual = await realpath(temp);
  if (!info.isDirectory() || info.isSymbolicLink() || actual !== resolved || path.dirname(actual) !== expectedParent || !path.basename(actual).startsWith('paperclip-migration-compat-')) {
    throw new Error('Refusing to mutate or remove a temporary path outside the private migration-run root');
  }
  return actual;
}
function runNode(args, cwd, databaseUrl) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000, env: { ...process.env, MIGRATION_COMPAT_DB_URL: databaseUrl } });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr ?? result.stdout ?? 'no process output';
    throw new Error(`Node migration subprocess failed (${result.status ?? 'spawn error'}): ${String(detail).slice(-3000)}`);
  }
  return result.stdout;
}
async function migrationIdentity(dir) {
  const journal = await readFile(path.join(dir, 'meta', '_journal.json'));
  const fs = await import('node:fs/promises');
  const names = await fs.readdir(dir);
  const inventory = {};
  for (const name of names.filter((n) => n.endsWith('.sql')).sort()) inventory[`${MIGRATION_INVENTORY_PREFIX}${name}`] = sha256(await readFile(path.join(dir, name)));
  inventory[`${MIGRATION_INVENTORY_PREFIX}meta/_journal.json`] = sha256(journal);
  return { journalHash: sha256(journal), inventory, journal: JSON.parse(journal.toString('utf8')) };
}
async function sourceMigrationIdentity(sourceRoot) {
  const dir = path.join(sourceRoot, 'packages', 'db', 'src', 'migrations');
  const fs = await import('node:fs/promises');
  const names = await fs.readdir(dir);
  const inventory = {};
  for (const name of names.filter((entry) => entry.endsWith('.sql')).sort()) inventory[`${MIGRATION_INVENTORY_PREFIX}${name}`] = sha256(await readFile(path.join(dir, name)));
  const journalPath = path.join(dir, 'meta', '_journal.json');
  inventory[`${MIGRATION_INVENTORY_PREFIX}meta/_journal.json`] = sha256(await readFile(journalPath));
  return { inventory, journal: JSON.parse((await readFile(journalPath)).toString('utf8')) };
}
function gitValue(sourceRoot, ...args) {
  return run('git', ['-C', sourceRoot, ...args], sourceRoot).trim().toLowerCase();
}
export async function assertPreparedSource(sourceRoot, provenancePath, candidateInventory, { expectedSourceCommit, expectedInventoryCount = EXPECTED_CANDIDATE_INVENTORY_COUNT, expectedInventorySha256 = EXPECTED_CANDIDATE_INVENTORY_SHA256 } = {}) {
  const root = path.resolve(sourceRoot);
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  const marker = JSON.parse(await readFile(path.join(root, '.canary-train.json'), 'utf8'));
  const head = gitValue(root, 'rev-parse', 'HEAD');
  const tree = gitValue(root, 'rev-parse', 'HEAD^{tree}');
  const status = run('git', ['-C', root, 'status', '--porcelain'], root).trim();
  const markerPatches = provenance.patches?.map(({ number, repository, head: patchHead, state, integrationPatch }) => ({ number, repository, head: patchHead, state, ...(integrationPatch ? { integrationPatch } : {}) }));
  const sourceCommitIsValid = /^[a-f0-9]{40}$/.test(provenance.sourceCommit ?? '');
  const failures = [];
  if (status) failures.push('dirty-worktree');
  if (provenance.schemaVersion !== 1) failures.push('provenance-schema');
  if (!sourceCommitIsValid) failures.push('source-commit');
  if (head !== provenance.patchCommit) failures.push('patch-head');
  if (tree !== provenance.patchTree) failures.push('patch-tree');
  if (sourceCommitIsValid && gitValue(root, 'rev-parse', `${provenance.sourceCommit}^{tree}`) !== provenance.sourceTree) failures.push('source-tree');
  if (expectedSourceCommit !== undefined && provenance.sourceCommit !== expectedSourceCommit) failures.push('expected-source-commit');
  if (marker.sourceCommit !== provenance.sourceCommit) failures.push('marker-source-commit');
  if (!/^\d{4}\.\d+\.0-canary\.\d+$/.test(provenance.version ?? '')) failures.push('candidate-version');
  if (marker.version !== provenance.version) failures.push('marker-version');
  if (provenance.branch !== 'deploy/canary-patched') failures.push('provenance-branch');
  if (!Array.isArray(provenance.patches) || !Array.isArray(marker.patches) || !isDeepStrictEqual(marker.patches, markerPatches)) failures.push('marker-patches');
  if (failures.length) throw new Error(`Prepared candidate source does not match its clean immutable provenance: ${failures.join(', ')}`);
  const packagePin = provenance.npmPackages?.['@paperclipai/db'];
  if (packagePin?.version !== provenance.version || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(packagePin?.integrity ?? '')) throw new Error('Prepared source provenance does not pin the exact database package for this candidate version');
  const sourceIdentity = await sourceMigrationIdentity(root);
  assertSourceInventoryMatchesCandidate(sourceIdentity.inventory, candidateInventory, { expectedCount: expectedInventoryCount, expectedSha256: expectedInventorySha256 });
  return { sourceCommit: provenance.sourceCommit, patchCommit: provenance.patchCommit, patchTree: provenance.patchTree, migrationInventoryCount: Object.keys(sourceIdentity.inventory).length, migrationInventorySha256: canonicalInventoryHash(sourceIdentity.inventory) };
}
async function main() {
  const [receiptPath, sourceRoot, provenancePath] = process.argv.slice(2);
  const stage = (name) => process.stderr.write(`[migration-compat] ${name}\n`);
  if (!receiptPath || !sourceRoot || !provenancePath) throw new Error('Usage: node verify-migration-compatibility.mjs <receipt-output> <prepared-source> <provenance.json>');
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  const candidateVersion = provenance.npmPackages?.['@paperclipai/db']?.version;
  const candidateSRI = provenance.npmPackages?.['@paperclipai/db']?.integrity;
  if (candidateVersion !== provenance.version || !/^\d{4}\.\d+\.0-canary\.\d+$/.test(candidateVersion ?? '') || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(candidateSRI ?? '')) throw new Error('Prepared provenance does not contain the exact candidate database package identity');
  const tempParent = await realpath(os.tmpdir());
  const temp = await mkdtemp(path.join(tempParent, 'paperclip-migration-compat-'));
  await assertPrivateTempRoot(temp, tempParent);
  let database; let client; let restoreCandidateJournal; let restoreCandidateBoundary;
  try {
    stage(`fetch pinned old and prepared Canary ${candidateVersion} database packages`);
    const oldPack = JSON.parse(run('npm', ['pack', `@paperclipai/db@${EXPECTED_OLD_VERSION}`, '--json', '--pack-destination', temp], temp))[0];
    if (oldPack.version !== EXPECTED_OLD_VERSION || oldPack.integrity !== EXPECTED_OLD_SRI) throw new Error('Registry metadata did not match the reviewed old package pin');
    const oldTarball = path.join(temp, oldPack.filename);
    verifySRI(await readFile(oldTarball), EXPECTED_OLD_SRI);
    const candidatePack = JSON.parse(run('npm', ['pack', `@paperclipai/db@${candidateVersion}`, '--json', '--pack-destination', temp], temp))[0];
    if (candidatePack.version !== candidateVersion || candidatePack.integrity !== candidateSRI) throw new Error('Registry metadata did not match the prepared candidate package identity');
    const candidateTarball = path.join(temp, candidatePack.filename);
    verifySRI(await readFile(candidateTarball), candidateSRI);
    const oldInstall = path.join(temp, 'old');
    const candidateInstall = path.join(temp, 'candidate');
    await (await import('node:fs/promises')).mkdir(oldInstall);
    await (await import('node:fs/promises')).mkdir(candidateInstall);
    run('npm', ['install', '--prefix', oldInstall, '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund', oldTarball], temp);
    run('npm', ['install', '--prefix', candidateInstall, '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund', candidateTarball], temp);
    const oldIndex = path.join(oldInstall, 'node_modules/@paperclipai/db/dist/index.js');
    const oldMigrations = path.join(oldInstall, 'node_modules/@paperclipai/db/dist/migrations');
    const candidateIndex = path.join(candidateInstall, 'node_modules/@paperclipai/db/dist/index.js');
    const candidateMigrations = path.join(candidateInstall, 'node_modules/@paperclipai/db/dist/migrations');
    if (process.platform === 'linux') {
      stage('verify and hydrate only the pinned Linux PostgreSQL package scripts');
      const platformPack = JSON.parse(run('npm', ['pack', `${EMBEDDED_POSTGRES_PLATFORM}@${EMBEDDED_POSTGRES_PLATFORM_VERSION}`, '--json', '--pack-destination', temp], temp))[0];
      if (platformPack.version !== EMBEDDED_POSTGRES_PLATFORM_VERSION || platformPack.integrity !== EMBEDDED_POSTGRES_PLATFORM_SRI) throw new Error('Linux PostgreSQL platform package did not match the reviewed npm SRI pin');
      const platformTarball = path.join(temp, platformPack.filename);
      verifySRI(await readFile(platformTarball), EMBEDDED_POSTGRES_PLATFORM_SRI);
      const platformBytes = await readFile(platformTarball);
      await hydrateVerifiedPlatformPackage(oldIndex, oldInstall, platformBytes, '');
      await hydrateVerifiedPlatformPackage(candidateIndex, candidateInstall, platformBytes, '');
    }
    const oldIdentity = await migrationIdentity(oldMigrations);
    const candidateIdentity = await migrationIdentity(candidateMigrations);
    const extension = assertMigrationExtension(oldIdentity.inventory, candidateIdentity.inventory, oldIdentity.journal, candidateIdentity.journal);
    stage('bind actual prepared source migrations to the pinned npm package and provenance');
    const sourceBinding = await assertPreparedSource(sourceRoot, provenancePath, candidateIdentity.inventory, { expectedSourceCommit: provenance.sourceCommit });
    stage('load old migration engine');
    const oldDb = await import(pathToFileURL(oldIndex));
    stage('start disposable database with the pinned package test harness');
    database = await oldDb.startEmbeddedPostgresTestDatabase('paperclip-migration-compat-');
    const url = database.connectionString;
    stage('seed historical rows in the old schema');
    const { default: postgres } = await import(pathToFileURL(resolvePackageDependency(oldIndex, 'postgres')));
    client = postgres(url, { max: 1 });
    const company = '10000000-0000-4000-8000-000000000001';
    const agent = '10000000-0000-4000-8000-000000000002';
    await client`insert into companies(id,name) values (${company},'compatibility fixture')`;
    await client`insert into agents(id,company_id,name) values (${agent},${company},'compatibility agent')`;
    await client`insert into agent_wakeup_requests(company_id,agent_id,source,idempotency_key,payload) values (${company},${agent},'manual','task-retry:compatibility-fixture',${client.json({ source: 'upgrade-fixture' })})`;
    const plugin = '10000000-0000-4000-8000-000000000003';
    const userDefinition = '10000000-0000-4000-8000-000000000004';
    await client`insert into plugins(id,plugin_key,package_name,version,manifest_json) values (${plugin},'compat-fixture','@fixture/plugin','1.0.0',${client.json({ id: 'compat-fixture' })})`;
    await client`insert into user_secret_definitions(id,company_id,key,name) values (${userDefinition},${company},'compat_user','Compatibility user secret')`;
    await client`insert into company_secrets(id,company_id,scope,key,name) values ('10000000-0000-4000-8000-000000000005',${company},'company','compat_company','Compatibility company secret')`;
    await client`insert into company_secrets(id,company_id,scope,owner_user_id,user_secret_definition_id,key,name) values ('10000000-0000-4000-8000-000000000006',${company},'user','compat-user',${userDefinition},'compat_user','Compatibility user secret')`;
    await client`insert into company_secrets(id,company_id,scope,owner_agent_id,owner_plugin_id,key,name) values ('10000000-0000-4000-8000-000000000007',${company},'instance',${agent},${plugin},'compat_instance','Compatibility instance secret')`;
    const candidateJournalPath = path.join(candidateMigrations, 'meta', '_journal.json');
    await assertPrivateTempRoot(temp, tempParent);
    const journalInfo = await lstat(candidateJournalPath);
    const journalParent = await realpath(path.dirname(candidateJournalPath));
    if (!journalInfo.isFile() || journalInfo.isSymbolicLink() || !journalParent.startsWith(`${temp}${path.sep}`)) throw new Error('Refusing to modify a candidate journal outside the private npm installation');
    const originalCandidateJournal = await readFile(candidateJournalPath);
    const originalJournalHash = sha256(originalCandidateJournal);
    restoreCandidateJournal = async () => {
      await assertPrivateTempRoot(temp, tempParent);
      const restoreParent = await realpath(path.dirname(candidateJournalPath));
      const restoreInfo = await lstat(candidateJournalPath);
      if (!restoreInfo.isFile() || restoreInfo.isSymbolicLink() || !restoreParent.startsWith(`${temp}${path.sep}`)) throw new Error('Refusing to restore a journal outside the private npm installation');
      await writeFile(candidateJournalPath, originalCandidateJournal);
      const restored = await readFile(candidateJournalPath);
      if (!restored.equals(originalCandidateJournal) || sha256(restored) !== originalJournalHash) throw new Error('Temporary candidate journal was not restored byte-for-byte');
    };
    const candidateJournal = JSON.parse(originalCandidateJournal.toString('utf8'));
    const deferredNames = candidateJournal.entries.slice(-EXPECTED_DEFERRED_MIGRATIONS.length).map((entry) => `${entry.tag}.sql`);
    if (JSON.stringify(deferredNames) !== JSON.stringify(EXPECTED_DEFERRED_MIGRATIONS)) throw new Error('Candidate tail did not match the pinned 0374/0375/0376/0377 compatibility migrations');
    const deferredDirectory = path.join(temp, 'deferred-candidate-migrations');
    await mkdir(deferredDirectory);
    const deferredFiles = deferredNames.map((name) => ({
      name,
      source: path.join(candidateMigrations, name),
      deferred: path.join(deferredDirectory, name),
    }));
    const deferredHashes = new Map();
    for (const file of deferredFiles) deferredHashes.set(file.name, sha256(await readFile(file.source)));
    restoreCandidateBoundary = async () => {
      await assertPrivateTempRoot(temp, tempParent);
      for (const file of deferredFiles) {
        const sourceExists = existsSync(file.source);
        const deferredExists = existsSync(file.deferred);
        if (!sourceExists && deferredExists) await rename(file.deferred, file.source);
        else if (!sourceExists || deferredExists) throw new Error(`Temporary migration file restore state was invalid for ${file.name}`);
        const restoredMigration = await readFile(file.source);
        if (sha256(restoredMigration) !== deferredHashes.get(file.name)) throw new Error(`Temporary migration file was not restored byte-for-byte: ${file.name}`);
      }
      await restoreCandidateJournal();
    };
    const through0373 = { ...candidateJournal, entries: candidateJournal.entries.slice(0, -EXPECTED_DEFERRED_MIGRATIONS.length) };
    stage('apply candidate migrations through 0373 using the real migration engine');
    await writeFile(candidateJournalPath, `${JSON.stringify(through0373, null, 2)}\n`);
    for (const file of deferredFiles) {
      const info = await lstat(file.source);
      const sourceParent = await realpath(path.dirname(file.source));
      if (!info.isFile() || info.isSymbolicLink() || !sourceParent.startsWith(`${temp}${path.sep}`) || !path.resolve(file.deferred).startsWith(`${temp}${path.sep}`)) throw new Error(`Refusing to defer a migration outside the private npm installation: ${file.name}`);
      await rename(file.source, file.deferred);
    }
    const inspectScript = "import {pathToFileURL} from 'node:url'; const db=await import(pathToFileURL(process.argv[1])); const url=process.env.MIGRATION_COMPAT_DB_URL; await db.applyPendingMigrations(url); const state=await db.inspectMigrations(url); process.stdout.write(JSON.stringify(state));";
    const preRestorePointState = JSON.parse(runNode(['--input-type=module', '-e', inspectScript, candidateIndex], temp, url));
    if (preRestorePointState.status !== 'upToDate' || preRestorePointState.journalEntryCount !== candidateJournal.entries.length - EXPECTED_DEFERRED_MIGRATIONS.length) throw new Error(`Fixture did not stop at the exact 0373 pre-restore-point-migration boundary: ${JSON.stringify(preRestorePointState)}`);
    await restoreCandidateBoundary();
    const project = '10000000-0000-4000-8000-000000000008';
    const workspace = '10000000-0000-4000-8000-000000000009';
    await client`insert into projects(id,company_id,name) values (${project},${company},'compatibility project')`;
    await client`insert into execution_workspaces(id,company_id,project_id,mode,strategy_type,name) values (${workspace},${company},${project},'local','worktree','compatibility workspace')`;
    await client`insert into execution_workspace_restore_points(id,company_id,execution_workspace_id,generation,object_key,sha256,byte_size,status) values ('10000000-0000-4000-8000-000000000010',${company},${workspace},7,'compat/primary',${'a'.repeat(64)},10,'active')`;
    const issue = '10000000-0000-4000-8000-000000000014';
    await client`insert into issues(id,company_id,title,status) values (${issue},${company},'native recovery migration fixture','done')`;
    const recoveryHistory = [{ disposition: 'resume_dead_runner', requestId: 'history-fixture' }];
    const baselineUpdatedAt = '2000-01-01T00:00:00.000Z';
    const nativeFinalizationFixtures = [
      { key: 'committed-unleased', runId: '10000000-0000-4000-8000-000000000015', phase: 'committed', leaseOwner: null, recoveryState: 'resuming_session', recoveryRequestId: 'committed-request' },
      { key: 'committed-leased', runId: '10000000-0000-4000-8000-000000000016', phase: 'committed', leaseOwner: 'native-finalizer:live', recoveryState: 'resuming_session', recoveryRequestId: 'leased-request' },
      { key: 'observed-unleased', runId: '10000000-0000-4000-8000-000000000017', phase: 'observed', leaseOwner: null, recoveryState: 'resuming_session', recoveryRequestId: 'observed-request' },
      { key: 'terminal-failure-unleased', runId: '10000000-0000-4000-8000-000000000018', phase: 'terminal_failure', leaseOwner: null, recoveryState: 'blocked', recoveryRequestId: 'terminal-request' },
      { key: 'committed-without-recovery-state', runId: '10000000-0000-4000-8000-000000000019', phase: 'committed', leaseOwner: null, recoveryState: null, recoveryRequestId: 'null-state-request' },
    ];
    for (const fixture of nativeFinalizationFixtures) {
      await client`insert into heartbeat_runs(id,company_id,agent_id,status,runtime_mode,native_issue_id) values (${fixture.runId},${company},${agent},'succeeded','native',${issue})`;
      await client`insert into native_run_finalizations(run_id,company_id,issue_id,phase,lease_owner,recovery_state,recovery_request_id,recovery_history,updated_at) values (${fixture.runId},${company},${issue},${fixture.phase},${fixture.leaseOwner},${fixture.recoveryState},${fixture.recoveryRequestId},${client.json(recoveryHistory)},${baselineUpdatedAt})`;
    }
    const environment = '10000000-0000-4000-8000-000000000020';
    // Environments are instance-scoped since migration 0105; the company
    // ownership belongs to environment_leases, not this catalog row. Use a
    // non-local/non-managed driver so the fixture cannot collide with the
    // instance's canonical Local or managed sandbox environment.
    await client`insert into environments(id,name,driver,status,config,env_vars,metadata)
      values (${environment},'migration compatibility environment','fixture','active','{}'::jsonb,'{}'::jsonb,'{}'::jsonb)`;
    const oldFinishedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const recentFinishedAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const nativeProcessFixtures = [
      { key: 'old-failed-with-stopped-remote-lease', status: 'failed', finishedAt: oldFinishedAt, checkpoint: true, leaseMode: 'stopped', coordinatorPhase: null, clears: true },
      { key: 'old-timeout-with-destroyed-lease-and-settled-coordinator', status: 'timed_out', finishedAt: oldFinishedAt, checkpoint: false, event: true, leaseMode: 'destroyed', coordinatorPhase: 'committed', clears: true },
      { key: 'old-cancelled-with-terminal-failure-coordinator', status: 'cancelled', finishedAt: oldFinishedAt, checkpoint: true, leaseMode: 'stopped', coordinatorPhase: 'terminal_failure', clears: true },
      { key: 'old-interrupted-with-stopped-remote-lease', status: 'interrupted', finishedAt: oldFinishedAt, checkpoint: true, leaseMode: 'stopped', coordinatorPhase: null, clears: true },
      { key: 'recent-failure', status: 'failed', finishedAt: recentFinishedAt, checkpoint: true, leaseMode: 'stopped', coordinatorPhase: null, clears: false },
      { key: 'running-run', status: 'running', finishedAt: null, checkpoint: true, leaseMode: 'stopped', coordinatorPhase: null, clears: false },
      { key: 'old-legacy-failed-run', status: 'failed', runtimeMode: 'legacy', finishedAt: oldFinishedAt, checkpoint: true, leaseMode: 'stopped', coordinatorPhase: null, clears: false },
      { key: 'missing-lease', status: 'failed', finishedAt: oldFinishedAt, checkpoint: true, leaseMode: null, coordinatorPhase: null, clears: false },
      { key: 'missing-termination-receipt', status: 'failed', finishedAt: oldFinishedAt, checkpoint: true, leaseMode: 'missing', coordinatorPhase: null, clears: false },
      { key: 'misbound-termination-receipt', status: 'failed', finishedAt: oldFinishedAt, checkpoint: true, leaseMode: 'misbound', coordinatorPhase: null, clears: false },
      { key: 'local-lease', status: 'failed', finishedAt: oldFinishedAt, checkpoint: true, leaseMode: 'local', coordinatorPhase: null, clears: false },
      { key: 'one-unconfirmed-lease', status: 'failed', finishedAt: oldFinishedAt, checkpoint: true, leaseMode: 'mixed', coordinatorPhase: null, clears: false },
      { key: 'no-session-or-event-evidence', status: 'failed', finishedAt: oldFinishedAt, checkpoint: false, leaseMode: 'stopped', coordinatorPhase: null, clears: false },
      { key: 'unsettled-coordinator', status: 'failed', finishedAt: oldFinishedAt, checkpoint: true, leaseMode: 'stopped', coordinatorPhase: 'observed', clears: false },
    ];
    const processStartedAt = '2000-01-01T00:00:00.000Z';
    const leaseFor = async (fixture, suffix, mode) => {
      const runId = fixture.runId;
      const leaseId = `10000000-0000-4000-8000-${String(60 + fixture.index * 2 + suffix).padStart(12, '0')}`;
      const provider = mode === 'local' ? 'local' : 'fixture-provider';
      const providerLeaseId = mode === 'local' ? null : `provider-lease-${fixture.key}-${suffix}`;
      let termination = null;
      if (['stopped', 'destroyed', 'misbound'].includes(mode)) {
        termination = {
          schema: 'paperclip.remote-termination.v1',
          companyId: company,
          runId: mode === 'misbound' ? '10000000-0000-4000-8000-000000000099' : runId,
          leaseId,
          provider,
          providerLeaseId,
          state: mode === 'destroyed' ? 'destroyed' : 'stopped',
          confirmedAt: oldFinishedAt,
        };
      }
      const metadata = termination ? { remoteExecutionTermination: termination } : {};
      await client`insert into environment_leases(id,company_id,environment_id,heartbeat_run_id,status,provider,provider_lease_id,released_at,cleanup_status,metadata) values (${leaseId},${company},${environment},${runId},'released',${provider},${providerLeaseId},${oldFinishedAt},'success',${client.json(metadata)})`;
    };
    for (const [index, fixture] of nativeProcessFixtures.entries()) {
      fixture.index = index;
      fixture.runId = `10000000-0000-4000-8000-${String(30 + index).padStart(12, '0')}`;
      const profile = fixture.checkpoint ? { sessionCheckpoint: { sessionId: `fixture-session-${index}` } } : {};
      await client`insert into heartbeat_runs(id,company_id,agent_id,status,runtime_mode,native_issue_id,finished_at,runner_profile_json,process_pid,process_group_id,process_started_at) values (${fixture.runId},${company},${agent},${fixture.status},${fixture.runtimeMode ?? 'native'},${issue},${fixture.finishedAt},${client.json(profile)},${70000 + index},${80000 + index},${processStartedAt})`;
      if (fixture.event) await client`insert into heartbeat_run_events(company_id,run_id,agent_id,seq,event_type,stream,level,message,payload) values (${company},${fixture.runId},${agent},1,'harness.ready','system','info','migration compatibility evidence',${client.json({ fixture: fixture.key })})`;
      if (fixture.leaseMode === 'stopped' || fixture.leaseMode === 'destroyed' || fixture.leaseMode === 'misbound' || fixture.leaseMode === 'local') {
        await leaseFor(fixture, 0, fixture.leaseMode);
      } else if (fixture.leaseMode === 'missing') {
        await leaseFor(fixture, 0, fixture.leaseMode);
      } else if (fixture.leaseMode === 'mixed') {
        await leaseFor(fixture, 0, 'stopped');
        await leaseFor(fixture, 1, 'missing');
      }
      if (fixture.coordinatorPhase) {
        await client`insert into native_run_finalizations(run_id,company_id,issue_id,phase) values (${fixture.runId},${company},${issue},${fixture.coordinatorPhase})`;
      }
    }
    stage('apply exact candidate migrations 0374 through 0377');
    const applyScript = "import {pathToFileURL} from 'node:url'; const db=await import(pathToFileURL(process.argv[1])); const url=process.env.MIGRATION_COMPAT_DB_URL; await db.applyPendingMigrations(url); const state=await db.inspectMigrations(url); process.stdout.write(JSON.stringify(state));";
    const state = JSON.parse(runNode(['--input-type=module', '-e', applyScript, candidateIndex], temp, url));
    if (state.status !== 'upToDate') throw new Error(`Candidate migration state was ${state.status}`);
    const fixture = await client`select company_id,agent_id,idempotency_key,payload from agent_wakeup_requests where idempotency_key='task-retry:compatibility-fixture'`;
    if (fixture.length !== 1 || fixture[0].company_id !== company || fixture[0].agent_id !== agent || fixture[0].payload.source !== 'upgrade-fixture') throw new Error('Representative wakeup row did not survive candidate migrations');
    const unique = await client`select indexdef from pg_indexes where indexname='agent_wakeup_requests_task_retry_idempotency_uq'`;
    const projectOwner = await client`select column_name from information_schema.columns where table_name='company_secrets' and column_name='owner_project_id'`;
    const secrets = await client`select scope,owner_user_id,user_secret_definition_id,owner_agent_id,owner_project_id,owner_plugin_id from company_secrets where id in ('10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000007') order by scope`;
    const originalRestorePoint = await client`select checkout_name,generation,object_key,status from execution_workspace_restore_points where id='10000000-0000-4000-8000-000000000010'`;
    const deletedRestorePoint = await client`insert into execution_workspace_restore_points(id,company_id,execution_workspace_id,generation,object_key,sha256,byte_size,status) values ('10000000-0000-4000-8000-000000000011',${company},${workspace},7,'compat/deleted',${'b'.repeat(64)},10,'deleted') returning id`;
    const alternateCheckout = await client`insert into execution_workspace_restore_points(id,company_id,execution_workspace_id,generation,checkout_name,object_key,sha256,byte_size,status) values ('10000000-0000-4000-8000-000000000012',${company},${workspace},7,'alternate','compat/alternate',${'c'.repeat(64)},10,'pending') returning id`;
    const duplicateAlternate = await client`insert into execution_workspace_restore_points(id,company_id,execution_workspace_id,generation,checkout_name,object_key,sha256,byte_size,status) values ('10000000-0000-4000-8000-000000000013',${company},${workspace},7,'alternate','compat/alternate-duplicate',${'d'.repeat(64)},10,'active') on conflict do nothing returning id`;
    const restoreIndex = await client`select indexdef from pg_indexes where indexname='execution_workspace_restore_points_live_status_uniq'`;
    const migratedFinalizations = new Map();
    for (const fixture of nativeFinalizationFixtures) {
      const [row] = await client`select phase,lease_owner,recovery_state,recovery_request_id,recovery_history,updated_at from native_run_finalizations where run_id=${fixture.runId}`;
      if (!row) throw new Error(`Native finalization migration fixture disappeared: ${fixture.key}`);
      migratedFinalizations.set(fixture.key, row);
    }
    const clearedCommitted = migratedFinalizations.get('committed-unleased');
    const preservedLeased = migratedFinalizations.get('committed-leased');
    const preservedObserved = migratedFinalizations.get('observed-unleased');
    const preservedTerminal = migratedFinalizations.get('terminal-failure-unleased');
    const preservedNullState = migratedFinalizations.get('committed-without-recovery-state');
    const historyPreserved = (row) => isDeepStrictEqual(row?.recovery_history, recoveryHistory);
    const baselineTimestamp = Date.parse(baselineUpdatedAt);
    const nativeRecoveryMigrationPassed =
      clearedCommitted.phase === 'committed' && clearedCommitted.lease_owner === null &&
      clearedCommitted.recovery_state === null && clearedCommitted.recovery_request_id === null &&
      historyPreserved(clearedCommitted) && Date.parse(clearedCommitted.updated_at) > baselineTimestamp &&
      preservedLeased.phase === 'committed' && preservedLeased.lease_owner === 'native-finalizer:live' &&
      preservedLeased.recovery_state === 'resuming_session' && preservedLeased.recovery_request_id === 'leased-request' &&
      historyPreserved(preservedLeased) && Date.parse(preservedLeased.updated_at) === baselineTimestamp &&
      preservedObserved.phase === 'observed' && preservedObserved.lease_owner === null &&
      preservedObserved.recovery_state === 'resuming_session' && preservedObserved.recovery_request_id === 'observed-request' &&
      historyPreserved(preservedObserved) && Date.parse(preservedObserved.updated_at) === baselineTimestamp &&
      preservedTerminal.phase === 'terminal_failure' && preservedTerminal.lease_owner === null &&
      preservedTerminal.recovery_state === 'blocked' && preservedTerminal.recovery_request_id === 'terminal-request' &&
      historyPreserved(preservedTerminal) && Date.parse(preservedTerminal.updated_at) === baselineTimestamp &&
      preservedNullState.phase === 'committed' && preservedNullState.lease_owner === null &&
      preservedNullState.recovery_state === null && preservedNullState.recovery_request_id === 'null-state-request' &&
      historyPreserved(preservedNullState) && Date.parse(preservedNullState.updated_at) === baselineTimestamp;
    const migratedProcessFixtures = new Map();
    for (const fixture of nativeProcessFixtures) {
      const [row] = await client`select status,process_pid,process_group_id,process_started_at from heartbeat_runs where id=${fixture.runId}`;
      if (!row) throw new Error(`Native process identity migration fixture disappeared: ${fixture.key}`);
      migratedProcessFixtures.set(fixture.key, row);
    }
    const settledNativeProcessIdentityMigrationPassed = nativeProcessFixtures.every((fixture) => {
      const row = migratedProcessFixtures.get(fixture.key);
      const cleared = row.process_pid === null && row.process_group_id === null && row.process_started_at === null;
      const preserved = row.process_pid === 70000 + fixture.index && row.process_group_id === 80000 + fixture.index && Date.parse(row.process_started_at) === Date.parse(processStartedAt);
      return row.status === fixture.status && (fixture.clears ? cleared : preserved);
    });
    const assertions = [
      { id: 'migration-engine-upgrade', passed: true, detail: 'old package schema upgraded using candidate migration engine' },
      { id: 'task-retry-row-preserved', passed: true, detail: 'company/agent/payload/idempotency data preserved' },
      { id: 'candidate-schema-current', passed: true, detail: 'candidate migration journal reports upToDate' },
      { id: 'migration-specific-invariants', passed: unique.length === 1 && projectOwner.length === 1, detail: 'retry uniqueness index and project-secret owner column present' },
      { id: 'secret-scope-data-preserved', passed: secrets.length === 3 && secrets.some((s) => s.scope === 'company' && s.owner_user_id === null && s.user_secret_definition_id === null && s.owner_agent_id === null && s.owner_project_id === null && s.owner_plugin_id === null) && secrets.some((s) => s.scope === 'user' && s.owner_user_id === 'compat-user' && s.user_secret_definition_id === userDefinition && s.owner_agent_id === null && s.owner_project_id === null && s.owner_plugin_id === null) && secrets.some((s) => s.scope === 'instance' && s.owner_user_id === null && s.user_secret_definition_id === null && s.owner_agent_id === agent && s.owner_project_id === null && s.owner_plugin_id === plugin), detail: 'company, user, and agent-owned instance secret metadata survived with valid scope shapes' },
      { id: 'restore-point-checkout-migrations', passed: originalRestorePoint.length === 1 && originalRestorePoint[0].checkout_name === '' && originalRestorePoint[0].generation === 7 && originalRestorePoint[0].object_key === 'compat/primary' && deletedRestorePoint.length === 1 && alternateCheckout.length === 1 && duplicateAlternate.length === 0 && restoreIndex.length === 1 && restoreIndex[0].indexdef.includes('checkout_name') && restoreIndex[0].indexdef.includes('pending') && restoreIndex[0].indexdef.includes('active') && restoreIndex[0].indexdef.includes('expiring'), detail: '0374 preserves existing rows and default checkout name; 0375 enforces per-checkout live uniqueness while allowing deleted history' },
      { id: 'committed-native-recovery-state-migration', passed: nativeRecoveryMigrationPassed, detail: '0376 clears only recovery state on committed unleased rows, updates their timestamp, and preserves lease-owned, noncommitted, null-state and history data' },
      { id: 'settled-native-run-process-identity-migration', passed: settledNativeProcessIdentityMigrationPassed, detail: '0377 clears process identity only for old terminal native runs with session evidence, a fully confirmed remote lease and no unsettled finalization; failed, timed_out, cancelled, and interrupted native runs are covered, while legacy, active, recent, local, unleased, unconfirmed, misbound, unactioned, and unsettled-coordinator rows retain status and all identity fields' },
      { id: 'migration-inventory-extension', passed: extension.addedSql === 23, detail: `exact ${extension.oldCount}-file baseline plus ${extension.addedSql} pinned SQL migrations; no baseline SQL changed` },
    ];
    if (assertions.some((a) => !a.passed)) throw new Error('Candidate schema invariants failed');
    await restoreCandidateBoundary();
    restoreCandidateBoundary = undefined;
    restoreCandidateJournal = undefined;
    const receipt = makeReceipt({ oldVersion: EXPECTED_OLD_VERSION, oldSRI: EXPECTED_OLD_SRI, oldJournalHash: oldIdentity.journalHash, oldMigrationInventoryHash: extension.oldInventorySha256, candidateVersion, candidateSRI, candidateJournalHash: candidateIdentity.journalHash, candidateMigrationHash: extension.candidateInventorySha256, sourceMigrationHash: sourceBinding.migrationInventorySha256, sourceMigrationCount: sourceBinding.migrationInventoryCount, sourceCommit: sourceBinding.sourceCommit, patchCommit: sourceBinding.patchCommit, patchTree: sourceBinding.patchTree, assertions });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    stage('migration receipt written');
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    await restoreCandidateBoundary?.().catch(() => {});
    await restoreCandidateJournal?.().catch(() => {});
    await client?.end({ timeout: 1 }).catch(() => {});
    await database?.cleanup().catch(() => {});
    await assertPrivateTempRoot(temp, tempParent);
    await rm(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const exitCode = await runCli(main, process.argv[2]);
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise((resolve) => stream.write('', resolve))));
  process.exit(exitCode);
}
