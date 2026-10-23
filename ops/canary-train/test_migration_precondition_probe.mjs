import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFixtureConfig,
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
