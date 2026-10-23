import { EnvironmentId, type SshHostResult, type SshHostStatus } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  createSshRuntimeState,
  sshRuntimeBuildOrder,
  sshRuntimeRecoveryText,
  sshRuntimeStatusText,
  sshRuntimePhaseText,
} from "./sshRuntime.ts";

const target = { alias: "box", hostname: "box.test", username: "ops", port: 2222 };
const input = { environmentId: EnvironmentId.make("desktop-a"), target };
const waiting: SshHostResult = {
  kind: "ok",
  status: {
    host: "box",
    state: "update_waiting",
    runtimeVersion: "1.2.2",
    requestedVersion: "1.2.3",
  },
};
function harness(reply: SshHostResult = waiting) {
  const registry = AtomRegistry.make();
  const state = createSshRuntimeState(Atom.runtime(Layer.empty), {
    status: () => Effect.succeed(reply),
    update: () => Effect.succeed(reply),
  });
  return { registry, state };
}

describe("Desktop SSH runtime state", () => {
  it.each([
    ["0.4.2", "0.4.3", "Update available", null, -1],
    ["0.5.0", "0.4.3", "Newer than this app", "Update this app to manage it.", 1],
    [
      "0.1.0-dev.b1dc5be3d",
      "0.1.0-dev.1792290331.g52be2c095",
      "Kept",
      "GOAT can't tell whether 0.1.0-dev.b1dc5be3d is older than this app's build, so it leaves it running. Stop it on macmini-cf when its work is done, then reconnect to move it to 0.1.0-dev.1792290331.g52be2c095.",
      undefined,
    ],
    [
      "0.1.0-dev.1792290330.gabcdef0",
      "0.1.0-dev.1792290331.gdef0123",
      "Update available",
      null,
      -1,
    ],
    [
      "0.1.0-dev.1792290332.gabcdef0",
      "0.1.0-dev.1792290331.gdef0123",
      "Newer than this app",
      "Update this app to manage it.",
      1,
    ],
    ["0.4.3", "0.4.3", "Up to date", null, 0],
  ] as const)(
    "explains ready runtime %s against app %s",
    (runtimeVersion, requestedVersion, label, recovery, order) => {
      const status = {
        host: "macmini-cf",
        state: "ready",
        runtimeVersion,
        requestedVersion,
      } as const;
      expect(sshRuntimeStatusText(status)).toBe(`${label} · Runtime ${runtimeVersion}`);
      expect(sshRuntimeRecoveryText(status)).toBe(recovery);
      const actualOrder = sshRuntimeBuildOrder(status);
      expect(actualOrder === undefined ? undefined : Math.sign(actualOrder)).toBe(order);
    },
  );
  it("names the available owner version and keeps setup titles out of phase copy", () => {
    const base = { host: "vps-1", runtimeVersion: "0.4.2", requestedVersion: "0.4.3" };
    expect(sshRuntimeStatusText({ ...base, state: "ready" })).toBe(
      "Update available · Runtime 0.4.2",
    );
    expect(sshRuntimeStatusText({ ...base, state: "ready", runtimeVersion: "0.4.3" })).toBe(
      "Up to date · Runtime 0.4.3",
    );
    expect(sshRuntimeStatusText({ ...base, state: "preparing" })).toBe("Starting setup");
    expect(sshRuntimeStatusText({ ...base, state: "preparing", phase: "checking" })).toBe(
      "Checking GOAT runtime",
    );
  });
  it.each([
    [undefined, "Installing GOAT runtime — first setup can take a few minutes"],
    [{ sentBytes: 0, totalBytes: 70 * 1024 * 1024 }, "Uploading GOAT runtime: 0 of 70 MB"],
    [
      { sentBytes: 23 * 1024 * 1024 + 512, totalBytes: 70 * 1024 * 1024 },
      "Uploading GOAT runtime: 23 of 70 MB",
    ],
    [{ sentBytes: 1024, totalBytes: 1024 * 1024 + 1 }, "Uploading GOAT runtime: 0 of 2 MB"],
    [{ sentBytes: 70 * 1024 * 1024, totalBytes: 70 * 1024 * 1024 }, "Installing GOAT runtime"],
  ])("explains upload progress %j", (upload, text) => {
    expect(
      sshRuntimeStatusText({
        host: "box",
        runtimeVersion: null,
        requestedVersion: "1.2.3",
        state: "preparing",
        phase: "uploading",
        ...(upload === undefined ? {} : { upload }),
      }),
    ).toBe(text);
  });

  it("compares runtime builds instead of guessing blocked state from detail", () => {
    const base = {
      host: "vps-1",
      state: "update_blocked",
      runtimeVersion: "0.5.0",
      requestedVersion: "0.4.3",
    } as const;
    expect(sshRuntimeStatusText({ ...base, detail: "external" })).toBe(
      "vps-1 runs a newer GOAT (0.5.0). Update this app from the update button next to Settings.",
    );
    const external =
      "A GOAT server that this app didn't start is running on vps-1. Stop it on the host, then reconnect.";
    expect(sshRuntimeStatusText({ ...base, runtimeVersion: "0.4.2", detail: "newer" })).toBe(
      external,
    );
    expect(
      sshRuntimeStatusText({
        ...base,
        runtimeVersion: "0.4.3-dev.abc",
        requestedVersion: "0.4.3-dev.def",
        detail: "newer",
      }),
    ).toBe(external);
    expect(sshRuntimeStatusText({ ...base, runtimeVersion: null })).toBe(external);
  });
  it("uses structured waiting reasons and preserves one provider fix", () => {
    const base = {
      host: "vps-1",
      state: "update_waiting",
      runtimeVersion: "0.4.2",
      requestedVersion: "0.4.3",
    } as const;
    expect(sshRuntimeRecoveryText({ ...base, waitingReason: "unknown", detail: "contended" })).toBe(
      "GOAT can't tell whether vps-1 is busy. It retries every 10 minutes.",
    );
    expect(sshRuntimeRecoveryText({ ...base, waitingReason: "contended", detail: "unknown" })).toBe(
      "Another computer is updating vps-1. GOAT will retry.",
    );
    expect(
      sshRuntimeRecoveryText({ ...base, waitingReason: "busy", detail: "unknown" }),
    ).toBeNull();
    expect(sshRuntimeRecoveryText({ ...base, detail: "Another computer" })).toBeNull();
    expect(
      sshRuntimeRecoveryText({
        ...base,
        state: "providers_not_ready",
        providers: {
          checkedAt: "2026-10-18T00:00:00.000Z",
          ready: false,
          fixes: [
            { actor: "human", instruction: "Sign in" },
            { actor: "human", instruction: "Install a provider" },
          ],
        },
      }),
    ).toBe("Sign in");
  });
  it("explains why a changed host key stopped the connection", () => {
    expect(
      sshRuntimeStatusText({
        host: "vps-1",
        state: "failed",
        runtimeVersion: null,
        requestedVersion: "0.4.3",
        failure: {
          reason: "host_key_changed",
          fix: { actor: "human", instruction: "Verify the host key" },
        },
      }),
    ).toBe(
      "The host key for vps-1 changed, so GOAT stopped connecting. If you rebuilt this server, forget it and add it again.",
    );
  });
  it("keeps pending across row subscriptions", async () => {
    const { registry, state } = harness();
    const atom = state.statusAtom(input);
    const unmount = registry.mount(atom);
    await state.refresh.run(registry, input);
    unmount();
    const remount = registry.mount(
      state.statusAtom({ ...input, target: { ...target, hostname: " BOX.TEST " } }),
    );
    expect(registry.get(atom)).toEqual(waiting);
    expect(registry.get(state.statusAtom(input))).toEqual(waiting);
    remount();
    registry.dispose();
  });
  it("separates equal targets in different environments", async () => {
    const { registry, state } = harness();
    await state.refresh.run(registry, input);
    const other = { ...input, environmentId: EnvironmentId.make("desktop-b") };
    expect(registry.get(state.statusAtom(other))).toBeNull();
    state.forget(registry, other);
    expect(registry.get(state.statusAtom(input))).toEqual(waiting);
    registry.dispose();
  });
  it("clears removed progress", async () => {
    const registry = AtomRegistry.make();
    let finish!: (result: SshHostResult) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const result = new Promise<SshHostResult>((resolve) => {
      finish = resolve;
    });
    const state = createSshRuntimeState(Atom.runtime(Layer.empty), {
      status: () =>
        Effect.promise(() => {
          started();
          return result;
        }),
      update: () => Effect.succeed(waiting),
    });
    const pending = state.refresh.run(registry, input);
    await entered;
    const queued = state.update.run(registry, { ...input, mode: "now" });
    state.forget(registry, input);
    finish(waiting);
    await pending;
    await queued;
    expect(registry.get(state.statusAtom(input))).toBeNull();
    registry.dispose();
  });
  it("serializes manual updates while status observes owner progress", async () => {
    const registry = AtomRegistry.make();
    const calls: string[] = [];
    let finish!: (result: SshHostResult) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const result = new Promise<SshHostResult>((resolve) => {
      finish = resolve;
    });
    const preparing: SshHostResult = {
      kind: "ok",
      status: {
        host: "box",
        runtimeVersion: "1.2.2",
        requestedVersion: "1.2.3",
        state: "preparing",
        phase: "uploading",
      },
    };
    const state = createSshRuntimeState(Atom.runtime(Layer.empty), {
      status: () =>
        Effect.sync(() => {
          calls.push("status");
          return preparing;
        }),
      update: () =>
        Effect.promise(() => {
          calls.push("update");
          started();
          return result;
        }),
    });
    const first = state.update.run(registry, { ...input, mode: "when_idle" });
    await entered;
    const second = state.update.run(registry, { ...input, mode: "now" });
    await state.refresh.run(registry, input);
    expect(registry.get(state.statusAtom(input))).toEqual(preparing);
    expect(calls).toEqual(["update", "status"]);
    finish(waiting);
    await Promise.all([first, second]);
    expect(calls).toEqual(["update", "status", "update"]);
    expect(registry.get(state.statusAtom(input))).toEqual(waiting);
    registry.dispose();
  });
  it("does not overwrite a completed update with an older status read", async () => {
    const registry = AtomRegistry.make();
    let finish!: (result: SshHostResult) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const result = new Promise<SshHostResult>((resolve) => {
      finish = resolve;
    });
    const ready: SshHostResult = {
      kind: "ok",
      status: { host: "box", requestedVersion: "1.2.3", state: "ready", runtimeVersion: "1.2.3" },
    };
    const state = createSshRuntimeState(Atom.runtime(Layer.empty), {
      status: () =>
        Effect.promise(() => {
          started();
          return result;
        }),
      update: () => Effect.succeed(ready),
    });
    const read = state.refresh.run(registry, input);
    await entered;
    await state.update.run(registry, { ...input, mode: "when_idle" });
    finish(waiting);
    await read;
    expect(registry.get(state.statusAtom(input))).toEqual(ready);
    registry.dispose();
  });
  it("adds a recovery line only for archive failures", () => {
    const base = { host: "box", runtimeVersion: null, requestedVersion: "1.2.3" };
    const reasons = [
      "archive_unavailable",
      "host_key_changed",
      "start_timeout",
      "missing_tools",
      "unsupported_platform",
    ] as const;
    for (const reason of reasons) {
      const status: SshHostStatus = {
        ...base,
        state: "failed",
        failure: {
          reason,
          ...(reason === "archive_unavailable"
            ? {
                archive: {
                  requestedVersion: "1.2.3",
                  platformKey: "linux-x64",
                  sourcesTried: ["releases"],
                },
              }
            : {}),
          fix: { actor: "human", instruction: "One recovery action" },
        },
      };
      expect(sshRuntimeRecoveryText(status)).toBe(
        reason === "archive_unavailable" ? "One recovery action" : null,
      );
      expect(sshRuntimeStatusText(status)).not.toContain("Ready");
    }
    expect(
      sshRuntimeStatusText({
        ...base,
        state: "failed",
        failure: {
          reason: "archive_unavailable",
          archive: { requestedVersion: "1.2.3", platformKey: "linux-x64", sourcesTried: [] },
          fix: { actor: "human", instruction: "Use a release" },
        },
      }),
    ).toBe("No GOAT runtime for Linux (x64) that works with GOAT 1.2.3 could be installed.");
  });
});

describe("SSH host recovery", () => {
  it("offers a fresh review for untrusted hosts and exposes only public-key registration guidance", () => {
    const base = { host: "vps-1", runtimeVersion: null, requestedVersion: "0.4.2" };
    expect(sshRuntimeRecoveryText({ ...base, state: "untrusted" })).toBe(
      "Add this host again to review its fingerprint.",
    );
    expect(sshRuntimeRecoveryText({ ...base, state: "auth_failed" })).toBe(
      "Register your public SSH key on the host, then try again.",
    );
    expect(
      sshRuntimeRecoveryText({ ...base, state: "auth_failed", publicKey: "ssh-ed25519 public" }),
    ).toContain("GOAT created a key for vps-1.");
  });
});

it.each([
  "approval_expired",
  "authorization_revoked",
  "diagnosis_failed",
  "operation_failed",
] as const)("keeps the server's terminal %s explanation and a single recovery line", (reason) => {
  const status: SshHostStatus = {
    host: "vps-1",
    state: "failed",
    runtimeVersion: "0.4.2",
    requestedVersion: "0.4.2",
    failure: { reason, fix: { actor: "human", instruction: "Ask the agent again." } },
  };
  expect(sshRuntimeStatusText(status)).toBe("Ask the agent again.");
  expect(sshRuntimeStatusText({ ...status, detail: "The setup request could not continue." })).toBe(
    "The setup request could not continue.",
  );
  expect(sshRuntimeRecoveryText(status)).toBeNull();
});

it.each(
  (["archive_unavailable", "drain_unavailable"] as const).flatMap((reason) =>
    (["ready", "providers_not_ready"] as const).map((state) => ({ reason, state })),
  ),
)("explains $reason on $state without hiding provider recovery", ({ state, reason }) => {
  const detail =
    reason === "drain_unavailable"
      ? "Refresh deferred: this runtime could not drain for the refresh"
      : "Upgrade to 0.4.3 deferred";
  const status: SshHostStatus = {
    host: "box",
    state,
    runtimeVersion: "0.4.2",
    requestedVersion: "0.4.3",
    refreshDeferred: {
      reason: "archive_unavailable",
      ...(reason === "drain_unavailable" ? { refreshCause: reason } : {}),
      requestedVersion: "0.4.3",
      detail,
    },
    ...(state === "providers_not_ready"
      ? {
          providers: {
            checkedAt: "2026-10-18T00:00:00.000Z",
            ready: false,
            fixes: [{ actor: "human", instruction: "Sign in" }],
          },
        }
      : {}),
  };
  expect(sshRuntimeStatusText(status)).toBe(
    state === "providers_not_ready"
      ? `Providers need attention · Runtime 0.4.2 · ${detail}`
      : `Running 0.4.2 · ${detail}`,
  );
  expect(sshRuntimeRecoveryText(status)).toBe(
    `${state === "providers_not_ready" ? "Sign in " : ""}GOAT is connected. It retries the upgrade every 10 minutes.`,
  );
  const exact = {
    host: status.host,
    requestedVersion: status.requestedVersion,
    state: "ready",
    runtimeVersion: "0.4.3",
  } as const;
  expect(sshRuntimeStatusText(exact)).toBe("Up to date · Runtime 0.4.3");
  expect(sshRuntimeRecoveryText(exact)).toBeNull();
});

it.each([
  ["connecting", "Connecting to SSH host"],
  ["checking", "Checking GOAT runtime"],
  ["uploading", "Installing GOAT runtime — first setup can take a few minutes"],
  ["starting", "Starting GOAT"],
] as const)("uses honest source-neutral phase copy for %s", (phase, text) => {
  expect(sshRuntimePhaseText(phase)).toBe(text);
  const result = sshRuntimeStatusText({
    host: "fixture",
    state: "preparing",
    phase,
    runtimeVersion: null,
    requestedVersion: "1.0.0",
  });
  expect(result).toBe(text);
  expect(result).not.toMatch(/unknown|90 MB|70 MB|upload/i);
});

it.each([
  ["ready", "Runtime ready"],
  ["stopped", "Not running"],
  ["update_waiting", "Update waits for running work"],
  ["providers_not_ready", "Providers need attention"],
] as const)("does not invent a runtime version for %s", (state, text) => {
  expect(
    sshRuntimeStatusText({
      host: "fixture",
      state,
      runtimeVersion: null,
      requestedVersion: "1.0.0",
    }),
  ).toBe(text);
});
