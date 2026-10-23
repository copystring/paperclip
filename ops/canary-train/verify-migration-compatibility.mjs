#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

const EXPECTED_OLD_VERSION = '2026.1017.0-canary.6';
const EXPECTED_OLD_SRI = 'sha512-ben+ng50+SxXKmXD8MCUit6yZf20i0CQBWG6ZZq44AGvnX8GF5OvLH/F9ogzXFAgEW/Kc2LXCf3qvPolcoagCg==';
const EXPECTED_OLD_INVENTORY_COUNT = 354;
const EXPECTED_OLD_INVENTORY_SHA256 = '9cec6945b6dd1c38b80940e5246d500da8b5d506a4be68db20ab89136fc11ed9';
const EXPECTED_ADDED_SQL_COUNT = 19;
export const MIGRATION_INVENTORY_PREFIX = 'node_modules/@paperclipai/db/dist/migrations/';
const USER = 'paperclip';
const PASSWORD = 'paperclip';
const REQUIRED_ASSERTIONS = ['migration-engine-upgrade', 'task-retry-row-preserved', 'candidate-schema-current', 'migration-specific-invariants', 'secret-scope-data-preserved', 'migration-inventory-extension'];

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function verifySRI(bytes, sri) {
  const m = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(sri ?? '');
  if (!m) throw new Error('Expected one exact sha512 SRI token');
  const actual = createHash('sha512').update(bytes).digest('base64');
  if (actual !== m[1]) throw new Error('Old package SRI did not match the pinned package');
  return actual;
}
export function makeReceipt({ oldVersion, oldSRI, oldJournalHash, oldMigrationInventoryHash, candidateJournalHash, candidateMigrationHash, assertions }) {
  if (oldVersion !== EXPECTED_OLD_VERSION || oldSRI !== EXPECTED_OLD_SRI) throw new Error('Unapproved old package identity');
  if (![oldJournalHash, oldMigrationInventoryHash, candidateJournalHash, candidateMigrationHash].every((h) => /^[a-f0-9]{64}$/.test(h))) throw new Error('Receipt requires SHA-256 migration identities');
  if (!Array.isArray(assertions) || assertions.length !== REQUIRED_ASSERTIONS.length || assertions.some((a) => a.passed !== true) || REQUIRED_ASSERTIONS.some((id) => !assertions.some((a) => a.id === id))) throw new Error('Receipt must contain every successful migration invariant');
  const body = { schema: 1, oldPackage: { name: '@paperclipai/db', version: oldVersion, integrity: oldSRI, migrationInventoryCount: EXPECTED_OLD_INVENTORY_COUNT, migrationInventorySha256: oldMigrationInventoryHash, journalSha256: oldJournalHash }, candidate: { migrationInventoryCount: EXPECTED_OLD_INVENTORY_COUNT + EXPECTED_ADDED_SQL_COUNT, migrationInventorySha256: candidateMigrationHash, journalSha256: candidateJournalHash }, assertions };
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
export function assertMigrationExtension(oldInventory, candidateInventory, oldJournal, candidateJournal) {
  try {
    assertInventoryBinding(oldInventory, { expectedCount: EXPECTED_OLD_INVENTORY_COUNT, expectedSha256: EXPECTED_OLD_INVENTORY_SHA256, pathPrefix: MIGRATION_INVENTORY_PREFIX });
  } catch {
    throw new Error('Old package migration inventory did not match the reviewed 0354 baseline');
  }
  const oldFiles = Object.keys(oldInventory).sort();
  const candidateFiles = Object.keys(candidateInventory).sort();
  if (candidateFiles.some((name) => !name.startsWith(MIGRATION_INVENTORY_PREFIX))) throw new Error('Candidate migration inventory has a path outside the package inventory');
  for (const name of oldFiles) {
    if (name === `${MIGRATION_INVENTORY_PREFIX}meta/_journal.json`) continue;
    if (candidateInventory[name] !== oldInventory[name]) throw new Error(`Candidate changed or removed baseline migration ${name}`);
  }
  const added = candidateFiles.filter((name) => !Object.hasOwn(oldInventory, name));
  if (added.length !== EXPECTED_ADDED_SQL_COUNT || added.some((name) => !/\/\d{4}_.+\.sql$/.test(name))) throw new Error('Candidate must add exactly the 19 reviewed SQL migrations');
  if (candidateFiles.length !== EXPECTED_OLD_INVENTORY_COUNT + EXPECTED_ADDED_SQL_COUNT) throw new Error('Candidate migration inventory has unexpected files');
  const priorEntries = oldJournal.entries;
  if (!Array.isArray(priorEntries) || !Array.isArray(candidateJournal.entries) || candidateJournal.entries.length !== priorEntries.length + EXPECTED_ADDED_SQL_COUNT) throw new Error('Candidate migration journal length is not a 19-entry extension');
  if (JSON.stringify(candidateJournal.entries.slice(0, priorEntries.length)) !== JSON.stringify(priorEntries)) throw new Error('Candidate changed the pinned migration journal prefix');
  return { oldCount: oldFiles.length, candidateCount: candidateFiles.length, addedSql: added.length, oldInventorySha256: canonicalInventoryHash(oldInventory), candidateInventorySha256: canonicalInventoryHash(candidateInventory) };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${(result.stderr || result.stdout).slice(-3000)}`);
  return result.stdout;
}
async function port() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close((e) => e ? reject(e) : resolve(p)); });
  });
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
async function main() {
  const [candidateRoot, receiptPath, oldVersion = EXPECTED_OLD_VERSION, oldSRI = EXPECTED_OLD_SRI] = process.argv.slice(2);
  if (!candidateRoot || !receiptPath) throw new Error('Usage: node verify-migration-compatibility.mjs <candidate-db-package-root> <receipt-output> [old-version] [old-sri]');
  if (oldVersion !== EXPECTED_OLD_VERSION || oldSRI !== EXPECTED_OLD_SRI) throw new Error('Old package version/SRI must match the reviewed pin');
  const candidateIndex = path.resolve(candidateRoot, 'dist/index.js');
  const candidateMigrations = path.resolve(candidateRoot, 'dist/migrations');
  const candidateIdentity = await migrationIdentity(candidateMigrations);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'paperclip-migration-compat-'));
  let pg; let client;
  try {
    const pack = JSON.parse(run('npm', ['pack', `@paperclipai/db@${oldVersion}`, '--json', '--pack-destination', temp], temp))[0];
    if (pack.version !== oldVersion) throw new Error('Registry returned a different old package version');
    if (pack.integrity !== oldSRI) throw new Error('Registry metadata integrity did not match the reviewed pin');
    const tgz = await readFile(path.join(temp, pack.filename));
    verifySRI(tgz, oldSRI);
    const install = path.join(temp, 'old');
    await (await import('node:fs/promises')).mkdir(install);
    run('npm', ['install', '--prefix', install, '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund', path.join(temp, pack.filename)], temp);
    const oldIndex = path.join(install, 'node_modules/@paperclipai/db/dist/index.js');
    const oldMigrations = path.join(install, 'node_modules/@paperclipai/db/dist/migrations');
    const oldIdentity = await migrationIdentity(oldMigrations);
    const extension = assertMigrationExtension(oldIdentity.inventory, candidateIdentity.inventory, oldIdentity.journal, candidateIdentity.journal);
    const oldDb = await import(pathToFileURL(oldIndex));
    const candidateDb = await import(pathToFileURL(candidateIndex));
    const oldRequire = createRequire(path.join(install, 'package.json'));
    const EmbeddedPostgres = (await import(pathToFileURL(oldRequire.resolve('embedded-postgres')))).default;
    const dbDir = path.join(temp, 'pg'); const pgPort = await port();
    pg = new EmbeddedPostgres({ databaseDir: dbDir, user: USER, password: PASSWORD, port: pgPort, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C', '--lc-messages=C'] });
    await pg.initialise(); await pg.start();
    const adminUrl = `postgres://${USER}:${PASSWORD}@127.0.0.1:${pgPort}/postgres`;
    await oldDb.ensurePostgresDatabase(adminUrl, 'paperclip');
    const url = `postgres://${USER}:${PASSWORD}@127.0.0.1:${pgPort}/paperclip`;
    await oldDb.applyPendingMigrations(url);
    const { default: postgres } = await import(pathToFileURL(oldRequire.resolve('postgres')));
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
    await candidateDb.applyPendingMigrations(url);
    const state = await candidateDb.inspectMigrations(url);
    if (state.status !== 'upToDate') throw new Error(`Candidate migration state was ${state.status}`);
    const fixture = await client`select company_id,agent_id,idempotency_key,payload from agent_wakeup_requests where idempotency_key='task-retry:compatibility-fixture'`;
    if (fixture.length !== 1 || fixture[0].company_id !== company || fixture[0].agent_id !== agent || fixture[0].payload.source !== 'upgrade-fixture') throw new Error('Representative wakeup row did not survive candidate migrations');
    const unique = await client`select indexdef from pg_indexes where indexname='agent_wakeup_requests_task_retry_idempotency_uq'`;
    const projectOwner = await client`select column_name from information_schema.columns where table_name='company_secrets' and column_name='owner_project_id'`;
    const secrets = await client`select scope,owner_user_id,user_secret_definition_id,owner_agent_id,owner_project_id,owner_plugin_id from company_secrets where id in ('10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000007') order by scope`;
    const assertions = [
      { id: 'migration-engine-upgrade', passed: true, detail: 'old package schema upgraded using candidate migration engine' },
      { id: 'task-retry-row-preserved', passed: true, detail: 'company/agent/payload/idempotency data preserved' },
      { id: 'candidate-schema-current', passed: true, detail: 'candidate migration journal reports upToDate' },
      { id: 'migration-specific-invariants', passed: unique.length === 1 && projectOwner.length === 1, detail: 'retry uniqueness index and project-secret owner column present' },
      { id: 'secret-scope-data-preserved', passed: secrets.length === 3 && secrets.some((s) => s.scope === 'company' && s.owner_user_id === null && s.user_secret_definition_id === null && s.owner_agent_id === null && s.owner_project_id === null && s.owner_plugin_id === null) && secrets.some((s) => s.scope === 'user' && s.owner_user_id === 'compat-user' && s.user_secret_definition_id === userDefinition && s.owner_agent_id === null && s.owner_project_id === null && s.owner_plugin_id === null) && secrets.some((s) => s.scope === 'instance' && s.owner_user_id === null && s.user_secret_definition_id === null && s.owner_agent_id === agent && s.owner_project_id === null && s.owner_plugin_id === plugin), detail: 'company, user, and agent-owned instance secret metadata survived with valid scope shapes' },
      { id: 'migration-inventory-extension', passed: extension.addedSql === 19, detail: `exact ${extension.oldCount}-file baseline plus ${extension.addedSql} SQL migrations; no baseline SQL changed` },
    ];
    if (assertions.some((a) => !a.passed)) throw new Error('Candidate schema invariants failed');
    const receipt = makeReceipt({ oldVersion, oldSRI, oldJournalHash: oldIdentity.journalHash, oldMigrationInventoryHash: extension.oldInventorySha256, candidateJournalHash: candidateIdentity.journalHash, candidateMigrationHash: extension.candidateInventorySha256, assertions });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    await client?.end({ timeout: 1 }).catch(() => {});
    await pg?.stop().catch(() => {});
    await rm(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
