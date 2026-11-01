import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { GoatclawLane } from "./goatclawLanes.ts";

const codec = Schema.fromJsonString(GoatclawLane);
const decode = Schema.decodeUnknownSync(GoatclawLane);
const lane = {
  kind: "review",
  mode: "dispatch",
  profile: "worker",
  host: "macmini",
  providerInstanceId: "codex",
  model: "gpt-5.5",
  parent: { threadId: "thread-parent" },
  reportTo: { threadId: "thread-manager", host: "mac-studio" },
} as const;

describe("goatclaw lane contract", () => {
  it("round-trips a dispatched lane that reports to a manager on another host", () => {
    const decoded = decode(lane);
    expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(decoded))).toEqual(decoded);
  });

  it("keeps a native lane on its parent's host", () => {
    const { host: _host, ...local } = lane;
    expect(decode({ ...local, mode: "native" }).mode).toBe("native");
    expect(() => decode({ ...lane, mode: "native" })).toThrow(
      "A native lane runs on its parent's host.",
    );
    expect(
      decode({ ...lane, mode: "native", parent: { threadId: "thread-parent", host: "macmini" } })
        .host,
    ).toBe("macmini");
  });

  it("rejects unknown kinds and modes", () => {
    expect(() => decode({ ...lane, kind: "deploy" })).toThrow();
    expect(() => decode({ ...lane, mode: "cloud" })).toThrow();
  });
});
