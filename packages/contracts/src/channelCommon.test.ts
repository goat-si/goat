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
  it("keeps the Slack thread root and external timestamps as strings", () => {
    const json = Schema.toCodecJson(ChannelReplyAddress);
    const address = Schema.decodeUnknownSync(json)(
      Schema.encodeSync(json)(Schema.decodeUnknownSync(json)(slackAddress)),
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
