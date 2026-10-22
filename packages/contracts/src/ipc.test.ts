import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopUpdateStateSchema,
  DesktopSshEnvironmentEnsureInputSchema,
  DesktopSshEnvironmentEnsureResultSchema,
  DesktopSshPreparationProgressSchema,
  DesktopSshPreparationProgressEventSchema,
} from "./ipc.ts";

const decodeSshEnsureInput = Schema.decodeUnknownSync(DesktopSshEnvironmentEnsureInputSchema);
const decodeSshEnsureResult = Schema.decodeUnknownSync(DesktopSshEnvironmentEnsureResultSchema);
const decodeSshProgressEvent = Schema.decodeUnknownSync(DesktopSshPreparationProgressEventSchema);
const decodeDesktopUpdateState = Schema.decodeUnknownSync(DesktopUpdateStateSchema);

describe("DesktopUpdateStateSchema", () => {
  it("decodes update state from a desktop that predates automatic updates", () => {
    const legacy = {
      enabled: true,
      status: "idle",
      channel: "nightly",
      currentVersion: "0.0.45-nightly.20261011.3",
      hostArch: "arm64",
      appArch: "arm64",
      runningUnderArm64Translation: false,
      availableVersion: null,
      downloadedVersion: null,
      releaseNotes: [],
      downloadPercent: null,
      checkedAt: null,
      message: null,
      errorContext: null,
      canRetry: false,
      omittedReleaseCount: 0,
    };
    const state = decodeDesktopUpdateState(legacy);
    expect(state.installPolicy).toBe("restart-when-idle");
    expect(state.pendingUpdate).toBeNull();
    expect(state.recoveryStatus).toBeNull();
    expect(state.installationNotice).toBeUndefined();
    expect(
      decodeDesktopUpdateState({ ...legacy, installationNotice: "Ask an administrator." })
        .installationNotice,
    ).toBe("Ask an administrator.");
  });
});

describe("SSH preparation IPC", () => {
  const target = { alias: "fixture-vps", hostname: "example.invalid", username: null, port: null };
  const active = {
    operationId: "operation-1",
    phase: "uploading",
    hostAnswered: true,
    remainingMs: 899_000,
  };
  const ready = {
    operationId: "operation-1",
    phase: null,
    hostAnswered: true,
    remainingMs: 0,
    outcome: "ready",
    attachmentId: "attachment-1",
    runtimeStatus: {
      host: "fixture-vps",
      state: "ready",
      runtimeVersion: null,
      requestedVersion: "1.0.0",
    },
  };
  const decode = Schema.decodeUnknownSync(DesktopSshPreparationProgressSchema);

  it("accepts legacy inputs and results without ephemeral fields", () => {
    expect(decodeSshEnsureInput({ target })).toEqual({ target });
    const bootstrap = {
      target,
      httpBaseUrl: "http://127.0.0.1:1234/",
      wsBaseUrl: "ws://127.0.0.1:1234/",
      pairingToken: null,
    };
    expect(decodeSshEnsureResult(bootstrap)).toEqual(bootstrap);
  });
  it("decodes active progress and requires explicit terminal outcomes", () => {
    expect(decode(active)).toEqual(active);
    expect(decode(ready)).toEqual(ready);
    for (const outcome of ["pending", "failed", "superseded"]) {
      expect(decode({ ...active, phase: null, outcome }).outcome).toBe(outcome);
    }
    const event = { requestId: "request-1", ...active };
    expect(decodeSshProgressEvent(event)).toEqual(event);
  });
  it.each([
    { ...active, operationId: "" },
    { ...active, operationId: "  " },
    { ...active, phase: "downloading" },
    { ...active, remainingMs: -1 },
    { ...active, remainingMs: 0.5 },
    { ...active, remainingMs: Infinity },
    { ...active, outcome: "ready" },
    { ...active, attachmentId: "a" },
    { ...active, runtimeStatus: ready.runtimeStatus },
    { ...active, phase: null },
    { ...ready, attachmentId: undefined },
    { ...ready, runtimeStatus: undefined },
    { ...ready, outcome: "failed" },
    { ...ready, outcome: "pending" },
    { ...ready, runtimeStatus: { ...ready.runtimeStatus, state: "stopped" } },
  ])("rejects malformed progress %#", (progress) => {
    expect(() => decode(progress)).toThrow();
  });
  it("validates hint and trace metadata without callbacks", () => {
    const input = {
      target,
      requestId: "request-1",
      options: { preparedAttachmentId: "attachment-1", issuePairingToken: true },
      caller: "saved-connection",
      attemptContext: { supervisorId: "supervisor-1", attemptId: 2, routeId: "ssh:fixture-vps" },
    };
    expect(decodeSshEnsureInput(input)).toEqual(input);
    expect(() =>
      decodeSshEnsureInput({
        ...input,
        attemptContext: { ...input.attemptContext, attemptId: -1 },
      }),
    ).toThrow();
    expect(() => decodeSshProgressEvent({ requestId: "", ...active })).toThrow();
  });
});
