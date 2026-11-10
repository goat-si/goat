import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  BotProfile,
  ChannelGatewayError,
  ChannelCreateBotInput,
  ChannelIdentityLinkConsumeInput,
  ChannelIngestInput,
  ChannelIngestResult,
  ChannelInputSnapshot,
  ChannelListTasksInput,
  ChannelNoticeInput,
  ChannelOutboundMessage,
  ChannelRequester,
  ChannelUpdateBotInput,
} from "./index.ts";

const json = <S extends Schema.Codec<unknown, unknown>>(schema: S) => Schema.toCodecJson(schema);
const decodeProfile = Schema.decodeUnknownExit(BotProfile);

describe("channel.updateBot input", () => {
  const decode = Schema.decodeUnknownExit(ChannelUpdateBotInput);
  it("refuses a profile edit a bot could not carry", () => {
    for (const input of [
      { name: "Jarvis" },
      { botId: "", name: "Jarvis" },
      { botId: "main", name: "" },
      { botId: "main", name: "   " },
      { botId: "main", name: "x".repeat(65) },
      { botId: "main", avatar: "x".repeat(17) },
      { botId: "main", avatar: "" },
      { botId: "main", purpose: "x".repeat(4001) },
    ]) {
      expect(decode(input)._tag, JSON.stringify(input)).toBe("Failure");
    }
  });
  it("accepts a partial edit and a cleared avatar", () => {
    expect(decode({ botId: "main", avatar: null })._tag).toBe("Success");
    expect(decode({ botId: "main", purpose: "" })._tag).toBe("Success");
    expect(decode({ botId: "main", name: "Jarvis", purpose: "x".repeat(4000) })._tag).toBe(
      "Success",
    );
  });
  it("carries a member's model edit only when one is sent", () => {
    const model = { instanceId: "codex", model: "gpt-small" };
    const decoded = Schema.decodeUnknownSync(ChannelUpdateBotInput);
    expect(decoded({ botId: "helper", defaultModelSelection: model })).toEqual({
      botId: "helper",
      defaultModelSelection: model,
    });
    expect(decoded({ botId: "helper", defaultModelSelection: null })).toEqual({
      botId: "helper",
      defaultModelSelection: null,
    });
    expect(decoded({ botId: "helper", name: "Builder" })).not.toHaveProperty(
      "defaultModelSelection",
    );
    expect(decode({ botId: "helper", defaultModelSelection: { model: "gpt-small" } })._tag).toBe(
      "Failure",
    );
  });
  it("carries a bot color as #RRGGBB, clears it with null and refuses anything else", () => {
    const decoded = Schema.decodeUnknownSync(ChannelUpdateBotInput);
    expect(decoded({ botId: "helper", color: "#2f80ed" })).toEqual({
      botId: "helper",
      color: "#2f80ed",
    });
    expect(decoded({ botId: "helper", color: null })).toEqual({ botId: "helper", color: null });
    expect(decoded({ botId: "helper", name: "Builder" })).not.toHaveProperty("color");
    for (const color of ["red", "#fff", "#12345g", "#1234567", "url(x)", "var(--x)", ""]) {
      expect(decode({ botId: "helper", color })._tag, color).toBe("Failure");
    }
    const create = Schema.decodeUnknownExit(ChannelCreateBotInput);
    const fields = {
      clientRequestId: "c1",
      name: "Helper",
      avatar: null,
      purpose: "",
      defaultModelSelection: null,
    };
    expect(create(fields)._tag).toBe("Success");
    expect(create({ ...fields, color: "#2F80ED" })._tag).toBe("Success");
    expect(create({ ...fields, color: "blue" })._tag).toBe("Failure");
  });
  it("keeps a colored profile readable by a client that predates color", () => {
    const { color: _color, ...olderFields } = BotProfile.fields;
    const older = Schema.decodeUnknownExit(Schema.Struct(olderFields));
    const profile = {
      botId: "helper",
      role: "member",
      name: "Helper",
      avatar: null,
      purpose: "",
      defaultModelSelection: null,
      defaultProjectId: null,
      environmentId: "env",
      sessionThreadId: "thread",
      createdAt: "2026-11-11T00:00:00.000Z",
      updatedAt: "2026-11-11T00:00:00.000Z",
      color: "#2F80ED",
    };
    expect(older(profile)._tag).toBe("Success");
    const { color: _stored, ...legacy } = profile;
    expect(decodeProfile(legacy)._tag).toBe("Success");
  });
});

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
