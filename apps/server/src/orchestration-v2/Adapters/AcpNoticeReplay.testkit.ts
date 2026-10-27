import { assert } from "@effect/vitest";
import * as Schema from "effect/Schema";
import type { AcpProtocolLogEvent } from "effect-acp/protocol";

const decodeFrame = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optional(Schema.String),
      params: Schema.optional(
        Schema.Struct({ clientCapabilities: Schema.optional(Schema.Unknown) }),
      ),
      result: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

export function assertNoticeInitialization(
  events: ReadonlyArray<AcpProtocolLogEvent>,
  protocolVersion: number,
): void {
  const frames = events.flatMap((event) =>
    event.stage === "raw" && typeof event.payload === "string"
      ? event.payload
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => ({ direction: event.direction, ...decodeFrame(line) }))
      : [],
  );
  const initialize = frames.find(
    (frame) => frame.direction === "outgoing" && frame.method === "initialize",
  );
  assert.deepInclude(initialize?.params?.clientCapabilities, { session: { notices: {} } });
  const response = frames.find(
    (frame) => frame.direction === "incoming" && frame.result?.protocolVersion !== undefined,
  )?.result;
  assert.isDefined(response);
  assert.equal(response?.protocolVersion, protocolVersion);
  assert.equal(response !== undefined && "info" in response, protocolVersion === 2);
  assert.equal(response !== undefined && "agentInfo" in response, protocolVersion === 1);
}
