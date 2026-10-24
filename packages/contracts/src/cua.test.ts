import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ComputerUseCallReservation,
  ComputerUseCallAdmission,
  ComputerUseLeaseUpdate,
  ComputerUseForegroundGrant,
  ComputerUseRequestInput,
  CuaHostStatus,
} from "./cua.ts";
import { HostStatusEntry } from "./hostStatus.ts";
import { ProviderHostRow } from "./providerHostSync.ts";

const decodeCallReservation = Schema.decodeUnknownSync(ComputerUseCallReservation);
const decodeLeaseUpdate = Schema.decodeUnknownSync(ComputerUseLeaseUpdate);
const decodeCallAdmission = Schema.decodeUnknownSync(ComputerUseCallAdmission);

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
  it("preserves optional foreground authority and rejects malformed grant identities and expiry", () => {
    const grant = {
      handoffId: "handoff:foreground",
      purpose: "Check build",
      target: "desktop",
      expiresAtMillis: 1234,
    };
    const decode = Schema.decodeUnknownSync(ComputerUseForegroundGrant);
    expect(decode(grant)).toEqual(grant);
    for (const invalid of [
      { ...grant, handoffId: "" },
      { ...grant, purpose: " " },
      { ...grant, target: "app" },
      ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity].map((expiresAtMillis) => ({
        ...grant,
        expiresAtMillis,
      })),
    ])
      expect(() => decode(invalid)).toThrow();
    const active = {
      state: "active",
      controlId: "control:one",
      expiresAt: "later",
      foreground: [grant],
      idleEpoch: 2,
    };
    expect(decodeLeaseUpdate(active)).toEqual(active);
    const reserve = {
      action: "reserve",
      controlId: "control:one",
      connectionId: "driver:one",
      callId: "call:one",
      interruptions: 0,
      idleEpoch: 2,
      name: "bring_to_front",
      args: {},
      foregroundGrantId: grant.handoffId,
    };
    expect(decodeCallReservation(reserve)).toEqual(reserve);
    expect(
      decodeCallAdmission({
        status: "refused",
        detail: "foreground_not_approved",
      }),
    ).toEqual({ status: "refused", detail: "foreground_not_approved" });
    const request = Schema.decodeUnknownSync(ComputerUseRequestInput);
    expect(request({ purpose: "Check" })).toEqual({ purpose: "Check" });
    for (const foreground of [true, false])
      expect(request({ purpose: "Check", foreground })).toEqual({ purpose: "Check", foreground });
    for (const foreground of ["true", 1, {}])
      expect(() => request({ purpose: "Check", foreground })).toThrow();
  });
  it("roundtrips execution ownership and refuses malformed or unknown reservation actions", () => {
    const decode = Schema.decodeUnknownSync(ComputerUseCallReservation);
    const request = {
      action: "reserve",
      controlId: "control:one",
      connectionId: "driver:one",
      callId: "one",
      interruptions: 0,
      idleEpoch: 0,
      name: "type_text",
      args: { pid: 42, window_id: 7 },
    };
    expect(decode(request)).toEqual(request);
    const { idleEpoch: _idleEpoch, ...missingIdleEpoch } = request;
    for (const invalid of [
      missingIdleEpoch,
      { ...request, action: "steal" },
      { ...request, connectionId: "" },
      { ...request, interruptions: -1 },
      { ...request, idleEpoch: -1 },
      { ...request, name: "" },
    ])
      expect(() => decode(invalid)).toThrow();
    const refusal = { status: "refused", detail: "target_busy", holderThreadId: "thread:holder" };
    expect(decodeCallAdmission(refusal)).toEqual(refusal);
    expect(decodeLeaseUpdate({ state: "idle", controlId: "control:one" })).toEqual({
      state: "idle",
      controlId: "control:one",
    });
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
