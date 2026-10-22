import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CuaHostStatus } from "./cua.ts";
import { HostStatusEntry } from "./hostStatus.ts";
import { ProviderHostRow } from "./providerHostSync.ts";

const computerUse = {
  enabled: false,
  running: false,
  capability: "partial",
  reason:
    "Agents can take screenshots and use the mouse and keyboard on :1, but cannot read app controls.",
  display: ":1",
} as const;

const metrics = {
  sampledAt: 1,
  cpuUtilization: null,
  cpuCount: 4,
  totalMemoryBytes: 8_000,
  availableMemoryBytes: 4_000,
  loadAvg: null,
  disk: null,
  threads: { running: 0, waiting: 0, queued: 0 },
  quotas: [],
};

describe("computer use on the wire", () => {
  it("decodes driver status from hosts that predate the display check", () => {
    const decode = Schema.decodeUnknownSync(CuaHostStatus);
    expect(decode({ platform: "linux", running: false })).toEqual({
      platform: "linux",
      running: false,
    });
    expect(
      decode({
        platform: "linux",
        running: false,
        display: { capability: "unavailable", reason: "No X display." },
      }).display,
    ).toEqual({ capability: "unavailable", reason: "No X display." });
  });

  it("drops a capability level this client does not know instead of failing the status", () => {
    const decode = Schema.decodeUnknownSync(CuaHostStatus);
    const status = decode({
      platform: "linux",
      running: false,
      display: { capability: "remote-desktop", reason: "Later level." },
    });
    expect(status).toEqual({ platform: "linux", running: false });
  });

  it("keeps host status decoding for older and newer hosts", () => {
    const decode = Schema.decodeUnknownSync(HostStatusEntry);
    const older = decode({ host: "cursor-2", reachability: "ok", metrics });
    expect(older.metrics?.computerUse).toBeUndefined();
    const newer = decode({
      host: "cursor-2",
      reachability: "ok",
      metrics: { ...metrics, computerUse },
    });
    expect(newer.metrics?.computerUse).toEqual(computerUse);
    const later = decode({
      host: "cursor-2",
      reachability: "ok",
      metrics: { ...metrics, computerUse: { ...computerUse, capability: "remote-desktop" } },
    });
    expect(later.reachability).toBe("ok");
    expect(later.metrics?.computerUse).toBeUndefined();
  });

  it("keeps provider × host rows decoding for older and newer hosts", () => {
    const decode = Schema.decodeUnknownSync(ProviderHostRow);
    const row = { host: "cursor-2", status: "ok", providers: [] };
    expect(decode(row).computerUse).toBeUndefined();
    expect(decode({ ...row, computerUse }).computerUse).toEqual(computerUse);
    expect(decode({ ...row, computerUse: { enabled: "yes" } }).computerUse).toBeUndefined();
  });
});
