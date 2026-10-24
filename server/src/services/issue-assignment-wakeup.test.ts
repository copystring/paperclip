import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";

describe("assignment execution identity", () => {
  it.each([undefined, null, "resolved-user"])("preserves the server-resolved owner %s", async (responsibleUserId) => {
    const wakeup = vi.fn().mockResolvedValue(null);
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue", assigneeAgentId: "agent", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "test",
      responsibleUserId,
    });
    const context = wakeup.mock.calls[0][1].contextSnapshot;
    expect(context).toEqual({
      issueId: "issue",
      source: "test",
      ...(responsibleUserId ? { responsibleUserId } : {}),
    });
  });
});
