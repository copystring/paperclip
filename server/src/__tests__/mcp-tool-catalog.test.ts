import { describe, expect, it } from "vitest";
import {
  McpToolCatalogError,
  MCP_TOOL_CATALOG_DEFINITIONS,
  createMcpToolCatalogDefinitions,
  PAPERCLIP_CALL_TOOL_DEFINITION,
  PAPERCLIP_SEARCH_TOOLS_DEFINITION,
  parseMcpToolCall,
  parsePaperclipCallToolInput,
  parsePaperclipSearchToolsInput,
  searchPaperclipTools,
  searchMcpToolCatalog,
  validateCatalogToolArguments,
  type McpToolCatalogDescriptor,
  type McpToolSearchPage,
} from "../services/mcp-tool-catalog.js";

function descriptor(name: string, extra: Partial<McpToolCatalogDescriptor> = {}): McpToolCatalogDescriptor {
  return {
    name,
    displayName: name,
    description: `Description for ${name}`,
    parametersSchema: { type: "object", properties: {}, additionalProperties: false },
    ...extra,
  };
}

function isSearchPage(result: ReturnType<typeof searchPaperclipTools>): result is McpToolSearchPage {
  return "tools" in result;
}

describe("MCP tool catalog utility", () => {
  it("exports the two compact generic tool definitions", () => {
    expect(PAPERCLIP_SEARCH_TOOLS_DEFINITION.name).toBe("paperclip_search_tools");
    expect(PAPERCLIP_CALL_TOOL_DEFINITION.name).toBe("paperclip_call_tool");
    expect(PAPERCLIP_SEARCH_TOOLS_DEFINITION.inputSchema.additionalProperties).toBe(false);
    expect(PAPERCLIP_CALL_TOOL_DEFINITION.inputSchema.additionalProperties).toBe(false);
    expect(MCP_TOOL_CATALOG_DEFINITIONS.map(definition => definition.name)).toEqual([
      "paperclip_search_tools",
      "paperclip_call_tool",
    ]);
  });

  it("adds a complete UTF-8 app/action index while keeping exactly two generic wrappers", () => {
    const tools = [
      descriptor("gateway:search", {
        applicationKey: "mcp-proxy",
        applicationDisplayName: "MCP Proxy 🌲",
        upstreamToolName: "PowerShell Search",
        parametersSchema: { type: "object", properties: { secret: { type: "string" } } },
      }),
      descriptor("gateway:run", {
        applicationKey: "mcp-proxy",
        applicationDisplayName: "MCP Proxy 🌲",
        displayName: "Run command",
      }),
    ];
    const before = JSON.stringify(tools);
    const definitions = createMcpToolCatalogDefinitions(tools);
    expect(definitions.map(definition => definition.name)).toEqual(["paperclip_search_tools", "paperclip_call_tool"]);
    expect(definitions[0].description).toContain("MCP Proxy 🌲: PowerShell Search, Run command");
    expect(definitions[0].description).toContain("find and use that app's discovery action first");
    expect(definitions[0].inputSchema).toEqual(PAPERCLIP_SEARCH_TOOLS_DEFINITION.inputSchema);
    expect(definitions[1]).toEqual(PAPERCLIP_CALL_TOOL_DEFINITION);
    expect(JSON.stringify(tools)).toBe(before);
    expect(definitions[0].description).not.toContain('"secret"');
  });

  it("uses whole app counts instead of partial action names when the index exceeds its UTF-8 budget", () => {
    const tools = Array.from({ length: 5_000 }, (_, index) => descriptor(`gateway:${index}`, {
      applicationKey: "large-app",
      applicationDisplayName: "Großer MCP Proxy 🌲",
      upstreamToolName: `Upstream action ${index}`,
    }));
    const before = JSON.stringify(tools.map(tool => [tool.name, tool.upstreamToolName]));
    const description = createMcpToolCatalogDefinitions(tools)[0].description;
    const index = description.split("Current app index:\n")[1];
    expect(index).toBe("App counts only; search for the desired action.\nGroßer MCP Proxy 🌲 (5000)");
    expect(Buffer.byteLength(index, "utf8")).toBeLessThanOrEqual(12 * 1024);
    expect(index).not.toContain("Upstream action");
    expect(JSON.stringify(tools.map(tool => [tool.name, tool.upstreamToolName]))).toBe(before);
  });

  it("falls back to a browse hint when even complete app counts exceed the index budget", () => {
    const tools = Array.from({ length: 1_000 }, (_, index) => descriptor(`tool-${index}`, {
      applicationKey: `application-${index}-${"x".repeat(20)}`,
      applicationDisplayName: `Application ${index}-${"🌲".repeat(10)}`,
    }));
    const description = createMcpToolCatalogDefinitions(tools)[0].description;
    const index = description.split("Current app index:\n")[1];
    expect(index).toBe("The app index is too large to include. Search or browse the current catalog by app or tool name.");
    expect(Buffer.byteLength(index, "utf8")).toBeLessThanOrEqual(12 * 1024);
  });

  it("paginates every result without mutation and preserves tool metadata and schemas", () => {
    const tools = [
      descriptor("tool-d", { risk: "write", approvalDescription: "Approval detail d" }),
      descriptor("tool-b", { applicationKey: "filesystem", applicationDisplayName: "File system", risk: "destructive" }),
      descriptor("tool-e"),
      descriptor("tool-a"),
      descriptor("tool-c"),
    ];
    const before = JSON.stringify(tools);
    const names: string[] = [];
    let offset = 0;
    while (true) {
      const page = searchPaperclipTools(tools, parsePaperclipSearchToolsInput({ offset, limit: 2 }));
      expect(isSearchPage(page)).toBe(true);
      if (!isSearchPage(page)) throw new Error("Expected a search page");
      names.push(...page.tools.map(tool => tool.name));
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }

    expect(names).toEqual(["tool-a", "tool-b", "tool-c", "tool-d", "tool-e"]);
    expect(names).toHaveLength(new Set(names).size);
    const fileSystemMatch = searchPaperclipTools(tools, parsePaperclipSearchToolsInput({ query: "file system" }));
    expect(isSearchPage(fileSystemMatch)).toBe(true);
    if (!isSearchPage(fileSystemMatch)) throw new Error("Expected a search page");
    expect(fileSystemMatch.tools[0]).toMatchObject({
      name: "tool-b",
      applicationKey: "filesystem",
      applicationDisplayName: "File system",
      risk: "destructive",
    });
    const approval = searchPaperclipTools(tools, parsePaperclipSearchToolsInput({ query: "tool-d" }));
    expect(isSearchPage(approval)).toBe(true);
    if (!isSearchPage(approval)) throw new Error("Expected a search page");
    expect(approval.tools[0]).toMatchObject({ name: "tool-d", approvalDescription: "Approval detail d" });
    expect(JSON.stringify(tools)).toBe(before);
  });

  it("defaults to five results and exposes SHA-256 references for chunked content", () => {
    const tools = Array.from({ length: 7 }, (_, index) => descriptor(`tool-${index}`, {
      description: "🌲".repeat(20_000),
      parametersSchema: { type: "object", properties: { value: { type: "string", description: "x".repeat(40_000) } } },
    }));
    const page = searchMcpToolCatalog(tools, {});
    expect(isSearchPage(page)).toBe(true);
    if (!isSearchPage(page)) throw new Error("Expected a search page");
    expect(page.limit).toBe(5);
    expect(page.tools[0].schemaHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(page.tools[0].textRefs?.description?.hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps each page below the response budget and replaces only oversized inline schemas with references", () => {
    const tools = Array.from({ length: 12 }, (_, index) => descriptor(`tool-${String(index).padStart(2, "0")}`, {
      parametersSchema: {
        type: "object",
        properties: { payload: { type: "string", description: "x".repeat(29 * 1024) } },
      },
    }));
    const all: string[] = [];
    const entries = [];
    let offset = 0;
    while (true) {
      const page = searchMcpToolCatalog(tools, { offset, limit: 12 });
      expect(isSearchPage(page)).toBe(true);
      if (!isSearchPage(page)) throw new Error("Expected a search page");
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThan(256 * 1024);
      all.push(...page.tools.map(tool => tool.name));
      entries.push(...page.tools);
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(all).toEqual(tools.map(tool => tool.name));
    expect(all).toHaveLength(new Set(all).size);
    expect(entries.some(tool => tool.parametersSchema)).toBe(true);
    expect(entries.some(tool => tool.schemaRef)).toBe(true);
  });

  it("uses AND search terms across fields and prioritizes exact names", () => {
    const tools = [
      descriptor("github_search_extended", { applicationDisplayName: "GitHub" }),
      descriptor("github_search", { applicationDisplayName: "GitHub" }),
      descriptor("gitlab_search", { applicationDisplayName: "GitHub" }),
    ];
    const exact = searchPaperclipTools(tools, parsePaperclipSearchToolsInput({ query: "GITHUB_SEARCH" }));
    expect(isSearchPage(exact)).toBe(true);
    if (!isSearchPage(exact)) throw new Error("Expected a search page");
    expect(exact.tools.map(tool => tool.name)).toEqual(["github_search", "github_search_extended"]);

    const byApplication = searchPaperclipTools(tools, parsePaperclipSearchToolsInput({ query: "github gitlab" }));
    expect(isSearchPage(byApplication)).toBe(true);
    if (!isSearchPage(byApplication)) throw new Error("Expected a search page");
    expect(byApplication.tools.map(tool => tool.name)).toEqual(["gitlab_search"]);
    const browse = searchMcpToolCatalog(tools, { query: "   " });
    expect(isSearchPage(browse)).toBe(true);
    if (!isSearchPage(browse)) throw new Error("Expected a search page");
    expect(browse.tools).toHaveLength(3);
  });

  it("searches and prioritizes exact upstream action names over description mentions", () => {
    const tools = [
      descriptor("paperclip_call_tool", { description: "Call wrapper for retrieve_tools from another app." }),
      descriptor("gateway-retrieve-tools", { upstreamToolName: "retrieve_tools", applicationDisplayName: "MCP Proxy" }),
      descriptor("gateway-retrieve-tools-help", { description: "Use retrieve_tools for discovery." }),
    ];
    const results = searchMcpToolCatalog(tools, { query: "retrieve_tools" });
    expect(isSearchPage(results)).toBe(true);
    if (!isSearchPage(results)) throw new Error("Expected a search page");
    expect(results.tools.map(tool => tool.name)).toEqual([
      "gateway-retrieve-tools",
      "gateway-retrieve-tools-help",
      "paperclip_call_tool",
    ]);
  });

  it("retrieves a large Unicode schema in bounded code-point chunks that reconstruct exactly", () => {
    const schema = {
      type: "object",
      properties: {
        content: { type: "string", description: "🌲漢字\n".repeat(20_000) },
      },
      required: ["content"],
      additionalProperties: false,
    };
    const tools = [descriptor("filesystem:read", { parametersSchema: schema })];
    const search = searchPaperclipTools(tools, parsePaperclipSearchToolsInput({ query: "filesystem" }));
    expect(isSearchPage(search)).toBe(true);
    if (!isSearchPage(search)) throw new Error("Expected a search page");
    expect(search.tools[0]).toMatchObject({ schemaRef: "filesystem:read" });
    expect(search.tools[0].schemaHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(search.tools[0].parametersSchema).toBeUndefined();

    const contents: string[] = [];
    let offset = 0;
    while (true) {
      const chunk = searchPaperclipTools(tools, parsePaperclipSearchToolsInput({ schemaTool: "filesystem:read", schemaOffset: offset }));
      expect("schemaChunk" in chunk).toBe(true);
      if (!("schemaChunk" in chunk)) throw new Error("Expected schema chunk");
      expect(new TextEncoder().encode(JSON.stringify(chunk)).byteLength).toBeLessThanOrEqual(256 * 1024);
      expect(chunk.schemaChunk.offset).toBe(offset);
      expect(chunk.schemaChunk.hash).toBe(search.tools[0].schemaHash);
      contents.push(chunk.schemaChunk.content);
      if (chunk.schemaChunk.nextOffset === null) break;
      offset = chunk.schemaChunk.nextOffset;
    }

    const reconstructed = contents.join("");
    expect(JSON.parse(reconstructed)).toEqual(schema);
    expect(Array.from(reconstructed).join("")).toBe(reconstructed);
    const terminal = searchPaperclipTools(tools, parsePaperclipSearchToolsInput({
      schemaTool: "filesystem:read",
      schemaOffset: Array.from(reconstructed).length,
    }));
    expect(terminal).toMatchObject({ schemaChunk: { content: "", nextOffset: null } });
  });

  it("rejects schema or text chunks when the referenced content changed", () => {
    const original = descriptor("large:tool", {
      parametersSchema: { type: "object", properties: { value: { type: "string", description: "x".repeat(40_000) } } },
      description: "🌲".repeat(20_000),
    });
    const originalPage = searchMcpToolCatalog([original], { query: "large" });
    expect(isSearchPage(originalPage)).toBe(true);
    if (!isSearchPage(originalPage)) throw new Error("Expected a search page");

    const schemaHash = originalPage.tools[0].schemaHash;
    const changedSchema = { ...original, parametersSchema: { type: "object", properties: { newer: { type: "boolean", description: "y".repeat(40_000) } } } };
    expect(() => searchMcpToolCatalog([changedSchema], {
      schemaTool: "large:tool", schemaOffset: 24_576, expectedHash: schemaHash,
    })).toThrowError(expect.objectContaining({ statusCode: 409, code: "mcp_tool_catalog_content_changed" }));

    const textHash = originalPage.tools[0].textRefs?.description?.hash;
    const changedText = { ...original, description: "changed 🌳".repeat(20_000) };
    expect(() => searchMcpToolCatalog([changedText], {
      textTool: "large:tool", textField: "description", textOffset: 24_576, expectedHash: textHash,
    })).toThrowError(expect.objectContaining({ statusCode: 409, code: "mcp_tool_catalog_content_changed" }));
  });

  it("retrieves long descriptions and approval text in complete Unicode-safe chunks", () => {
    const description = "Use PowerShell 🌲漢字\n".repeat(25_000);
    const tools = [descriptor("powershell:run", {
      applicationDisplayName: "MCP Proxy",
      description,
      approvalDescription: "Review required: " + "🔐".repeat(10_000),
    })];
    const results = searchMcpToolCatalog(tools, { query: "powershell" });
    expect(isSearchPage(results)).toBe(true);
    if (!isSearchPage(results)) throw new Error("Expected a search page");
    const result = results.tools[0];
    expect(result.description).toBeNull();
    expect(result.textRefs?.description).toMatchObject({ toolName: "powershell:run", field: "description" });
    expect(result.applicationDisplayName).toBe("MCP Proxy");

    const chunks: string[] = [];
    let offset = 0;
    while (true) {
      const chunk = searchMcpToolCatalog(tools, {
        textTool: "powershell:run",
        textField: "description",
        textOffset: offset,
      });
      expect("textChunk" in chunk).toBe(true);
      if (!("textChunk" in chunk)) throw new Error("Expected a text chunk");
      expect(new TextEncoder().encode(JSON.stringify(chunk)).byteLength).toBeLessThanOrEqual(256 * 1024);
      expect(chunk.textChunk.offset).toBe(offset);
      chunks.push(chunk.textChunk.content);
      if (chunk.textChunk.nextOffset === null) break;
      offset = chunk.textChunk.nextOffset;
    }
    expect(chunks.join("")).toBe(description);

    const approvalChunks: string[] = [];
    let approvalOffset = 0;
    while (true) {
      const chunk = searchMcpToolCatalog(tools, {
        textTool: "powershell:run",
        textField: "approvalDescription",
        textOffset: approvalOffset,
      });
      expect("textChunk" in chunk).toBe(true);
      if (!("textChunk" in chunk)) throw new Error("Expected an approval-text chunk");
      approvalChunks.push(chunk.textChunk.content);
      if (chunk.textChunk.nextOffset === null) break;
      approvalOffset = chunk.textChunk.nextOffset;
    }
    expect(approvalChunks.join("")).toBe(tools[0].approvalDescription);
  });

  it("rejects malformed search arguments with client errors", () => {
    const cases: unknown[] = [
      null,
      [],
      { unexpected: true },
      { offset: -1 },
      { offset: 1.5 },
      { offset: Number.MAX_SAFE_INTEGER + 1 },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { query: 42 },
      { schemaOffset: 2 },
      { schemaTool: "tool", query: "tool" },
      { schemaTool: "" },
      { textField: "description" },
      { textTool: "tool" },
      { textTool: "tool", textField: "unknown" },
      { expectedHash: "abc" },
      { schemaTool: "tool", expectedHash: "ABC".repeat(21) + "A" },
      { textTool: "tool", textField: "description", schemaTool: "tool" },
    ];
    for (const input of cases) {
      expect(() => parsePaperclipSearchToolsInput(input)).toThrow(McpToolCatalogError);
    }
    try {
      parsePaperclipSearchToolsInput({ extra: true });
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 400, code: "mcp_tool_catalog_invalid_input" });
    }
  });

  it("retrieves only schemas for exact current tool names and rejects unknown names", () => {
    const tools = [descriptor("known:tool")];
    expect(() => searchPaperclipTools(tools, parsePaperclipSearchToolsInput({ schemaTool: "missing:tool" })))
      .toThrowError(expect.objectContaining({ statusCode: 400, code: "mcp_tool_catalog_unknown_tool" }));
    expect(() => parsePaperclipCallToolInput({ name: "missing:tool", arguments: {} }, tools))
      .toThrowError(expect.objectContaining({ statusCode: 400, code: "mcp_tool_catalog_unknown_tool" }));
  });

  it("validates call envelopes and returns only the exact listed tool and object arguments", () => {
    const tools = [descriptor("filesystem:read")];
    const args = { path: "README.md" };
    expect(parsePaperclipCallToolInput({ name: "filesystem:read", arguments: args }, tools))
      .toEqual({ name: "filesystem:read", arguments: args });
    expect(parseMcpToolCall({ name: "filesystem:read", arguments: args }))
      .toEqual({ name: "filesystem:read", arguments: args });
    for (const input of [
      null,
      { name: "filesystem:read", arguments: [] },
      { name: "filesystem:read", arguments: null },
      { name: "filesystem:read", arguments: {}, extra: true },
      { name: "", arguments: {} },
    ]) {
      expect(() => parsePaperclipCallToolInput(input, tools)).toThrow(McpToolCatalogError);
    }
  });

  it("validates arguments against each listed tool schema without mutation or coercion", () => {
    const draft07 = descriptor("draft07", {
      parametersSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { message: { type: "string", minLength: 1 } },
        required: ["message"],
        additionalProperties: false,
      },
    });
    const draft2020 = descriptor("draft2020", {
      parametersSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: true,
      },
    });
    const draft2019 = descriptor("draft2019", {
      parametersSchema: {
        $schema: "https://json-schema.org/draft/2019-09/schema",
        type: "object",
        properties: { at: { type: "string", format: "date-time" } },
        required: ["at"],
        additionalProperties: false,
      },
    });
    const valid07 = { message: "Привет 🌍" };
    const valid2020 = { text: "漢字 and 🌲", extra: 7 };
    const before07 = JSON.stringify(valid07);
    const before2020 = JSON.stringify(valid2020);

    expect(() => validateCatalogToolArguments(draft07, valid07)).not.toThrow();
    expect(() => validateCatalogToolArguments(draft2020, valid2020)).not.toThrow();
    expect(() => validateCatalogToolArguments(draft2019, { at: "2026-10-18T10:00:00Z" })).not.toThrow();
    expect(JSON.stringify(valid07)).toBe(before07);
    expect(JSON.stringify(valid2020)).toBe(before2020);
    expect(() => validateCatalogToolArguments(draft07, { message: 7 })).toThrowError(
      expect.objectContaining({ statusCode: 400, code: "mcp_tool_catalog_arguments_invalid" }),
    );
    expect(() => validateCatalogToolArguments(draft07, { message: "ok", extra: true })).toThrowError(
      expect.objectContaining({ statusCode: 400, code: "mcp_tool_catalog_arguments_invalid" }),
    );
    expect(() => validateCatalogToolArguments(draft2019, { at: "not-a-date" })).toThrowError(
      expect.objectContaining({ statusCode: 400, code: "mcp_tool_catalog_arguments_invalid" }),
    );
  });

  it("fails closed for schemas with unresolved remote references without fetching them", () => {
    const unresolved = descriptor("unresolved", {
      parametersSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $ref: "https://schemas.invalid/remote.json",
      },
    });
    expect(() => validateCatalogToolArguments(unresolved, {})).toThrowError(
      expect.objectContaining({ statusCode: 500, code: "mcp_tool_catalog_schema_unresolvable" }),
    );
  });
});
