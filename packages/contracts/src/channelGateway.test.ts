import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ChannelGatewayError,
  ChannelIngestInput,
  ChannelIngestResult,
  ChannelInputSnapshot,
  ChannelListTasksInput,
} from "./index.ts";

const json = <S extends Schema.Codec<unknown, unknown>>(schema: S) => Schema.toCodecJson(schema);

describe("channel ingest", () => {
  const input = {
    kind: "slack",
    connectionId: "slack-1",
    conversationKey: "T1:C1:1760000000.000100",
    externalMessageId: "1760000000.000200",
    idempotencyKey: "T1:Ev123",
    actor: { externalActorId: "U123", displayName: "Jun" },
    replyAddress: {
      kind: "slack",
      connectionId: "slack-1",
      teamId: "T1",
      channelId: "C1",
      rootTs: "1760000000.000100",
    },
    text: "Re-verify the Opus 5.5 call",
    attachments: [],
    receivedAt: "2026-10-12T00:00:00.000Z",
    intent: "message",
  };

  it("round-trips an inbound message and its durable receipt", () => {
    const decoded = Schema.decodeUnknownSync(json(ChannelIngestInput))(input);
    expect(Schema.encodeSync(json(ChannelIngestInput))(decoded)).toEqual(input);
    const receipt = {
      inputId: "input-1",
      conversationId: "conv-1",
      bindingId: "binding-1",
      duplicate: false,
      state: "accepted",
      acceptedAt: "2026-10-12T00:00:00.050Z",
      taskIds: [],
    };
    expect(Schema.decodeUnknownSync(json(ChannelIngestResult))(receipt)).toEqual(receipt);
    expect(
      Schema.decodeUnknownSync(json(ChannelInputSnapshot))({
        ...receipt,
        state: "replied",
        readAt: "2026-10-12T00:00:00.100Z",
        reply: { text: "On it.", inReplyToInputId: "input-1" },
      }),
    ).toMatchObject({ reply: { inReplyToInputId: "input-1" } });
  });

  it("caps task list pages", () => {
    const decode = Schema.decodeUnknownSync(ChannelListTasksInput);
    expect(decode({ limit: 100 })).toEqual({ limit: 100 });
    expect(() => decode({ limit: 101 })).toThrow();
    expect(() => decode({ limit: 0 })).toThrow();
  });

  it("explains failures without echoing channel content", () => {
    const error = new ChannelGatewayError({ reason: "idempotency_conflict" });
    expect(error.message).toBe(
      "A different message was already stored under this idempotency key.",
    );
    expect(Schema.encodeSync(json(ChannelGatewayError))(error)).toEqual({
      _tag: "ChannelGatewayError",
      reason: "idempotency_conflict",
    });
  });
});
