import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ChannelGatewayError,
  ChannelIdentityLinkConsumeInput,
  ChannelIngestInput,
  ChannelIngestResult,
  ChannelInputSnapshot,
  ChannelListTasksInput,
  ChannelNoticeInput,
  ChannelOutboundMessage,
  ChannelRequester,
} from "./index.ts";

const json = <S extends Schema.Codec<unknown, unknown>>(schema: S) => Schema.toCodecJson(schema);

describe("channel ingest", () => {
  it("round-trips iMessage input, requester and outbound destination", () => {
    const address = {
      kind: "imessage" as const,
      connectionId: "imessage-000000000001",
      chatGuid: "iMessage;-;+15550000000",
    };
    const inbound = {
      kind: "imessage" as const,
      connectionId: address.connectionId,
      conversationKey: address.chatGuid,
      externalMessageId: "guid-1",
      idempotencyKey: "imessage-000000000001:1",
      actor: { externalActorId: "+15550000000" },
      replyAddress: address,
      text: "hello",
      attachments: [],
      receivedAt: "2026-10-19T00:00:00.000Z",
      intent: "message" as const,
    };
    expect(
      Schema.decodeSync(json(ChannelIngestInput))(
        Schema.encodeSync(json(ChannelIngestInput))(inbound),
      ),
    ).toEqual(inbound);
    const requester = {
      ownerId: "owner",
      principalId: "local-cli",
      displayName: "Owner",
      originKind: "imessage" as const,
      externalActorId: "+15550000000",
      runtimeModeCeiling: "approval-required" as const,
      grantedScopes: ["orchestration:operate" as const],
    };
    expect(
      Schema.decodeSync(json(ChannelRequester))(
        Schema.encodeSync(json(ChannelRequester))(requester),
      ),
    ).toEqual(requester);
    const outbound = {
      deliveryId: "delivery" as never,
      destination: address,
      kind: "receipt" as const,
      text: "hello",
    };
    expect(
      Schema.decodeSync(json(ChannelOutboundMessage))(
        Schema.encodeSync(json(ChannelOutboundMessage))(outbound),
      ),
    ).toEqual(outbound);
  });
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
    const decoded = Schema.decodeSync(json(ChannelIngestInput))(input);
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
    expect(Schema.decodeSync(json(ChannelIngestResult))(receipt)).toEqual(receipt);
    expect(
      Schema.decodeSync(json(ChannelInputSnapshot))({
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

  it("tells a transport whether a failed delivery may have arrived", () => {
    const encode = Schema.encodeSync(json(ChannelGatewayError));
    expect(
      encode(
        new ChannelGatewayError({
          reason: "delivery_failed",
          deliveryOutcome: "not_sent",
          deliveryErrorCode: "rate_limited",
          retryAfterSeconds: 30,
        }),
      ),
    ).toEqual({
      _tag: "ChannelGatewayError",
      reason: "delivery_failed",
      deliveryOutcome: "not_sent",
      deliveryErrorCode: "rate_limited",
      retryAfterSeconds: 30,
    });
    expect(() =>
      Schema.decodeSync(json(ChannelGatewayError))({
        _tag: "ChannelGatewayError",
        reason: "delivery_failed",
        deliveryErrorCode: "slack_said_no",
      }),
    ).toThrow();
  });
});

describe("identity link notices", () => {
  const replyAddress = {
    kind: "slack",
    connectionId: "slack-1",
    teamId: "T1",
    channelId: "D1",
    rootTs: "1760000000.000300",
  };

  it("needs a reply address and idempotency key to answer a link code", () => {
    const decode = Schema.decodeUnknownSync(ChannelIdentityLinkConsumeInput);
    const input = { connectionId: "slack-1", externalActorId: "U123", code: "483920" };
    expect(() => decode(input)).toThrow();
    expect(decode({ ...input, idempotencyKey: "T1:Ev9", replyAddress })).toMatchObject({
      replyAddress: { rootTs: "1760000000.000300" },
    });
  });

  it("accepts only the fixed notices", () => {
    const decode = Schema.decodeUnknownSync(ChannelNoticeInput);
    const input = {
      connectionId: "slack-1",
      idempotencyKey: "T1:Ev10",
      replyAddress,
      actor: { externalActorId: "U123" },
      notice: "link_help",
    };
    expect(decode(input)).toEqual(input);
    expect(() => decode({ ...input, notice: "free_text" })).toThrow();
  });
});
