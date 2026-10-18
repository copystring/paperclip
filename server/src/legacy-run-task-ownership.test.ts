import { describe, expect, it, vi } from "vitest";
import { assertLegacyRunTaskOwnership, LEGACY_ISSUE_OWNERSHIP_REVOKED_EVENT } from "./legacy-run-task-ownership.js";

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

  it("allows a run with no revocation event", async () => {
    const query = dbWithEvent();
    await expect(assertLegacyRunTaskOwnership(query.db, run, issue)).resolves.toBeUndefined();
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

  it("records a stable event contract for the append-only revocation evidence", () => {
    expect(LEGACY_ISSUE_OWNERSHIP_REVOKED_EVENT).toBe("issue.legacy_run_ownership_revoked");
  });
});
