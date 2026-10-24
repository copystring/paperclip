import { agentApiKeys, agents, companies, createDb, environments, environmentCustomImageSetupSessions, heartbeatRuns, issues, toolInvocations, workspaceOperations, type Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { beginIdleTrackedWork, idleWorkSnapshot } from "../services/task-admission.js";
import { readRestartReadiness, type RestartDrainStatus } from "../services/restart-readiness.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const ownerId = "owner-fixture";
const startedAt = new Date("2026-01-01T00:00:00.000Z");
const expiresAt = new Date("2026-01-01T00:01:00.000Z");
const now = () => Date.parse("2026-01-01T00:00:30.000Z");
const held = (): RestartDrainStatus => ({ ownerId, draining: true, startedAt, expiresAt, activeRuns: 0, pendingWakes: 0 });
const plugins = vi.fn(async () => ({ backgroundWork: "none" as const, pluginIds: [] }));
const local = vi.fn(async (_options: { purpose?: "restart" }) => "none" as const);

function database(result: unknown = [{ activeRuns: 0, activeInvocations: 0, activeOperations: 0, unconfirmedPlugins: false }]) {
  const execute = vi.fn(async () => result);
  const transaction = vi.fn(async (run: (tx: { execute: typeof execute }) => Promise<unknown>) => run({ execute }));
  return { db: { transaction } as unknown as Db, transaction, execute };
}

afterEach(() => {
  plugins.mockClear();
  local.mockClear();
});

describe("restart readiness", () => {
  it("allows future issues, API keys, and periodic heartbeats when no execution is active", async () => {
    const { db, execute } = database();
    const result = await readRestartReadiness(db, held, ownerId, plugins, now, local);
    expect(result).toMatchObject({ version: 1, status: "ready", ownerId, startedAt: startedAt.toISOString(), expiresAt: expiresAt.toISOString(), serverPid: process.pid, blockers: [] });
    expect(result.generation).toBe(idleWorkSnapshot().generation);
    const sqlText = String(execute.mock.calls.at(-1)?.[0]);
    expect(sqlText).not.toMatch(/\bissues\b|agent_api_keys|board_api_keys|intervalSec|scheduled_retry_at/);
  });

  it.each([
    ["missing drain", () => ({ ...held(), draining: false }), "drain_missing"],
    ["foreign owner", () => ({ ...held(), ownerId: "other-owner" }), "owner_mismatch"],
    ["expired owner", () => ({ ...held(), expiresAt: new Date(now() - 1) }), "drain_expired"],
    ["active process run", () => ({ ...held(), activeRuns: 2 }), "process_runs_active"],
    ["pending process wake", () => ({ ...held(), pendingWakes: 1 }), "process_wakes_pending"],
  ] as const)("blocks %s", async (_label, getStatus, code) => {
    const { db, transaction } = database();
    const result = await readRestartReadiness(db, getStatus, ownerId, plugins, now, local);
    expect(result.status).toBe("blocked");
    expect(result.blockers).toContainEqual(expect.objectContaining({ code }));
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(["startedAt", "expiresAt"] as const)("returns unknown for an invalid %s instead of throwing", async field => {
    const invalid = new Date(Number.NaN);
    const result = await readRestartReadiness(database().db,
      () => ({ ...held(), [field]: invalid }), ownerId, plugins, now, local);
    expect(result.status).toBe("unknown");
    expect(result.blockers).toContainEqual({ code: "evidence_unavailable" });
    expect(result[field]).toBeNull();
  });

  it("fails closed when plugin workers are missing, busy, or unknown", async () => {
    const { db, transaction } = database();
    expect((await readRestartReadiness(db, held, ownerId, undefined, now, local)).status).toBe("unknown");
    expect(transaction).not.toHaveBeenCalled();
    for (const backgroundWork of ["present", "unknown"] as const) {
      const inspect = vi.fn(async () => ({ backgroundWork, pluginIds: [] }));
      const result = await readRestartReadiness(db, held, ownerId, inspect, now, local);
      expect(result.status).toBe(backgroundWork === "present" ? "blocked" : "unknown");
      expect(transaction).not.toHaveBeenCalled();
    }
    const malformed = vi.fn(async () => ({ backgroundWork: "invalid" as never, pluginIds: [] }));
    expect((await readRestartReadiness(db, held, ownerId, malformed, now, local)).status).toBe("unknown");
    const malformedIds = vi.fn(async () => ({ backgroundWork: "none" as const, pluginIds: ["not-a-plugin-id"] }));
    expect((await readRestartReadiness(db, held, ownerId, malformedIds, now, local)).status).toBe("unknown");
    const malformedLocal = vi.fn(async () => "invalid" as never);
    expect((await readRestartReadiness(db, held, ownerId, plugins, now, malformedLocal)).status).toBe("unknown");
  });

  it("blocks database execution effects but ignores non-running backlog", async () => {
    const { db } = database([{ activeRuns: 1, activeInvocations: 2, activeOperations: 0, unconfirmedPlugins: false }]);
    const result = await readRestartReadiness(db, held, ownerId, plugins, now, local);
    expect(result.status).toBe("blocked");
    expect(result.blockers).toContainEqual({ code: "database_effects_active", count: 3 });
  });

  it("keeps unconfirmed enabled database plugins closed", async () => {
    const { db } = database([{ activeRuns: 0, activeInvocations: 0, activeOperations: 0, unconfirmedPlugins: true }]);
    const result = await readRestartReadiness(db, held, ownerId, plugins, now, local);
    expect(result.status).toBe("blocked");
    expect(result.blockers).toContainEqual({ code: "plugins_busy" });
  });

  it("reports unknown on database errors or malformed evidence", async () => {
    const unavailable = { transaction: vi.fn().mockRejectedValue(new Error("private db detail")) } as unknown as Db;
    expect((await readRestartReadiness(unavailable, held, ownerId, plugins, now, local)).status).toBe("unknown");
    const malformed = database([{ activeRuns: "0", activeInvocations: 0, activeOperations: 0, unconfirmedPlugins: false }]);
    expect((await readRestartReadiness(malformed.db, held, ownerId, plugins, now, local)).status).toBe("unknown");
  });

  it("rejects work starting and finishing during the scan by generation", async () => {
    const { db, execute } = database();
    execute.mockImplementationOnce(async () => {
      const end = beginIdleTrackedWork();
      end();
      return [{ activeRuns: 0, activeInvocations: 0, activeOperations: 0, unconfirmedPlugins: false }];
    });
    const result = await readRestartReadiness(db, held, ownerId, plugins, now, local);
    expect(result.status).toBe("unknown");
    expect(result.blockers).toContainEqual({ code: "generation_changed" });
  });

  it("fails closed when local or plugin evidence changes during the scan", async () => {
    const status = vi.fn().mockReturnValueOnce(held()).mockReturnValue({ ...held(), ownerId: "replacement" });
    const { db } = database();
    expect((await readRestartReadiness(db, status, ownerId, plugins, now, local)).status).toBe("unknown");
    expect(plugins).not.toHaveBeenCalled();
    const pluginUnknown = vi.fn(async () => { throw new Error("private plugin error"); });
    expect((await readRestartReadiness(db, held, ownerId, pluginUnknown, now, local)).status).toBe("unknown");
  });
});

const pgSupport = await getEmbeddedPostgresTestSupport();
if (!pgSupport.supported) console.warn(`Skipping restart readiness Postgres tests: ${pgSupport.reason}`);
(pgSupport.supported ? describe : describe.skip)("restart readiness against persisted activity", () => {
  let db: ReturnType<typeof createDb>;
  let databaseHandle: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    databaseHandle = await startEmbeddedPostgresTestDatabase("restart-readiness-");
    db = createDb(databaseHandle.connectionString);
  }, 60_000);
  afterEach(async () => { await db.execute(sql`TRUNCATE companies, plugins, environments CASCADE`); });
  afterAll(async () => { await databaseHandle?.cleanup(); });

  async function seed() {
    const companyId = "ba5721cd-667c-4a2e-a238-01aafe12b1bb";
    const agentId = "3aac840c-497c-46d7-8d6e-f0759a6858d4";
    const runId = "0174f454-7123-4553-a600-d4be71ccf5b0";
    await db.insert(companies).values({ id: companyId, name: "Restart readiness", issuePrefix: "RR" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Periodic agent", role: "engineer", status: "idle",
      adapterType: "process", runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } } });
    await db.insert(issues).values({ companyId, title: "Future issue", status: "todo" });
    await db.insert(agentApiKeys).values({ companyId, agentId, name: "Ingress key", keyHash: "test-hash" });
    return { companyId, agentId, runId };
  }
  const readDb = (status: RestartDrainStatus = held()) => readRestartReadiness(db, () => status, ownerId,
    async () => ({ backgroundWork: "none", pluginIds: [] }), now, local);

  it("is ready with open issues, API keys, and periodic heartbeat configuration but no active effects", async () => {
    await seed();
    expect((await readDb()).status).toBe("ready");
  });

  it("blocks a persisted running heartbeat run", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ id: f.runId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "on_demand", status: "running" });
    expect(await readDb()).toMatchObject({ status: "blocked", blockers: [{ code: "database_effects_active", count: 1 }] });
  });

  it("ignores an old executing invocation row when its owner run is terminal and no local handler is active", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ id: f.runId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "on_demand", status: "cancelled", startedAt: new Date("2026-01-01T00:00:00.000Z"),
      finishedAt: new Date("2026-01-01T00:00:01.000Z") });
    const [invocation] = await db.insert(toolInvocations).values({ companyId: f.companyId,
      runId: f.runId, agentId: f.agentId, toolName: "mcp.fixture:write", riskLevel: "destructive",
      policyDecision: "allow", status: "executing", startedAt: new Date("2026-01-01T00:00:00.500Z") }).returning();

    expect(await readDb()).toMatchObject({ status: "ready", blockers: [] });
    await expect(db.select({ status: toolInvocations.status, completedAt: toolInvocations.completedAt })
      .from(toolInvocations).where(sql`${toolInvocations.id} = ${invocation.id}`))
      .resolves.toEqual([{ status: "executing", completedAt: null }]);
  });

  it("blocks active workspace and image operations without treating retained history as active", async () => {
    const f = await seed();
    await db.insert(workspaceOperations).values({ companyId: f.companyId, phase: "workspace_copyback", status: "running" });
    expect(await readDb()).toMatchObject({ status: "blocked", blockers: [{ code: "database_effects_active", count: 1 }] });
    await db.execute(sql`TRUNCATE workspace_operations CASCADE`);
    await db.insert(workspaceOperations).values({ companyId: f.companyId, phase: "workspace_copyback", status: "succeeded" });
    expect((await readDb()).status).toBe("ready");
    const [environment] = await db.insert(environments).values({ name: "Image worker fixture", driver: "sandbox" }).returning();
    await db.insert(environmentCustomImageSetupSessions).values({ environmentId: environment.id, provider: "fixture", status: "capturing" });
    expect(await readDb()).toMatchObject({ status: "blocked", blockers: [{ code: "database_effects_active", count: 1 }] });
  });
});
