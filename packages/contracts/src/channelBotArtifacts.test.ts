import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ChannelReadBotArtifactInput, ChannelReadBotArtifactResult } from "./index.ts";

const roundTrip = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelReadBotArtifactResult));
const toJson = Schema.encodeSync(Schema.fromJsonString(ChannelReadBotArtifactResult));

describe("GOAT Bot artifact reads on the wire", () => {
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
