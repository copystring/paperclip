import { parseIssueExecutionState } from "./issue-execution-policy.js";

// A fixed server-owned prefix also lets comment deduplication find the same
// report after its review state changes. Never infer approval from model prose.
export const UNREVIEWED_AGENT_REPORT_PREFIX =
  "> **Paperclip: Independent review/approval was not complete when this report was posted.** " +
  "The following is an agent report, not an independent acceptance decision.\n\n";

export function withIssueCommentReviewContext(
  body: string,
  agentId: string | undefined,
  executionState: unknown,
): string {
  if (!agentId) return body;
  const state = parseIssueExecutionState(executionState);
  if (!state || !["pending", "changes_requested"].includes(state.status)
    || !["review", "approval"].includes(state.currentStageType ?? "")) return body;
  const participant = state.currentParticipant;
  if (participant?.type === "agent" && participant.agentId === agentId) return body;
  return UNREVIEWED_AGENT_REPORT_PREFIX + body;
}
