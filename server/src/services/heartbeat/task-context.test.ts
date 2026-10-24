import { describe, expect, it } from "vitest";
import { refreshCurrentExecutionStageContext } from "./task-context.js";

const issueId = "10000000-0000-4000-8000-000000000001";
const stageId = "20000000-0000-4000-8000-000000000002";
const reviewerId = "30000000-0000-4000-8000-000000000003";
const executorId = "40000000-0000-4000-8000-000000000004";

function issueContext(input: {
  status: string;
  executionState: Record<string, unknown>;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
}) {
  return {
    id: issueId,
    status: input.status,
    executionState: input.executionState,
    assigneeAgentId: input.assigneeAgentId === undefined ? reviewerId : input.assigneeAgentId,
    assigneeUserId: input.assigneeUserId ?? null,
  } as unknown as Parameters<typeof refreshCurrentExecutionStageContext>[0]["issueContext"];
}

function state(input: {
  status?: "pending" | "changes_requested";
  currentStageType?: "review" | "approval";
  currentParticipantId?: string;
  returnAssigneeId?: string;
}) {
  return {
    status: input.status ?? "pending",
    currentStageId: stageId,
    currentStageIndex: 0,
    currentStageType: input.currentStageType ?? "review",
    currentParticipant: {
      type: "agent",
      agentId: input.currentParticipantId ?? reviewerId,
      userId: null,
    },
    returnAssignee: {
      type: "agent",
      agentId: input.returnAssigneeId ?? executorId,
      userId: null,
    },
    reviewRequest: { instructions: "Review the submitted work." },
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: null,
    changesRequestedCount: 0,
  };
}

describe("refreshCurrentExecutionStageContext", () => {
  it.each([
    "issue_assigned",
    "transient_failure_retry",
    "issue_monitor_due",
  ])("rebuilds the same authorized review context for %s", (wakeReason) => {
    const context: Record<string, unknown> = { wakeReason };
    refreshCurrentExecutionStageContext({
      context,
      issueId,
      issueContext: issueContext({ status: "in_review", executionState: state({}) }),
      agentId: reviewerId,
    });

    expect(context.executionStage).toMatchObject({
      wakeRole: "reviewer",
      stageId,
      stageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerId },
      allowedActions: ["approve", "request_changes"],
    });
  });

  it("rebuilds the approver role from the current pending approval stage", () => {
    const context: Record<string, unknown> = {};
    refreshCurrentExecutionStageContext({
      context,
      issueId,
      issueContext: issueContext({
        status: "in_review",
        executionState: state({ currentStageType: "approval" }),
      }),
      agentId: reviewerId,
    });

    expect(context.executionStage).toMatchObject({ wakeRole: "approver", stageType: "approval" });
  });

  it("returns executor context for the current assignee after changes were requested", () => {
    const context: Record<string, unknown> = {};
    refreshCurrentExecutionStageContext({
      context,
      issueId,
      issueContext: issueContext({
        status: "in_progress",
        executionState: state({ status: "changes_requested" }),
        assigneeAgentId: executorId,
      }),
      agentId: executorId,
    });

    expect(context.executionStage).toMatchObject({
      wakeRole: "executor",
      stageId,
      returnAssignee: { type: "agent", agentId: executorId },
      allowedActions: ["address_changes", "resubmit"],
    });
  });

  it.each([
    {
      name: "a different review participant",
      status: "in_review",
      state: state({ currentParticipantId: executorId }),
      agentId: reviewerId,
      issueMatch: true,
    },
    {
      name: "stale pending state after the issue left review",
      status: "done",
      state: state({}),
      agentId: reviewerId,
      issueMatch: true,
    },
    {
      name: "a stale issue context for another issue",
      status: "in_review",
      state: state({}),
      agentId: reviewerId,
      issueMatch: false,
    },
  ])("clears old stage instructions for $name", ({ status, state: executionState, agentId, issueMatch }) => {
    const context: Record<string, unknown> = {
      executionStage: { wakeRole: "reviewer", stageId, allowedActions: ["approve", "request_changes"] },
    };
    refreshCurrentExecutionStageContext({
      context,
      issueId: issueMatch ? issueId : "50000000-0000-4000-8000-000000000005",
      issueContext: issueContext({ status, executionState }),
      agentId,
    });

    expect(context).not.toHaveProperty("executionStage");
  });

  it.each([
    { name: "unassigned issue", assigneeAgentId: null, assigneeUserId: null },
    { name: "human co-assignee", assigneeAgentId: reviewerId, assigneeUserId: "user-1" },
    { name: "foreign assignee", assigneeAgentId: executorId, assigneeUserId: null },
  ])("clears stage for $name", ({ assigneeAgentId, assigneeUserId }) => {
    const context: Record<string, unknown> = { executionStage: { stageId, wakeRole: "reviewer" } };
    refreshCurrentExecutionStageContext({
      context,
      issueId,
      issueContext: issueContext({ status: "in_review", executionState: state({}), assigneeAgentId, assigneeUserId }),
      agentId: reviewerId,
    });
    expect(context).not.toHaveProperty("executionStage");
  });

  it("does not rebind a retained recovery run when the current stage changed", () => {
    const context: Record<string, unknown> = { executionStage: {
      stageId, wakeRole: "reviewer", currentParticipant: { type: "agent", agentId: reviewerId },
      recoveryInstruction: "Resume the saved stage.",
    } };
    const nextStage = { ...state({}), currentStageId: "50000000-0000-4000-8000-000000000005" };
    refreshCurrentExecutionStageContext({
      context, issueId, issueContext: issueContext({ status: "in_review", executionState: nextStage }),
      agentId: reviewerId, recovering: true,
    });
    expect(context).not.toHaveProperty("executionStage");
  });

  it.each([
    { name: "missing saved stage", saved: undefined },
    { name: "participant mismatch", saved: { stageId, wakeRole: "reviewer", currentParticipant: { type: "agent", agentId: executorId } } },
    { name: "role mismatch", saved: { stageId, wakeRole: "approver", currentParticipant: { type: "agent", agentId: reviewerId } } },
  ])("does not synthesize retained recovery context for $name", ({ saved }) => {
    const context: Record<string, unknown> = {};
    if (saved) context.executionStage = saved;
    refreshCurrentExecutionStageContext({
      context, issueId, issueContext: issueContext({ status: "in_review", executionState: state({}) }),
      agentId: reviewerId, recovering: true,
    });
    expect(context).not.toHaveProperty("executionStage");
  });

  it("preserves a recovery reminder only while the same current stage and role remain valid", () => {
    const context: Record<string, unknown> = {
      executionStage: {
        wakeRole: "reviewer",
        stageId,
        currentParticipant: { type: "agent", agentId: reviewerId },
        recoveryInstruction: "Record the pending decision through the issue route.",
      },
    };
    refreshCurrentExecutionStageContext({
      context,
      issueId,
      issueContext: issueContext({ status: "in_review", executionState: state({}) }),
      agentId: reviewerId,
    });

    expect(context.executionStage).toMatchObject({
      wakeRole: "reviewer",
      recoveryInstruction: "Record the pending decision through the issue route.",
    });
  });
});
