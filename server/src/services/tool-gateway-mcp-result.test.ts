import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { buildGatewayToolCallResult } from "./tool-gateway-mcp-result.js";

describe("buildGatewayToolCallResult", () => {
  it.each([undefined, null, "scalar", 7, true, ["array"]])(
    "omits invalid structuredContent for %s while preserving the text result",
    (structuredContent) => {
      const result = buildGatewayToolCallResult({ text: "provider response", structuredContent });
      expect(CallToolResultSchema.parse(result)).toEqual({
        content: [{ type: "text", text: "provider response" }],
        isError: false,
      });
    },
  );

  it("preserves object structuredContent and error results", () => {
    const result = buildGatewayToolCallResult({
      text: "provider error details",
      structuredContent: { code: "provider_failed" },
      isError: true,
    });
    expect(CallToolResultSchema.parse(result)).toEqual({
      content: [{ type: "text", text: "provider error details" }],
      structuredContent: { code: "provider_failed" },
      isError: true,
    });
  });
});
