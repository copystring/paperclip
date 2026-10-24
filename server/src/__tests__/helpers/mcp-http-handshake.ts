import { MCP_PROTOCOL_VERSION } from "../../services/mcp-http.js";

/** Protocol responses shared by mocked remote MCP endpoints. Return null for
 * application requests so each fixture keeps its own catalog/auth behavior. */
export function mcpHttpHandshakeResponse(request: { method?: string; id?: string | number }): Response | null {
  if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (request.method !== "initialize") return null;
  return Response.json({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "remote-mcp-test-fixture", version: "1" },
    },
  });
}
