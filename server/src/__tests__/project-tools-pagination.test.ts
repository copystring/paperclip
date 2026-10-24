import { afterEach, describe, expect, it, vi } from "vitest";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";

const input = {
  name: "list_projects", arguments: {}, apiUrl: "http://paperclip.test", token: "test-token",
  companyId: "company", issueId: "issue", agentId: "agent", conversation: false,
};

afterEach(() => vi.unstubAllGlobals());

describe("project discovery result bounds", () => {
  it.each(["standard", "ask", "planning"])("lists serializable input schemas in %s mode", mode => {
    const definitions = projectToolDefinitions(mode, true);
    expect(definitions.length).toBeGreaterThan(0);
    for (const tool of definitions) {
      expect(JSON.parse(JSON.stringify(tool.inputSchema))).toMatchObject({ type: "object" });
    }
    const create = definitions.find(tool => tool.name === "create_project");
    if (mode !== "standard") {
      expect(create).toBeUndefined();
      return;
    }
    expect(create?.inputSchema).toMatchObject({
      required: ["idempotencyKey", "name"],
      properties: { executionWorkspacePolicy: expect.any(Object), workspace: expect.any(Object) },
    });
  });

  it("validates project creation with the same input contract advertised to MCP", async () => {
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => ({ id: "project" }) }));
    vi.stubGlobal("fetch", fetch);
    await callProjectTool({ ...input, name: "create_project", arguments: {
      name: "Project", idempotencyKey: "  create-project  ",
      executionWorkspacePolicy: { enabled: true, runtimePolicy: { custom: "retained" } },
    } });
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toMatchObject({
      idempotencyKey: "create-project", status: "backlog",
      executionWorkspacePolicy: { runtimePolicy: { custom: "retained" } },
    });
    fetch.mockClear();
    await expect(callProjectTool({ ...input, name: "create_project", arguments: { name: "Project", idempotencyKey: " " } }))
      .rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requests bounded summaries and normalizes continuation cursors", async () => {
    const page = { projects: [{ id: "abcdefab-0000-4000-8000-000000000001", name: "Project", status: "in_progress", description: "Summary", descriptionTruncated: true }], nextCursor: "abcdefab-0000-4000-8000-000000000001" };
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => page }));
    vi.stubGlobal("fetch", fetch);
    expect(await callProjectTool(input)).toEqual(page);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://paperclip.test/api/companies/company/projects?view=summary&limit=50");
    await callProjectTool({ ...input, arguments: { limit: 3, cursor: page.nextCursor.toUpperCase() } });
    expect(fetch.mock.calls[1]?.[0]).toBe(`http://paperclip.test/api/companies/company/projects?view=summary&limit=3&cursor=${page.nextCursor}`);
    expect(projectToolDefinitions("standard").find(t => t.name === "list_projects")?.inputSchema)
      .toMatchObject({ properties: { cursor: expect.any(Object), limit: expect.any(Object) } });
  });

  it.each([{ limit: 0 }, { limit: 51 }, { cursor: "invalid" }])("rejects invalid paging arguments %j before fetching", async (arguments_) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(callProjectTool({ ...input, arguments: arguments_ })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
