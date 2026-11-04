import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { ChannelListChildWorkInput } from "./channelGateway.ts";

describe("child work query bounds", () => {
  it("accepts 1 to 50 task ids and rejects 51", () => {
    const valid = Schema.is(ChannelListChildWorkInput);
    expect(valid({ taskIds: [] })).toBe(false);
    expect(valid({ taskIds: Array.from({ length: 50 }, (_, i) => `task-${i}`) })).toBe(true);
    expect(valid({ taskIds: Array.from({ length: 51 }, (_, i) => `task-${i}`) })).toBe(false);
  });
});
