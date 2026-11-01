import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ChannelMessageMeta, ChannelReplyAddress } from "./index.ts";

const decodeAddress = Schema.decodeUnknownSync(ChannelReplyAddress);
const decodeMeta = Schema.decodeUnknownSync(ChannelMessageMeta);

const slackAddress = {
  kind: "slack",
  connectionId: "slack-1",
  teamId: "T1",
  channelId: "C1",
  rootTs: "1760000000.000100",
};

describe("channel addresses", () => {
  it("round-trips an iMessage chat GUID", () => {
    const address = {
      kind: "imessage" as const,
      connectionId: "imessage-000000000001",
      chatGuid: "iMessage;-;+15550000000",
    };
    const codec = Schema.toCodecJson(ChannelReplyAddress);
    expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(address))).toEqual(address);
    expect(
      decodeMeta({ conversationId: "conv", originKind: "imessage", kind: "inbound" }).originKind,
    ).toBe("imessage");
  });
  it("keeps the Slack thread root and external timestamps as strings", () => {
    const json = Schema.toCodecJson(ChannelReplyAddress);
    const address = Schema.decodeSync(json)(
      Schema.encodeSync(json)(Schema.decodeSync(json)(slackAddress)),
    );
    expect(address).toEqual(slackAddress);
    expect(() => decodeAddress({ ...slackAddress, rootTs: 1760000000.0001 })).toThrow();
  });

  it("rejects blank ids so a missing conversation cannot become a shared key", () => {
    expect(() =>
      decodeMeta({
        conversationId: "  ",
        originKind: "goat",
        kind: "receipt",
      }),
    ).toThrow();
  });

  it("rejects a message kind outside the contract", () => {
    expect(() =>
      decodeMeta({ conversationId: "conv-1", originKind: "goat", kind: "typing" }),
    ).toThrow();
  });
});

describe("memory report metadata", () => {
  it("round-trips report reference", () => {
    const memory = {
      memorySpaceId: "00000000-0000-4000-8000-000000000001",
      environmentId: "env",
      memoryId: "00000000-0000-4000-8000-000000000002",
    };
    expect(
      decodeMeta({ conversationId: "conv", originKind: "goat", kind: "receipt", memory }).memory,
    ).toEqual(memory);
  });
  it("keeps old report metadata unchanged and rejects invalid ids", () => {
    const old = { conversationId: "conv", originKind: "goat", kind: "receipt" };
    expect(decodeMeta(old).memory).toBeUndefined();
    expect(() =>
      decodeMeta({
        ...old,
        memory: { memorySpaceId: "invalid", environmentId: "env", memoryId: "invalid" },
      }),
    ).toThrow();
  });
});
