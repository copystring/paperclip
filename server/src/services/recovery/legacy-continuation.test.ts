import { describe, expect, it } from "vitest";
import { decideLegacyContinuation, legacyDispositionEpisode, type LegacyContinuationInput } from "./legacy-continuation.js";
const input: LegacyContinuationInput = {
  run: { id: "run", companyId: "company", agentId: "agent", status: "succeeded", runtimeMode: "legacy" },
  issue: { id: "issue", companyId: "company", status: "in_progress", assigneeAgentId: "agent" },
  agent: { id: "agent", companyId: "company", status: "idle" },
  episode: { id: "run", attempt: 0, maxAttempts: 2 },
  gates: { stopped: false, paused: false, budgetBlocked: false, pendingWait: false, activeExecution: false, ownedLifecycle: false, conversation: false, agentInvokable: true },
};
describe("legacy continuation authority", () => {
  it("requests agent repair for a successful process without a task disposition", () => {
    expect(decideLegacyContinuation(input)).toMatchObject({ kind: "enqueue", nextAttempt: 1 });
  });
  it.each(["done", "cancelled", "in_review"])("respects persisted %s disposition", status => {
    expect(decideLegacyContinuation({ ...input, issue: { ...input.issue!, status } }).kind).toBe("skip");
  });
  it("does not mistake a blocked self-owner note for a durable wait", () => {
    const blocked = { ...input, issue: {
      ...input.issue!,
      status: "blocked",
      unblockDescriptor: { owner: { agentId: input.run.agentId }, action: "Continue after the owner wake" },
    } };
    expect(decideLegacyContinuation(blocked)).toMatchObject({ kind: "enqueue", nextAttempt: 1 });
    expect(decideLegacyContinuation({ ...blocked, episode: { ...input.episode, attempt: 2 } }))
      .toMatchObject({ kind: "exhausted", attempt: 2, maxAttempts: 2 });
  });
  it.each([
    { owner: "board" },
    { owner: { userId: "human-owner" } },
  ])("preserves a blocked issue with human-owned unblock responsibility (%j)", descriptor => {
    expect(decideLegacyContinuation({
      ...input,
      issue: { ...input.issue!, status: "blocked", unblockDescriptor: { ...descriptor, action: "Review and unblock" } },
    }).kind).toBe("skip");
  });
  it.each([
    ["pendingWait", "durable_wait"],
    ["activeExecution", "existing_execution"],
    ["paused", "paused"],
    ["stopped", "stopped"],
    ["budgetBlocked", "budget_blocked"],
  ] as const)("keeps a blocked self-owner issue with real %s evidence out of automatic repair", (gate, reason) => {
    expect(decideLegacyContinuation({
      ...input,
      issue: {
        ...input.issue!,
        status: "blocked",
        unblockDescriptor: { owner: { agentId: input.run.agentId }, action: "Continue after the owner wake" },
      },
      gates: { ...input.gates, [gate]: true },
    })).toEqual({ kind: "skip", reason });
  });
  it.each([
    [null, "missing"],
    [undefined, "absent"],
    [{ owner: { agentId: "another-agent" }, action: "Continue" }, "foreign agent"],
  ] as const)("does not reinterpret a blocked issue without a self-owner descriptor (%s)", (descriptor, _label) => {
    const issue = { ...input.issue!, status: "blocked", unblockDescriptor: descriptor };
    expect(decideLegacyContinuation({ ...input, issue })).toEqual({ kind: "skip", reason: "recorded_disposition" });
  });
  it.each(["failed", "cancelled", "interrupted", "timed_out", "running"])("does not convert a %s process into repair", status => {
    expect(decideLegacyContinuation({ ...input, run: { ...input.run, status } }).kind).toBe("skip");
  });
  it.each(["stopped", "paused", "budgetBlocked", "pendingWait", "activeExecution", "ownedLifecycle", "conversation"] as const)("preserves %s", gate => {
    expect(decideLegacyContinuation({ ...input, gates: { ...input.gates, [gate]: true } }).kind).toBe("skip");
  });
  it.each(["paused", "terminated", "pending_approval"])("does not repair with a %s agent", status => {
    expect(decideLegacyContinuation({ ...input, agent: { ...input.agent!, status } }).kind).toBe("skip");
  });
  it("rejects foreign agent and reassigned issue", () => {
    expect(decideLegacyContinuation({ ...input, agent: { ...input.agent!, id: "other" } }).kind).toBe("skip");
    expect(decideLegacyContinuation({ ...input, issue: { ...input.issue!, assigneeAgentId: "other" } }).kind).toBe("skip");
    expect(decideLegacyContinuation({ ...input, issue: { ...input.issue!, status: "blocked", assigneeUserId: "human-owner" } }).kind).toBe("skip");
  });
  it("preserves the episode through two attempts and exhaustion", () => {
    const first = decideLegacyContinuation(input);
    const second = decideLegacyContinuation({ ...input, episode: { ...input.episode, attempt: 1 } });
    expect(second).toMatchObject({ kind: "enqueue", nextAttempt: 2 });
    expect(second).not.toEqual(first);
    expect(decideLegacyContinuation({ ...input, episode: { ...input.episode, attempt: 2 } }).kind).toBe("exhausted");
  });
  it("does not resurrect an exhausted pre-upgrade liveness or handoff budget", () => {
    for (const run of [
      { id: "old", continuationAttempt: 2 },
      { id: "old", contextSnapshot: { dispositionRepairAttempt: 3, dispositionRepairMaxAttempts: 5, dispositionRepairFingerprint: "old-episode" } },
      { id: "old", contextSnapshot: { wakeReason: "finish_successful_run_handoff", handoffAttempt: 1 } },
      { id: "old", contextSnapshot: { source: "issue.productive_terminal_continuation_recovery" } },
    ]) expect(decideLegacyContinuation({ ...input, episode: legacyDispositionEpisode(run) }).kind).toBe("exhausted");
  });
  it("keeps replay identity stable while a genuinely new episode gets its own identity", () => {
    expect(decideLegacyContinuation(structuredClone(input))).toEqual(decideLegacyContinuation(input));
    expect(decideLegacyContinuation({ ...input, episode: { ...input.episode, id: "new-authorized-run" } })).not.toEqual(decideLegacyContinuation(input));
  });
  it("leaves native finalization to its own authority", () => {
    expect(decideLegacyContinuation({ ...input, run: { ...input.run, runtimeMode: "native" } }).kind).toBe("skip");
  });
});
