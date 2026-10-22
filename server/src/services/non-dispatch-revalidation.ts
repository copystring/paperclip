import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  agents,
  companies,
  decisionInvocations,
  environmentLeases,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  toolInvocations,
  type Db,
  workspaceOperations,
} from "@paperclipai/db";
import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { logActivity } from "./activity-log.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import { historicalDependencyReceipt, isNonDispatchVerified } from "./non-dispatch-receipt.js";

/** Reclassifies only a positively evidenced non-dispatch incident; it never replays a run. */
export async function revalidateNonDispatchHolds(db: Db, input: {
  companyId: string;
  issueId: string;
  expectedStatusVersion: number;
  actorId: string;
}) {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(issues).where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.id, input.issueId),
    )).for("update");
    if (
      !task ||
      task.statusVersion !== input.expectedStatusVersion ||
      !["todo", "in_progress", "in_review"].includes(task.status) ||
      task.executionRunId ||
      task.checkoutRunId
    ) return { resolved: [], reason: "issue_changed_or_owned" };

    const [company] = await tx.select().from(companies).where(eq(companies.id, task.companyId)).limit(1);
    const [agent] = task.assigneeAgentId
      ? await tx.select().from(agents).where(and(
          eq(agents.id, task.assigneeAgentId),
          eq(agents.companyId, task.companyId),
        )).limit(1)
      : [];
    if (
      company?.status !== "active" ||
      !(await evaluateAgentInvokabilityFromDb(tx as unknown as Db, agent)).invokable ||
      await issueTreeControlService(tx as unknown as Db).getActivePauseHoldGate(task.companyId, task.id)
    ) return { resolved: [], reason: "control_gate" };

    const candidates = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, task.companyId),
      eq(issueRecoveryActions.sourceIssueId, task.id),
      eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
      or(
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
      ),
    )).limit(10);
    const resolved: string[] = [];

    for (const candidate of candidates) {
      const runId = candidate.evidence.runId;
      const automatic = candidate.evidence.automaticRecovery as Record<string, unknown> | undefined;
      if (
        candidate.status === "resolved" &&
        (candidate.outcome !== "blocked" || automatic?.policy !== "preserve_without_replay_v1")
      ) continue;
      if (
        typeof runId !== "string" ||
        candidate.fingerprint !== `legacy-execution:${runId}` ||
        candidate.evidence.executionReconciliation ||
        hasRequiredWorkspaceRecovery(candidate.evidence) ||
        hasWorkspaceRestoreFailure(candidate.evidence)
      ) continue;

      const [run] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, task.companyId),
        eq(heartbeatRuns.id, runId),
      )).for("update");
      if (!run || run.contextSnapshot?.issueId !== task.id || task.assigneeAgentId !== run.agentId) continue;

      const stage = run.contextSnapshot.executionStage as Record<string, unknown> | undefined;
      // This canary predates the shared execution-stage wake predicate. Keep
      // stage-bound runs unresolved here rather than guessing whether their
      // workflow participant and review state are still current.
      if (stage && Object.keys(stage).length > 0) continue;

      const [successor] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, task.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}`,
        inArray(heartbeatRuns.status, ["queued", "scheduled_retry", "running"]),
      )).limit(1);
      if (successor) continue;

      // A non-dispatch receipt never proves the predecessor's effects. Keep its
      // own stop, lease, tool and workspace obligations independently gated.
      const sourceIds = new Set(
        [run.retryOfRunId, run.contextSnapshot.interruptedRunId]
          .filter((value): value is string => typeof value === "string"),
      );
      let lineageValid = true;
      for (const sourceId of sourceIds) {
        const [source] = await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, task.companyId),
          eq(heartbeatRuns.id, sourceId),
        )).limit(1);
        if (
          !source ||
          source.contextSnapshot?.issueId !== task.id ||
          source.id === run.id ||
          source.retryOfRunId === run.id ||
          source.contextSnapshot?.interruptedRunId === run.id ||
          !["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(source.status) ||
          hasRequiredWorkspaceRecovery(source.resultJson) ||
          hasWorkspaceRestoreFailure(source.resultJson) ||
          (source.startedAt && !(
            (source.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state === "acknowledged" &&
            source.resultJson?.reassignmentStopConfirmed === true
          ))
        ) lineageValid = false;
        if (
          source && !source.startedAt &&
          !(await isNonDispatchVerified(tx as unknown as Db, source)) &&
          // Only the exact historical dependency event can reconstruct the old receipt.
          !(await historicalDependencyReceipt(tx as unknown as Db, source))
        ) lineageValid = false;
      }

      for (const sourceId of sourceIds) {
        const leases = await tx.select().from(environmentLeases).where(and(
          eq(environmentLeases.companyId, task.companyId),
          eq(environmentLeases.heartbeatRunId, sourceId),
        ));
        if (leases.some((lease) => lease.provider === "local"
          ? !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
          : !hasRemoteTerminationReceipt(lease))) lineageValid = false;
        const operations = await tx.select().from(workspaceOperations).where(and(
          eq(workspaceOperations.companyId, task.companyId),
          eq(workspaceOperations.heartbeatRunId, sourceId),
        ));
        if (operations.some((operation) => operation.status !== "succeeded")) lineageValid = false;
        const tools = await tx.select().from(toolInvocations).where(and(
          eq(toolInvocations.companyId, task.companyId),
          eq(toolInvocations.runId, sourceId),
        ));
        if (tools.some((tool) => !["succeeded", "denied"].includes(tool.status))) lineageValid = false;
        const decisions = await tx.select().from(decisionInvocations).where(and(
          eq(decisionInvocations.companyId, task.companyId),
          eq(decisionInvocations.runId, sourceId),
        ));
        if (decisions.some((decision) => decision.status !== "succeeded")) lineageValid = false;
      }
      if (!lineageValid) continue;

      const storedReceipt = run.resultJson?.nonDispatchReceipt as Record<string, unknown> | undefined;
      if (storedReceipt && storedReceipt.issueStatusVersion !== task.statusVersion) continue;
      const historical = storedReceipt ? null : await historicalDependencyReceipt(tx as unknown as Db, run);
      const proposed = historical
        ? { ...run, resultJson: { ...run.resultJson, nonDispatchReceipt: historical.receipt } }
        : run;
      if (historical) {
        await tx.update(heartbeatRuns).set({ resultJson: proposed.resultJson }).where(and(
          eq(heartbeatRuns.id, run.id),
          eq(heartbeatRuns.companyId, run.companyId),
        ));
      }
      if (!(await isNonDispatchVerified(tx as unknown as Db, proposed))) {
        if (historical) {
          await tx.update(heartbeatRuns).set({ resultJson: run.resultJson }).where(and(
            eq(heartbeatRuns.id, run.id),
            eq(heartbeatRuns.companyId, run.companyId),
          ));
        }
        continue;
      }

      const [action] = await tx.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, candidate.id)).for("update");
      if (!action || !isDeepStrictEqual(action, candidate)) continue;
      const now = new Date();
      await tx.update(issueRecoveryActions).set({
        status: "resolved",
        outcome: "false_positive",
        resolvedAt: now,
        updatedAt: now,
        resolutionNote: "Server evidence verifies that this exact dependency dispatch never started. No prior provider work was replayed.",
        evidence: {
          ...action.evidence,
          automaticRecovery: {
            ...(action.evidence.automaticRecovery as Record<string, unknown>),
            replay: "allowed",
          },
          nonDispatchRevalidation: {
            version: 1,
            runId: run.id,
            issueStatusVersion: task.statusVersion,
            historicalEventId: historical?.eventId ?? null,
            recordedAt: now.toISOString(),
          },
        },
      }).where(eq(issueRecoveryActions.id, action.id));
      resolved.push(action.id);
    }

    if (resolved.length > 0) {
      await logActivity(tx as unknown as Db, {
        companyId: task.companyId,
        actorType: "user",
        actorId: input.actorId,
        action: "issue.recovery_action_resolved",
        entityType: "issue",
        entityId: task.id,
        details: {
          source: "verified_non_dispatch_revalidation",
          recoveryActionIds: resolved,
          replayed: false,
        },
      });
    }
    return { resolved, replayed: false };
  });
}
