import { describe, expect, it } from "vitest";
import { isCurrentRunWorkHandback, shouldWakeAssigneeForIssueComment } from "../issue-comment-wakeup.js";
import { LEGACY_DISPOSITION_REPAIR_INSTRUCTION, OWNER_DISPOSITION_REPAIR_NEXT_ACTION } from "./legacy-continuation.js";

function publishedPatch(instruction: string) {
  const json = instruction.match(/\{"status":"todo","comment":"[^"\n]+","resume":true\}/)?.[0];
  expect(json, "The published repair contract must contain the complete executable continuation PATCH").toBeDefined();
  return JSON.parse(json!) as { status: string; comment: string; resume?: boolean };
}

describe("published disposition repair continuation", () => {
  it.each([LEGACY_DISPOSITION_REPAIR_INSTRUCTION, OWNER_DISPOSITION_REPAIR_NEXT_ACTION])("requests a real successor through the existing current-run handback contract", (instruction) => {
    const patch = publishedPatch(instruction);
    const input = {
      selfComment: true,
      resumeRequested: patch.resume === true,
      commentCreatedByRunId: "current-repair-run",
      issueAtCommentStart: { status: "in_progress", checkoutRunId: "current-repair-run" },
      reopened: false,
      currentStatus: patch.status,
    };
    expect(isCurrentRunWorkHandback(input)).toBe(true);
    expect(shouldWakeAssigneeForIssueComment(input)).toBe(true);
    expect(instruction).toContain("X-Paperclip-Run-Id");
    expect(isCurrentRunWorkHandback({ ...input, resumeRequested: false })).toBe(false);
    expect(shouldWakeAssigneeForIssueComment({ ...input, resumeRequested: false })).toBe(false);
    expect(isCurrentRunWorkHandback({ ...input, commentCreatedByRunId: "previous-source-run" })).toBe(false);
    expect(isCurrentRunWorkHandback({ ...input, currentStatus: "in_progress" })).toBe(false);
  });
  it.each(["todo", "blocked"])("requires a real checkout before a handback from %s", (status) => {
    for (const instruction of [LEGACY_DISPOSITION_REPAIR_INSTRUCTION, OWNER_DISPOSITION_REPAIR_NEXT_ACTION]) {
      const patch = publishedPatch(instruction);
      expect(instruction).toContain("otherwise acquire the normal checkout");
      expect(instruction).toContain("Respect a refused checkout, real blockers and ownership conflicts");
      expect(instruction).toContain("never fake in_progress with a status PATCH");
      const input = { selfComment: true, resumeRequested: patch.resume === true,
        commentCreatedByRunId: "current-repair-run", issueAtCommentStart: { status, checkoutRunId: "current-repair-run" },
        reopened: false, currentStatus: patch.status };
      expect(isCurrentRunWorkHandback(input)).toBe(false);
      expect(shouldWakeAssigneeForIssueComment(input)).toBe(false);
    }
  });
});
