import { describe, expect, it } from "vitest";
import { isCurrentRunWorkHandback, shouldWakeAssigneeForIssueComment } from "./issue-comment-wakeup.js";

describe("shouldWakeAssigneeForIssueComment", () => {
  it("preserves an explicit current-owner work handback to todo", () => {
    const input = { selfComment: true, resumeRequested: true, commentCreatedByRunId: "current",
      issueAtCommentStart: { status: "in_progress", executionRunId: "current" }, reopened: false, currentStatus: "todo" };
    expect(isCurrentRunWorkHandback(input)).toBe(true);
    expect(shouldWakeAssigneeForIssueComment(input)).toBe(true);
  });
  it.each(["no_resume", "already_todo", "still_running", "closed", "foreign_run"])("does not treat %s as an owned work handback", change => {
    const input = { selfComment: true, resumeRequested: change !== "no_resume", commentCreatedByRunId: change === "foreign_run" ? "other" : "current",
      issueAtCommentStart: { status: change === "already_todo" ? "todo" : "in_progress", executionRunId: "current" },
      reopened: false, currentStatus: change === "closed" ? "done" : change === "still_running" ? "in_progress" : "todo" };
    expect(isCurrentRunWorkHandback(input)).toBe(false);
  });
  it("suppresses explicit resume from the run that currently owns the issue", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-current",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("preserves explicit resume from a completed prior run", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(true);
  });

  it("keeps ordinary self-comments inert", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: false,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {},
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("does not wake a closed issue unless the comment reopened it", () => {
    const base = {
      selfComment: false,
      resumeRequested: false,
      issueAtCommentStart: {},
      currentStatus: "done",
    };
    expect(
      shouldWakeAssigneeForIssueComment({ ...base, reopened: false }),
    ).toBe(false);
    expect(shouldWakeAssigneeForIssueComment({ ...base, reopened: true })).toBe(
      true,
    );
  });
});
