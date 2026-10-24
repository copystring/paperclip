import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildFixtureConfig,
  bootRuntime,
  createFixtureEnvironment,
  assertMigrationSqlContract,
  assertZeroViolations,
  inventoryIdentity,
  pendingMigrationPreconditions,
  resolveDatabaseUrl,
  validateAppliedJournal,
  validateContext,
  withoutStdoutNoise,
} from "./migration-precondition-probe.mjs";

const validContext = () => ({
  schemaVersion: 1,
  baselineInventorySha256: "a".repeat(64),
  candidateInventorySha256: "b".repeat(64),
  activeFingerprintSha256: "c".repeat(64),
  activeProtectedFiles: { "node_modules/example.js": "e".repeat(64) },
  activeProtectedRoots: [],
  candidateManifestSha256: "d".repeat(64),
  productionIdentitySha256: "f".repeat(64),
  activePayloadPath: "/opt/paperclip/old",
  candidatePayloadPath: "/opt/paperclip/candidate",
  apiBase: "http://127.0.0.1:3100",
  paperclipHome: "/var/lib/paperclip",
  productionConfigPath: "/var/lib/paperclip/.paperclip/instances/default/config.json",
  productionEnvFilePath: "/var/lib/paperclip/.paperclip/instances/default/.env",
  productionConfigPathIdentity: { stat: ["1", "2", "3", "4", "33152"], sha256: "a".repeat(64) },
  productionEnvFilePathIdentity: { stat: ["1", "2", "3", "4", "33152"], sha256: "b".repeat(64) },
  productionServerPid: 1234,
});

test("context requires exact hashes, absolute inputs and a credential-free loopback API", () => {
  assert.equal(validateContext(validContext()).productionServerPid, 1234);
  for (const apiBase of ["https://127.0.0.1:3100", "http://example.test", "http://user:secret@127.0.0.1:3100"]) {
    assert.throws(() => validateContext({ ...validContext(), apiBase }), /loopback/);
  }
  assert.throws(() => validateContext({ ...validContext(), candidatePayloadPath: "relative" }), /candidatePayloadPath/);
  assert.throws(() => validateContext({ ...validContext(), candidateManifestSha256: "bad" }), /candidateManifestSha256/);
  assert.throws(() => validateContext({ ...validContext(), productionServerPid: 0 }), /PID/);
});

test("inventory identity is stable and binds every exact migration inventory entry", () => {
  const first = {
    "node_modules/@paperclipai/db/dist/migrations/meta/_journal.json": "1".repeat(64),
    "node_modules/@paperclipai/db/dist/migrations/0374_change.sql": "2".repeat(64),
  };
  const reordered = {
    "node_modules/@paperclipai/db/dist/migrations/0374_change.sql": "2".repeat(64),
    "node_modules/@paperclipai/db/dist/migrations/meta/_journal.json": "1".repeat(64),
  };
  assert.equal(inventoryIdentity(first), inventoryIdentity(reordered));
  assert.notEqual(inventoryIdentity(first), inventoryIdentity({
    ...first, "node_modules/@paperclipai/db/dist/migrations/0374_change.sql": "3".repeat(64),
  }));
});

test("live journal proof rejects missing, unknown and duplicate migration entries", () => {
  const inventory = {
    "node_modules/@paperclipai/db/dist/migrations/meta/_journal.json": "1".repeat(64),
    "node_modules/@paperclipai/db/dist/migrations/0374_first.sql": "2".repeat(64),
    "node_modules/@paperclipai/db/dist/migrations/0375_second.sql": "3".repeat(64),
  };
  const first = "node_modules/@paperclipai/db/dist/migrations/0374_first.sql";
  const second = "node_modules/@paperclipai/db/dist/migrations/0375_second.sql";
  assert.deepEqual(validateAppliedJournal([first, second], inventory), [first, second]);
  assert.throws(() => validateAppliedJournal([first], inventory), /does not match/);
  assert.throws(() => validateAppliedJournal([first, "foreign.sql"], inventory), /does not match/);
  assert.throws(() => validateAppliedJournal([first, first], inventory), /does not match/);
});

test("database target resolution matches runtime source precedence and mode", () => {
  assert.equal(resolveDatabaseUrl({
    processEnv: { DATABASE_URL: " postgres://process/db " },
    fileEnv: { DATABASE_URL: "postgres://file/db" },
    config: { mode: "postgres", connectionString: "postgres://config/db" },
  }), "postgres://process/db");
  assert.equal(resolveDatabaseUrl({
    processEnv: { DATABASE_URL: "" },
    fileEnv: { DATABASE_URL: "postgres://file/db" },
    config: { mode: "postgres", connectionString: "postgres://config/db" },
  }), "postgres://file/db");
  assert.equal(resolveDatabaseUrl({
    fileEnv: {},
    config: { mode: "postgres", connectionString: "postgres://config/db" },
  }), "postgres://config/db");
  assert.equal(resolveDatabaseUrl({
    fileEnv: {},
    config: { mode: "embedded-postgres", connectionString: "postgres://stale/db" },
  }), undefined);
});

test("migration preconditions bind to changed reviewed migrations only", () => {
  const taskRetry = "node_modules/@paperclipai/db/dist/migrations/0369_late_logan.sql";
  const secrets = "node_modules/@paperclipai/db/dist/migrations/0370_flimsy_lord_tyger.sql";
  const active = { [taskRetry]: "1".repeat(64), [secrets]: "2".repeat(64) };
  const candidate = { [taskRetry]: "3".repeat(64), [secrets]: "4".repeat(64) };
  assert.deepEqual(pendingMigrationPreconditions(active, candidate).map(({ id }) => id), [
    "0369_task_retry_idempotency", "0370_project_secret_constraints",
  ]);
  assert.deepEqual(pendingMigrationPreconditions(candidate, candidate), []);
  assert.throws(() => assertMigrationSqlContract("0369_task_retry_idempotency", "CREATE INDEX other_idx"), /reviewed/);
  assert.throws(() => assertMigrationSqlContract("0370_project_secret_constraints", "ALTER TABLE company_secrets ADD COLUMN owner_project_id UUID"), /reviewed/);
});

test("read-only migration preconditions fail closed on any reported conflicts", () => {
  assert.deepEqual(assertZeroViolations([{ id: "task_retry", violations: "0" }]), [{ id: "task_retry", violations: "0" }]);
  assert.throws(() => assertZeroViolations([{ id: "task_retry", violations: "2" }]), /incompatible live rows/);
  assert.throws(() => assertZeroViolations([{ id: "task_retry", violations: undefined }]), /incompatible live rows/);
});

test("fixture helper output cannot contaminate the JSON receipt channel", async () => {
  const originalWrite = process.stdout.write;
  const result = await withoutStdoutNoise(async () => {
    process.stdout.write("helper diagnostic that must not reach deployer stdout\n");
    return "proof";
  });
  assert.equal(result, "proof");
  assert.equal(process.stdout.write, originalWrite);
});

test("CLI waits for unref-awaited work, flushes the receipt, and preserves errors against beforeExit hooks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-migration-cli-lifetime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hookPath = path.join(root, "before-exit.mjs");
  const sentinelPath = path.join(root, "before-exit-ran");
  await writeFile(hookPath, `import { writeFileSync } from "node:fs";\nprocess.on('beforeExit', () => { writeFileSync(${JSON.stringify(sentinelPath)}, 'called'); process.nextTick(() => process.exit(0)); });\n`);
  const probeUrl = pathToFileURL(fileURLToPath(new URL("./migration-precondition-probe.mjs", import.meta.url))).href;
  const receipt = JSON.stringify({ schemaVersion: 1, passed: true });
  const delayedOperation = `await new Promise(resolve => { const timer = setTimeout(resolve, 50); timer.unref(); }); process.stdout.write(${JSON.stringify(`${receipt}\n`)});`;

  const oldBoundary = spawnSync(process.execPath, ["--import", pathToFileURL(hookPath).href, "--input-type=module", "-e", delayedOperation], {
    encoding: "utf8", timeout: 5_000,
  });
  assert.equal(oldBoundary.status, 0, oldBoundary.stderr);
  assert.equal(oldBoundary.stdout, "", "the old boundary exits successfully before writing its receipt");
  assert.equal(await readFile(sentinelPath, "utf8"), "called", "the old boundary invokes the competing beforeExit hook");
  await rm(sentinelPath, { force: true });

  const successful = spawnSync(process.execPath, ["--import", pathToFileURL(hookPath).href, "--input-type=module", "-e",
    `import { runCli } from ${JSON.stringify(probeUrl)}; const code = await runCli(async () => { ${delayedOperation} }); process.exit(code);`], {
    encoding: "utf8", timeout: 5_000,
  });
  assert.equal(successful.status, 0, successful.stderr);
  assert.equal(successful.stdout, `${receipt}\n`, "the full awaited operation completes before the exact receipt is emitted");
  assert.equal(await readFile(sentinelPath, "utf8").catch(() => null), null, "the new boundary exits explicitly before beforeExit");

  const failed = spawnSync(process.execPath, ["--import", pathToFileURL(hookPath).href, "--input-type=module", "-e",
    `import { runCli } from ${JSON.stringify(probeUrl)}; const code = await runCli(async () => { throw new Error("controlled failure"); }); process.exit(code);`], {
    encoding: "utf8", timeout: 5_000,
  });
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(failed.stdout, "");
  assert.deepEqual(JSON.parse(failed.stderr), { ok: false, error: "controlled failure" });
  assert.equal(await readFile(sentinelPath, "utf8").catch(() => null), null);

  const invalidCli = spawnSync(process.execPath, ["--import", pathToFileURL(hookPath).href,
    fileURLToPath(new URL("./migration-precondition-probe.mjs", import.meta.url))], {
    encoding: "utf8", timeout: 5_000,
  });
  assert.equal(invalidCli.status, 1, invalidCli.stderr);
  assert.equal(invalidCli.stdout, "");
  assert.deepEqual(JSON.parse(invalidCli.stderr), { ok: false, error: "Expected an absolute probe context path" });
  assert.equal(await readFile(sentinelPath, "utf8").catch(() => null), null);

  const pending = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { runCli } from ${JSON.stringify(probeUrl)}; const code = await runCli(() => new Promise(() => {})); process.exit(code);`], {
    encoding: "utf8", timeout: 1_000,
  });
  assert.equal(pending.error?.code, "ETIMEDOUT", "an unsettled operation remains alive until the bounded test timeout");
  assert.notEqual(pending.status, 0, "pending operation cannot return a false successful exit");
});

test("fixture config and child environment disable production side effects and workers", () => {
  const home = "/tmp/probe/old";
  const configPath = `${home}/.paperclip/instances/default/config.json`;
  const dbUrl = "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
  const config = buildFixtureConfig(home, 32001, dbUrl);
  const env = createFixtureEnvironment(home, configPath, 32001, dbUrl, "fixture-only-random-secret");
  assert.equal(config.database.backup.enabled, false);
  assert.equal(config.telemetry.enabled, false);
  assert.equal(config.server.host, "127.0.0.1");
  assert.equal(env.DATABASE_URL, dbUrl);
  assert.equal(env.PAPERCLIP_DB_BACKUP_ENABLED, "false");
  assert.equal(env.HEARTBEAT_SCHEDULER_ENABLED, "false");
  assert.equal(JSON.parse(env.PAPERCLIP_MANAGED_CONFIG).plugins.autoInstall.length, 0);
  assert.equal(Object.hasOwn(env, "ANTHROPIC_API_KEY"), false);
  assert.equal(Object.hasOwn(env, "OPENAI_API_KEY"), false);
  assert.equal(env.BETTER_AUTH_SECRET, "fixture-only-random-secret");
});

test("a real failed API child preserves its startup error together with cleanup failure", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-boot-failure-"));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = path.join(root, "payload");
  const dist = path.join(payload, "node_modules", "@paperclipai", "server", "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, "build-info.json"), JSON.stringify({ commit: "1".repeat(40) }));
  await writeFile(path.join(dist, "index.js"), "process.stderr.write('controlled startup failure\\n'); process.exit(1);\n");

  await assert.rejects(bootRuntime("old", payload, "postgres://fixture:secret@127.0.0.1/fixture", root), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /API child exited before readiness:.*controlled startup failure/s);
    assert.match(error.errors[1].message, /old API child did not stop cleanly \(1\)/);
    assert.match(error.message, /controlled startup failure/);
    return true;
  });
});
