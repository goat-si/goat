import { OrchestrationV2TurnItemJson, type OrchestrationV2TurnItem } from "@goat/contracts";
import { sentMessageFromToolItem } from "@goat/shared/toolOutput";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const SENT_MESSAGE_MARKER = ',"persistentSentMessage":true}';

export function encodeTurnItemPayload(item: OrchestrationV2TurnItem) {
  const encoded = encodePayload(item);
  if (item.type !== "dynamic_tool" || sentMessageFromToolItem(item) === undefined) return encoded;

  // Keep the marker in the projection JSON object, outside the event and wire schemas.
  return encoded.pipe(Effect.map((json) => json.slice(0, -1) + SENT_MESSAGE_MARKER));
}

export function isInlineWorkOutput(payloadJson: string): boolean {
  const payload = payloadJson.toLowerCase();
  return (
    payload.includes("htmlrender") ||
    payload.includes("goatmcpapp") ||
    payload.includes("t3mcpapp") || // goat-rename: legacy: payloads recorded before the rename
    payload.includes('"viewedimagepath"') ||
    /"toolname":"[\s\S]*delegate.task"/i.test(payloadJson) ||
    payload.endsWith(SENT_MESSAGE_MARKER.toLowerCase())
  );
}
