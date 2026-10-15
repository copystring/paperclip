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

  it("keeps the stored receipt readable on a replay without emitting null structuredContent", () => {
    // Mirrors executeTool's persisted idempotent-replay result and the route's
    // result/data projection without requiring the gateway database setup.
    const replay = {
      status: "replayed",
      result: {
        summary: '{"status":"completed","receiptId":"receipt-1"}',
        sha256: "receipt-hash",
        sizeBytes: 49,
      },
    };
    const resultRecord = replay as unknown as Record<string, unknown>;
    const contentText = JSON.stringify(resultRecord.data ?? replay.result ?? null);
    const result = buildGatewayToolCallResult({
      text: contentText,
      structuredContent: resultRecord.data,
    });

    expect(CallToolResultSchema.parse(result)).toEqual({
      content: [{ type: "text", text: contentText }],
      isError: false,
    });
    expect(contentText).toContain("receiptId");
    expect("structuredContent" in result).toBe(false);
  });
});
