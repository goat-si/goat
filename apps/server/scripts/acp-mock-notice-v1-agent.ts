// @effect-diagnostics nodeBuiltinImport:off - raw ACP v1 fixture bypasses the v2-only agent encoder.
import * as NodeReadline from "node:readline";
import * as Schema from "effect/Schema";
import { mockSessionNotices } from "./acpMockNotices.ts";

const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
      method: Schema.String,
      params: Schema.optional(Schema.Struct({ sessionId: Schema.optional(Schema.String) })),
    }),
  ),
);
const encodeFrame = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const writeFrame = (frame: unknown) => process.stdout.write(`${encodeFrame(frame)}\n`);

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const request = decodeRequest(line);
  if (request.id === undefined) continue;
  let result: unknown;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: 1,
        agentInfo: { name: "notice-v1-fixture", version: "0.0.0" },
        agentCapabilities: {},
        authMethods: [],
      };
      break;
    case "session/new":
      result = { sessionId: "notice-v1-session" };
      break;
    case "session/prompt": {
      const sessionId = request.params?.sessionId;
      const chunk = (text: string) =>
        writeFrame({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          },
        });
      chunk("before the notice, ");
      for (const notice of mockSessionNotices) {
        writeFrame({ jsonrpc: "2.0", method: "session/update", params: { sessionId, ...notice } });
      }
      chunk("after the notice");
      result = { stopReason: "end_turn" };
      break;
    }
    default:
      writeFrame({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `Unsupported fixture method: ${request.method}` },
      });
      continue;
  }
  writeFrame({ jsonrpc: "2.0", id: request.id, result });
}
