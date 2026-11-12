import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ChannelListBotArtifactsResult,
  ChannelReadBotArtifactInput,
  ChannelReadBotArtifactResult,
} from "./index.ts";

const roundTrip = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelReadBotArtifactResult));
const toJson = Schema.encodeSync(Schema.fromJsonString(ChannelReadBotArtifactResult));

describe("GOAT Bot artifact reads on the wire", () => {
  it("decodes a listing with the server's artifacts folder and an older one without it", () => {
    const decode = Schema.decodeUnknownSync(ChannelListBotArtifactsResult);
    const artifacts = [{ relativePath: "README", size: 3, modifiedAt: "2026-11-07T10:00:00.000Z" }];
    expect(decode({ root: "/srv/goat-bot/artifacts", artifacts, truncated: false })).toEqual({
      root: "/srv/goat-bot/artifacts",
      artifacts,
      truncated: false,
    });
    expect(decode({ artifacts, truncated: false })).toEqual({ artifacts, truncated: false });
  });

  it("carries every read outcome through JSON unchanged", () => {
    for (const result of [
      {
        status: "chunk",
        relativePath: "charts/q3.png",
        mimeType: "image/png",
        size: 4,
        offset: 0,
        bytesBase64: "iVBORw==",
        version: "1:2:4:5",
        done: true,
      },
      { status: "too_large", relativePath: "big.bin", size: 30, maxBytes: 20 },
      { status: "changed", relativePath: "log.txt" },
      { status: "busy", relativePath: "log.txt" },
    ] as const) {
      expect(roundTrip(toJson(result))).toEqual(result);
    }
  });

  it("refuses a path longer than the server reads", () => {
    const decode = Schema.decodeUnknownSync(ChannelReadBotArtifactInput);
    expect(decode({ relativePath: " a.txt " })).toEqual({ relativePath: "a.txt" });
    expect(() => decode({ relativePath: "a".repeat(513) })).toThrow();
  });
});
