import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { buildGatewayToolCallResult } from "./tool-gateway-mcp-result.js";

describe("buildGatewayToolCallResult", () => {
  it.each(["mcp_http", "local_stdio", "cognee_cloud"])("preserves native images and text from governed %s content", (transport) => {
    const content = [{ type: "text", text: "Screenshot" }, { type: "image", mimeType: "image/png", data: "cGl4ZWxz" }];
    const result = buildGatewayToolCallResult({ text: JSON.stringify(content), structuredContent: { content, transport, structuredContent: { width: 1 }, isError: false } });
    expect(CallToolResultSchema.parse(result).content).toEqual(content);
    expect(result.structuredContent).toEqual({ transport, structuredContent: { width: 1 }, isError: false });
    expect(JSON.stringify(result.structuredContent)).not.toContain("cGl4ZWxz");
  });

  it("does not promote arbitrary structured data into provider content", () => {
    const result = buildGatewayToolCallResult({ text: "governed response", structuredContent: { content: [{ type: "image", mimeType: "image/png", data: "pixels" }] } });
    expect(result.content).toEqual([{ type: "text", text: "governed response" }]);
  });

  it("falls back to governed text when provider blocks are malformed", () => {
    const result = buildGatewayToolCallResult({ text: "redacted response", structuredContent: { transport: "mcp_http", content: [{ type: "image", data: null }] }, isError: true });
    expect(result.content).toEqual([{ type: "text", text: "redacted response" }]);
    expect(result.isError).toBe(true);
  });

  it("preserves provider errors", () => {
    const result = buildGatewayToolCallResult({ text: "failed", structuredContent: { transport: "mcp_http", content: [{ type: "text", text: "failed" }], isError: true } });
    expect(result.isError).toBe(true);
  });
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
