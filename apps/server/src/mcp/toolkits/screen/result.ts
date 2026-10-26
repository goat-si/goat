import { ScreenRunResult } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

const isScreenRunResult = Schema.is(ScreenRunResult);

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** MCP images stay in content; neither JSON channel carries their bytes. */
export function screenRunMcpResult(encoded: unknown): McpSchema.CallToolResult {
  if (!isScreenRunResult(encoded)) {
    return new McpSchema.CallToolResult({
      isError: true,
      content: [{ type: "text", text: encodeJsonText(encoded) }],
    });
  }
  const { images, ...summary } = encoded;
  return new McpSchema.CallToolResult({
    isError: false,
    structuredContent: summary,
    content: [
      { type: "text", text: encodeJsonText(summary) },
      ...images.map((image) => ({
        type: "image" as const,
        data: new Uint8Array(Buffer.from(image.bytes, "base64")),
        mimeType: image.mimeType,
      })),
    ],
  });
}
