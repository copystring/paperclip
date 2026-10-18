import { forbidden } from "./errors.js";

const LEGACY_ISSUE_OWNERSHIP_REVOCATION = "legacyIssueOwnershipRevocation";

export function revokeLegacyRunIssueOwnership(
  contextSnapshot: Record<string, unknown> | null | undefined,
  input: { issueId: string; ownerAgentId: string },
) {
  return {
    ...(contextSnapshot ?? {}),
    [LEGACY_ISSUE_OWNERSHIP_REVOCATION]: {
      issueId: input.issueId,
      ownerAgentId: input.ownerAgentId,
    },
  };
}

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
  const revocation = run.contextSnapshot[LEGACY_ISSUE_OWNERSHIP_REVOCATION];
  if (
    !revocation ||
    typeof revocation !== "object" ||
    Array.isArray(revocation) ||
    (revocation as Record<string, unknown>).issueId !== issue.id ||
    (revocation as Record<string, unknown>).ownerAgentId !== run.agentId
  ) return;
  throw forbidden(
    issue.assigneeUserId
      ? "This task is assigned to a human; the outgoing run can no longer change it"
      : "This task has been handed to another owner; the outgoing run can no longer change it",
    { code: "issue_handed_off", issueId: issue.id },
  );
}
