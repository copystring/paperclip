import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  decisionInvocations,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeRunFinalizations,
  toolInvocations,
  workspaceOperations,
  type Db,
} from "@paperclipai/db";
import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";

type Run = typeof heartbeatRuns.$inferSelect;

const NON_DISPATCH_REASONS = new Set([
  "issue_dependencies_blocked",
  "issue_waiting_for_response",
  "issue_continuation_waiting_on_review",
  "issue_reassigned",
  "issue_review_participant_changed",
  "issue_execution_lock_changed",
  "issue_cancelled",
  "issue_terminal_status",
  "issue_blocked",
  "issue_paused",
  "budget_blocked",
  "agent_not_invokable",
  "heartbeat_wake_on_demand_disabled",
]);

function contextHash(run: Run) {
  return createHash("sha256").update(JSON.stringify(run.contextSnapshot)).digest("hex");
}

function runFingerprint(run: Run) {
  return createHash("sha256")
    .update(JSON.stringify(run, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
        : value,
    ))
    .digest("hex");
}

/** A receipt can only be created from a legacy run that has never been claimed. */
export function isUnclaimedRun(run: Run): boolean {
  const cancellation = run.resultJson?.cancellation as Record<string, unknown> | undefined;
  const recovery = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  const hasInterruptedExecution = recovery?.kind === "interrupted";
  const initiator = cancellation?.initiator as Record<string, unknown> | undefined;
  const receipt = run.resultJson?.nonDispatchReceipt as Record<string, unknown> | undefined;
  const acceptedControlPlaneCancellation = cancellation?.source === "control_plane" &&
    cancellation.expected === true &&
    initiator?.type === "system" &&
    typeof cancellation.reason === "string" && cancellation.reason.trim().length > 0 &&
    typeof cancellation.recordedAt === "string" && Number.isFinite(Date.parse(cancellation.recordedAt)) &&
    receipt?.version === 1 &&
    receipt.runId === run.id &&
    receipt.companyId === run.companyId &&
    receipt.issueId === run.contextSnapshot?.issueId &&
    receipt.agentId === run.agentId &&
    receipt.reason === run.errorCode &&
    receipt.providerWorkStarted === false &&
    ["dependency_gate", "scheduled_retry_gate", "stale_queued_run_gate"].includes(String(receipt.gate));

  return !hasInterruptedExecution && run.runtimeMode === "legacy" &&
    typeof run.contextSnapshot?.issueId === "string" &&
    (!run.issueId || run.issueId === run.contextSnapshot.issueId) &&
    [
      run.startedAt,
      run.runtimeModeResolvedAt,
      run.processPid,
      run.processGroupId,
      run.processStartedAt,
      run.nativeIssueId,
      run.nativeSessionId,
      run.sessionIdAfter,
      run.controllerBootId,
      run.controllerLeaseExpiresAt,
      run.executionStage,
      run.runnerInstanceId,
      run.logRef,
    ].every((value) => value === null) &&
    (run.resultJson?.executionRecovery as Record<string, unknown> | undefined)?.providerWorkStarted !== true &&
    !(Number(run.resultJson?.acpPendingToolCount) > 0) &&
    !hasWorkspaceRestoreFailure(run.resultJson) &&
    !hasRequiredWorkspaceRecovery(run.resultJson) &&
    !run.resultJson?.startupCancellation &&
    !run.resultJson?.cancelledByActorType &&
    !run.resultJson?.cancelledByUserId &&
    !run.resultJson?.interruptedByActorType &&
    (!cancellation || acceptedControlPlaneCancellation);
}

/** Compare the full run projection captured before terminalization. */
export function matchesNonDispatchSource(run: Run, receipt: unknown): boolean {
  if (!receipt || typeof receipt !== "object") return false;
  const value = receipt as Record<string, unknown>;
  return isDeepStrictEqual(
    receipt,
    makeNonDispatchReceipt(
      run,
      String(value.reason),
      String(value.gate),
      typeof value.issueStatusVersion === "number" ? value.issueStatusVersion : null,
    ),
  );
}

export function makeNonDispatchReceipt(
  run: Run,
  reason: string,
  gate: string,
  issueStatusVersion: number | null = null,
) {
  if (
    !NON_DISPATCH_REASONS.has(reason) ||
    !isUnclaimedRun(run) ||
    !["queued", "scheduled_retry"].includes(run.status)
  ) return null;

  return {
    version: 1,
    runId: run.id,
    companyId: run.companyId,
    issueId: run.contextSnapshot!.issueId,
    agentId: run.agentId,
    retryOfRunId: run.retryOfRunId,
    reason,
    gate,
    contextHash: contextHash(run),
    providerWorkStarted: false,
    issueStatusVersion,
    sourceStatus: run.status,
    sourceRunFingerprint: runFingerprint(run),
  };
}

/** A retained receipt is insufficient when any provider effect contradicts it. */
export async function hasNonDispatchContradiction(db: Db, run: Run): Promise<boolean> {
  for (const [table, runColumn, companyColumn] of [
    [environmentLeases, environmentLeases.heartbeatRunId, environmentLeases.companyId],
    [nativeRunFinalizations, nativeRunFinalizations.runId, nativeRunFinalizations.companyId],
    [toolInvocations, toolInvocations.runId, toolInvocations.companyId],
    [decisionInvocations, decisionInvocations.runId, decisionInvocations.companyId],
    [workspaceOperations, workspaceOperations.heartbeatRunId, workspaceOperations.companyId],
  ] as const) {
    const rows = await db.select({ runId: runColumn }).from(table).where(
      and(eq(runColumn, run.id), eq(companyColumn, run.companyId)),
    ).limit(1);
    if (rows.length > 0) return true;
  }

  const events = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId),
    eq(heartbeatRunEvents.runId, run.id),
  ));
  return events.some((event) =>
    event.sourceEventId !== null || !["lifecycle", "diagnostic"].includes(event.eventType),
  );
}

export async function isNonDispatchVerified(db: Db, candidate: Run): Promise<boolean> {
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, candidate.companyId),
    eq(heartbeatRuns.id, candidate.id),
  )).limit(1);
  if (
    !run ||
    !isDeepStrictEqual(run, candidate) ||
    run.status !== "cancelled" ||
    !run.finishedAt ||
    !isUnclaimedRun(run) ||
    !run.errorCode
  ) return false;

  const receipt = run.resultJson?.nonDispatchReceipt as Record<string, unknown> | undefined;
  const expected = makeNonDispatchReceipt(
    { ...run, status: "queued" },
    run.errorCode,
    String(receipt?.gate),
    typeof receipt?.issueStatusVersion === "number" ? receipt.issueStatusVersion : null,
  );
  // The terminal row is necessarily different from its pre-claim source. The
  // source fingerprint is checked at the write boundary, under the run lock.
  if (
    !receipt ||
    !["queued", "scheduled_retry"].includes(String(receipt.sourceStatus)) ||
    typeof receipt.sourceRunFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.sourceRunFingerprint)
  ) return false;
  if (expected) {
    expected.sourceStatus = String(receipt.sourceStatus);
    expected.sourceRunFingerprint = receipt.sourceRunFingerprint;
  }
  return Boolean(
    expected &&
      ["dependency_gate", "scheduled_retry_gate", "stale_queued_run_gate"].includes(String(receipt.gate)) &&
      isDeepStrictEqual(receipt, expected) &&
      !(await hasNonDispatchContradiction(db, run)),
  );
}

/** Reconstruct only the historical dependency gate backed by its exact event. */
export async function historicalDependencyReceipt(db: Db, run: Run) {
  if (run.status !== "cancelled" || run.errorCode !== "issue_dependencies_blocked" || !isUnclaimedRun(run)) return null;
  const events = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId),
    eq(heartbeatRunEvents.runId, run.id),
  ));
  const event = events.find((candidate) =>
    candidate.agentId === run.agentId &&
    candidate.eventType === "lifecycle" &&
    candidate.stream === "system" &&
    candidate.sourceEventId === null &&
    candidate.payload?.issueId === run.contextSnapshot?.issueId &&
    Array.isArray(candidate.payload?.unresolvedBlockerIssueIds) &&
    candidate.payload.unresolvedBlockerIssueIds.length > 0 &&
    (candidate.message === "Cancelled because issue dependencies are still blocked; Paperclip will wake the assignee when blockers resolve" ||
      candidate.message === "Scheduled retry suppressed because issue dependencies are still blocked"),
  );
  if (!event || await hasNonDispatchContradiction(db, run)) return null;
  return {
    receipt: makeNonDispatchReceipt({ ...run, status: "queued" }, run.errorCode, "dependency_gate")!,
    eventId: event.id,
  };
}
