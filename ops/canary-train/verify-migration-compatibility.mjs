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
const USER = 'paperclip';
const PASSWORD = 'paperclip';

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function verifySRI(bytes, sri) {
  const m = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(sri ?? '');
  if (!m) throw new Error('Expected one exact sha512 SRI token');
  const actual = createHash('sha512').update(bytes).digest('base64');
  if (actual !== m[1]) throw new Error('Old package SRI did not match the pinned package');
  return actual;
}
export function makeReceipt({ oldVersion, oldSRI, oldJournalHash, candidateJournalHash, candidateMigrationHash, assertions }) {
  if (oldVersion !== EXPECTED_OLD_VERSION || oldSRI !== EXPECTED_OLD_SRI) throw new Error('Unapproved old package identity');
  if (!/^[a-f0-9]{64}$/.test(oldJournalHash) || !/^[a-f0-9]{64}$/.test(candidateJournalHash) || !/^[a-f0-9]{64}$/.test(candidateMigrationHash)) throw new Error('Receipt requires SHA-256 migration identities');
  if (!Array.isArray(assertions) || assertions.length < 3 || assertions.some((a) => a.passed !== true)) throw new Error('Receipt can only attest successful invariants');
  const body = { schema: 1, oldPackage: { name: '@paperclipai/db', version: oldVersion, integrity: oldSRI, journalSha256: oldJournalHash }, candidate: { journalSha256: candidateJournalHash, migrationsSha256: candidateMigrationHash }, assertions };
  return { ...body, receiptSha256: sha256(Buffer.from(JSON.stringify(body))) };
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
  const files = (await (await import('node:fs/promises')).readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  const h = createHash('sha256');
  for (const name of files) { h.update(name); h.update('\0'); h.update(await readFile(path.join(dir, name))); h.update('\0'); }
  return { journalHash: sha256(journal), migrationsHash: h.digest('hex') };
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
    await candidateDb.applyPendingMigrations(url);
    const state = await candidateDb.inspectMigrations(url);
    if (state.status !== 'upToDate') throw new Error(`Candidate migration state was ${state.status}`);
    const fixture = await client`select company_id,agent_id,idempotency_key,payload from agent_wakeup_requests where idempotency_key='task-retry:compatibility-fixture'`;
    if (fixture.length !== 1 || fixture[0].company_id !== company || fixture[0].agent_id !== agent || fixture[0].payload.source !== 'upgrade-fixture') throw new Error('Representative wakeup row did not survive candidate migrations');
    const unique = await client`select indexdef from pg_indexes where indexname='agent_wakeup_requests_task_retry_idempotency_uq'`;
    const projectOwner = await client`select column_name from information_schema.columns where table_name='company_secrets' and column_name='owner_project_id'`;
    const assertions = [
      { id: 'migration-engine-upgrade', passed: true, detail: 'old package schema upgraded using candidate migration engine' },
      { id: 'task-retry-row-preserved', passed: true, detail: 'company/agent/payload/idempotency data preserved' },
      { id: 'candidate-schema-current', passed: true, detail: 'candidate migration journal reports upToDate' },
      { id: 'migration-specific-invariants', passed: unique.length === 1 && projectOwner.length === 1, detail: 'retry uniqueness index and project-secret owner column present' },
    ];
    if (assertions.some((a) => !a.passed)) throw new Error('Candidate schema invariants failed');
    const receipt = makeReceipt({ oldVersion, oldSRI, oldJournalHash: oldIdentity.journalHash, candidateJournalHash: candidateIdentity.journalHash, candidateMigrationHash: candidateIdentity.migrationsHash, assertions });
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
