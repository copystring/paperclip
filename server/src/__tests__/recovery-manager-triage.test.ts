import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issueThreadInteractions, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { MANAGER_TRIAGE_ORIGIN, recoveryManagerTriageService } from "../services/recovery/manager-triage.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { recoveryService } from "../services/recovery/service.js";
import { hasExplicitUserWake, isAutomaticManagerTriageRun, managerTriageWakeAllowed } from "../services/recovery/manager-triage-budget.js";

describe("durable bounded recovery manager triage", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-manager-triage-");
    db = createDb(temporary.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({ id: "triage-owner", name: "Triage Owner", email: "triage-owner@example.test",
      emailVerified: true, createdAt: now, updatedAt: now });
  }, 120_000);
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), managerId = randomUUID(), ownerId = randomUUID();
    const issueId = randomUUID(), runId = randomUUID(), actionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Triage contract", issuePrefix: `T${companyId.slice(0, 6)}`, defaultResponsibleUserId: "triage-owner" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "triage-owner", membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: managerId, companyId, name: "Manager", role: "ceo", status: "idle", adapterType: "codex_local", runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    await db.insert(agents).values({ id: ownerId, companyId, name: "Owner", role: "engineer", reportsTo: managerId, status: "idle", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Implement export", status: "blocked", assigneeAgentId: ownerId, responsibleUserId: "triage-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: ownerId, issueId,
      invocationSource: "automation", status: "succeeded", runtimeMode: "legacy", responsibleUserId: "triage-owner", finishedAt: new Date(), contextSnapshot: { issueId } });
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId,
      kind: "deliberate_wait_without_target", cause: "deliberate_wait_without_target", ownerType: "board",
      fingerprint: `episode:${runId}`, attemptCount: 2, maxAttempts: null,
      evidence: { latestRunId: runId, terminalReason: "unchanged_source_state_exhausted", sourceAttemptCount: 2, sourceMaxAttempts: 2 },
      wakePolicy: { type: "board_escalation" }, nextAction: "Inspect the disposition." });
    const service = () => recoveryManagerTriageService(db);
    const action = () => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId)).then(r => r[0]!);
    const source = () => db.select().from(issues).where(eq(issues.id, issueId)).then(r => r[0]!);
    return { companyId, managerId, ownerId, issueId, runId, actionId, service, action, source };
  }

  it("atomically reserves exactly one separate manager task and invocation across competing workers and restart", async () => {
    const f = await fixture(); const before = await f.action();
    const states = await Promise.all([f.service().reserve(f.actionId), f.service().reserve(f.actionId)]);
    expect(states[0]).toBeTruthy(); expect(states[1]).toEqual(states[0]);
    const again = await f.service().reserve(f.actionId); expect(again).toEqual(states[0]);
    expect(await db.select().from(issues).where(and(eq(issues.companyId, f.companyId), eq(issues.originKind, MANAGER_TRIAGE_ORIGIN)))).toHaveLength(1);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(wakes).toHaveLength(1); expect(wakes[0].agentId).toBe(f.managerId);
    const after = await f.action();
    expect(after).toMatchObject({ ownerType: "board", attemptCount: before.attemptCount, maxAttempts: before.maxAttempts,
      fingerprint: before.fingerprint, evidence: { sourceAttemptCount: 2, sourceMaxAttempts: 2, managerTriage: { attemptCount: 1, maxAttempts: 1, managerId: f.managerId } } });
    expect(await f.source()).toMatchObject({ status: "blocked", assigneeAgentId: f.ownerId });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, again!.runId));
    expect(run).toMatchObject({ status: "scheduled_retry", agentId: f.managerId, issueId: again!.issueId });
    expect(await f.service().dispatchBlock(run)).toBeNull();
  });

  it.each(["paused", "terminated", "missing", "foreign"])("does not reserve for a %s manager", async kind => {
    const f = await fixture();
    if (kind === "missing") await db.update(agents).set({ reportsTo: null }).where(eq(agents.id, f.ownerId));
    else if (kind === "foreign") {
      const other = await fixture(); await db.update(agents).set({ reportsTo: other.managerId }).where(eq(agents.id, f.ownerId));
    } else await db.update(agents).set({ status: kind }).where(eq(agents.id, f.managerId));
    expect(await f.service().reserve(f.actionId)).toBeNull();
    expect((await f.action()).recoveryIssueId).toBeNull();
  });

  it.each(["unknown", "user", "approval", "human_wait", "chain", "paused_company", "unspent"])("preserves the %s boundary", async kind => {
    const f = await fixture();
    if (kind === "unknown") await db.update(heartbeatRuns).set({ status: "interrupted" }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "user") await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "human" }).where(eq(issues.id, f.issueId));
    if (kind === "approval") await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Allow publication?" } });
    if (kind === "human_wait") await db.update(issues).set({ unblockDescriptor: { owner: "board", action: "Human decision" } }).where(eq(issues.id, f.issueId));
    if (kind === "chain") await db.update(issues).set({ originKind: MANAGER_TRIAGE_ORIGIN }).where(eq(issues.id, f.issueId));
    if (kind === "paused_company") await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
    if (kind === "unspent") await db.update(issueRecoveryActions).set({ attemptCount: 1 }).where(eq(issueRecoveryActions.id, f.actionId));
    expect(await f.service().reserve(f.actionId)).toBeNull();
  });

  it("waits for actual predecessor ownership release before creating a manager turn", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, f.runId));
    expect(await f.service().reserve(f.actionId)).toBeNull();
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, f.runId));
    expect(await f.service().reserve(f.actionId)).toBeTruthy();
  });

  it("fails closed after a reserved source changes and never grants a second manager slot", async () => {
    const f = await fixture(), state = await f.service().reserve(f.actionId); expect(state).toBeTruthy();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, state!.runId));
    await db.update(issues).set({ status: "done", statusVersion: 1 }).where(eq(issues.id, f.issueId));
    expect(await f.service().dispatchBlock(run)).toBe("manager_triage_source_changed_or_held");
    const [duplicate] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.managerId,
      issueId: state!.issueId, invocationSource: "automation", status: "queued", contextSnapshot: { issueId: state!.issueId } }).returning();
    expect(await f.service().dispatchBlock(duplicate)).toBe("manager_triage_slot_not_reserved");
  });

  it.each(["hold", "owner_paused", "manager_budget"])("does not reserve across %s", async gate => {
    const f = await fixture();
    if (gate === "hold") await issueTreeControlService(db).createHold(f.companyId, f.issueId,
      { mode: "pause", actor: { actorType: "user", actorId: "triage-owner", userId: "triage-owner" } });
    if (gate === "owner_paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.ownerId));
    if (gate === "manager_budget") await db.update(agents).set({ status: "paused", pauseReason: "budget" }).where(eq(agents.id, f.managerId));
    expect(await f.service().reserve(f.actionId)).toBeNull();
    expect((await f.action()).attemptCount).toBe(2);
  });

  it.each(["hold", "stop", "approval", "manager_budget"])("revalidates %s introduced after reservation", async gate => {
    const f = await fixture(), state = await f.service().reserve(f.actionId); expect(state).toBeTruthy();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, state!.runId));
    if (gate === "hold") await issueTreeControlService(db).createHold(f.companyId, f.issueId,
      { mode: "pause", actor: { actorType: "user", actorId: "triage-owner", userId: "triage-owner" } });
    if (gate === "stop") await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "operator_cancelled" }).where(eq(heartbeatRuns.id, f.runId));
    if (gate === "approval") await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Allow next action?" } });
    if (gate === "manager_budget") await db.update(agents).set({ status: "paused", pauseReason: "budget" }).where(eq(agents.id, f.managerId));
    expect(await f.service().dispatchBlock(run)).not.toBeNull();
    expect((await f.action()).attemptCount).toBe(2);
  });

  it("starts the manager through the real scheduled dispatch and local process adapter after predecessor end", async () => {
    const f = await fixture(), marker = `manager-executed-${randomUUID()}`;
    await db.update(agents).set({ adapterType: "process", adapterConfig: { command: process.execPath,
      args: ["-e", `console.log(JSON.stringify({marker:${JSON.stringify(marker)},run:process.env.PAPERCLIP_RUN_ID}))`],
      cwd: process.cwd(), timeoutSec: 20 } }).where(eq(agents.id, f.managerId));
    const state = await f.service().reserve(f.actionId); expect(state).toBeTruthy();
    const heartbeat = heartbeatService(db);
    await heartbeat.promoteDueScheduledRetries();
    await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.managerId);
    await vi.waitFor(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, state!.runId));
      expect(run.status, run.error ?? undefined).toBe("succeeded");
      expect(run.stdoutExcerpt).toContain(marker);
      expect(run.stdoutExcerpt).toContain(state!.runId);
      const [manager] = await db.select().from(agents).where(eq(agents.id, f.managerId));
      expect(manager.status).toBe("idle");
    }, { timeout: 25_000, interval: 100 });
    await heartbeat.drainActiveRunExecutions();
    expect((await f.action()).attemptCount).toBe(2);
  }, 35_000);

  it("does not replenish a failed manager invocation through repeated sweeps or provider retry", async () => {
    const f = await fixture(), state = await f.service().reserve(f.actionId); expect(state).toBeTruthy();
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "adapter_failed" }).where(eq(heartbeatRuns.id, state!.runId));
    await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date() }).where(eq(agentWakeupRequests.runId, state!.runId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, state!.issueId));
    const enqueue = vi.fn(async () => null);
    for (let i = 0; i < 3; i++) await recoveryService(db, { enqueueWakeup: enqueue }).reconcileStrandedAssignedIssues();
    expect((await heartbeatService(db).scheduleBoundedRetry(state!.runId))?.outcome).toBe("not_scheduled");
    expect(enqueue).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.managerId)))).toHaveLength(1);
    expect((await f.action()).attemptCount).toBe(2);
  });

  it("rejects automatic queue producers even when they omit the manager marker", async () => {
    const f = await fixture(), state = await f.service().reserve(f.actionId);
    const heartbeat = heartbeatService(db);
    expect(await heartbeat.wakeup(f.managerId, { source: "automation", triggerDetail: "system",
      reason: "issue_missing_comment_retry", requestedByActorType: "system",
      contextSnapshot: { issueId: state!.issueId }, payload: { issueId: state!.issueId } })).toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.managerId)))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(1);
  });

  it("accepts a durable new human intent and its same-task retry, but rejects forged cross-task provenance", async () => {
    const f = await fixture(), state = await f.service().reserve(f.actionId);
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.managerId,
      source: "on_demand", status: "consumed", requestedByActorType: "user", requestedByActorId: "triage-owner",
      payload: { issueId: state!.issueId } }).returning();
    const [humanRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.managerId,
      issueId: state!.issueId, invocationSource: "on_demand", status: "failed", wakeupRequestId: wake.id,
      contextSnapshot: { issueId: state!.issueId } }).returning();
    await db.update(agentWakeupRequests).set({ runId: humanRun.id }).where(eq(agentWakeupRequests.id, wake.id));
    const [retry] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.managerId,
      issueId: state!.issueId, invocationSource: "automation", status: "queued", retryOfRunId: humanRun.id,
      contextSnapshot: { issueId: state!.issueId } }).returning();
    expect(await hasExplicitUserWake(db, retry)).toBe(true);
    expect(await isAutomaticManagerTriageRun(db, retry)).toBe(false);
    expect(await f.service().dispatchBlock(retry)).toBeNull();
    const input = { companyId: f.companyId, issueId: state!.issueId, agentId: f.managerId,
      context: { retryOfRunId: humanRun.id } };
    expect(await managerTriageWakeAllowed(db, input)).toBe(true);
    expect(await managerTriageWakeAllowed(db, { ...input, issueId: f.issueId })).toBe(false);
    const [forged] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.managerId,
      issueId: f.issueId, invocationSource: "automation", status: "queued", retryOfRunId: humanRun.id,
      contextSnapshot: { issueId: f.issueId } }).returning();
    expect(await hasExplicitUserWake(db, forged)).toBe(false);
  });

  it("settles an exhausted manager once with a concrete visible decision and unchanged source allowance", async () => {
    const f = await fixture(), state = await f.service().reserve(f.actionId);
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "adapter_failed" }).where(eq(heartbeatRuns.id, state!.runId));
    await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date() }).where(eq(agentWakeupRequests.runId, state!.runId));
    expect(await f.service().settle(f.actionId)).toBe(true);
    expect(await f.service().settle(f.actionId)).toBe(false);
    const [child] = await db.select().from(issues).where(eq(issues.id, state!.issueId));
    expect(child.status).toBe("blocked");
    expect(child.unblockDescriptor).toMatchObject({ owner: "board" });
    expect(child.unblockDescriptor?.action).toContain(state!.runId);
    expect(child.unblockDescriptor?.action).toContain("cancelled?");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, state!.issueId))).toHaveLength(1);
    expect(await f.action()).toMatchObject({ attemptCount: 2, evidence: { sourceAttemptCount: 2,
      sourceMaxAttempts: 2, managerTriage: { phase: "exhausted", attemptCount: 1, maxAttempts: 1 } } });
    expect(await f.source()).toMatchObject({ status: "blocked", assigneeAgentId: f.ownerId });
  });

  it("keeps a real human wait after the manager run intact", async () => {
    const f = await fixture(), state = await f.service().reserve(f.actionId);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, state!.runId));
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: state!.issueId,
      kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Authorize the concrete patch?" } });
    expect(await f.service().settle(f.actionId)).toBe(false);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, state!.issueId))).toHaveLength(0);
  });

  it("fences a source change between preliminary checks and the final adapter handoff", async () => {
    const f = await fixture(), marker = `must-not-execute-${randomUUID()}`;
    await db.update(agents).set({ adapterType: "process", adapterConfig: { command: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(marker)})`], cwd: process.cwd(), timeoutSec: 20 } }).where(eq(agents.id, f.managerId));
    const state = await f.service().reserve(f.actionId); expect(state).toBeTruthy();
    let raced = false;
    const heartbeat = heartbeatService(db, { afterResolvedInteractionContinuationDispatchCheck: async ({ runId }) => {
      if (runId !== state!.runId || raced) return;
      raced = true;
      await db.update(issues).set({ status: "done", statusVersion: 1 }).where(eq(issues.id, f.issueId));
    } });
    await heartbeat.promoteDueScheduledRetries();
    await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.managerId);
    await heartbeat.drainActiveRunExecutions();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, state!.runId));
    expect(raced).toBe(true);
    expect(run.status).not.toBe("succeeded");
    expect(run.stdoutExcerpt ?? "").not.toContain(marker);
    const attempts = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
      retryOfRunId: heartbeatRuns.retryOfRunId, contextSnapshot: heartbeatRuns.contextSnapshot,
      scheduledRetryReason: heartbeatRuns.scheduledRetryReason }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.issueId, state!.issueId)));
    const [actualChild] = await db.select({ originKind: issues.originKind }).from(issues).where(eq(issues.id, state!.issueId));
    expect(actualChild.originKind).toBe(MANAGER_TRIAGE_ORIGIN);
    expect(attempts, JSON.stringify(attempts.map(a => ({ ...a, contextSnapshot: {
      source: a.contextSnapshot?.source, wakeReason: a.contextSnapshot?.wakeReason,
      managerTriageActionId: a.contextSnapshot?.managerTriageActionId } })))).toHaveLength(1);
    expect((await f.action()).attemptCount).toBe(2);
  }, 35_000);

  it("rolls back the task, wake and budget link if durable run insertion fails", async () => {
    const f = await fixture(), constraint = `triage_fault_${f.companyId.replaceAll("-", "")}`;
    await db.execute(sql`alter table heartbeat_runs add constraint ${sql.identifier(constraint)}
      check (company_id <> ${sql.raw(`'${f.companyId}'::uuid`)} or scheduled_retry_reason is distinct from 'recovery_manager_triage')`);
    try { await expect(f.service().reserve(f.actionId)).rejects.toThrow(); }
    finally { await db.execute(sql`alter table heartbeat_runs drop constraint ${sql.identifier(constraint)}`); }
    expect((await f.action()).recoveryIssueId).toBeNull();
    expect((await f.action()).attemptCount).toBe(2);
    expect(await db.select().from(issues).where(and(eq(issues.companyId, f.companyId), eq(issues.originKind, MANAGER_TRIAGE_ORIGIN)))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect(await f.service().reserve(f.actionId)).toBeTruthy();
  });
});
