import { createHash } from "node:crypto";

/** This contract deliberately has no narrative, liveness label or progress count. */
export interface LegacyContinuationInput {
  run: { id: string; companyId: string; agentId: string; status: string; runtimeMode?: string | null };
  issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null; assigneeUserId?: string | null; unblockDescriptor?: unknown } | null;
  agent: { id: string; companyId: string; status: string } | null;
  episode: LegacyDispositionEpisode;
  gates: {
    stopped: boolean;
    paused: boolean;
    budgetBlocked: boolean;
    pendingWait: boolean;
    activeExecution: boolean;
    ownedLifecycle: boolean;
    conversation: boolean;
    agentInvokable: boolean;
  };
}
export interface LegacyDispositionEpisode {
  id: string;
  attempt: number;
  maxAttempts: number;
}
export const LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS = 2;
export const OWNER_DISPOSITION_REPAIR_NEXT_ACTION =
  'For your own unfinished work, use the normal PATCH /api/issues/{issueId} under your existing authority, preserving its assignee. ' +
  'First verify your current run owns an in_progress checkout; otherwise acquire the normal checkout. Respect a refused checkout, real blockers and ownership conflicts; never fake in_progress with a status PATCH. ' +
  'From your current in_progress checkout send {"status":"todo","comment":"Saved progress; next concrete step","resume":true} with X-Paperclip-Run-Id set to your current run. ' +
  'Both the in_progress-to-todo transition and resume:true are required; a self-comment or todo alone queues nothing. Verify the saved successor path. ' +
  'Otherwise record the real terminal, review or blocker path. Do not call /api/issues/{issueId}/recovery-actions/resolve: restored/todo is a board retry. Do not invent blockers, change owners or reset budgets. Respect Stop, pause and approval gates.';
export const LEGACY_DISPOSITION_REPAIR_INSTRUCTION =
  "The previous task run ended without a recorded disposition or an owned next execution path. " +
  "Re-read the current task state. A final message alone does not record disposition. " +
  OWNER_DISPOSITION_REPAIR_NEXT_ACTION;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
export function legacyDispositionEpisode(run: {
  id: string;
  contextSnapshot?: unknown;
  continuationAttempt?: number | null;
}): LegacyDispositionEpisode {
  const context = record(run.contextSnapshot);
  const episode = record(context.legacyDispositionEpisode);
  if (typeof episode.id === "string" && episode.id) {
    return { id: episode.id, attempt: count(episode.attempt), maxAttempts: Math.max(1, Math.min(LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS, count(episode.maxAttempts) || LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS)) };
  }
  // Pre-upgrade repairs have already consumed their old (possibly tighter)
  // allowance. A classifier/key migration must not grant them a fresh budget.
  const handoff = context.wakeReason === "finish_successful_run_handoff" || context.handoffRequired === true;
  const oldRecovery = context.source === "issue.productive_terminal_continuation_recovery";
  const attempt = Math.max(count(run.continuationAttempt), count(context.livenessContinuationAttempt), count(context.dispositionRepairAttempt), handoff ? count(context.handoffAttempt) || 1 : 0, oldRecovery ? 1 : 0);
  return {
    id: typeof context.dispositionRepairFingerprint === "string" ? context.dispositionRepairFingerprint : typeof context.livenessContinuationSourceRunId === "string" ? context.livenessContinuationSourceRunId : run.id,
    attempt,
    maxAttempts: handoff || oldRecovery ? 1 : LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS,
  };
}
export function legacyDispositionFingerprint(companyId: string, issueId: string, agentId: string, episodeId: string) {
  return `legacy_disposition:v1:${createHash("sha256").update(JSON.stringify([companyId, issueId, agentId, episodeId])).digest("hex")}`;
}
export function decideLegacyContinuation(input: LegacyContinuationInput):
  | { kind: "skip"; reason: string }
  | { kind: "exhausted"; attempt: number; maxAttempts: number }
  | { kind: "enqueue"; nextAttempt: number; idempotencyKey: string; instruction: string } {
  const { run, issue, agent, gates, episode } = input;
  if (run.runtimeMode === "native") return { kind: "skip", reason: "native_finalization" };
  if (run.status !== "succeeded") return { kind: "skip", reason: "run_not_successful" };
  if (!issue || !agent || issue.companyId !== run.companyId || agent.companyId !== run.companyId || agent.id !== run.agentId) return { kind: "skip", reason: "invalid_binding" };
  if (issue.assigneeAgentId !== run.agentId || issue.assigneeUserId) return { kind: "skip", reason: "owner_changed" };
  if (!["todo", "in_progress", "blocked"].includes(issue.status)) return { kind: "skip", reason: "recorded_disposition" };
  const descriptor = record(issue.unblockDescriptor);
  const unblockOwner = descriptor.owner;
  const humanOwnedWait = unblockOwner === "board" || typeof record(unblockOwner).userId === "string";
  if (issue.status === "blocked" && humanOwnedWait) return { kind: "skip", reason: "human_owned_wait" };
  const unblockOwnerAgentId = record(unblockOwner).agentId;
  if (issue.status === "blocked" && (typeof unblockOwnerAgentId !== "string" || unblockOwnerAgentId.trim() !== run.agentId)) {
    return { kind: "skip", reason: "recorded_disposition" };
  }
  for (const [blocked, reason] of [
    [gates.stopped, "stopped"], [gates.paused, "paused"],
    [gates.budgetBlocked, "budget_blocked"], [gates.pendingWait, "durable_wait"],
    [gates.activeExecution, "existing_execution"], [gates.ownedLifecycle, "owned_lifecycle"],
    [gates.conversation, "conversation"],
    [!gates.agentInvokable || ["paused", "terminated", "pending_approval"].includes(agent.status), "agent_not_invokable"],
  ] as const) if (blocked) return { kind: "skip", reason };
  // A blocked status records that work stopped; it is not itself a future
  // trigger. The caller still respects actual waits above, and any repair here
  // remains bounded by the episode counter below.
  if (episode.attempt >= episode.maxAttempts) return { kind: "exhausted", attempt: episode.attempt, maxAttempts: episode.maxAttempts };
  const nextAttempt = episode.attempt + 1;
  return {
    kind: "enqueue", nextAttempt,
    idempotencyKey: `issue_disposition_repair:${issue.id}:${legacyDispositionFingerprint(run.companyId, issue.id, run.agentId, episode.id)}:${nextAttempt}`,
    instruction: LEGACY_DISPOSITION_REPAIR_INSTRUCTION,
  };
}
