import { describe, expect, it } from "vitest";
import { assertLegacyRunTaskOwnership } from "./legacy-run-task-ownership.js";

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

  it("revokes an outgoing run's issue-write authority after an agent handoff", () => {
    expect(() => assertLegacyRunTaskOwnership(run, {
      id: "issue-1", companyId: "company-1", assigneeAgentId: "reviewer", assigneeUserId: null,
    })).toThrowError("This task has been handed to another owner");
  });

  it("keeps human handoffs denied and unrelated issues outside this ownership check", () => {
    expect(() => assertLegacyRunTaskOwnership(run, {
      id: "issue-1", companyId: "company-1", assigneeAgentId: null, assigneeUserId: "user-1",
    })).toThrow();
    expect(() => assertLegacyRunTaskOwnership(run, {
      id: "issue-2", companyId: "company-1", assigneeAgentId: "reviewer", assigneeUserId: null,
    })).not.toThrow();
  });

  it("does not infer legacy run ownership for native runs", () => {
    expect(() => assertLegacyRunTaskOwnership({ ...run, runtimeMode: "native" }, {
      id: "issue-1", companyId: "company-1", assigneeAgentId: "reviewer", assigneeUserId: null,
    })).not.toThrow();
  });
});
