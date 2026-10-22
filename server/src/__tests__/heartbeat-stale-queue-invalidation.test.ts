import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  companies,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  issueRecoveryActions,
  issueRelations,
  issueTreeHolds,
  nativeRunFinalizations,
  decisionInvocations,
  toolInvocations,
  workspaceOperations,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { truncateTablesWithDeadlockRetry } from "./helpers/truncate-with-deadlock-retry.js";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { recoveryService } from "../services/recovery/service.ts";
import * as nonDispatchReceipts from "../services/non-dispatch-receipt.js";
import { revalidateNonDispatchHolds } from "../services/non-dispatch-revalidation.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { legacyExecutionNeedsReconciliationWithEvidence } from "../services/legacy-execution-recovery.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { withQueuedCommentIdsInWakePayload } from "../services/issue-queued-comment-queue.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stale-queue invalidation test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat stale-queue invalidation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function cleanupHeartbeatInvalidationFixture(db: ReturnType<typeof createDb>) {
  await truncateTablesWithDeadlockRetry(
    db,
    `
      TRUNCATE TABLE
        "company_skills",
        "issue_comments",
        "issue_documents",
        "document_revisions",
        "documents",
        "issue_relations",
        "issue_tree_holds",
        "issues",
        "heartbeat_run_events",
        "cost_events",
        "activity_log",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `,
    { attempts: 10, delayMs: () => 100 },
  );
}

type SeedOptions = {
  agentName?: string;
  agentRole?: string;
  maxConcurrentRuns?: number;
  heartbeatConfig?: Record<string, unknown>;
};

type SeedResult = {
  companyId: string;
  agentId: string;
};

describeEmbeddedPostgres("heartbeat stale queued-run invalidation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let beforeContinuationDispatchCheck:
    | ((input: { runId: string; issueId: string }) => Promise<void>)
    | null = null;
  let afterContinuationDispatchCheck:
    | ((input: { runId: string; issueId: string }) => Promise<void>)
    | null = null;

  const countExecuteCallsForRun = (runId: string) =>
    mockAdapterExecute.mock.calls.filter(([context]) => context?.runId === runId).length;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-stale-queue-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
      beforeResolvedInteractionContinuationDispatchCheck: async (input) => {
        await beforeContinuationDispatchCheck?.(input);
      },
      afterResolvedInteractionContinuationDispatchCheck: async (input) => {
        await afterContinuationDispatchCheck?.(input);
      },
    });
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    beforeContinuationDispatchCheck = null;
    afterContinuationDispatchCheck = null;
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Stale-queue invalidation test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    // A table poll for "queued" or "running" rows cannot see a wakeup promise
    // that has not yet written its run row. The shared drain helper awaits
    // both in-flight wakeup promises and in-flight run executions first, then
    // re-checks the run table, so a late writer cannot still be in flight when
    // the TRUNCATE below runs.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await cleanupHeartbeatInvalidationFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(opts: SeedOptions = {}): Promise<SeedResult> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: opts.agentName ?? "ClaudeCoder",
      role: opts.agentRole ?? "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: opts.maxConcurrentRuns ?? 1,
          ...(opts.heartbeatConfig ?? {}),
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("runs an explicit owner handback only after its current recovery run ends", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ maxConcurrentRuns: 5 });
    const issueId = randomUUID(), predecessorId = randomUUID(), commentId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: predecessorId, companyId, agentId, status: "running",
      invocationSource: "automation", triggerDetail: "system", startedAt: new Date(),
      contextSnapshot: { issueId, wakeReason: "issue_disposition_repair" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Explicit work handback", status: "todo", assigneeAgentId: agentId,
      executionRunId: predecessorId, checkoutRunId: predecessorId });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorAgentId: agentId,
      createdByRunId: predecessorId, body: "Continue the next implementation step." });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "agent", requestedByActorId: agentId, allowRunCoalescing: false,
      issueStateGuard: { statuses: ["todo"], assigneeAgentId: agentId, statusVersion: issue!.statusVersion },
      payload: { issueId, commentId, mutation: "comment", resumeIntent: true, followUpRequested: true },
      contextSnapshot: { issueId, taskId: issueId, commentId, wakeCommentId: commentId,
        source: "issue.comment", wakeReason: "issue_commented", forceFreshSession: true, resumeIntent: true, followUpRequested: true } });
    const [request] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(request).toMatchObject({ status: "queued" });
    expect(request!.runId).toBeTruthy();
    expect((await heartbeat.getRun(request!.runId!))!.status).toBe("queued");
    expect(countExecuteCallsForRun(request!.runId!)).toBe(0);
    expect(countExecuteCallsForRun(predecessorId)).toBe(0);
    const [unchanged] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, predecessorId));
    expect(unchanged!.contextSnapshot).toEqual({ issueId, wakeReason: "issue_disposition_repair" });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, predecessorId));
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, issueId));
    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => Boolean((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request!.id)))[0]?.runId));
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request!.id));
    expect(delivered!.runId).toBeTruthy();
    const next = await heartbeat.getRun(delivered!.runId!);
    expect(next!.contextSnapshot).toMatchObject({ issueId, forceFreshSession: true, resumeIntent: true });
    expect(next!.retryOfRunId).toBeNull();
    await heartbeat.waitForRunExecutionDrain(next!.id);
    expect(countExecuteCallsForRun(next!.id)).toBe(1);
  });

  it.each(["preparing", "verifying", "resuming"] as const)("keeps assigned work queued through %s, including recovery with timers disabled", async lifecycleState => {
    const { companyId, agentId } = await seedCompanyAndAgent({ heartbeatConfig: { enabled: false } });
    await db.update(agents).set({ status: "paused", lifecycleState }).where(eq(agents.id, agentId));
    const [issue] = await db.insert(issues).values({ companyId, title: "Work accepted during setup", status: "todo", assigneeAgentId: agentId }).returning();
    const run = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: issue.id } });
    expect(run?.status).toBe("queued");
    await heartbeat.resumeQueuedRuns();
    expect((await heartbeat.getRun(run!.id))?.status).toBe("queued");
    expect(countExecuteCallsForRun(run!.id)).toBe(0);
    expect((await heartbeat.reconcileStrandedAssignedIssues()).escalated).toBe(0);
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]).toMatchObject({ status: "todo", assigneeAgentId: agentId });
    await db.update(agents).set({ status: "idle", lifecycleState: "ready" }).where(eq(agents.id, agentId));
    const recovered = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    await recovered.resumeQueuedRuns();
    expect(await waitForCondition(async () => countExecuteCallsForRun(run!.id) === 1)).toBe(true);
    await recovered.waitForRunExecutionDrain(run!.id);
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it.each(["initial", "scheduled"] as const)("records and verifies a complete receipt for a %s dependency-gated run", async kind => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const [blocker] = await db.insert(issues).values({ companyId, title: "Dependency", status: "in_progress", assigneeAgentId: agentId }).returning();
    const [task] = await db.insert(issues).values({ companyId, title: "Blocked dispatch", status: "in_progress", assigneeAgentId: agentId }).returning();
    await db.insert(issueRelations).values({ companyId, issueId: blocker.id, relatedIssueId: task.id, type: "blocks" });
    const { runId } = await seedQueuedRun({ companyId, agentId, issueId: task.id, wakeReason: "issue_assigned" });

    if (kind === "scheduled") {
      await db.update(heartbeatRuns).set({ status: "scheduled_retry", scheduledRetryAt: new Date(0), scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure" }).where(eq(heartbeatRuns.id, runId));
      await heartbeat.promoteDueScheduledRetries();
    } else {
      await heartbeat.resumeQueuedRuns();
    }
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.status).toBe("cancelled");
    expect(countExecuteCallsForRun(runId)).toBe(0);
    expect(run.resultJson?.nonDispatchReceipt).toMatchObject({
      version: 1, runId, companyId, issueId: task.id, agentId,
      providerWorkStarted: false, reason: "issue_dependencies_blocked",
    });
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, run)).toBe(false);

    await db.update(heartbeatRuns).set({ processPid: 12345 }).where(eq(heartbeatRuns.id, runId));
    const [contradictory] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, contradictory)).toBe(true);
  });

  it.each(["queued", "scheduled_retry"] as const)("rejects an unknown-stop receipt for %s work", async status => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const [task] = await db.insert(issues).values({ companyId, title: "Unknown stop", status: "in_progress", assigneeAgentId: agentId }).returning();
    const { runId } = await seedQueuedRun({ companyId, agentId, issueId: task.id, wakeReason: "issue_assigned" });
    if (status === "scheduled_retry") {
      await db.update(heartbeatRuns).set({ status, scheduledRetryAt: new Date(Date.now() + 60_000), scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure" }).where(eq(heartbeatRuns.id, runId));
    }
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const forgedReceipt = nonDispatchReceipts.makeNonDispatchReceipt(source, "issue_dependencies_blocked", "dependency_gate", task.statusVersion);
    const unknownStop = { source: "unknown", expected: false, reason: "Execution stopped without a recorded request", recordedAt: new Date().toISOString() };
    await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson, cancellation: unknownStop } }).where(eq(heartbeatRuns.id, runId));
    const [withUnknownStop] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));

    expect(nonDispatchReceipts.isUnclaimedRun(withUnknownStop)).toBe(false);
    expect(nonDispatchReceipts.makeNonDispatchReceipt(withUnknownStop, "issue_dependencies_blocked", "dependency_gate", task.statusVersion)).toBeNull();

    await db.update(heartbeatRuns).set({
      status: "cancelled",
      finishedAt: new Date(),
      errorCode: "issue_dependencies_blocked",
      resultJson: { ...withUnknownStop.resultJson, nonDispatchReceipt: forgedReceipt },
    }).where(eq(heartbeatRuns.id, runId));
    const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(await nonDispatchReceipts.isNonDispatchVerified(db, cancelled)).toBe(false);
  });

  it.each(["before-read", "after-read", "same-status-stop", "same-status-context"] as const)(
    "does not terminalize a dependency run when a concurrent %s changes its source projection", async interleaving => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const [blocker] = await db.insert(issues).values({ companyId, title: "Dependency", status: "in_progress", assigneeAgentId: agentId }).returning();
      const [task] = await db.insert(issues).values({ companyId, title: "Claim race", status: "in_progress", assigneeAgentId: agentId }).returning();
      await db.insert(issueRelations).values({ companyId, issueId: blocker.id, relatedIssueId: task.id, type: "blocks" });
      const { runId, wakeupRequestId } = await seedQueuedRun({ companyId, agentId, issueId: task.id, wakeReason: "issue_assigned" });
      let receiptCreated = false;
      let injected = false;
      let baseline: unknown;
      async function snapshot() {
        return {
          run: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0],
          task: (await db.select().from(issues).where(eq(issues.id, task.id)))[0],
          wake: (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId)))[0],
          events: await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)),
          actions: await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, task.id)),
        };
      }
      async function claim() {
        injected = true;
        await db.transaction(async tx => {
          await tx.select().from(issues).where(eq(issues.id, task.id)).for("update");
          await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
          const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
          await tx.update(heartbeatRuns).set(interleaving === "same-status-stop"
            ? { resultJson: { cancellation: { source: "operator", expected: true } } }
            : interleaving === "same-status-context"
              ? { contextSnapshot: { ...current.contextSnapshot, revision: 2 } }
              : { status: "running", startedAt: new Date(), processPid: 12345,
                  controllerBootId: randomUUID(), executionStage: "provider_execution",
                  resultJson: { retainedMarker: "claimed", executionRecovery: { providerWorkStarted: true } } },
          ).where(eq(heartbeatRuns.id, runId));
          await tx.update(issues).set({ executionRunId: runId, checkoutRunId: runId, executionLockedAt: new Date() }).where(eq(issues.id, task.id));
          await tx.update(agentWakeupRequests).set({ status: "claimed", claimedAt: new Date() }).where(eq(agentWakeupRequests.id, wakeupRequestId));
        });
        baseline = await snapshot();
      }
      const originalReceipt = nonDispatchReceipts.makeNonDispatchReceipt;
      const receiptSpy = vi.spyOn(nonDispatchReceipts, "makeNonDispatchReceipt").mockImplementation((...args) => {
        const receipt = originalReceipt(...args);
        if (args[0].id === runId && args[2] === "dependency_gate") receiptCreated = true;
        return receipt;
      });
      const originalSelect = db.select.bind(db);
      const selectSpy = vi.spyOn(db, "select").mockImplementation(((...args: unknown[]) => {
        const builder = originalSelect(...args as []);
        const originalFrom = builder.from.bind(builder);
        builder.from = ((table: unknown) => {
          const query = originalFrom(table as typeof heartbeatRuns);
          if (table === heartbeatRuns && args.length === 0) {
            const originalThen = query.then.bind(query);
            query.then = ((resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) => {
              if (receiptCreated && !injected && !query.toSQL().sql.includes("for update")) {
                if (interleaving === "before-read") return claim().then(() => originalThen(resolve, reject));
                return originalThen(async rows => { await claim(); return resolve(rows); }, reject);
              }
              return originalThen(resolve, reject);
            }) as typeof query.then;
          }
          return query;
        }) as typeof builder.from;
        return builder;
      }) as typeof db.select);
      try {
        await heartbeat.resumeQueuedRuns();
        expect(injected).toBe(true);
        expect(await snapshot()).toEqual(baseline);
        expect(countExecuteCallsForRun(runId)).toBe(0);
      } finally {
        selectSpy.mockRestore();
        receiptSpy.mockRestore();
        await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
      }
    },
  );

  it.each(["clean", "started", "operator", "foreign", "pause", "revision", "successor", "source-tool-failed"] as const)(
    "revalidates a retained dependency HOLD only with complete unchanged evidence (%s)", async mutation => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const [blocker] = await db.insert(issues).values({ companyId, title: "Dependency", status: "in_progress", assigneeAgentId: agentId }).returning();
      const [task] = await db.insert(issues).values({ companyId, title: "Recovery", status: "in_progress", assigneeAgentId: agentId }).returning();
      await db.insert(issueRelations).values({ companyId, issueId: blocker.id, relatedIssueId: task.id, type: "blocks" });
      const { runId } = await seedQueuedRun({ companyId, agentId, issueId: task.id, wakeReason: "issue_assigned" });
      await heartbeat.resumeQueuedRuns();
      const [original] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const oldResult = { ...original.resultJson } as Record<string, any>;
      delete oldResult.nonDispatchReceipt;
      delete oldResult.cancellation;
      await db.update(heartbeatRuns).set({ resultJson: oldResult }).where(eq(heartbeatRuns.id, runId));
      const [hold] = await db.insert(issueRecoveryActions).values({
        companyId, sourceIssueId: task.id, kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation",
        fingerprint: `legacy-execution:${runId}`, nextAction: "Synthetic retained HOLD", ownerType: "board", status: "resolved", outcome: "blocked",
        evidence: { runId, automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", actionOutcome: "unknown" } },
      }).returning();

      if (mutation === "started") await db.update(heartbeatRuns).set({ startedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      if (mutation === "operator") await db.update(heartbeatRuns).set({ resultJson: { ...oldResult, cancellation: { source: "operator", expected: true } } }).where(eq(heartbeatRuns.id, runId));
      if (mutation === "pause") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
      if (mutation === "revision") await db.update(issues).set({ statusVersion: task.statusVersion + 1 }).where(eq(issues.id, task.id));
      if (mutation === "successor") await seedQueuedRun({ companyId, agentId, issueId: task.id, wakeReason: "issue_assigned" });
      if (mutation === "source-tool-failed") {
        const [source] = await db.insert(heartbeatRuns).values({
          companyId, agentId, status: "cancelled", invocationSource: "assignment", startedAt: new Date(),
          contextSnapshot: { issueId: task.id },
          resultJson: { executionCancellation: { state: "acknowledged" }, reassignmentStopConfirmed: true },
        }).returning();
        await db.update(heartbeatRuns).set({ contextSnapshot: { ...original.contextSnapshot, interruptedRunId: source.id } }).where(eq(heartbeatRuns.id, runId));
        await db.insert(toolInvocations).values({ companyId, runId: source.id, toolName: "synthetic.failed", status: "failed" });
      }

      const response = await revalidateNonDispatchHolds(db, {
        companyId: mutation === "foreign" ? randomUUID() : companyId,
        issueId: task.id,
        expectedStatusVersion: task.statusVersion,
        actorId: "synthetic-board",
      });
      expect(response.resolved).toEqual(mutation === "clean" ? [hold.id] : []);
      const [stored] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
      expect((stored.evidence.automaticRecovery as Record<string, unknown>).replay).toBe(mutation === "clean" ? "allowed" : "blocked");
      if (mutation === "clean") {
        expect(await getExecutionBlocker(db, companyId, task.id)).toBe(null);
        expect((await revalidateNonDispatchHolds(db, { companyId, issueId: task.id, expectedStatusVersion: task.statusVersion, actorId: "synthetic-board" })).resolved).toEqual([]);
      }
      expect(countExecuteCallsForRun(runId)).toBe(0);
    },
  );

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    wakeReason: string;
    contextExtras?: Record<string, unknown>;
    invocationSource?: "assignment" | "automation";
    scheduledRetryReason?: string | null;
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      reason: input.wakeReason,
      payload: { issueId: input.issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      scheduledRetryReason: input.scheduledRetryReason ?? null,
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: input.wakeReason,
        ...(input.contextExtras ?? {}),
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  async function seedContinuationSummary(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    body: string;
  }) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: input.body,
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: input.agentId,
      updatedByAgentId: input.agentId,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId: input.companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: input.body,
      createdByAgentId: input.agentId,
    });
    await db.insert(issueDocuments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    });
  }

  it.each([
    { name: "assignments", sameIssue: true, first: "assignment", second: "assignment" },
    { name: "unrelated tasks", sameIssue: false, first: "assignment", second: "assignment" },
    { name: "assignment then direct comment", sameIssue: true, first: "assignment", second: "direct" },
    { name: "direct comment then assignment", sameIssue: true, first: "direct", second: "assignment" },
    { name: "assignment then queued comment", sameIssue: true, first: "assignment", second: "queued" },
    { name: "queued comment then assignment", sameIssue: true, first: "queued", second: "assignment" },
    { name: "queued comments", sameIssue: true, first: "queued", second: "queued" },
  ])("serializes issue claims without serializing unrelated work: $name", async ({ sameIssue, first, second }) => {
    const { companyId, agentId } = await seedCompanyAndAgent({ maxConcurrentRuns: 2 });
    const firstIssueId = randomUUID();
    const secondIssueId = sameIssue ? firstIssueId : randomUUID();
    for (const id of new Set([firstIssueId, secondIssueId])) {
      await db.insert(issues).values({ id, companyId, title: "Concurrent assignment", status: "todo", assigneeAgentId: agentId });
    }
    async function queue(issueId: string, kind: string) {
      const commentId = kind === "assignment" ? null : randomUUID();
      if (commentId) await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorUserId: "local-board", body: "Continue this task." });
      const queued = await seedQueuedRun({ companyId, agentId, issueId,
        wakeReason: commentId ? "issue_commented" : "issue_assigned",
        invocationSource: commentId ? "automation" : "assignment",
        contextExtras: commentId ? { wakeCommentIds: [commentId], wakeCommentId: commentId } : {},
      });
      if (kind === "queued") await db.update(agentWakeupRequests).set({
        payload: withQueuedCommentIdsInWakePayload({ issueId }, [commentId!]),
      }).where(eq(agentWakeupRequests.id, queued.wakeupRequestId));
    }
    await queue(firstIssueId, first);
    await queue(secondIssueId, second);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockAdapterExecute.mockImplementation(async () => {
      await gate;
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Assignment finished.", provider: "test", model: "test-model" };
    });
    try {
      await heartbeat.resumeQueuedRuns();
      expect(await waitForCondition(() => Promise.resolve(mockAdapterExecute.mock.calls.length > 0))).toBe(true);
      const runs = await db.select().from(heartbeatRuns);
      const running = runs.filter((run) => run.status === "running");
      expect(running).toHaveLength(sameIssue ? 1 : 2);
      expect(runs.filter((run) => run.status === "queued")).toHaveLength(sameIssue ? 1 : 0);
      for (const run of running) {
        const [issue] = await db.select().from(issues).where(eq(issues.id, (run.contextSnapshot as { issueId: string }).issueId));
        expect(issue.executionRunId).toBe(run.id);
      }
    } finally {
      release();
      await heartbeat.drainActiveRunExecutions();
    }
  });

  it.each(["active_lease", "pending_cleanup", "failed_cleanup", "finalizer_lease", "workspace_finalization",
    "retained_ready", "retained_missing_receipt", "retained_failed", "retained_wrong_policy"])(
    "waits for durable cleanup from another controller: %s", async (pending) => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID(), previousId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title: "Remote cleanup", status: "todo", assigneeAgentId: agentId });
      await db.insert(heartbeatRuns).values({ id: previousId, companyId, agentId,
        status: "succeeded", runtimeMode: "native", nativeIssueId: issueId,
        invocationSource: "assignment", contextSnapshot: { issueId }, finishedAt: new Date() });
      await db.update(issues).set({ executionRunId: previousId }).where(eq(issues.id, issueId));
      const leaseId = randomUUID();
      const retained = pending.startsWith("retained_");
      const hasLease = retained || ["active_lease", "pending_cleanup", "failed_cleanup"].includes(pending);
      if (hasLease) await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId,
        heartbeatRunId: previousId, provider: "daytona",
        status: retained ? "retained" : pending === "pending_cleanup" ? "pending_cleanup" : "released",
        leasePolicy: pending === "retained_wrong_policy" ? "retain_on_failure" : retained ? "reuse_by_environment" : "ephemeral",
        releasedAt: retained || pending === "active_lease" ? null : new Date(),
        cleanupStatus: ["retained_ready", "retained_wrong_policy"].includes(pending) ? "success"
          : ["failed_cleanup", "retained_failed"].includes(pending) ? "failed" : null });
      await db.insert(nativeRunFinalizations).values({ runId: previousId, companyId, issueId,
        phase: pending === "workspace_finalization" ? "workspace_finalizing" : "committed",
        leaseOwner: pending === "finalizer_lease" ? "another-controller" : null });
      const next = await seedQueuedRun({ companyId, agentId, issueId, wakeReason: "issue_assigned", invocationSource: "assignment" });
      mockAdapterExecute.mockImplementation(async () => {
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
        return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
          summary: "Task completed", provider: "test", model: "test-model" };
      });
      // No in-memory executor exists in this service. Durable ownership alone
      // must fence a second controller until cleanup settles. A verified warm
      // retention receipt is already a settled boundary and allows continuation.
      await heartbeat.resumeQueuedRuns();
      if (pending !== "retained_ready") {
        expect((await heartbeat.getRun(next.runId))?.status).toBe("queued");
        expect(mockAdapterExecute).not.toHaveBeenCalled();
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionRunId).toBe(previousId);
        if (hasLease) await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" }).where(eq(environmentLeases.id, leaseId));
        await db.update(nativeRunFinalizations).set({ phase: "committed", leaseOwner: null }).where(eq(nativeRunFinalizations.runId, previousId));
        await heartbeat.resumeQueuedRuns();
      }
      await heartbeat.drainActiveRunExecutions();
      expect((await heartbeat.getRun(next.runId))?.status).toBe("succeeded");
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    },
  );

  it("skips generic timer wakes with no actionable assigned work before adapter execution", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: true,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    const runRows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.timer.no_actionable_work",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        reason: expect.stringContaining("No assigned todo or in_progress issue"),
      },
    });
    expect(runRows).toHaveLength(0);
  });

  it("checks guarded issue status and assignee under the enqueue lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const parkedIssueId = randomUUID();
    const reassignedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: parkedIssueId,
        companyId,
        title: "Parked connection intent",
        status: "backlog" as const,
        priority: "medium" as const,
        assigneeAgentId: agentId,
      },
      {
        id: reassignedIssueId,
        companyId,
        title: "Reassigned connection intent",
        status: "in_progress" as const,
        priority: "medium" as const,
        assigneeAgentId: null,
      },
    ]);

    for (const issueId of [parkedIssueId, reassignedIssueId]) {
      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, interactionId: randomUUID() },
        contextSnapshot: { issueId, wakeReason: "issue_commented" },
        requestedByActorType: "user",
        requestedByActorId: "responsible-user",
        issueStateGuard: {
          statuses: ["in_progress"],
          assigneeAgentId: agentId,
        },
      });
      expect(run).toBeNull();
    }

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)).toEqual([
      { status: "skipped", reason: "issue_state_guard_mismatch" },
      { status: "skipped", reason: "issue_state_guard_mismatch" },
    ]);
  });

  it.each(["decision", "policy"] as const)("skips review recovery when its %s changes before the enqueue lock reads the issue", async (change) => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const expectedDecisionId = randomUUID();
    const actualDecisionId = randomUUID();
    const stageId = randomUUID();
    const policy = { stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
      participants: [{ id: randomUUID(), type: "agent", agentId, userId: null }] }] };
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review decision changed during recovery admission",
      executionPolicy: policy,
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentParticipant: { type: "agent", agentId },
        lastDecisionId: expectedDecisionId,
      },
    });
    const [issueSnapshot] = await db.select().from(issues).where(eq(issues.id, issueId));

    let pendingWake!: ReturnType<typeof heartbeat.wakeup>;
    await db.transaction(async (tx) => {
      if (change === "decision") await tx.update(issues).set({ executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentParticipant: { type: "agent", agentId },
        lastDecisionId: actualDecisionId,
      } }).where(eq(issues.id, issueId));
      if (change === "policy") await tx.update(issues).set({ executionPolicy: {
        ...policy, stages: policy.stages.map(stage => ({ ...stage,
          participants: [{ ...stage.participants[0], agentId: randomUUID() }] })),
      } }).where(eq(issues.id, issueId));
      const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      pendingWake = heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "execution_review_participant_recovery",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          retryReason: "execution_review_participant_recovery",
          currentReviewDecisionId: expectedDecisionId,
        },
        requestedByActorType: "system",
        requestedByActorId: null,
        issueStateGuard: {
          statuses: ["in_review"],
          assigneeAgentId: agentId,
          statusVersion: issueSnapshot!.statusVersion,
          reviewAttempt: {
            decisionId: expectedDecisionId,
            participantAgentId: agentId,
            currentStageId: stageId,
            executionPolicy: normalizeIssueExecutionPolicy(policy),
          },
        },
      });
      expect(await waitForCondition(async () => {
        const [{ waiting }] = await db.execute<{ waiting: boolean }>(sql`
          select exists (
            select 1 from pg_stat_activity
            where ${pid} = any(pg_blocking_pids(pid))
          ) as waiting
        `);
        return waiting;
      })).toBe(true);
    });

    expect(await pendingWake).toBeNull();
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toHaveLength(0);
    const [wakeup] = await db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason,
      payload: agentWakeupRequests.payload }).from(agentWakeupRequests);
    expect(wakeup).toMatchObject({ status: "skipped", reason: "issue_state_guard_mismatch" });
    expect(wakeup?.payload).toMatchObject({ heartbeatSkip: {
      expectedReviewDecisionId: expectedDecisionId,
      actualReviewDecisionId: change === "decision" ? actualDecisionId : expectedDecisionId,
      expectedReviewParticipantAgentId: agentId,
      actualReviewParticipantAgentId: agentId,
    } });
  });

  it.each([
    { runtimeMode: "native", status: "done", reassigned: false },
    { runtimeMode: "legacy", status: "done", reassigned: false },
    { runtimeMode: "native", status: "cancelled", reassigned: false },
    { runtimeMode: "native", status: "backlog", reassigned: false },
    { runtimeMode: "native", status: "in_review", reassigned: false },
    { runtimeMode: "native", status: "blocked", reassigned: false },
    { runtimeMode: "native", status: "in_progress", reassigned: true },
  ] as const)("skips stale $runtimeMode productive recovery after status=$status reassigned=$reassigned commits under the enqueue lock", async ({ runtimeMode, status, reassigned }) => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Completion racing with productive recovery",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      runtimeMode,
      status: "succeeded",
      livenessState: "completed",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      startedAt: new Date(),
      finishedAt: new Date(),
    });

    // Let the real sweep select its in-progress snapshot, then hold the issue
    // lock until the real enqueue transaction is waiting on the newer state.
    const enqueueWakeup = vi.fn(async (...[targetAgentId, options]: Parameters<typeof heartbeat.wakeup>) => {
      let pendingWake!: ReturnType<typeof heartbeat.wakeup>;
      await db.transaction(async (tx) => {
        await tx.update(issues).set({
          status,
          ...(reassigned ? { assigneeAgentId: null, assigneeUserId: "responsible-user" } : {}),
        }).where(eq(issues.id, issueId));
        const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        pendingWake = heartbeat.wakeup(targetAgentId, options);
        try {
          expect(await waitForCondition(async () => {
            const [{ waiting }] = await db.execute<{ waiting: boolean }>(sql`
              select exists (
                select 1 from pg_stat_activity
                where ${pid} = any(pg_blocking_pids(pid))
              ) as waiting
            `);
            return waiting;
          })).toBe(true);
        } catch (error) {
          // Observe a pending rejection even if the lock assertion fails.
          void pendingWake.catch(() => {});
          throw error;
        }
      });
      return pendingWake;
    });
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(enqueueWakeup).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ continuationRequeued: 0, escalated: 0, skipped: 1, issueIds: [] });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toEqual([{ id: runId }]);
    expect(await db.select().from(issueComments)).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const [wakeup] = await db.select().from(agentWakeupRequests);
    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "issue_state_guard_mismatch",
      runId: null,
      payload: {
        heartbeatSkip: {
          expectedStatuses: ["in_progress"],
          actualStatus: status,
          expectedAssigneeAgentId: agentId,
          actualAssigneeAgentId: reassigned ? null : agentId,
        },
      },
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ status, assigneeAgentId: reassigned ? null : agentId });
  });

  it("cancels a resolved connection-intent wake parked before queued-run claim", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Connection intent parked after enqueue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        interactionId: randomUUID(),
        interactionKind: "connection_intent",
        interactionStatus: "accepted",
        interactionResolvedAt: "2026-08-28T13:30:00.000Z",
        mutation: "interaction",
        source: "connection_intent.resolved",
      },
    });

    await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, issueId));
    await heartbeat.resumeQueuedRuns();

    const [run, wakeup, issue] = await Promise.all([
      db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_not_in_progress" });
    expect(wakeup).toMatchObject({ status: "skipped", error: expect.stringContaining("no longer in_progress") });
    expect(issue?.status).toBe("backlog");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("does not re-open a resolved connection-intent issue parked after claim", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Connection intent parked between claim and checkout",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        interactionId: randomUUID(),
        interactionKind: "connection_intent",
        interactionStatus: "accepted",
        interactionResolvedAt: "2026-08-28T13:30:00.000Z",
        mutation: "interaction",
        source: "connection_intent.resolved",
      },
    });

    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION park_connection_intent_after_claim()
      RETURNS trigger AS $trigger$
      BEGIN
        IF NEW.id = '${runId}'::uuid AND NEW.status = 'running' THEN
          UPDATE issues SET status = 'backlog' WHERE id = '${issueId}'::uuid;
        END IF;
        RETURN NEW;
      END;
      $trigger$ LANGUAGE plpgsql;

      CREATE TRIGGER park_connection_intent_after_claim
      AFTER UPDATE OF status ON heartbeat_runs
      FOR EACH ROW EXECUTE FUNCTION park_connection_intent_after_claim();
    `));

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const [run, wakeup] = await Promise.all([
        db.select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId))
          .then((rows) => rows[0] ?? null),
        db.select({ status: agentWakeupRequests.status })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, wakeupRequestId))
          .then((rows) => rows[0] ?? null),
      ]);
      return run?.status === "cancelled" && wakeup?.status === "skipped";
    });

    const [run, wakeup, issue] = await Promise.all([
      db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_not_in_progress" });
    expect(wakeup).toMatchObject({ status: "skipped", error: expect.stringContaining("no longer in_progress") });
    expect(issue?.status).toBe("backlog");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it.each([
    {
      mutation: "parked",
      expectedErrorCode: "issue_not_in_progress",
      expectedError: "no longer in_progress",
    },
    {
      mutation: "reassigned",
      expectedErrorCode: "issue_assignee_changed",
      expectedError: "changed assignee",
    },
  ])(
    "cancels a resolved connection-intent wake $mutation after checkout but before adapter dispatch",
    async ({ mutation, expectedErrorCode, expectedError }) => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const replacementAgentId = randomUUID();
      if (mutation === "reassigned") {
        await db.insert(agents).values({
          id: replacementAgentId,
          companyId,
          name: "ReplacementCoder",
          role: "engineer",
          status: "active",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
          permissions: {},
        });
      }
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Connection intent ${mutation} at final dispatch`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      });
      const { runId, wakeupRequestId } = await seedQueuedRun({
        companyId,
        agentId,
        issueId,
        wakeReason: "issue_commented",
        invocationSource: "automation",
        contextExtras: {
          interactionId: randomUUID(),
          interactionKind: "connection_intent",
          interactionStatus: "accepted",
          interactionResolvedAt: "2026-08-28T13:30:00.000Z",
          mutation: "interaction",
          source: "connection_intent.resolved",
        },
      });
      beforeContinuationDispatchCheck = async ({ runId: guardedRunId, issueId: guardedIssueId }) => {
        expect(guardedRunId).toBe(runId);
        expect(guardedIssueId).toBe(issueId);
        await db
          .update(issues)
          .set(mutation === "parked"
            ? { status: "backlog", updatedAt: new Date() }
            : { assigneeAgentId: replacementAgentId, updatedAt: new Date() })
          .where(eq(issues.id, issueId));
      };

      await heartbeat.resumeQueuedRuns();
      await waitForCondition(async () => {
        const [run, wakeup] = await Promise.all([
          db.select({ status: heartbeatRuns.status })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, runId))
            .then((rows) => rows[0] ?? null),
          db.select({ status: agentWakeupRequests.status })
            .from(agentWakeupRequests)
            .where(eq(agentWakeupRequests.id, wakeupRequestId))
            .then((rows) => rows[0] ?? null),
        ]);
        return run?.status === "cancelled" && wakeup?.status === "skipped";
      });

      const [run, wakeup, issue] = await Promise.all([
        db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId))
          .then((rows) => rows[0] ?? null),
        db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, wakeupRequestId))
          .then((rows) => rows[0] ?? null),
        db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0] ?? null),
      ]);
      expect(run).toMatchObject({ status: "cancelled", errorCode: expectedErrorCode });
      expect(wakeup).toMatchObject({ status: "skipped", error: expect.stringContaining(expectedError) });
      expect(issue).toMatchObject(mutation === "parked"
        ? { status: "backlog", assigneeAgentId: agentId }
        : { status: "in_progress", assigneeAgentId: replacementAgentId });
      expect(countExecuteCallsForRun(runId)).toBe(0);
    },
  );

  it("rejects ownership changes immediately before the final continuation handoff", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Connection intent parked at the atomic dispatch gate",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        interactionId: randomUUID(),
        interactionKind: "connection_intent",
        interactionStatus: "accepted",
        interactionResolvedAt: "2026-08-28T13:30:00.000Z",
        mutation: "interaction",
        source: "connection_intent.resolved",
      },
    });

    const ordering: string[] = [];
    let parkPromise: Promise<unknown> | null = null;
    afterContinuationDispatchCheck = async ({ runId: guardedRunId, issueId: guardedIssueId }) => {
      expect(guardedRunId).toBe(runId);
      expect(guardedIssueId).toBe(issueId);
      ordering.push("validated");
      parkPromise = Promise.resolve(
        db
          .update(issues)
          .set({
            status: "backlog",
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issueId))
          .returning({ id: issues.id }),
      ).then((rows) => {
        expect(rows).toHaveLength(1);
        ordering.push("parked");
      });
      // Admission is committed before adapter-owned setup. This concurrent
      // update must not wait on a lock held by the adapter callback.
      await new Promise((resolve) => setTimeout(resolve, 25));
      await parkPromise;
      expect(ordering).toEqual(["validated", "parked"]);
    };
    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });
    await parkPromise;

    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("backlog");
    expect(ordering).toEqual(["validated", "parked"]);
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("rate-limits skipped generic timer wakes by advancing the timer baseline", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        intervalSec: 60,
        skipTimerWhenNoActionableWork: true,
      },
    });
    const now = new Date();
    await db
      .update(agents)
      .set({ lastHeartbeatAt: new Date(now.getTime() - 120_000) })
      .where(eq(agents.id, agentId));

    const firstTick = await heartbeat.tickTimers(now);
    const secondTick = await heartbeat.tickTimers(now);

    expect(firstTick.skipped).toBe(1);
    expect(secondTick.skipped).toBe(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const wakeups = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    const [agent] = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId));

    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.reason).toBe("heartbeat.timer.no_actionable_work");
    expect(agent?.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(agent?.lastHeartbeatAt?.getTime()).toBeGreaterThan(now.getTime() - 120_000);
  });

  it("atomically claims a due timer interval across overlapping scheduler ticks", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        intervalSec: 60,
      },
    });
    const now = new Date();
    await db
      .update(agents)
      .set({
        createdAt: new Date(now.getTime() - 120_000),
        lastHeartbeatAt: null,
      })
      .where(eq(agents.id, agentId));

    const results = await Promise.all([
      heartbeat.tickTimers(now),
      heartbeat.tickTimers(now),
    ]);

    expect(results.reduce((total, result) => total + result.enqueued, 0)).toBe(1);

    const runs = await db
      .select({
        id: heartbeatRuns.id,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const [agent] = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId));

    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot).toMatchObject({
      timerClaimWasFirstHeartbeat: true,
    });
    expect(agent?.lastHeartbeatAt?.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it("allows generic timer wakes when the agent has assigned todo work", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: true,
      },
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Assigned work",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);

    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("allows legacy generic timer wakes by default when no skip policy is set", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("allows explicit proactive generic timer wakes without assigned issue work", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: false,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "schedule",
    });

    expect(run).not.toBeNull();
    await waitForCondition(async () => countExecuteCallsForRun(run!.id) > 0);
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("skips wakes before queueing when per-agent daily run cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 1,
        limit: 1,
      },
    });
  });

  it("treats zero daily run cap as a hard stop", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 0,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 0,
        limit: 0,
      },
    });
  });

  it("counts started cancelled runs toward the per-agent daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "cancelled",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 1,
        limit: 1,
      },
    });
  });

  it("coalesces same-issue wakes before enforcing the daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
    });

    expect(run?.id).toBe(queuedRunId);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const wakeups = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "coalesced",
          reason: "issue_execution_same_name",
          runId: queuedRunId,
        }),
      ]),
    );
  });

  it.each(["codex_local", "gemini_local"].flatMap(adapterType => [
    { adapterType, inputTokens: 50_000, cachedInputTokens: 550_000, rotate: true, rawInputIncludesCached: false },
    { adapterType, inputTokens: 50_000, cachedInputTokens: 449_999, rotate: false, rawInputIncludesCached: false },
    { adapterType, inputTokens: 0, cachedInputTokens: 500_000, rotate: true, rawInputIncludesCached: false },
    { adapterType, inputTokens: 400_000, cachedInputTokens: 350_000, rotate: false, rawInputIncludesCached: undefined },
    { adapterType, inputTokens: 500_000, cachedInputTokens: 350_000, rotate: true, rawInputIncludesCached: undefined },
  ]))("counts cached prompt input for $adapterType session rotation ($inputTokens + $cachedInputTokens; raw includes cache: $rawInputIncludesCached)", async ({ adapterType, inputTokens, cachedInputTokens, rotate, rawInputIncludesCached }) => {
    const { companyId, agentId } = await seedCompanyAndAgent({ heartbeatConfig: {
      sessionCompaction: { enabled: true, maxSessionRuns: 0, maxRawInputTokens: 500_000, maxSessionAgeHours: 0 },
    } });
    const sessionId = randomUUID();
    await db.update(agents).set({ adapterType }).where(eq(agents.id, agentId));
    await db.insert(agentRuntimeState).values({ companyId, agentId, adapterType, sessionId });
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", sessionIdAfter: sessionId,
      usageJson: { ...(rawInputIncludesCached === false ? { rawInputIncludesCached } : {}), inputTokens, cachedInputTokens, outputTokens: 10, rawInputTokens: inputTokens, rawCachedInputTokens: cachedInputTokens },
      resultJson: { summary: "Continue from this completed turn" }, startedAt: new Date(), finishedAt: new Date(),
    });
    mockAdapterExecute.mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, errorMessage: null,
      provider: "test", model: "test-model", costUsd: 0, usageComplete: true, usageBasis: "per_run",
      usage: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3 },
    });
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual" });
    expect(run).not.toBeNull();
    expect(await waitForCondition(() => Promise.resolve(countExecuteCallsForRun(run!.id) === 1))).toBe(true);
    const [context] = mockAdapterExecute.mock.calls.find(([context]) => context?.runId === run!.id)!;
    expect(context.runtime.sessionId).toBe(rotate ? null : sessionId);
    if (rotate) {
      expect(context.context.paperclipSessionRotationReason).toContain((inputTokens + (rawInputIncludesCached === false ? cachedInputTokens : 0)).toLocaleString("en-US"));
      expect(context.context.paperclipSessionHandoffMarkdown).toContain("Continue from this completed turn");
    } else expect(context.context.paperclipSessionRotationReason).toBeUndefined();
    await heartbeat.drainActiveRunExecutions();
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(finished.usageJson).toMatchObject({ rawInputTokens: 1, rawCachedInputTokens: 2, rawInputIncludesCached: false });
  });

  it("skips wakes before queueing when per-agent daily cost cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 75,
      },
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 75,
      occurredAt: new Date(),
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_cost_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 75,
        limit: 75,
      },
    });
  });

  it("treats zero daily cost cap as a hard stop", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 0,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_cost_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 0,
        limit: 0,
      },
    });
  });

  it("skips already queued runs before adapter execution when the daily cost cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 75,
      },
    });
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: {},
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {},
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 75,
      occurredAt: new Date(),
    });

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "heartbeat.daily_cost_limit",
    });
    expect(run?.resultJson).toMatchObject({
      stopReason: "heartbeat.daily_cost_limit",
      observed: 75,
      limit: 75,
    });
    expect(wakeup).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("per-day heartbeat budget cap"),
    });
  });

  it("skips already queued issue runs at the daily run cap and releases the execution lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId));
    const [wakeup] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    const [issue] = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "heartbeat.daily_run_limit",
    });
    expect(wakeup).toMatchObject({ status: "skipped" });
    expect(issue?.executionRunId).toBeNull();
  });

  it("promotes deferred issue wakes when a queued holder is cancelled by the daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const peerAgentId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    const deferredWakeupId = randomUUID();
    await db.insert(agents).values({
      id: peerAgentId,
      companyId,
      name: "PeerAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeupId,
      companyId,
      agentId: peerAgentId,
      source: "comment",
      triggerDetail: "mention",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: {
          issueId,
          wakeReason: "issue_mention",
        },
      },
      status: "deferred_issue_execution",
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => {
      const [deferred] = await db
        .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWakeupId));
      return Boolean(deferred?.runId) && deferred?.status !== "deferred_issue_execution";
    });

    const [deferred] = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeupId));
    const [promotedRun] = deferred?.runId
      ? await db
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, deferred.runId))
      : [];

    expect(deferred?.status).not.toBe("deferred_issue_execution");
    expect(promotedRun?.agentId).toBe(peerAgentId);
  });

  it("cancels queued max-turn continuations when another continuation owns the issue lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const lockOwnerRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: lockOwnerRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      scheduledRetryAttempt: 1,
      scheduledRetryAt: new Date("2026-04-20T12:00:00.000Z"),
      contextSnapshot: {
        issueId,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Duplicate max-turn continuation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: lockOwnerRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: new Date("2026-04-20T11:59:00.000Z"),
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      invocationSource: "automation",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextExtras: {
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "cancelled";
    });

    const [run, wakeup, issue] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_execution_lock_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_execution_lock_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("execution lock");
    expect(issue?.executionRunId).toBe(lockOwnerRunId);
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it.each([
    ["accepted", "connection_intent"],
    ["rejected", "connection_intent"],
    ["rejected", "request_confirmation"],
  ])("resumes a %s %s outcome and promotes the claimed review task", async (interactionStatus, interactionKind) => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    const wakeCommentId = randomUUID();
    let claimedIssue: { status: string; executionRunId: string | null } | null = null;
    afterContinuationDispatchCheck = async ({ runId: checkedRunId, issueId: checkedIssueId }) => {
      if (checkedIssueId !== issueId) return;
      claimedIssue = await db
        .select({ status: issues.status, executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(claimedIssue).toEqual({ status: "in_progress", executionRunId: checkedRunId });
    };
    await db.insert(issues).values({ id: issueId, companyId, title: "Waiting for connection", status: "in_review", priority: "medium", assigneeAgentId: agentId });
    await db.insert(issueComments).values({
      id: wakeCommentId,
      companyId,
      issueId,
      authorUserId: "local-board",
      body: "Continue after the interaction result.",
    });
    if (interactionKind === "request_confirmation") {
      await db.insert(issueThreadInteractions).values({
        id: interactionId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "rejected",
        continuationPolicy: "wake_assignee",
        payload: {},
        result: { version: 1, outcome: "rejected", reason: "Needs more work" },
        createdByAgentId: agentId,
        resolvedAt: new Date(),
      });
    }
    const { runId } = await seedQueuedRun({ companyId, agentId, issueId, wakeReason: "issue_commented",
      contextExtras: { interactionId, interactionKind, interactionStatus, wakeCommentId,
        originCommentIds: [wakeCommentId],
        interactionResolvedAt: new Date().toISOString(), mutation: "interaction", source: `${interactionKind}.resolved`, forceFreshSession: true } });
    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => (await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status === "succeeded")).toBe(true);
    // Terminal status precedes completion bookkeeping. Drain those writes before
    // afterEach truncates the fixture, otherwise PostgreSQL can deadlock.
    await heartbeat.waitForRunExecutionDrain(runId);
    expect(countExecuteCallsForRun(runId)).toBe(1);
    await waitForCondition(async () => claimedIssue !== null);
    expect(claimedIssue).toEqual({ status: "in_progress", executionRunId: runId });
  });
});
