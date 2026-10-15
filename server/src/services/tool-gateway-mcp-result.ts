/** Build the standard MCP envelope for a Paperclip gateway tool response. */
export function buildGatewayToolCallResult(input: {
  text: string;
  structuredContent: unknown;
  isError?: boolean;
}) {
  const structuredContent = input.structuredContent;
  return {
    content: [{ type: "text" as const, text: input.text }],
    ...(structuredContent !== null &&
    typeof structuredContent === "object" &&
    !Array.isArray(structuredContent)
      ? { structuredContent: structuredContent as Record<string, unknown> }
      : {}),
    isError: input.isError ?? false,
  };
}
