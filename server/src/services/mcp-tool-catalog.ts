import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Plugin } from "ajv";
import type { FormatsPluginOptions } from "ajv-formats";
import * as addFormatsModule from "ajv-formats";

export type McpToolCatalogDescriptor = {
  name: string;
  displayName?: string | null;
  description?: string | null;
  parametersSchema: Record<string, unknown>;
  applicationKey?: string | null;
  applicationDisplayName?: string | null;
  upstreamToolName?: string | null;
  risk?: string | null;
  approvalDescription?: string | null;
};

export type PaperclipSearchToolsInput = {
  query?: string;
  offset?: number;
  limit?: number;
  schemaTool?: string;
  schemaOffset?: number;
  expectedHash?: string;
  textTool?: string;
  textField?: McpToolCatalogTextField;
  textOffset?: number;
};

export type McpToolCatalogTextField = "displayName" | "description" | "applicationKey" | "applicationDisplayName" | "approvalDescription";

export type PaperclipCallToolInput = {
  name: string;
  arguments: Record<string, unknown>;
};

export type McpToolCatalogEntry = {
  name: string;
  displayName: string | null;
  description: string | null;
  applicationKey?: string | null;
  applicationDisplayName?: string | null;
  risk?: string;
  approvalDescription?: string | null;
  textRefs?: Partial<Record<McpToolCatalogTextField, { toolName: string; field: McpToolCatalogTextField; hash: string; bytes: number; codePoints: number }>>;
  parametersSchema?: Record<string, unknown>;
  schemaRef?: string;
  schemaBytes?: number;
  schemaCodePoints?: number;
  schemaHash?: string;
};

export type McpToolSearchPage = {
  tools: McpToolCatalogEntry[];
  offset: number;
  limit: number;
  total: number;
  nextOffset: number | null;
};

export type McpToolSchemaChunk = {
  schemaChunk: {
    schemaRef: string;
    offset: number;
    totalCodePoints: number;
    content: string;
    hash: string;
    nextOffset: number | null;
  };
};

export type McpToolTextChunk = {
  textChunk: {
    toolName: string;
    field: McpToolCatalogTextField;
    offset: number;
    totalCodePoints: number;
    content: string;
    hash: string;
    nextOffset: number | null;
  };
};

export type PaperclipSearchToolsResult = McpToolSearchPage | McpToolSchemaChunk | McpToolTextChunk;

export class McpToolCatalogError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, code = "mcp_tool_catalog_invalid_input", statusCode = 400) {
    super(message);
    this.name = "McpToolCatalogError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const MAX_PAGE_LIMIT = 100;
const MAX_SCHEMA_INLINE_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 240 * 1024;
const MAX_SCHEMA_CHUNK_CODE_POINTS = 24 * 1024;
const MAX_TEXT_INLINE_BYTES = 32 * 1024;
const MAX_TEXT_CHUNK_CODE_POINTS = 24 * 1024;
const MAX_APP_INDEX_BYTES = 12 * 1024;
const TEXT_FIELDS = new Set<McpToolCatalogTextField>(["displayName", "description", "applicationKey", "applicationDisplayName", "approvalDescription"]);
const addFormats = (addFormatsModule as unknown as { default: Plugin<FormatsPluginOptions> }).default;

export const PAPERCLIP_SEARCH_TOOLS_DEFINITION = {
  name: "paperclip_search_tools",
  description:
    "Search the currently authorized Paperclip tool catalog by tool or application name. Prefer a targeted query; omit query or use an empty query to browse. Before calling a selected tool, read its complete schema, description and approval text, following all returned references and cursors. Results default to five per page. Large parameter schemas use schemaTool/schemaOffset and long text fields use textTool/textField/textOffset. Every reference and chunk includes a SHA-256 hash; assemble chunks only when hashes match, and pass expectedHash to reject changed content with 409.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Optional AND-matched search terms; empty means browse." },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT },
      schemaTool: { type: "string", description: "Exact tool name returned as schemaRef by a search result." },
      schemaOffset: { type: "integer", minimum: 0, description: "Unicode code-point offset into the serialized JSON schema." },
      expectedHash: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Optional SHA-256 from the original reference; changed content returns 409." },
      textTool: { type: "string", description: "Exact tool name whose text field is returned by a search result." },
      textField: { type: "string", enum: ["displayName", "description", "applicationKey", "applicationDisplayName", "approvalDescription"] },
      textOffset: { type: "integer", minimum: 0, description: "Unicode code-point offset into the referenced text field." },
    },
    additionalProperties: false,
  },
} as const;

export const PAPERCLIP_CALL_TOOL_DEFINITION = {
  name: "paperclip_call_tool",
  description:
    "Call one exact tool name from the current authorized Paperclip catalog. The gateway applies the tool's normal authorization and approval checks.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      arguments: { type: "object" },
    },
    required: ["name", "arguments"],
    additionalProperties: false,
  },
} as const;

export const MCP_TOOL_CATALOG_DEFINITIONS = [
  PAPERCLIP_SEARCH_TOOLS_DEFINITION,
  PAPERCLIP_CALL_TOOL_DEFINITION,
] as const;

function appIndexFor(tools: readonly McpToolCatalogDescriptor[]): string {
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const apps = new Map<string, Set<string>>();
  for (const tool of tools) {
    const appName = tool.applicationDisplayName?.trim() || tool.applicationKey?.trim() || "Other";
    const actionName = tool.upstreamToolName?.trim() || tool.displayName?.trim() || tool.name;
    const actions = apps.get(appName) ?? new Set<string>();
    actions.add(actionName);
    apps.set(appName, actions);
  }
  const sortedApps = [...apps.entries()].sort(([left], [right]) => compare(left, right));
  const fullIndex = sortedApps
    .map(([appName, actions]) => `${appName}: ${[...actions].sort(compare).join(", ")}`)
    .join("\n");
  if (Buffer.byteLength(fullIndex, "utf8") <= MAX_APP_INDEX_BYTES) return fullIndex;

  const counts = `App counts only; search for the desired action.\n${sortedApps.map(([appName, actions]) => `${appName} (${actions.size})`).join("\n")}`;
  if (Buffer.byteLength(counts, "utf8") <= MAX_APP_INDEX_BYTES) {
    return counts;
  }
  return "The app index is too large to include. Search or browse the current catalog by app or tool name.";
}

export function createMcpToolCatalogDefinitions(tools: readonly McpToolCatalogDescriptor[]) {
  const [searchDefinition, callDefinition] = MCP_TOOL_CATALOG_DEFINITIONS;
  const index = appIndexFor(tools);
  const nestedDiscoveryHint =
    "These entries are currently authorized gateway tools. Some expose another app's tools: when the desired upstream action is not listed, find and use that app's discovery action first. This index grants no access; search for complete descriptions, approval text, and schemas before calling.";
  return [
    {
      ...searchDefinition,
      description: `${searchDefinition.description}\n${nestedDiscoveryHint}\nCurrent app index:\n${index}`,
    },
    callDefinition,
  ] as const;
}

const SEARCH_KEYS = new Set(["query", "offset", "limit", "schemaTool", "schemaOffset", "expectedHash", "textTool", "textField", "textOffset"]);
const CALL_KEYS = new Set(["name", "arguments"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new McpToolCatalogError(`${label} contains unsupported field(s): ${unknown.join(", ")}`);
}

function parseOffset(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new McpToolCatalogError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

export function parsePaperclipSearchToolsInput(value: unknown): PaperclipSearchToolsInput {
  if (!isPlainObject(value)) throw new McpToolCatalogError("Search input must be an object");
  rejectUnknownKeys(value, SEARCH_KEYS, "Search input");

  if (value.query !== undefined && typeof value.query !== "string") {
    throw new McpToolCatalogError("query must be a string");
  }
  if (value.schemaTool !== undefined && (typeof value.schemaTool !== "string" || value.schemaTool.length === 0)) {
    throw new McpToolCatalogError("schemaTool must be a non-empty exact tool name");
  }
  if (value.textTool !== undefined && (typeof value.textTool !== "string" || value.textTool.length === 0)) {
    throw new McpToolCatalogError("textTool must be a non-empty exact tool name");
  }
  if (value.textField !== undefined && (typeof value.textField !== "string" || !TEXT_FIELDS.has(value.textField as McpToolCatalogTextField))) {
    throw new McpToolCatalogError("textField must name a supported catalog text field");
  }
  if (value.expectedHash !== undefined && (typeof value.expectedHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.expectedHash))) {
    throw new McpToolCatalogError("expectedHash must be a lowercase SHA-256 hex digest");
  }
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > MAX_PAGE_LIMIT)) {
    throw new McpToolCatalogError(`limit must be an integer from 1 to ${MAX_PAGE_LIMIT}`);
  }

  const offset = parseOffset(value.offset, 0, "offset");
  const schemaOffset = parseOffset(value.schemaOffset, 0, "schemaOffset");
  if (value.schemaTool === undefined && value.schemaOffset !== undefined) {
    throw new McpToolCatalogError("schemaOffset requires schemaTool");
  }
  if (value.schemaTool === undefined && value.textTool === undefined && value.expectedHash !== undefined) {
    throw new McpToolCatalogError("expectedHash requires schemaTool or textTool retrieval");
  }
  if (value.textTool === undefined && (value.textField !== undefined || value.textOffset !== undefined)) {
    throw new McpToolCatalogError("textField and textOffset require textTool");
  }
  if (value.textTool !== undefined && value.textField === undefined) {
    throw new McpToolCatalogError("textTool requires textField");
  }
  const hasRetrieval = value.schemaTool !== undefined || value.textTool !== undefined;
  if (!hasRetrieval && value.expectedHash !== undefined) {
    throw new McpToolCatalogError("expectedHash requires schema or text retrieval");
  }
  if (hasRetrieval && (value.query !== undefined || value.offset !== undefined || value.limit !== undefined)) {
    throw new McpToolCatalogError("schema or text retrieval cannot be combined with search paging");
  }
  if (value.schemaTool !== undefined && value.textTool !== undefined) {
    throw new McpToolCatalogError("schema and text retrieval cannot be combined");
  }

  return {
    ...(value.query === undefined ? {} : { query: value.query as string }),
    ...(value.offset === undefined ? {} : { offset }),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
    ...(value.schemaTool === undefined ? {} : { schemaTool: value.schemaTool as string }),
    ...(value.schemaOffset === undefined ? {} : { schemaOffset }),
    ...(value.expectedHash === undefined ? {} : { expectedHash: value.expectedHash as string }),
    ...(value.textTool === undefined ? {} : { textTool: value.textTool as string }),
    ...(value.textField === undefined ? {} : { textField: value.textField as McpToolCatalogTextField }),
    ...(value.textOffset === undefined ? {} : { textOffset: parseOffset(value.textOffset, 0, "textOffset") }),
  };
}

export function parsePaperclipCallToolInput(
  value: unknown,
  descriptors?: readonly McpToolCatalogDescriptor[],
): PaperclipCallToolInput {
  if (!isPlainObject(value)) throw new McpToolCatalogError("Call input must be an object");
  rejectUnknownKeys(value, CALL_KEYS, "Call input");
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new McpToolCatalogError("name must be a non-empty exact tool name");
  }
  if (!isPlainObject(value.arguments)) throw new McpToolCatalogError("arguments must be an object");
  if (descriptors && !descriptors.some(tool => tool.name === value.name)) {
    throw new McpToolCatalogError(`Unknown Paperclip tool: ${value.name}`, "mcp_tool_catalog_unknown_tool");
  }
  return { name: value.name, arguments: value.arguments };
}

export function parseMcpToolCall(value: unknown): PaperclipCallToolInput {
  return parsePaperclipCallToolInput(value);
}

function schemaJson(schema: Record<string, unknown>, toolName: string): string {
  try {
    const serialized = JSON.stringify(schema);
    if (serialized === undefined) throw new Error("schema did not serialize");
    return serialized;
  } catch {
    throw new McpToolCatalogError(`Tool schema cannot be serialized: ${toolName}`, "mcp_tool_catalog_invalid_schema", 500);
  }
}

function responseBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function contentHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toolTextValue(tool: McpToolCatalogDescriptor, field: McpToolCatalogTextField): string | null {
  switch (field) {
    case "displayName": return tool.displayName ?? tool.name;
    case "description": return tool.description ?? "";
    case "applicationKey": return tool.applicationKey ?? null;
    case "applicationDisplayName": return tool.applicationDisplayName ?? null;
    case "approvalDescription": return tool.approvalDescription ?? null;
  }
}

function toolOutput(
  tool: McpToolCatalogDescriptor,
  includeSchema: boolean,
  forceTextReferences = false,
): McpToolCatalogEntry {
  const textRefs: NonNullable<McpToolCatalogEntry["textRefs"]> = {};
  const textOutput = (field: McpToolCatalogTextField): string | null => {
    const value = toolTextValue(tool, field);
    if (value === null) return null;
    const bytes = new TextEncoder().encode(value).byteLength;
    if (!forceTextReferences && bytes <= MAX_TEXT_INLINE_BYTES) return value;
    textRefs[field] = { toolName: tool.name, field, hash: contentHash(value), bytes, codePoints: Array.from(value).length };
    return null;
  };
  const result: McpToolCatalogEntry = {
    name: tool.name,
    displayName: textOutput("displayName"),
    description: textOutput("description"),
  };
  if (tool.applicationKey != null) result.applicationKey = textOutput("applicationKey");
  if (tool.applicationDisplayName != null) result.applicationDisplayName = textOutput("applicationDisplayName");
  if (tool.risk != null) result.risk = tool.risk;
  if (tool.approvalDescription != null) result.approvalDescription = textOutput("approvalDescription");
  if (Object.keys(textRefs).length) result.textRefs = textRefs;

  const serialized = schemaJson(tool.parametersSchema, tool.name);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (includeSchema && bytes <= MAX_SCHEMA_INLINE_BYTES) result.parametersSchema = tool.parametersSchema;
  else {
    result.schemaRef = tool.name;
    result.schemaBytes = bytes;
    result.schemaCodePoints = Array.from(serialized).length;
    result.schemaHash = contentHash(serialized);
  }
  return result;
}

function termsFor(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
}

function matchingTools(descriptors: readonly McpToolCatalogDescriptor[], query: string): McpToolCatalogDescriptor[] {
  const terms = termsFor(query);
  const matched = descriptors.filter(tool => {
    const searchable = [
      tool.name,
      tool.upstreamToolName ?? "",
      tool.displayName ?? "",
      tool.description ?? "",
      tool.applicationKey ?? "",
      tool.applicationDisplayName ?? "",
    ].join(" ").toLowerCase();
    return terms.every(term => searchable.includes(term));
  });
  const exactName = query.trim().toLowerCase();
  return matched.toSorted((left, right) => {
    const exactPriority = (tool: McpToolCatalogDescriptor) => {
      if (exactName === "") return 2;
      if (tool.name.toLowerCase() === exactName) return 0;
      if (tool.upstreamToolName?.toLowerCase() === exactName || tool.displayName?.toLowerCase() === exactName) return 1;
      return 2;
    };
    const leftExact = exactPriority(left);
    const rightExact = exactPriority(right);
    if (leftExact !== rightExact) return leftExact - rightExact;
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();
    return leftName < rightName ? -1 : leftName > rightName ? 1 : left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
}

function schemaChunk(
  tool: McpToolCatalogDescriptor,
  offset: number,
  expectedHash?: string,
): McpToolSchemaChunk {
  const serialized = schemaJson(tool.parametersSchema, tool.name);
  const hash = contentHash(serialized);
  if (expectedHash !== undefined && expectedHash !== hash) {
    throw new McpToolCatalogError("Tool schema changed since the reference was issued", "mcp_tool_catalog_content_changed", 409);
  }
  const points = Array.from(serialized);
  if (offset > points.length) throw new McpToolCatalogError("schemaOffset is beyond the end of this schema");
  if (offset === points.length) {
    return {
      schemaChunk: {
        schemaRef: tool.name,
        offset,
        totalCodePoints: points.length,
        content: "",
        hash,
        nextOffset: null,
      },
    };
  }
  let end = Math.min(points.length, offset + MAX_SCHEMA_CHUNK_CODE_POINTS);
  let output: McpToolSchemaChunk;
  while (end > offset) {
    output = {
      schemaChunk: {
        schemaRef: tool.name,
        offset,
        totalCodePoints: points.length,
        content: points.slice(offset, end).join(""),
        hash,
        nextOffset: end < points.length ? end : null,
      },
    };
    if (responseBytes(output) <= MAX_RESPONSE_BYTES) return output;
    end = offset + Math.floor((end - offset) / 2);
  }
  throw new McpToolCatalogError("Schema chunk cannot fit in a catalog response", "mcp_tool_catalog_response_too_large", 500);
}

function textChunk(
  tool: McpToolCatalogDescriptor,
  field: McpToolCatalogTextField,
  offset: number,
  expectedHash?: string,
): McpToolTextChunk {
  const value = toolTextValue(tool, field);
  if (value === null) throw new McpToolCatalogError(`Tool text field is unavailable: ${field}`, "mcp_tool_catalog_text_unavailable");
  const points = Array.from(value);
  const hash = contentHash(value);
  if (expectedHash !== undefined && expectedHash !== hash) {
    throw new McpToolCatalogError("Tool text changed since the reference was issued", "mcp_tool_catalog_content_changed", 409);
  }
  if (offset > points.length) throw new McpToolCatalogError("textOffset is beyond the end of this field");
  if (offset === points.length) {
    return { textChunk: { toolName: tool.name, field, offset, totalCodePoints: points.length, content: "", hash, nextOffset: null } };
  }
  let end = Math.min(points.length, offset + MAX_TEXT_CHUNK_CODE_POINTS);
  while (end > offset) {
    const output: McpToolTextChunk = {
      textChunk: {
        toolName: tool.name,
        field,
        offset,
        totalCodePoints: points.length,
        content: points.slice(offset, end).join(""),
        hash,
        nextOffset: end < points.length ? end : null,
      },
    };
    if (responseBytes(output) <= MAX_RESPONSE_BYTES) return output;
    end = offset + Math.floor((end - offset) / 2);
  }
  throw new McpToolCatalogError("Text chunk cannot fit in a catalog response", "mcp_tool_catalog_response_too_large", 500);
}

export function searchPaperclipTools(
  descriptors: readonly McpToolCatalogDescriptor[],
  input: PaperclipSearchToolsInput,
): PaperclipSearchToolsResult {
  if (input.schemaTool !== undefined) {
    const tool = descriptors.find(candidate => candidate.name === input.schemaTool);
    if (!tool) throw new McpToolCatalogError(`Unknown Paperclip tool schema: ${input.schemaTool}`, "mcp_tool_catalog_unknown_tool");
    return schemaChunk(tool, input.schemaOffset ?? 0, input.expectedHash);
  }
  if (input.textTool !== undefined && input.textField !== undefined) {
    const tool = descriptors.find(candidate => candidate.name === input.textTool);
    if (!tool) throw new McpToolCatalogError(`Unknown Paperclip tool text: ${input.textTool}`, "mcp_tool_catalog_unknown_tool");
    return textChunk(tool, input.textField, input.textOffset ?? 0, input.expectedHash);
  }

  const tools = matchingTools(descriptors, input.query ?? "");
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 5;
  if (offset >= tools.length) return { tools: [], offset, limit, total: tools.length, nextOffset: null };

  const page: McpToolCatalogEntry[] = [];
  const base: McpToolSearchPage = { offset, limit, total: tools.length, nextOffset: null, tools: page };
  for (let index = offset; index < Math.min(tools.length, offset + limit); index += 1) {
    const nextOffset = index + 1 < tools.length ? index + 1 : null;
    let candidate = toolOutput(tools[index], true);
    page.push(candidate);
    base.nextOffset = nextOffset;
    if (responseBytes(base) > MAX_RESPONSE_BYTES) {
      page.pop();
      candidate = toolOutput(tools[index], false, true);
      page.push(candidate);
      base.nextOffset = nextOffset;
      if (responseBytes(base) > MAX_RESPONSE_BYTES) {
        page.pop();
        if (page.length === 0) {
          throw new McpToolCatalogError(
            `Tool metadata exceeds the maximum catalog response size: ${tools[index].name}`,
            "mcp_tool_catalog_response_too_large",
            500,
          );
        }
        base.nextOffset = index;
        break;
      }
    }
  }
  return base;
}

export function searchMcpToolCatalog(
  descriptors: readonly McpToolCatalogDescriptor[],
  argumentsValue: unknown,
): PaperclipSearchToolsResult {
  return searchPaperclipTools(descriptors, parsePaperclipSearchToolsInput(argumentsValue));
}

export function validateCatalogToolArguments(
  tool: McpToolCatalogDescriptor,
  argumentsValue: unknown,
): asserts argumentsValue is Record<string, unknown> {
  if (!isPlainObject(argumentsValue)) {
    throw new McpToolCatalogError("Tool arguments must be an object", "mcp_tool_catalog_arguments_invalid");
  }

  const dialect = tool.parametersSchema.$schema;
  const options = { strict: false, coerceTypes: false, useDefaults: false, removeAdditional: false } as const;
  const ajv = (() => {
    if (
      dialect === undefined ||
      dialect === "https://json-schema.org/draft/2020-12/schema" ||
      dialect === "https://json-schema.org/draft/2020-12/schema#"
    ) {
      const instance = new Ajv2020(options);
      addFormats(instance);
      return instance;
    }
    if (
      dialect === "https://json-schema.org/draft/2019-09/schema" ||
      dialect === "https://json-schema.org/draft/2019-09/schema#" ||
      dialect === "http://json-schema.org/draft/2019-09/schema#"
    ) {
      const instance = new Ajv2019(options);
      addFormats(instance);
      return instance;
    }
    if (
      dialect === "http://json-schema.org/draft-07/schema#" ||
      dialect === "http://json-schema.org/draft-07/schema" ||
      dialect === "https://json-schema.org/draft-07/schema#"
    ) {
      const instance = new Ajv(options);
      addFormats(instance);
      return instance;
    }
    throw new McpToolCatalogError(
      `Unsupported input schema dialect for tool: ${tool.name}`,
      "mcp_tool_catalog_schema_unresolvable",
      500,
    );
  })();

  let valid: boolean;
  try {
    const validate = ajv.compile(tool.parametersSchema);
    valid = validate(argumentsValue) === true;
  } catch {
    throw new McpToolCatalogError(
      `Input schema could not be resolved for tool: ${tool.name}`,
      "mcp_tool_catalog_schema_unresolvable",
      500,
    );
  }
  if (!valid) {
    throw new McpToolCatalogError(
      "Tool arguments do not match the listed input schema",
      "mcp_tool_catalog_arguments_invalid",
    );
  }
}
