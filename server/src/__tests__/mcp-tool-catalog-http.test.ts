import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";
import { ToolGatewayHttpError, type ToolGatewayService } from "../services/tool-gateway.js";
import { validateCatalogToolArguments } from "../services/mcp-tool-catalog.js";

function fixture() {
  let visible = [{ name: "app:action", displayName: "Action", description: "Approval required.",
    applicationDisplayName: "Example app", risk: "write",
    parametersSchema: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "string" } } } }];
  const authorize = (input: { bearerToken?: string; sessionToken?: string }) => {
    if ((input.bearerToken ?? input.sessionToken) !== "valid") throw new ToolGatewayHttpError(401, "Invalid token", "token_invalid");
  };
  const provider = vi.fn(async () => ({ status: "completed", result: { data: { ok: true } } }));
  const gateway = {
    initializeNamedGatewayProtocol: vi.fn(async (input) => { authorize(input); return {}; }),
    listToolsForNamedGateway: vi.fn(async (input) => { authorize(input); return structuredClone(visible); }),
    executeTool: vi.fn(async (input) => {
      authorize(input);
      const tool = visible.find(tool => tool.name === input.tool);
      if (!tool) throw new ToolGatewayHttpError(404, "Unknown tool", "tool_unknown");
      if (input.validateParametersSchema) validateCatalogToolArguments(tool, input.parameters);
      return provider();
    }),
    executeContextForNamedGateway: vi.fn(async (input) => { authorize(input); return { resources: [] }; }),
  };
  const app = express().use(express.json()).use(mcpGatewayProtocolRoutes(gateway as unknown as ToolGatewayService));
  const post = (method: string, params?: unknown, mode = "?catalog=on-demand", token = "valid") => request(app)
    .post(`/mcp/gateways/fixture${mode}`).set("Authorization", `Bearer ${token}`).set("X-Catalog-Test", "caller")
    .send({ jsonrpc: "2.0", id: 7, method, params });
  return { gateway, provider, post, revoke: () => { visible = []; } };
}

describe("on-demand named gateway catalog over HTTP", () => {
  it("keeps the direct catalog compatible and only projects the opted-in catalog", async () => {
    const { post, gateway } = fixture();
    const direct = await post("tools/list", undefined, "").expect(200);
    expect(direct.body.result.tools[0]).toEqual({ name: "app:action", title: "Action", description: "Approval required.",
      inputSchema: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "string" } } } });
    const compact = await post("tools/list").expect(200);
    expect(compact.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "paperclip_search_tools", "paperclip_call_tool", "paperclip_list_resources", "paperclip_read_resource", "paperclip_list_prompts", "paperclip_get_prompt",
    ]);
    expect(JSON.stringify(compact.body)).not.toContain("app:action");
    expect(compact.body.result.tools[0].description).toContain("Example app: Action");
    expect(compact.body.result.tools[0].description).not.toContain("Approval required.");
    expect(gateway.listToolsForNamedGateway).toHaveBeenCalledTimes(2);
    expect((await post("tools/list", undefined, "?catalog=other")).body).toEqual(direct.body);
  });

  it("reauthorizes search and call and preserves the exact existing invocation inputs", async () => {
    const { post, gateway, provider, revoke } = fixture();
    const search = await post("tools/call", { name: "paperclip_search_tools", arguments: { query: "Example" } }).expect(200);
    const result = JSON.parse(search.body.result.content[0].text);
    expect(result.tools[0]).toMatchObject({ name: "app:action", description: "Approval required.", risk: "write" });
    await post("tools/call", { name: "paperclip_call_tool", arguments: { name: result.tools[0].name, arguments: { value: "äÖ😀" } } }).expect(200);
    expect(gateway.executeTool).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionToken: "valid", gatewayPublicId: "fixture", tool: "app:action", parameters: { value: "äÖ😀" },
      validateParametersSchema: true,
      callerHeaders: expect.objectContaining({ "x-catalog-test": "caller" }),
    }));
    revoke();
    const after = await post("tools/call", { name: "paperclip_search_tools", arguments: { query: "Example" } }).expect(200);
    expect(JSON.parse(after.body.result.content[0].text).tools).toEqual([]);
    await post("tools/call", { name: "paperclip_call_tool", arguments: { name: "app:action", arguments: { value: "x" } } }).expect(404);
    expect(gateway.listToolsForNamedGateway).toHaveBeenCalledTimes(2);
    expect(gateway.listToolsForNamedGateway).toHaveBeenLastCalledWith(expect.objectContaining({ requireToolCallAction: true }));
    expect(gateway.executeTool).toHaveBeenCalledTimes(2);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "paperclip_search_tools", arguments: { query: "", offset: -1 } },
    { name: "paperclip_call_tool", arguments: { name: "app:action", arguments: { value: 42 } } },
    { name: "paperclip_call_tool", arguments: { name: "app:action", arguments: { value: "x", extra: true } } },
    { name: "paperclip_call_tool", arguments: { name: "app:action", arguments: [] } },
  ])("rejects invalid wrapper/target arguments before dispatch: %j", async (params) => {
    const { post, provider } = fixture();
    const result = await post("tools/call", params).expect(400);
    expect(result.body.error.code).toBe(-32602);
    expect(provider).not.toHaveBeenCalled();
  });

  it("does not accept guessed direct names in on-demand mode, and keeps legacy direct calls", async () => {
    const { post, gateway } = fixture();
    await post("tools/call", { name: "app:action", arguments: { value: "x" } }).expect(404);
    expect(gateway.executeTool).not.toHaveBeenCalled();
    await post("tools/call", { name: "app:action", arguments: { value: "x" } }, "").expect(200);
    expect(gateway.executeTool).toHaveBeenCalledTimes(1);
  });

  it("preserves authentication, initialization, context permissions and gateway failures", async () => {
    const { post, gateway } = fixture();
    await post("initialize").expect(200);
    await post("initialize", undefined, "?catalog=on-demand", "invalid").expect(401);
    await post("tools/list", undefined, "?catalog=on-demand", "invalid").expect(401);
    await post("tools/call", { name: "paperclip_search_tools", arguments: { query: "" } }, "?catalog=on-demand", "invalid").expect(401);
    await post("tools/call", { name: "paperclip_list_resources", arguments: {} }).expect(200);
    gateway.executeTool.mockRejectedValueOnce(new ToolGatewayHttpError(403, "Approval required", "approval_required"));
    const denied = await post("tools/call", { name: "paperclip_call_tool", arguments: { name: "app:action", arguments: { value: "x" } } }).expect(403);
    expect(denied.body.error.data.reasonCode).toBe("approval_required");
    gateway.executeTool.mockRejectedValueOnce(new ToolGatewayHttpError(502, "Provider failed", "tool_error"));
    const failed = await post("tools/call", { name: "paperclip_call_tool", arguments: { name: "app:action", arguments: { value: "x" } } }).expect(200);
    expect(failed.body.result.isError).toBe(true);
  });
});
