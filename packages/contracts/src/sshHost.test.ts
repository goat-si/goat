import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopSshHostStatusInputSchema, DesktopSshRuntimeUpdateInputSchema } from "./ipc.ts";
import {
  SshHostErrorCode,
  SshHostAddInput,
  SshHostAlias,
  SshHostForgetInput,
  SshHostPrepareInput,
  SshHostProbeResult,
  SshHostProbeError,
  SshHostSetupProgress,
  SshHostTrustInput,
  SshHandoffProgressInput,
  SshHandoffProgressResult,
  SshHostFailure,
  SshHostFailureReason,
  SshHostResult,
  SshHostState,
  SshHostStatus,
  SshHostStatusInput,
  SshRuntimePhase,
  SshRuntimeUpdateInput,
  validateSshHostStatus,
  buildSshKeyAuthInstructions,
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
const decodeAdd = Schema.decodeUnknownSync(SshHostAddInput);
const decodeAlias = Schema.decodeUnknownSync(SshHostAlias);
const decodePrepare = Schema.decodeUnknownSync(SshHostPrepareInput);
const decodeForget = Schema.decodeUnknownSync(SshHostForgetInput);
const decodeTrust = Schema.decodeUnknownSync(SshHostTrustInput);
const decodeProbe = Schema.decodeUnknownSync(SshHostProbeResult);
const decodeSetup = Schema.decodeUnknownSync(SshHostSetupProgress);
const decodeProgressInput = Schema.decodeUnknownSync(SshHandoffProgressInput);
const decodeProgress = Schema.decodeUnknownSync(SshHandoffProgressResult);
const decodeUpdateInput = Schema.decodeUnknownSync(SshRuntimeUpdateInput);
const resultCodec = Schema.toCodecJson(SshHostResult);
const decodeResultWire = Schema.decodeUnknownSync(resultCodec);
const encodeResultWire = Schema.encodeSync(resultCodec);
const progressCodec = Schema.toCodecJson(SshHandoffProgressResult);
const decodeProgressWire = Schema.decodeUnknownSync(progressCodec);
const encodeProgressWire = Schema.encodeSync(progressCodec);

const setup = { operationId: "setup-1", generation: 2, stage: "runtime" } as const;
const progress = {
  kind: "available",
  host: "vps-1",
  operationId: setup.operationId,
  generation: setup.generation,
  result: { kind: "ok", status: { ...stopped, setup } },
} as const;

describe("SSH host setup contracts", () => {
  it("accepts address context separately from managed aliases", () => {
    expect(decodeAdd({ address: " 2001:db8::1 " })).toEqual({ address: "2001:db8::1" });
    const input = {
      address: "192.0.2.1",
      user: "root",
      port: 2222,
      alias: "goat-vps_1.example",
      label: "My VPS",
      identityFile: "/Users/runner/.ssh/existing",
    };
    expect(decodeAdd(input)).toEqual(input);
    expect(decodeAlias("a".repeat(64))).toHaveLength(64);
    expect(decodeAlias(" vps-1 ")).toBe("vps-1");
    expect(() => decodeAdd({ address: " " })).toThrow();
    expect(() => decodeAdd({ address: "vps", port: 0 })).toThrow();
    expect(() => decodeAdd({ address: "vps", port: 65536 })).toThrow();
    expect(() => decodeAdd({ address: "vps", port: 22.5 })).toThrow();
  });

  it.each([
    "",
    " ",
    "-option",
    "two hosts",
    "a/b",
    "vps\nother",
    "vps\0",
    "2001:db8::1",
    "a".repeat(65),
  ])("rejects invalid server alias %j in every alias input", (host) => {
    expect(() => decodeAlias(host)).toThrow();
    expect(() => decodeStatusInput({ host })).toThrow();
    expect(() => decodeUpdateInput({ host })).toThrow();
    expect(() => decodePrepare({ host })).toThrow();
    expect(() => decodeForget({ host, stopRuntime: "no" })).toThrow();
    expect(() => decodeAdd({ address: "vps", alias: host })).toThrow();
  });

  it("requires an explicit stop policy and a boolean trust decision", () => {
    for (const stopRuntime of ["if_idle", "no"] as const) {
      expect(decodeForget({ host: "vps-1", stopRuntime })).toEqual({ host: "vps-1", stopRuntime });
    }
    for (const stopRuntime of [undefined, "force", true]) {
      expect(() => decodeForget({ host: "vps-1", stopRuntime })).toThrow();
    }
    expect(decodePrepare({ host: "vps-1" })).toEqual({ host: "vps-1" });
    for (const accepted of [true, false]) {
      expect(decodeTrust({ probeId: "probe-1", accepted })).toEqual({
        probeId: "probe-1",
        accepted,
      });
    }
    expect(() => decodeTrust({ probeId: "", accepted: true })).toThrow();
    expect(() => decodeTrust({ probeId: "probe-1", accepted: "yes" })).toThrow();
    const probe = {
      probeId: "probe-1",
      host: "vps-1",
      human: { location: "Origin Mac", fingerprint: "SHA256:negotiated-key" },
      includeRequired: true,
    };
    expect(decodeProbe(probe)).toEqual(probe);
    expect(() => decodeProbe({ ...probe, human: undefined })).toThrow();
  });

  it.each(["2001:db8::1", "a".repeat(100)])(
    "preserves existing Desktop host %s through request and renderer result codecs",
    (hostname) => {
      const target = {
        alias: hostname.includes(":") ? `[${hostname}]:22` : hostname,
        hostname,
        username: "root",
        port: 22,
      };
      const request = decodeDesktopStatusInput({ target });
      expect(request.target).toEqual(target);
      const snapshot = { ...stopped, host: request.target.hostname };
      const result = { kind: "ok", status: snapshot } as const;
      const wire = JSON.parse(JSON.stringify(encodeResultWire(result)));
      expect(decodeResultWire(wire)).toEqual(result);
      expect(() => decodeStatusInput({ host: hostname })).toThrow();
    },
  );

  it.each(["runtime", "diagnosis", "complete"] as const)(
    "preserves the current setup operation at stage %s",
    (stage) => {
      const result = {
        kind: "ok",
        status: { ...stopped, state: "ready", setup: { ...setup, stage } },
      } as const;
      expect(decodeResultWire(JSON.parse(JSON.stringify(encodeResultWire(result))))).toEqual(
        result,
      );
      expect(decodeStatus({ ...stopped, state: "ready" }).setup).toBeUndefined();
    },
  );

  it("rejects malformed setup markers", () => {
    for (const invalid of [
      { ...setup, stage: "waiting" },
      { ...setup, operationId: " " },
      { ...setup, generation: 0.5 },
      { ...setup, generation: "2" },
      { ...setup, generation: undefined },
    ]) {
      expect(() => decodeSetup(invalid)).toThrow();
      expect(() => decodeResult({ kind: "ok", status: { ...stopped, setup: invalid } })).toThrow();
    }
  });

  it("allows managed public keys only in auth_failed snapshots", () => {
    const publicKey = "ssh-ed25519 public-key";
    const result = { kind: "ok", status: { ...stopped, state: "auth_failed", publicKey } } as const;
    expect(decodeResultWire(JSON.parse(JSON.stringify(encodeResultWire(result))))).toEqual(result);
    for (const state of SshHostState.literals) {
      if (state === "auth_failed") continue;
      const status = {
        ...stopped,
        state,
        publicKey,
        ...(state === "preparing" ? { phase: "checking" as const } : {}),
        ...(state === "failed" ? { failure: { reason: "missing_tools" as const, fix } } : {}),
        ...(state === "providers_not_ready" ? { providers } : {}),
      };
      expect(validateSshHostStatus(status)).toBe(false);
      expect(() => decodeStatus(status)).toThrow();
    }
  });

  it("binds progress to thread/handoff ids and the same operation and generation", () => {
    const input = { threadId: "thread-1", handoffId: "handoff-1" };
    expect(decodeProgressInput(input)).toEqual(input);
    expect(() => decodeProgressInput({ handoffId: "handoff-1" })).toThrow();
    expect(() => decodeProgressInput({ threadId: "thread-1" })).toThrow();
    expect(decodeProgressWire(JSON.parse(JSON.stringify(encodeProgressWire(progress))))).toEqual(
      progress,
    );
    for (const mismatched of [
      { ...setup, operationId: "setup-old" },
      { ...setup, generation: 1 },
    ]) {
      expect(() =>
        decodeProgress({
          ...progress,
          result: { kind: "ok", status: { ...stopped, setup: mismatched } },
        }),
      ).toThrow();
    }
    expect(decodeProgress({ ...progress, result: { kind: "ok", status: stopped } }).kind).toBe(
      "available",
    );
    expect(
      decodeProgress({
        ...progress,
        result: { kind: "error", code: "cancelled", message: "Expired" },
      }).kind,
    ).toBe("available");
    expect(() => decodeProgress({ ...progress, generation: 2.5 })).toThrow();
    expect(() => decodeProgress({ ...progress, operationId: "" })).toThrow();
    expect(() => decodeProgress({ ...progress, host: "2001:db8::1" })).toThrow();
    expect(() => decodeProgress({ ...progress, result: undefined })).toThrow();
    for (const reason of ["not_ssh", "expired", "superseded"] as const) {
      expect(decodeProgress({ kind: "unavailable", reason })).toEqual({
        kind: "unavailable",
        reason,
      });
    }
    expect(() => decodeProgress({ kind: "unavailable", reason: "unknown" })).toThrow();
  });

  it("keeps private trust context out of progress results", () => {
    expect(
      decodeProgress({
        ...progress,
        fingerprint: "SHA256:private",
        human: { location: "origin" },
        args: { private: true },
      }),
    ).toEqual(progress);
  });
});

describe("SSH key-auth instructions", () => {
  const context = { originLabel: "Home Mac", host: "vps-1", user: "root", port: 2222 };

  it("gives generated-key guidance and a command for the origin terminal", () => {
    const result = buildSshKeyAuthInstructions({
      ...context,
      generatedKey: true,
      publicKey: "ssh-ed25519 public-key",
      publicKeyPath: "/home/runner/.ssh/goat-hosts/id_ed25519.pub",
    });
    expect(result.originLabel).toBe("Home Mac");
    expect(result.instruction).toBe(
      "GOAT created a key for vps-1. Add this public key to the server. Most providers ask for it when you create a server. Run this on Home Mac.",
    );
    expect(result.publicKey).toBe("ssh-ed25519 public-key");
    expect(result.command).toBe(
      "ssh-copy-id -i '/home/runner/.ssh/goat-hosts/id_ed25519.pub' -p '2222' 'root@vps-1'",
    );
  });

  it("quotes each argument including apostrophes and shell metacharacters", () => {
    const result = buildSshKeyAuthInstructions({
      ...context,
      host: "vps;$(touch nope)",
      user: "o'brien",
      publicKeyPath: "/home/O'Brien/key $(touch nope).pub",
    });
    expect(result.command).toBe(
      "ssh-copy-id -i '/home/O'\\''Brien/key $(touch nope).pub' -p '2222' 'o'\\''brien@vps;$(touch nope)'",
    );
  });

  it("guides existing-key or agent-only authentication without inventing a key or command", () => {
    const result = buildSshKeyAuthInstructions(context);
    expect(result.instruction).toBe(
      "vps-1 refused the SSH key. Add your public key to the server, then try again. Run this on Home Mac.",
    );
    expect(result.instruction).toContain("Run this on Home Mac");
    expect(result.instruction).not.toContain("GOAT created");
    expect(result).not.toHaveProperty("publicKey");
    expect(result).not.toHaveProperty("command");
  });
});

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

const decodeProbeError = Schema.decodeUnknownSync(SshHostProbeError);
it("exposes typed probe failures without changing the successful probe shape", () => {
  for (const reason of [
    "unreachable",
    "connection_refused",
    "invalid_request",
    "alias_conflict",
    "operation_failed",
  ] as const) {
    expect(
      decodeProbeError({ _tag: "SshHostProbeError", host: "box", reason, message: "Try again." })
        .reason,
    ).toBe(reason);
  }
  expect(() =>
    decodeProbeError({
      _tag: "SshHostProbeError",
      host: "box",
      reason: "unknown",
      message: "Try again.",
    }),
  ).toThrow();
});
it("key-auth commands are restricted to auth_failed and match any exposed generated public key", () => {
  const keyAuth = buildSshKeyAuthInstructions({
    originLabel: "Origin",
    host: "box",
    user: "root",
    port: 2222,
    generatedKey: true,
    publicKey: "ssh-ed25519 AAAA",
    publicKeyPath: "/origin/key.pub",
  });
  const status = { ...stopped, state: "auth_failed", publicKey: "ssh-ed25519 AAAA", keyAuth };
  expect(decodeStatus(status).keyAuth?.command).toBe(
    "ssh-copy-id -i '/origin/key.pub' -p '2222' 'root@box'",
  );
  expect(() => decodeStatus({ ...status, state: "ready" })).toThrow();
  expect(() => decodeStatus({ ...status, publicKey: "another key" })).toThrow();
});
