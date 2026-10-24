import { describe, expect, it, vi } from "vitest";
import { assertLegacyRunTaskOwnership } from "./legacy-run-task-ownership.js";

describe("legacy run task ownership", () => {
  const run = { id: "run-1", companyId: "company-1", runtimeMode: "legacy", agentId: "implementer" };
  const issue = { id: "issue-1", companyId: "company-1", assigneeAgentId: "implementer", assigneeUserId: null };

  function dbWithEvent(event: unknown = null) {
    const limit = vi.fn().mockResolvedValue(event ? [event] : []);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    return { db: { select } as never, select, from, where, limit };
  }

  it.each([
    ["current owner", run, issue],
    ["peer reviewer", { ...run, agentId: "reviewer" }, { ...issue, assigneeAgentId: "reviewer" }],
    ["unassigned issue", run, { ...issue, assigneeAgentId: null }],
  ])("allows a %s when no revocation event exists", async (_description, candidate, targetIssue) => {
    const query = dbWithEvent();
    await expect(assertLegacyRunTaskOwnership(query.db, candidate, targetIssue)).resolves.toBeUndefined();
    expect(query.select).toHaveBeenCalledOnce();
  });

  it("blocks when the run's revocation query finds handoff evidence", async () => {
    const query = dbWithEvent({ id: 42 });
    await expect(assertLegacyRunTaskOwnership(query.db, run, issue)).rejects.toMatchObject({
      status: 403,
      details: { code: "issue_handed_off", issueId: issue.id },
    });
  });

  it("does not check native, foreign-company, or unbound runs", async () => {
    for (const candidate of [
      { ...run, runtimeMode: "native" },
      { ...run, companyId: "company-2" },
      { ...run, agentId: null },
    ]) {
      const query = dbWithEvent({ id: 42 });
      await expect(assertLegacyRunTaskOwnership(query.db, candidate, issue)).resolves.toBeUndefined();
      expect(query.select).not.toHaveBeenCalled();
    }
  });
});
