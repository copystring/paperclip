import { forbidden } from "./errors.js";

export function assertLegacyRunTaskOwnership(
  run: {
    companyId: string;
    runtimeMode: string;
    agentId?: string | null;
    contextSnapshot?: Record<string, unknown> | null;
  } | null | undefined,
  issue: {
    id: string;
    companyId: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  },
) {
  if (run?.runtimeMode !== "legacy" || run.companyId !== issue.companyId ||
      run.contextSnapshot?.issueId !== issue.id || !run.agentId) return;
  if (issue.assigneeAgentId !== run.agentId) {
    throw forbidden(
      issue.assigneeUserId
        ? "This task is assigned to a human; the outgoing run can no longer change it"
        : "This task has been handed to another owner; the outgoing run can no longer change it",
      { code: "issue_handed_off", issueId: issue.id },
    );
  }
}
