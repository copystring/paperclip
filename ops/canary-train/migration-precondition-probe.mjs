#!/usr/bin/env node
/**
 * Read-only live migration preconditions and isolated old/candidate API boot
 * proof for the Canary train. This file is service-owned and hash-pinned by
 * the instance hook registry; it never applies migrations to the live DB.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HASH = /^[a-f0-9]{64}$/;
const MIGRATION_ROOT = "node_modules/@paperclipai/db/dist/migrations/";
const REQUIRED_CONTEXT = [
  "schemaVersion",
  "baselineInventorySha256",
  "candidateInventorySha256",
  "activeFingerprintSha256",
  "activeProtectedFiles",
  "activeProtectedRoots",
  "candidateManifestSha256",
  "productionIdentitySha256",
  "activePayloadPath",
  "candidatePayloadPath",
  "apiBase",
  "paperclipHome",
  "productionConfigPath",
  "productionEnvFilePath",
  "productionConfigPathIdentity",
  "productionEnvFilePathIdentity",
  "productionServerPid",
];
const MAX_CAPTURE_BYTES = 96 * 1024;
const HEALTH_TIMEOUT_MS = 45_000;
const CHILD_STOP_TIMEOUT_MS = 8_000;

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertHash(value, name) {
  if (typeof value !== "string" || !HASH.test(value)) fail(`Invalid ${name}`);
}

function assertAbsolutePath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    fail(`Invalid ${name}`);
  }
}

function assertLoopbackApiBase(value) {
  let url;
  try { url = new URL(value); } catch { fail("Invalid API base URL"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || (url.pathname !== "" && url.pathname !== "/") || url.username || url.password || url.search || url.hash) {
    fail("API base URL must be credential-free loopback HTTP");
  }
  return url;
}

export function validateContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) fail("Invalid probe context");
  for (const key of REQUIRED_CONTEXT) {
    if (!(key in context)) fail(`Missing probe context field: ${key}`);
  }
  if (context.schemaVersion !== 1) fail("Unsupported probe context schema");
  for (const key of ["baselineInventorySha256", "candidateInventorySha256", "activeFingerprintSha256", "candidateManifestSha256", "productionIdentitySha256"]) {
    assertHash(context[key], key);
  }
  if (!context.activeProtectedFiles || typeof context.activeProtectedFiles !== "object"
    || Array.isArray(context.activeProtectedFiles) || Object.keys(context.activeProtectedFiles).length === 0) {
    fail("Invalid registered active protected-file inventory");
  }
  for (const [name, digest] of Object.entries(context.activeProtectedFiles)) {
    if (typeof name !== "string" || !name || name.includes("\\") || name.startsWith("/")
      || name.split("/").some((part) => !part || part === "." || part === "..")) fail("Invalid protected-file inventory path");
    assertHash(digest, "active protected-file digest");
  }
  for (const key of ["productionConfigPathIdentity", "productionEnvFilePathIdentity"]) {
    const identity = context[key];
    if (!identity || typeof identity !== "object" || Array.isArray(identity)
      || !Array.isArray(identity.stat) || identity.stat.length !== 5
      || identity.stat.some((value) => typeof value !== "string" || !/^\d+$/.test(value))) {
      fail(`Invalid ${key}`);
    }
    assertHash(identity.sha256, `${key} digest`);
  }
  if (!Array.isArray(context.activeProtectedRoots)
    || context.activeProtectedRoots.some((root) => typeof root !== "string" || !root)) {
    fail("Invalid registered active protected roots");
  }
  for (const key of ["activePayloadPath", "candidatePayloadPath", "paperclipHome", "productionConfigPath", "productionEnvFilePath"]) {
    assertAbsolutePath(context[key], key);
  }
  if (!Number.isSafeInteger(context.productionServerPid) || context.productionServerPid <= 1) {
    fail("Invalid production server PID");
  }
  assertLoopbackApiBase(context.apiBase);
  if (context.activePayloadPath === context.candidatePayloadPath) fail("Active and candidate payloads must differ");
  return context;
}

async function assertRealDirectory(input, name) {
  const info = await lstat(input).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) fail(`${name} is not a real directory`);
  const resolved = await realpath(input);
  if (resolved !== path.resolve(input)) fail(`${name} path is not canonical`);
  return resolved;
}

async function walkFiles(root, relative = "") {
  const dir = path.join(root, relative);
  const entries = await readdir(dir, { withFileTypes: true });
  const result = {};
  for (const entry of entries) {
    const rel = path.posix.join(relative.split(path.sep).join("/"), entry.name);
    const full = path.join(root, rel);
    if (entry.isSymbolicLink()) fail("Migration inventory contains a symlink");
    if (entry.isDirectory()) Object.assign(result, await walkFiles(root, rel));
    else if (entry.isFile()) result[rel.split(path.sep).join("/")] = sha256(await readFile(full));
    else fail("Migration inventory contains a non-regular file");
  }
  return result;
}

async function migrationInventory(payloadRoot) {
  const migrationRoot = path.join(payloadRoot, "node_modules", "@paperclipai", "db", "dist", "migrations");
  const info = await lstat(migrationRoot).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) fail("Migration directory is unavailable or unsafe");
  const files = await walkFiles(migrationRoot);
  if (!Object.keys(files).some((name) => name.endsWith(".sql"))
    || !Object.keys(files).includes("meta/_journal.json")) fail("Migration inventory is incomplete");
  return Object.fromEntries(Object.entries(files).map(([name, digest]) => [`${MIGRATION_ROOT}${name}`, digest]));
}

async function protectedInventory(payloadRoot, roots) {
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((value) => typeof value !== "string")) {
    fail("Active install receipt has no protected runtime roots");
  }
  const inventory = {};
  const addFile = async (relative) => {
    const normalized = relative.split("\\").join("/");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
      fail("Active integrity receipt contains an unsafe relative path");
    }
    const file = path.join(payloadRoot, ...normalized.split("/"));
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) fail("Active protected file is missing or unsafe");
    inventory[normalized] = sha256(await readFile(file));
  };
  for (const root of roots) {
    const normalized = root.split("\\").join("/");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
      fail("Active integrity receipt contains an unsafe protected root");
    }
    const absolute = path.join(payloadRoot, ...normalized.split("/"));
    const rootInfo = await lstat(absolute).catch(() => null);
    if (rootInfo?.isSymbolicLink() || (!rootInfo?.isDirectory() && !rootInfo?.isFile())) fail("Active protected root is missing or unsafe");
    if (rootInfo.isFile()) {
      await addFile(normalized);
    } else {
      Object.assign(inventory, await walkFiles(payloadRoot, normalized));
    }
  }
  for (const role of ["default", "ceo"]) {
    await addFile(`node_modules/@paperclipai/server/dist/onboarding-assets/${role}/AGENTS.md`);
  }
  return Object.fromEntries(Object.entries(inventory).sort(([left], [right]) => left.localeCompare(right)));
}

export function inventoryIdentity(inventory) {
  return sha256(Buffer.from(canonical(inventory), "utf8"));
}

function migrationSqlNames(inventory) {
  return Object.keys(inventory).filter((name) => name.endsWith(".sql")).sort();
}

export function validateAppliedJournal(applied, inventory) {
  const sqlNames = migrationSqlNames(inventory);
  if (!Array.isArray(applied) || applied.some((name) => typeof name !== "string")
    || new Set(applied).size !== applied.length
    || canonical([...applied].sort()) !== canonical(sqlNames)) {
    fail("Production migration journal does not match the active migration set");
  }
  return sqlNames;
}

const MIGRATION_PRECONDITIONS = [
  {
    suffix: "/0369_late_logan.sql",
    required: ['create unique index concurrently if not exists "agent_wakeup_requests_task_retry_idempotency_uq"', '"idempotency_key" like \'task-retry:%\''],
    id: "0369_task_retry_idempotency",
  },
  {
    suffix: "/0370_flimsy_lord_tyger.sql",
    required: ['create unique index "projects_company_id_uq"', 'create unique index "company_secrets_project_instance_owner_key_uq"', '"company_secrets_scope_shape_check"', '"owner_project_id"', '"owner_agent_id" is not null) <> ("company_secrets"."owner_project_id" is not null)'],
    id: "0370_project_secret_constraints",
  },
];

export function pendingMigrationPreconditions(activeInventory, candidateInventory) {
  return MIGRATION_PRECONDITIONS.filter(({ suffix }) => {
    const candidate = Object.keys(candidateInventory).find((name) => name.endsWith(suffix));
    if (!candidate) return false;
    return activeInventory[candidate] !== candidateInventory[candidate];
  });
}

export function assertMigrationSqlContract(id, sql) {
  const definition = MIGRATION_PRECONDITIONS.find((item) => item.id === id);
  if (!definition || typeof sql !== "string") fail("Unknown migration precondition contract");
  const normalized = sql.toLowerCase().replace(/\s+/g, " ");
  if (definition.required.some((fragment) => !normalized.includes(fragment))) {
    fail(`Candidate migration does not match the reviewed ${id} precondition contract`);
  }
  return true;
}

export function assertZeroViolations(checks) {
  if (!Array.isArray(checks) || checks.some((check) => !check || typeof check.id !== "string"
    || !/^\d+$/.test(String(check.violations)) || BigInt(check.violations) !== 0n)) {
    fail("Read-only migration preconditions found incompatible live rows");
  }
  return checks;
}

export function resolveDatabaseUrl({ processEnv = {}, fileEnv = {}, config = {} }) {
  const processUrl = processEnv.DATABASE_URL?.trim();
  if (processUrl) return processUrl;
  const fileUrl = fileEnv.DATABASE_URL?.trim();
  if (fileUrl) return fileUrl;
  if (config.mode === "postgres") {
    const configUrl = config.connectionString?.trim();
    if (configUrl) return configUrl;
  }
  return undefined;
}

function getDotenvParser(payloadRoot) {
  const require = createRequire(path.join(payloadRoot, "node_modules", "@paperclipai", "server", "package.json"));
  const dotenv = require("dotenv");
  if (typeof dotenv.parse !== "function") fail("Runtime dotenv parser is unavailable");
  return dotenv.parse;
}

function mergeEnv(target, parsed) {
  for (const [key, value] of Object.entries(parsed)) if (target[key] === undefined) target[key] = value;
}

export async function withoutStdoutNoise(action) {
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    return await action();
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function processEnvironment(pid) {
  const procRoot = `/proc/${pid}`;
  const proc = await stat(procRoot).catch(() => null);
  if (!proc?.isDirectory()) fail("Production server process is not present");
  const statText = await readFile(path.join(procRoot, "stat"), "utf8");
  const statFields = statText.slice(statText.lastIndexOf(")") + 2).trim().split(/\s+/);
  const startTime = statFields[19];
  if (!/^\d+$/.test(startTime ?? "")) fail("Production server process identity is invalid");
  const cmdline = (await readFile(path.join(procRoot, "cmdline"))).toString("utf8").split("\0").filter(Boolean);
  const executable = await readlink(path.join(procRoot, "exe"));
  const envRaw = await readFile(path.join(procRoot, "environ"));
  const env = {};
  for (const entry of envRaw.toString("utf8").split("\0")) {
    const index = entry.indexOf("=");
    if (index > 0) env[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return { pid, procRoot, cmdline, executable, env, startTime, cwd: await realpath(path.join(procRoot, "cwd")) };
}

async function assertProcessIdentityUnchanged(server) {
  const statText = await readFile(path.join(server.procRoot, "stat"), "utf8").catch(() => "");
  const statFields = statText.slice(statText.lastIndexOf(")") + 2).trim().split(/\s+/);
  if (statFields[19] !== server.startTime) fail("Production server PID identity changed during the probe");
}

function expandHomeAware(input, home) {
  if (typeof input !== "string" || !input.trim()) fail("Invalid configured embedded database path");
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.resolve(home, input.slice(2));
  return path.resolve(input);
}

async function readProductionDatabaseTarget(context, activeRoot) {
  const configStat = await lstat(context.productionConfigPath).catch(() => null);
  const envStat = await lstat(context.productionEnvFilePath).catch(() => null);
  if (!configStat?.isFile() || configStat.isSymbolicLink() || !envStat?.isFile() || envStat.isSymbolicLink()) {
    fail("Registered production config or environment file is unavailable or unsafe");
  }
  const configReal = await realpath(context.productionConfigPath);
  const envReal = await realpath(context.productionEnvFilePath);
  if (configReal !== path.resolve(context.productionConfigPath) || envReal !== path.resolve(context.productionEnvFilePath)) {
    fail("Registered production config paths are not canonical");
  }
  const insideHome = (value) => {
    const relative = path.relative(path.resolve(context.paperclipHome), value);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!insideHome(configReal) || !insideHome(envReal)
    || envReal !== path.join(path.dirname(configReal), ".env")) {
    fail("Registered production config files are outside the Paperclip instance home");
  }
  const configIdentity = await registeredFileIdentity(configReal);
  const envIdentity = await registeredFileIdentity(envReal);
  if (canonical(configIdentity) !== canonical(context.productionConfigPathIdentity)
    || canonical(envIdentity) !== canonical(context.productionEnvFilePathIdentity)) {
    fail("Registered production config identity changed");
  }
  const productionIdentity = {
    productionConfigPath: configReal,
    productionEnvFilePath: envReal,
    productionConfigPathIdentity: configIdentity,
    productionEnvFilePathIdentity: envIdentity,
    productionServerPid: context.productionServerPid,
    paperclipHome: await realpath(context.paperclipHome),
    apiBase: context.apiBase,
  };
  if (inventoryIdentity(productionIdentity) !== context.productionIdentitySha256) {
    fail("Production runtime identity hash does not match the registered context");
  }
  const server = await processEnvironment(context.productionServerPid);
  const expectedEntries = [
    { path: path.join(activeRoot, "node_modules", "paperclipai", "dist", "index.js"), suffix: "/node_modules/paperclipai/dist/index.js", cli: true },
    { path: path.join(activeRoot, "node_modules", "@paperclipai", "server", "dist", "index.js"), suffix: "/node_modules/@paperclipai/server/dist/index.js", cli: false },
  ];
  let runningActiveEntry = false;
  for (let index = 0; index < server.cmdline.length; index += 1) {
    const arg = server.cmdline[index];
    const expected = expectedEntries.find((entry) => arg.endsWith(entry.suffix));
    if (!expected) continue;
    const candidateEntry = path.isAbsolute(arg) ? arg : path.resolve(server.cwd, arg);
    const matches = await realpath(candidateEntry).catch(() => null) === expected.path;
    const isRunCommand = !expected.cli || server.cmdline.slice(index + 1).includes("run");
    if (matches && isRunCommand) runningActiveEntry = true;
  }
  if (!/\/(?:node|nodejs)$/.test(server.executable) || !runningActiveEntry) {
    fail("Production PID is not running the active server entrypoint");
  }
  const configuredByProcess = server.env.PAPERCLIP_CONFIG;
  const expectedConfig = configuredByProcess
    ? path.resolve(server.cwd, configuredByProcess.trim())
    : path.resolve(context.paperclipHome, ".paperclip", "instances", server.env.PAPERCLIP_INSTANCE_ID || "default", "config.json");
  if (expectedConfig !== configReal) fail("Production process config path does not match registered config");
  const config = JSON.parse(await readFile(configReal, "utf8"));
  const runtimeEnv = { ...server.env };
  const parse = getDotenvParser(activeRoot);
  const registeredEnv = parse(await readFile(envReal));
  mergeEnv(runtimeEnv, registeredEnv);
  const cwdEnv = path.join(server.cwd, ".env");
  if (path.resolve(cwdEnv) !== envReal && runtimeEnv.PAPERCLIP_DISABLE_CWD_ENV_FILE !== "true") {
    const cwdStat = await lstat(cwdEnv).catch(() => null);
    if (cwdStat?.isSymbolicLink()) fail("Production working-directory environment file is a symlink");
    if (cwdStat?.isFile()) mergeEnv(runtimeEnv, parse(await readFile(cwdEnv)));
  }
  const processHome = runtimeEnv.PAPERCLIP_HOME ?? server.env.HOME;
  const resolvedHome = processHome
    ? path.resolve(server.cwd, processHome)
    : path.resolve(context.paperclipHome);
  if (resolvedHome !== path.resolve(context.paperclipHome)) fail("Production process home does not match registered Paperclip home");
  const osHome = server.env.HOME ? path.resolve(server.cwd, server.env.HOME) : resolvedHome;
  const configId = runtimeEnv.PAPERCLIP_CONFIG;
  if (configId && path.resolve(server.cwd, configId.trim()) !== configReal) fail("Resolved runtime config differs from registered production config");

  const databaseUrl = resolveDatabaseUrl({
    processEnv: server.env,
    fileEnv: runtimeEnv,
    config: config.database ?? {},
  });
  if (databaseUrl) {
    let productionPort = null;
    try {
      const url = new URL(databaseUrl);
      if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) productionPort = Number(url.port) || 5432;
    } catch { fail("Production database URL is invalid"); }
    await assertProcessIdentityUnchanged(server);
    return { connectionString: databaseUrl, server, mode: "postgres", productionPort, productionIdentitySha256: context.productionIdentitySha256 };
  }
  if ((config.database?.mode ?? "embedded-postgres") !== "embedded-postgres") fail("Production database URL is unavailable");
  const home = resolvedHome;
  const dataDir = expandHomeAware(config.database?.embeddedPostgresDataDir ?? "~/.paperclip/instances/default/db", osHome);
  const pidFile = path.join(dataDir, "postmaster.pid");
  const pidInfo = await readFile(pidFile, "utf8").catch(() => null);
  if (!pidInfo) fail("Embedded production PostgreSQL identity file is unavailable");
  const fields = pidInfo.split(/\r?\n/);
  const postgresPid = Number(fields[0]);
  const recordedDir = path.resolve(fields[1] ?? "");
  const port = Number(fields[3]);
  if (!Number.isSafeInteger(postgresPid) || postgresPid <= 1 || recordedDir !== dataDir || !Number.isInteger(port) || port < 1 || port > 65535) {
    fail("Embedded production PostgreSQL identity does not match configured data directory");
  }
  await stat(`/proc/${postgresPid}`).catch(() => fail("Embedded production PostgreSQL process is not running"));
  const postgresCommand = (await readFile(`/proc/${postgresPid}/cmdline`).catch(() => Buffer.alloc(0))).toString("utf8");
  if (!/(?:^|\/)postgres(?:\0|\s|$)/.test(postgresCommand)) fail("Embedded production database process identity is invalid");
  await assertProcessIdentityUnchanged(server);
  return {
    connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    server,
    mode: "embedded-postgres",
    productionPort: port,
    expectedDataDir: dataDir,
    productionIdentitySha256: context.productionIdentitySha256,
  };
}

async function registeredFileIdentity(file) {
  const info = await lstat(file, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) fail("Registered production config is unsafe");
  const contents = await readFile(file);
  const after = await lstat(file, { bigint: true });
  const fields = (value) => [value.dev, value.ino, value.size, value.mtimeNs, value.mode].map(String);
  if (canonical(fields(info)) !== canonical(fields(after))) fail("Registered production config changed while being read");
  return { stat: fields(after), sha256: sha256(contents) };
}

async function inspectLiveJournal(context, activeRoot, baselineInventory, candidateRoot, candidateInventory) {
  const target = await readProductionDatabaseTarget(context, activeRoot);
  const require = createRequire(path.join(activeRoot, "node_modules", "@paperclipai", "db", "package.json"));
  const postgres = require("postgres");
  const sql = postgres(target.connectionString, {
    max: 1,
    connect_timeout: 8,
    onnotice: () => {},
    connection: { application_name: "paperclip-canary-migration-precondition", default_transaction_read_only: "on" },
  });
  try {
    const result = await sql.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      const readOnly = await tx`SHOW transaction_read_only`;
      if (readOnly[0]?.transaction_read_only !== "on") fail("Production SQL transaction is not read-only");
      const dataDir = await tx`SELECT current_database() AS db, current_setting('data_directory') AS data_dir`;
      if (target.mode === "embedded-postgres" && path.resolve(dataDir[0]?.data_dir ?? "") !== target.expectedDataDir) {
        fail("Embedded database data directory changed during probe");
      }
      const tables = await tx`
        SELECT n.nspname AS schema_name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = '__drizzle_migrations' AND c.relkind = 'r'
      `;
      const preference = ["drizzle", "public"];
      const schemas = tables.map((row) => row.schema_name);
      const selected = preference.find((name) => schemas.includes(name)) ?? schemas[0];
      if (!selected || schemas.filter((name) => name === selected).length !== 1) fail("Production migration journal is missing or ambiguous");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(selected)) fail("Production migration journal schema is invalid");
      const columns = await tx`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${selected} AND table_name = '__drizzle_migrations'
      `;
      const columnSet = new Set(columns.map((row) => row.column_name));
      if (!["name", "hash", "id"].some((name) => columnSet.has(name))) fail("Production migration journal is unrecognized");
      const orderBy = columnSet.has("id") ? '"id"'
        : columnSet.has("created_at") ? '"created_at"'
          : columnSet.has("name") ? '"name"' : '"hash"';
      const journalRows = await tx.unsafe(`SELECT * FROM "${selected}"."__drizzle_migrations" ORDER BY ${orderBy}`);
      const journalPath = path.join(activeRoot, "node_modules", "@paperclipai", "db", "dist", "migrations", "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      const sqlNames = migrationSqlNames(baselineInventory);
      const namesByFile = new Map(sqlNames.map((name) => [path.posix.basename(name), name]));
      let applied;
      if (columnSet.has("name")) applied = journalRows.map((row) => namesByFile.get(row.name) ?? null);
      else if (columnSet.has("hash")) {
        const hashToName = new Map();
        for (const name of sqlNames) hashToName.set(sha256(await readFile(path.join(activeRoot, ...name.split("/")))), name);
        applied = journalRows.map((row) => hashToName.get(row.hash) ?? null);
      } else {
        const entries = Array.isArray(journal.entries) ? journal.entries : [];
        applied = journalRows.map((row) => {
          const entry = entries.find((item, index) => Number(item.idx ?? index) + 1 === Number(row.id));
          return typeof entry?.tag === "string" ? namesByFile.get(`${entry.tag}.sql`) ?? null : null;
        });
      }
      validateAppliedJournal(applied, baselineInventory);
      const migrationPreconditions = await inspectMigrationPreconditions(tx, activeRoot, candidateRoot,
        baselineInventory, candidateInventory);
      await assertProcessIdentityUnchanged(target.server);
      return {
        transactionReadOnly: true,
        activeMigrationCount: sqlNames.length,
        activeMigrationSetSha256: sha256(Buffer.from(canonical(sqlNames), "utf8")),
        journalEntryCount: applied.length,
        mode: target.mode,
        productionPort: target.productionPort ?? null,
        migrationPreconditions,
      };
    });
    return result;
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : undefined;
    fail(code ? `Read-only production precondition query failed (${code})` : "Read-only production precondition query failed");
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

async function inspectMigrationPreconditions(tx, activeRoot, candidateRoot, activeInventory, candidateInventory) {
  const pending = pendingMigrationPreconditions(activeInventory, candidateInventory);
  const results = [];
  for (const migration of pending) {
    const migrationPath = Object.keys(candidateInventory).find((name) => name.endsWith(migration.suffix));
    const migrationBytes = await readFile(path.join(candidateRoot, ...migrationPath.split("/")));
    if (sha256(migrationBytes) !== candidateInventory[migrationPath]) fail("Candidate migration changed during precondition inspection");
    const sql = migrationBytes.toString("utf8");
    assertMigrationSqlContract(migration.id, sql);
    if (migration.id === "0369_task_retry_idempotency") {
      const duplicateCount = await tx.unsafe(`
        SELECT COUNT(*)::text AS violations
        FROM (
          SELECT company_id, idempotency_key
          FROM public.agent_wakeup_requests
          WHERE company_id IS NOT NULL AND idempotency_key IS NOT NULL
            AND idempotency_key LIKE 'task-retry:%'
          GROUP BY company_id, idempotency_key
          HAVING COUNT(*) > 1
        ) AS duplicate_keys
      `);
      results.push({ id: migration.id, violations: duplicateCount[0]?.violations });
      continue;
    }

    if (migration.id === "0370_project_secret_constraints") {
      const columns = await tx`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('projects', 'company_secrets')
      `;
      const byTable = new Map();
      for (const row of columns) {
        if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set());
        byTable.get(row.table_name).add(row.column_name);
      }
      const projectColumns = byTable.get("projects") ?? new Set();
      const secretColumns = byTable.get("company_secrets") ?? new Set();
      if (!["company_id", "id"].every((name) => projectColumns.has(name))
        || !["company_id", "scope", "owner_user_id", "user_secret_definition_id", "owner_agent_id", "owner_plugin_id", "key", "deleted_at"]
          .every((name) => secretColumns.has(name))) {
        fail("Live schema lacks columns required by the reviewed 0370 preconditions");
      }
      if (secretColumns.has("owner_project_id")) {
        fail("Live schema contains owner_project_id before its migration journal entry");
      }
      const projectDuplicates = await tx.unsafe(`
        SELECT COUNT(*)::text AS violations
        FROM (
          SELECT company_id, id FROM public.projects
          WHERE company_id IS NOT NULL AND id IS NOT NULL
          GROUP BY company_id, id HAVING COUNT(*) > 1
        ) AS duplicate_projects
      `);
      const invalidSecretShape = await tx.unsafe(`
        SELECT COUNT(*)::text AS violations
        FROM public.company_secrets
        WHERE (
          (scope = 'company' AND owner_user_id IS NULL AND user_secret_definition_id IS NULL
            AND owner_agent_id IS NULL AND NULL::uuid IS NULL AND owner_plugin_id IS NULL)
          OR (scope = 'user' AND owner_user_id IS NOT NULL AND user_secret_definition_id IS NOT NULL
            AND owner_agent_id IS NULL AND NULL::uuid IS NULL AND owner_plugin_id IS NULL)
          OR (scope = 'instance' AND owner_user_id IS NULL AND user_secret_definition_id IS NULL
            AND ((owner_agent_id IS NOT NULL) <> (NULL::uuid IS NOT NULL)) AND owner_plugin_id IS NOT NULL)
        ) IS NOT TRUE
      `);
      // The new project owner column is absent by design before 0370. Thus no
      // project-owned rows can yet collide in its new partial unique index.
      assertZeroViolations([
        { id: "0370_projects_company_id_unique", violations: projectDuplicates[0]?.violations },
        { id: "0370_company_secret_scope_shape", violations: invalidSecretShape[0]?.violations },
        { id: "0370_project_instance_secret_key_unique", violations: "0" },
      ]);
      results.push({
        id: migration.id,
        violations: "0",
        checks: ["0370_projects_company_id_unique", "0370_company_secret_scope_shape", "0370_project_instance_secret_key_unique"],
      });
    }
  }
  assertZeroViolations(results.map((result) => ({ id: result.id, violations: result.violations })));
  return results;
}

async function verifyLiveApi(context, activeRoot) {
  const buildInfoPath = path.join(activeRoot, "node_modules", "@paperclipai", "server", "dist", "build-info.json");
  const buildInfo = JSON.parse(await readFile(buildInfoPath, "utf8"));
  if (typeof buildInfo?.commit !== "string" || !/^[a-f0-9]{40}$/.test(buildInfo.commit)) {
    fail("Active runtime has no exact API identity");
  }
  const base = assertLoopbackApiBase(context.apiBase).toString().replace(/\/$/, "");
  let response;
  try {
    response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5_000) });
  } catch {
    fail("Registered Paperclip loopback API health check failed");
  }
  const body = await response.json().catch(() => null);
  if (response.status !== 200 || body?.status !== "ok" || body.commit !== buildInfo.commit) {
    fail("Registered Paperclip loopback API does not match the active runtime");
  }
  return { passed: true, status: response.status, runtimeCommit: body.commit };
}

async function verifyActiveFingerprint(context, activeRoot) {
  const cliRoot = path.join(context.paperclipHome, ".paperclip", "cli");
  const current = path.join(cliRoot, "current");
  const currentInfo = await lstat(current).catch(() => null);
  if (!currentInfo?.isSymbolicLink()) fail("Active Paperclip current pointer is not a symlink");
  if (await realpath(current) !== activeRoot) fail("Active payload path differs from the running current pointer");
  let actual;
  if (context.activeProtectedRoots.length > 0) {
    actual = await protectedInventory(activeRoot, context.activeProtectedRoots);
  } else {
    actual = {};
    for (const [name, expected] of Object.entries(context.activeProtectedFiles)) {
      const normalized = name.split("\\").join("/");
      if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
        fail("Registered active protected-file inventory contains an unsafe path");
      }
      const file = path.join(activeRoot, ...normalized.split("/"));
      const info = await lstat(file).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) fail("Active protected file is missing or unsafe");
      actual[normalized] = sha256(await readFile(file));
      if (actual[normalized] !== expected) fail("Active protected runtime file differs from the registered inventory");
    }
  }
  if (canonical(actual) !== canonical(context.activeProtectedFiles)) fail("Active protected runtime files differ from the registered inventory");
  if (inventoryIdentity(actual) !== context.activeFingerprintSha256) fail("Active fingerprint hash changed");
  return true;
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return server.close(() => reject(new Error("Could not reserve loopback port")));
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

export function buildFixtureConfig(tempRoot, port, connectionString) {
  return {
    $meta: { version: 1, updatedAt: new Date().toISOString(), source: "configure" },
    database: { mode: "postgres", connectionString, backup: { enabled: false, dir: path.join(tempRoot, "disabled-backups") } },
    logging: { mode: "cloud" },
    server: { deploymentMode: "local_trusted", exposure: "private", host: "127.0.0.1", port, serveUi: false },
    telemetry: { enabled: false },
    updates: { checkEnabled: false },
    storage: { provider: "local_disk", localDisk: { baseDir: path.join(tempRoot, "storage") } },
  };
}

export function createFixtureEnvironment(runtimeHome, configPath, port, dbUrl, secret, inheritedPath = "/usr/bin:/bin") {
  const managedConfig = JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "migration-precondition-probe", features: {}, plugins: { autoInstall: [] }, environments: [] });
  return {
    PATH: inheritedPath,
    HOME: runtimeHome,
    USERPROFILE: runtimeHome,
    PAPERCLIP_HOME: runtimeHome,
    PAPERCLIP_INSTANCE_ID: "default",
    PAPERCLIP_CONFIG: configPath,
    PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
    PAPERCLIP_MANAGED_CONFIG: managedConfig,
    PAPERCLIP_DECISION_SIGNING_SECRET: secret,
    PAPERCLIP_AGENT_JWT_SECRET: secret,
    PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: secret,
    BETTER_AUTH_SECRET: secret,
    DATABASE_URL: dbUrl,
    PAPERCLIP_DB_BACKUP_ENABLED: "false",
    PAPERCLIP_DB_BACKUP_DIR: path.join(runtimeHome, "disabled-backups"),
    HEARTBEAT_SCHEDULER_ENABLED: "false",
    PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false",
    PAPERCLIP_DISABLE_CWD_ENV_FILE: "true",
    SERVE_UI: "false",
    HOST: "127.0.0.1",
    PORT: String(port),
    PAPERCLIP_LOG_LEVEL: "info",
  };
}

function capture(child) {
  let output = "";
  const append = (chunk) => {
    output = (output + chunk.toString("utf8")).slice(-MAX_CAPTURE_BYTES);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return () => output;
}

function redactedTail(output, secret) {
  let safe = String(output ?? "");
  if (secret) safe = safe.split(secret).join("[redacted database URL]");
  safe = safe.replace(/(postgres(?:ql)?:\/\/[^\s"']+)/gi, "[redacted database URL]");
  return safe.slice(-1800);
}

async function waitForHealth(child, getOutput, connectionString, expectedCommit) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastStatus = "not-ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`API child exited before readiness: ${redactedTail(getOutput(), connectionString)}`);
    const listener = getOutput().match(/Server listener bound on 127\.0\.0\.1:(\d+); startup recovery in progress/);
    if (!listener) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      continue;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${listener[1]}/api/health`, { signal: AbortSignal.timeout(1500) });
      const body = await response.json().catch(() => null);
      if (response.status === 200 && body?.status === "ok" && body.commit === expectedCommit) {
        return { status: response.status, health: body.status, commit: body.commit };
      }
      lastStatus = response.status === 200 && body?.commit !== expectedCommit
        ? "runtime commit did not match the exact package"
        : `HTTP ${response.status}`;
    } catch {
      lastStatus = "connection-pending";
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  fail(`API child did not become healthy (${lastStatus}): ${redactedTail(getOutput(), connectionString)}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return child.exitCode;
  child.kill("SIGTERM");
  return await new Promise((resolveExit) => {
    let done = false;
    const finish = (code) => { if (!done) { done = true; clearTimeout(timer); resolveExit(code); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, CHILD_STOP_TIMEOUT_MS);
    child.once("exit", (code) => finish(code));
  });
}

export async function bootRuntime(runtimeName, payloadRoot, dbUrl, tempRoot) {
  const serverEntry = path.join(payloadRoot, "node_modules", "@paperclipai", "server", "dist", "index.js");
  const entryInfo = await lstat(serverEntry).catch(() => null);
  if (!entryInfo?.isFile() || entryInfo.isSymbolicLink()) fail(`${runtimeName} server entrypoint is missing or unsafe`);
  const runtimeHome = path.join(tempRoot, runtimeName);
  const instanceRoot = path.join(runtimeHome, ".paperclip", "instances", "default");
  const port = await freePort();
  const configPath = path.join(instanceRoot, "config.json");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(instanceRoot, { recursive: true, mode: 0o700 }));
  await writeFile(configPath, `${JSON.stringify(buildFixtureConfig(runtimeHome, port, dbUrl))}\n`, { mode: 0o600 });
  const secret = randomBytes(48).toString("base64url");
  const env = createFixtureEnvironment(runtimeHome, configPath, port, dbUrl, secret, process.env.PATH);
  const buildInfoPath = path.join(payloadRoot, "node_modules", "@paperclipai", "server", "dist", "build-info.json");
  const buildInfo = JSON.parse(await readFile(buildInfoPath, "utf8"));
  const expectedCommit = buildInfo?.commit;
  if (typeof expectedCommit !== "string" || !/^[a-f0-9]{40}$/.test(expectedCommit)) fail(`${runtimeName} runtime has no exact build identity`);
  const child = spawn(process.execPath, [serverEntry], { cwd: runtimeHome, env, stdio: ["ignore", "pipe", "pipe"] });
  const getOutput = capture(child);
  let startupError;
  try {
    const health = await waitForHealth(child, getOutput, dbUrl, expectedCommit);
    return { passed: true, runtime: runtimeName, healthStatus: health.status, runtimeCommit: health.commit, endpoint: "/api/health" };
  } catch (error) {
    startupError = error;
    throw error;
  } finally {
    const exitCode = await stopChild(child);
    if (exitCode !== 0) {
      const cleanupError = new Error(`${runtimeName} API child did not stop cleanly (${exitCode ?? "forced"})`);
      if (startupError) {
        throw new AggregateError([startupError, cleanupError],
          `${startupError instanceof Error ? startupError.message : String(startupError)}; ${cleanupError.message}`);
      }
      throw cleanupError;
    }
  }
}

async function bootProofs(context) {
  const candidateDbDir = path.join(context.candidatePayloadPath, "node_modules", "@paperclipai", "db");
  const testHelper = path.join(candidateDbDir, "dist", "test-embedded-postgres.js");
  const helperInfo = await lstat(testHelper).catch(() => null);
  if (!helperInfo?.isFile() || helperInfo.isSymbolicLink()) fail("Candidate isolated database test helper is unavailable");
  return await withoutStdoutNoise(async () => {
    const helper = await import(pathToFileURL(testHelper).href);
    if (typeof helper.startEmbeddedPostgresTestDatabase !== "function") fail("Candidate isolated database helper has an unsupported contract");
    const proofs = [];
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-canary-migration-probe-"));
    try {
      for (const runtime of ["old", "candidate"]) {
        const fixture = await helper.startEmbeddedPostgresTestDatabase(`paperclip-canary-${runtime}-boot-`);
        try {
          const evidence = await bootRuntime(runtime, runtime === "old" ? context.activePayloadPath : context.candidatePayloadPath,
            fixture.connectionString, tempRoot);
          proofs.push({ ...evidence, databaseInventorySha256: context.candidateInventorySha256 });
        } finally {
          await fixture.cleanup();
        }
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
    return proofs;
  });
}

export async function runProbe(context) {
  validateContext(context);
  const activeRoot = await assertRealDirectory(context.activePayloadPath, "Active payload");
  const candidateRoot = await assertRealDirectory(context.candidatePayloadPath, "Candidate payload");
  const home = await assertRealDirectory(context.paperclipHome, "Paperclip home");
  if (activeRoot === candidateRoot || home === activeRoot || home === candidateRoot) fail("Probe roots overlap unsafely");
  const activeInventory = await migrationInventory(activeRoot);
  const candidateInventory = await migrationInventory(candidateRoot);
  if (inventoryIdentity(activeInventory) !== context.baselineInventorySha256) fail("Active migration inventory hash changed");
  if (inventoryIdentity(candidateInventory) !== context.candidateInventorySha256) fail("Candidate migration inventory hash changed");
  await verifyActiveFingerprint(context, activeRoot);
  const api = await verifyLiveApi(context, activeRoot);
  const live = await inspectLiveJournal(context, activeRoot, activeInventory, candidateRoot, candidateInventory);
  const previousReservedPorts = process.env.PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS;
  if (live.productionPort) {
    const existing = (previousReservedPorts ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    process.env.PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS = [...new Set([...existing, String(live.productionPort)])].join(",");
  }
  let proofs;
  try {
    proofs = await bootProofs(context);
  } finally {
    if (previousReservedPorts === undefined) delete process.env.PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS;
    else process.env.PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS = previousReservedPorts;
  }
  if (proofs.length !== 2 || proofs.some((item) => !item.passed || item.databaseInventorySha256 !== context.candidateInventorySha256)) {
    fail("Both application runtimes did not boot against candidate migration inventory");
  }
  await readProductionDatabaseTarget(context, activeRoot);
  return {
    schemaVersion: 1,
    baselineInventorySha256: context.baselineInventorySha256,
    candidateInventorySha256: context.candidateInventorySha256,
    activeFingerprintSha256: context.activeFingerprintSha256,
    candidateManifestSha256: context.candidateManifestSha256,
    productionIdentitySha256: context.productionIdentitySha256,
    livePreconditions: {
      passed: true,
      readOnly: true,
      apiHealth: api.passed,
      activeApiCommit: api.runtimeCommit,
      migrationJournalMatchesActiveRuntime: true,
      activeMigrationInventorySha256: context.baselineInventorySha256,
      databaseMode: live.mode,
      activeMigrationCount: live.activeMigrationCount,
      journalEntryCount: live.journalEntryCount,
      migrationPreconditions: live.migrationPreconditions,
    },
    oldApplicationBootProof: proofs[0],
    candidateApplicationBootProof: proofs[1],
  };
}

async function main() {
  const contextPath = process.argv[2];
  if (!contextPath || !path.isAbsolute(contextPath)) fail("Expected an absolute probe context path");
  const info = await lstat(contextPath);
  if (!info.isFile() || info.isSymbolicLink()) fail("Probe context must be a regular file");
  const context = JSON.parse(await readFile(contextPath, "utf8"));
  const receipt = await runProbe(context);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

async function flushCliStreams() {
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise((resolve, reject) => {
    stream.write("", (error) => error ? reject(error) : resolve());
  })));
}

export async function runCli(operation = main) {
  let exitCode = 0;
  // Some imported database helpers keep async work on unref'd handles. Hold a
  // referenced timer for the lifetime of the awaited CLI operation so Node
  // cannot run beforeExit while that promise is still pending.
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    try {
      await operation();
    } catch (error) {
      const safe = error instanceof Error ? error.message : "Migration precondition probe failed";
      try {
        process.stderr.write(`${JSON.stringify({ ok: false, error: safe.slice(0, 600) })}\n`);
      } catch {
        // Preserve failure status even if stderr itself is unavailable.
      }
      exitCode = 1;
    }
    await flushCliStreams();
  } catch {
    exitCode = 1;
  } finally {
    clearInterval(keepAlive);
  }
  return exitCode;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const exitCode = await runCli();
  process.exit(exitCode);
}
