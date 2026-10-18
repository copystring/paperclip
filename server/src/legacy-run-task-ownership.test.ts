import { describe, expect, it } from "vitest";
import {
  assertLegacyRunTaskOwnership,
  revokeLegacyRunIssueOwnership,
} from "./legacy-run-task-ownership.js";

describe("legacy run task ownership", () => {
  const run = {
    companyId: "company-1",
    runtimeMode: "legacy",
    agentId: "implementer",
    contextSnapshot: { issueId: "issue-1" },
  };

  it("allows the current owner to finish its own issue update", () => {
    expect(() => assertLegacyRunTaskOwnership(run, {
      id: "issue-1", companyId: "company-1", assigneeAgentId: "implementer", assigneeUserId: null,
    })).not.toThrow();
  });

  it("does not infer handoff from assignment mismatch without durable revocation evidence", () => {
    expect(() => assertLegacyRunTaskOwnership(run, {
      id: "issue-1", companyId: "company-1", assigneeAgentId: "reviewer", assigneeUserId: null,
    })).not.toThrow();
  });

  it("keeps a specifically revoked run blocked even after the original owner is reassigned", () => {
    const revokedRun = {
      ...run,
      contextSnapshot: revokeLegacyRunIssueOwnership(run.contextSnapshot, {
        issueId: "issue-1",
        ownerAgentId: "implementer",
      }),
    };
    expect(revokedRun.contextSnapshot).toMatchObject({ issueId: "issue-1" });
    expect(() => assertLegacyRunTaskOwnership(revokedRun, {
      id: "issue-1", companyId: "company-1", assigneeAgentId: "implementer", assigneeUserId: null,
    })).toThrowError("This task has been handed to another owner");
  });

  it("does not apply a revocation marker to a different issue or run owner", () => {
    const revokedRun = {
      ...run,
      contextSnapshot: revokeLegacyRunIssueOwnership(run.contextSnapshot, {
        issueId: "issue-1",
        ownerAgentId: "implementer",
      }),
    };
    expect(() => assertLegacyRunTaskOwnership(revokedRun, {
      id: "issue-2", companyId: "company-1", assigneeAgentId: "reviewer", assigneeUserId: null,
    })).not.toThrow();
    expect(() => assertLegacyRunTaskOwnership({
      ...revokedRun,
      agentId: "reviewer",
    }, {
      id: "issue-1", companyId: "company-1", assigneeAgentId: "reviewer", assigneeUserId: null,
    })).not.toThrow();
  });

  it("keeps human handoffs denied and unrelated issues outside this ownership check", () => {
    const revokedRun = {
      ...run,
      contextSnapshot: revokeLegacyRunIssueOwnership(run.contextSnapshot, {
        issueId: "issue-1",
        ownerAgentId: "implementer",
      }),
    };
    expect(() => assertLegacyRunTaskOwnership(revokedRun, {
      id: "issue-1", companyId: "company-1", assigneeAgentId: null, assigneeUserId: "user-1",
    })).toThrow();
    expect(() => assertLegacyRunTaskOwnership(revokedRun, {
      id: "issue-2", companyId: "company-1", assigneeAgentId: "reviewer", assigneeUserId: null,
    })).not.toThrow();
  });

  it("does not infer legacy run ownership for native runs", () => {
    expect(() => assertLegacyRunTaskOwnership({ ...run, runtimeMode: "native" }, {
      id: "issue-1", companyId: "company-1", assigneeAgentId: "reviewer", assigneeUserId: null,
    })).not.toThrow();
  });
});
