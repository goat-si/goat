import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CuaHostStatus, DesktopCuaWatch } from "./cua.ts";
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
  it("accepts watch messages from older servers and preserves optional approved app ids", () => {
    const decode = Schema.decodeUnknownSync(DesktopCuaWatch);
    const watch = { version: 1, type: "cuaWatch", seq: 1, active: true };
    expect(decode(watch)).toEqual(watch);
    const apps = ["com.example.notes", "C:\\work\\fixture.exe"];
    expect(decode({ ...watch, apps })).toEqual({ ...watch, apps });
    expect(() => decode({ ...watch, apps: [7] })).toThrow();
  });

  it("preserves reported readiness and signals, and drops future optional shapes independently", () => {
    const decode = Schema.decodeUnknownSync(CuaHostStatus);
    const readiness = {
      grants: { accessibility: "granted", screenCapture: "pending" },
      helper: "authenticated",
      capture: "pending",
      tree: "ready",
      input: "foregroundOnly",
      blockers: ["restartRequired"],
      reasons: ["Waiting for consent."],
    };
    const signals = { humanInput: "supported", privateMode: "unsupported" };
    const status = { platform: "linux", running: true, readiness, signals, tools: "available" };
    expect(decode(status)).toEqual(status);
    expect(
      decode({ ...status, readiness: { ...readiness, helper: "future" }, tools: "future" }),
    ).toEqual({ platform: "linux", running: true, signals });
    expect(
      decode({ ...status, signals: { ...signals, humanInput: "future" } }).signals,
    ).toBeUndefined();
  });

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

  it("keeps host status when the helper's readiness carries a step this client does not know", () => {
    const decode = Schema.decodeUnknownSync(CuaHostStatus);
    const readiness = {
      grants: { accessibility: "granted", screenCapture: "pending" },
      helper: "authenticated",
      capture: "pending",
      tree: "unavailable",
      input: "unavailable",
      blockers: [],
      reasons: ["Screen Recording is waiting for an answer."],
    };
    const signals = { privateMode: "supported", humanInput: "unsupported" };
    expect(decode({ platform: "darwin", running: true, readiness, signals })).toEqual({
      platform: "darwin",
      running: true,
      readiness,
      signals,
    });
    expect(
      decode({
        platform: "darwin",
        running: true,
        readiness: { ...readiness, blockers: ["remoteSessionActive"] },
        signals,
      }),
    ).toEqual({ platform: "darwin", running: true, signals });
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
