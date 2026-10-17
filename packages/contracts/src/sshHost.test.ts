import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopSshHostStatusInputSchema, DesktopSshRuntimeUpdateInputSchema } from "./ipc.ts";
import {
  SshHostErrorCode,
  SshHostFailure,
  SshHostFailureReason,
  SshHostResult,
  SshHostState,
  SshHostStatus,
  SshHostStatusInput,
  SshRuntimePhase,
  SshRuntimeUpdateInput,
  validateSshHostStatus,
} from "./sshHost.ts";

const stopped = {
  host: "vps-1",
  state: "stopped",
  runtimeVersion: "0.4.2",
  requestedVersion: "0.4.3",
} satisfies SshHostStatus;
const fix = { actor: "human", instruction: "Install git on the host, then try again." } as const;
const archive = {
  requestedVersion: "0.4.3",
  platformKey: "linux-x64",
  sourcesTried: ["bundle", "cache", "goat-releases-https", "gh"],
};
const providers = {
  checkedAt: "2026-10-18T00:00:00.000Z",
  ready: false,
  fixes: [{ ...fix, path: "provider.setup", handoff: "terminal", command: "git --version" }],
} as const;
const decodeStatus = Schema.decodeUnknownSync(SshHostStatus);
const decodeResult = Schema.decodeUnknownSync(SshHostResult);
const decodeStatusInput = Schema.decodeUnknownSync(SshHostStatusInput);
const decodeDesktopStatusInput = Schema.decodeUnknownSync(DesktopSshHostStatusInputSchema);

describe("SSH host contracts", () => {
  it("keeps waiting reasons exclusive to pending runtime updates", () => {
    for (const waitingReason of ["busy", "unknown", "contended"] as const) {
      const waiting = { ...stopped, state: "update_waiting", waitingReason } as const;
      expect(decodeStatus(waiting).waitingReason).toBe(waitingReason);
      expect(decodeResult({ kind: "ok", status: waiting }).status?.waitingReason).toBe(
        waitingReason,
      );
      for (const state of SshHostState.literals) {
        if (state === "update_waiting") continue;
        const status = {
          ...stopped,
          state,
          waitingReason,
          ...(state === "preparing" ? { phase: "checking" as const } : {}),
          ...(state === "failed" ? { failure: { reason: "missing_tools" as const, fix } } : {}),
          ...(state === "providers_not_ready" ? { providers } : {}),
        };
        expect(validateSshHostStatus(status)).toBe(false);
        expect(() => decodeStatus(status)).toThrow();
      }
    }
    expect(() =>
      decodeStatus({ ...stopped, state: "update_waiting", waitingReason: "other" }),
    ).toThrow();
  });
  it("round-trips stopped and nested result envelopes", () => {
    const codec = Schema.toCodecJson(SshHostResult);
    const results = [
      { kind: "ok", status: stopped },
      { kind: "ok", status: { ...stopped, runtimeVersion: null } },
      {
        kind: "ok",
        status: { ...stopped, state: "providers_not_ready", providers },
        publicKey: "ssh-ed25519 public-key",
        providers,
      },
      {
        kind: "error",
        code: "operation_failed",
        message: "vps-1: SSH connection closed",
        status: stopped,
        fix: { actor: "agent", instruction: "Try again" },
      },
      {
        kind: "error",
        code: "host_unreachable",
        message: "Can't reach vps-1.",
      },
      {
        kind: "error",
        code: "operation_failed",
        message: "GOAT 0.4.3 isn't available to install on vps-1.",
        status: {
          ...stopped,
          state: "failed",
          failure: { reason: "archive_unavailable", archive, fix },
        },
      },
      {
        kind: "needs_human",
        handoff: {
          handoffId: "handoff-1",
          kind: "approval",
          title: "Update GOAT on vps-1",
          state: "pending",
          expiresAt: null,
          targetPath: "ssh.runtime_update",
        },
        next: { after: "approval", call: "goat_ssh_host_status" },
        status: { ...stopped, state: "update_waiting", detail: "busy" },
      },
    ];
    for (const result of results) {
      const decoded = Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(result)));
      expect(JSON.parse(JSON.stringify(Schema.encodeSync(codec)(decoded)))).toEqual(result);
    }
    expect(decodeStatusInput({ host: "vps-1" })).toEqual({
      host: "vps-1",
    });
  });

  it("keeps archive metadata exclusive to archive failures", () => {
    const decodeFailure = Schema.decodeUnknownSync(SshHostFailure);
    expect(decodeFailure({ reason: "archive_unavailable", archive, fix }).archive).toEqual(archive);
    expect(
      decodeFailure({
        reason: "archive_unavailable",
        archive: { ...archive, platformKey: null },
        fix,
      }).archive?.platformKey,
    ).toBeNull();
    expect(() => decodeFailure({ reason: "archive_unavailable", fix })).toThrow();
    for (const reason of SshHostFailureReason.literals) {
      if (reason === "archive_unavailable") continue;
      const status = { ...stopped, state: "failed", failure: { reason, fix } };
      expect(decodeStatus(status).failure?.reason).toBe(reason);
      expect(() => decodeFailure({ reason, archive, fix })).toThrow();
      expect(() =>
        decodeResult({ kind: "ok", status: { ...status, failure: { reason, archive, fix } } }),
      ).toThrow();
    }
  });

  it("keeps provider readiness conditional on a ready runtime", () => {
    const notReady = { ...stopped, state: "providers_not_ready", providers };
    expect(decodeStatus(notReady).providers).toEqual(providers);
    for (const status of [
      { ...notReady, providers: undefined },
      { ...notReady, providers: { ...providers, ready: true } },
      { ...notReady, runtimeVersion: null },
      { ...notReady, state: "ready" },
    ]) {
      expect(() => decodeStatus(status)).toThrow();
    }
    for (const status of [
      { ...stopped, providers },
      { ...stopped, state: "preparing", phase: "checking", providers },
      { ...stopped, state: "failed", failure: { reason: "missing_tools", fix }, providers },
    ]) {
      expect(decodeStatus(status).state).toBe(status.state);
    }
    expect(
      decodeStatus({ ...stopped, state: "ready", providers: { ...providers, ready: true } }).state,
    ).toBe("ready");
    const result = { kind: "ok", status: notReady, providers };
    expect(decodeResult(result).kind).toBe("ok");
    for (const summary of [
      { ...providers, ready: true },
      { ...providers, checkedAt: "2026-10-18T00:01:00.000Z" },
      { ...providers, fixes: [] },
      { ...providers, fixes: [{ ...providers.fixes[0], instruction: "Sign in again." }] },
    ]) {
      expect(() => decodeResult({ ...result, providers: summary })).toThrow();
    }
    expect(() => decodeResult({ ...result, status: stopped })).toThrow();
  });

  it("rejects unknown states and phases", () => {
    expect(() => decodeStatus({ ...stopped, state: "unknown" })).toThrow();
    expect(() => decodeStatus({ ...stopped, state: "preparing", phase: "ready" })).toThrow();
    expect(() => decodeStatus({ ...stopped, state: "preparing", phase: "unknown" })).toThrow();
    expect(() => decodeResult({ kind: "unknown", status: stopped })).toThrow();
    expect(() =>
      decodeResult({ kind: "error", code: "runtime_not_running", message: "Stopped" }),
    ).toThrow();
    for (const code of SshHostErrorCode.literals) {
      expect(decodeResult({ kind: "error", code, message: "vps-1: request failed" }).kind).toBe(
        "error",
      );
    }
    for (const state of SshHostState.literals) {
      const status = {
        ...stopped,
        state,
        ...(state === "preparing" ? { phase: "connecting" } : {}),
        ...(state === "failed" ? { failure: { reason: "missing_tools", fix } } : {}),
        ...(state === "providers_not_ready" ? { providers } : {}),
      };
      expect(decodeStatus(status).state).toBe(state);
    }
  });

  it("rejects preparing without phase and failed without failure", () => {
    for (const state of ["preparing", "failed"] as const) {
      const status = { ...stopped, state };
      expect(validateSshHostStatus(status)).toBe(false);
      expect(() => decodeStatus(status)).toThrow();
      expect(() => decodeResult({ kind: "ok", status })).toThrow();
    }
    for (const phase of SshRuntimePhase.literals) {
      const status = { ...stopped, state: "preparing", phase } as const;
      expect(validateSshHostStatus(status)).toBe(true);
      expect(decodeStatus(status).phase).toBe(phase);
    }
    for (const state of SshHostState.literals) {
      if (state === "preparing") continue;
      const status = { ...stopped, state, phase: "checking" } as const;
      expect(validateSshHostStatus(status)).toBe(false);
      expect(() => decodeStatus(status)).toThrow();
    }
    const needsHuman = {
      kind: "needs_human",
      handoff: {
        handoffId: "handoff-1",
        kind: "terminal",
        title: "Register the public key",
        state: "pending",
        expiresAt: null,
        targetPath: "ssh.host_prepare",
      },
      next: { after: "terminal", call: "goat_ssh_host_prepare" },
      status: { ...stopped, state: "auth_failed" },
    };
    expect(decodeResult(needsHuman).kind).toBe("needs_human");
    for (const key of ["handoff", "next", "status"] as const) {
      const incomplete = { ...needsHuman, [key]: undefined };
      expect(() => decodeResult(incomplete)).toThrow();
    }
    expect(() =>
      decodeResult({ ...needsHuman, next: { after: "ready", call: "goat_ssh_host_status" } }),
    ).toThrow();
    expect(() =>
      decodeResult({ ...needsHuman, next: { after: "approval", call: "goat_ssh_runtime_update" } }),
    ).toThrow();
  });

  it("keeps omitted mode idle-safe", () => {
    const target = { alias: "vps-1", hostname: "192.0.2.1", username: "runner", port: 2222 };
    const decodeUpdate = Schema.decodeUnknownSync(SshRuntimeUpdateInput);
    const decodeDesktopUpdate = Schema.decodeUnknownSync(DesktopSshRuntimeUpdateInputSchema);
    expect(decodeUpdate({ host: "vps-1" })).toEqual({ host: "vps-1" });
    expect(decodeDesktopUpdate({ target })).toEqual({ target });
    expect(decodeDesktopStatusInput({ target })).toEqual({
      target,
    });
    for (const mode of ["when_idle", "now"] as const) {
      expect(decodeUpdate({ host: "vps-1", mode }).mode).toBe(mode);
      expect(decodeDesktopUpdate({ target, mode }).mode).toBe(mode);
    }
    for (const mode of ["force", true, null]) {
      expect(() => decodeUpdate({ host: "vps-1", mode })).toThrow();
      expect(() => decodeDesktopUpdate({ target, mode })).toThrow();
    }
    expect(() => decodeDesktopUpdate({ host: "vps-1" })).toThrow();
    expect(() => decodeDesktopUpdate({ target: { alias: "vps-1" } })).toThrow();
  });
});
