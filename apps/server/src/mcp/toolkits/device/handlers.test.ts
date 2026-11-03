import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { agentDeviceQuickStart, pngDimensions, resolveHostId } from "./handlers.ts";

const device = {
  hostId: "local",
  id: "ABCD-1234",
  platform: "ios" as const,
  name: "iPhone 17 Pro",
  version: "iOS 27.0",
  booted: true,
  physical: false,
};

describe("device tool helpers", () => {
  it.effect("rejects ambiguous labels while preferring an exact host ID", () =>
    Effect.gen(function* () {
      const hosts = [
        {
          id: "one",
          label: "Mini",
          kind: "ssh" as const,
          platforms: [],
          hubInstalled: true,
          agentDeviceInstalled: true,
        },
        {
          id: "two",
          label: "mini",
          kind: "ssh" as const,
          platforms: [],
          hubInstalled: true,
          agentDeviceInstalled: true,
        },
      ];
      expect(yield* resolveHostId(hosts, "one")).toBe("one");
      const error = yield* Effect.flip(resolveHostId(hosts, "MINI"));
      expect(error.reason).toContain("Mini (one), mini (two)");
    }),
  );

  it("uses the absolute launcher in every quick-start command", () => {
    const text = agentDeviceQuickStart(
      device,
      ["--session", "thread-1", "--config", "/tmp/host.json"],
      "/tmp/t3 tools/agent-device",
    );
    expect(text).toContain(
      "'/tmp/t3 tools/agent-device' snapshot -i --session thread-1 --config /tmp/host.json",
    );
    expect(text).not.toContain("  agent-device ");
    expect(text).not.toContain("is on PATH");
  });

  it("reads PNG dimensions from the IHDR chunk", () => {
    const png = new Uint8Array(24);
    new DataView(png.buffer).setUint32(0, 0x89504e47);
    new DataView(png.buffer).setUint32(4, 0x0d0a1a0a);
    new DataView(png.buffer).setUint32(12, 0x49484452);
    new DataView(png.buffer).setUint32(16, 1179);
    new DataView(png.buffer).setUint32(20, 2556);
    expect(pngDimensions(png)).toEqual({ width: 1179, height: 2556 });
    expect(pngDimensions(new Uint8Array([1, 2, 3]))).toEqual({ width: 0, height: 0 });
  });
});
