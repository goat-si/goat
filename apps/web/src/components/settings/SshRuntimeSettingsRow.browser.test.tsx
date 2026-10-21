import { fakeTimers } from "../../../test/render";
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  type SshHostResult,
  type SshHostStatus,
  type DesktopSshEnvironmentTarget,
  type SshRuntimeUpdateMode,
} from "@goat/contracts";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const owner = vi.hoisted(() => ({
  status: vi.fn<(target: DesktopSshEnvironmentTarget) => Promise<SshHostResult>>(),
  update:
    vi.fn<
      (target: DesktopSshEnvironmentTarget, mode: SshRuntimeUpdateMode) => Promise<SshHostResult>
    >(),
}));
vi.mock("~/state/sshRuntime", async () => {
  const { createSshRuntimeState } = await import("@goat/client-runtime/state/sshRuntime");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const { Atom } = await import("effect/reactivity");
  return {
    sshRuntime: createSshRuntimeState(Atom.runtime(Layer.empty), {
      status: (target) => Effect.promise(() => owner.status(target)),
      update: (target, mode) => Effect.promise(() => owner.update(target, mode)),
    }),
  };
});
import { sshRuntime } from "~/state/sshRuntime";
import { SshRuntimeSettingsRow } from "./SshRuntimeSettingsRow";

const target = { alias: "vps-1", hostname: "10.0.0.2", username: "ops", port: 2222 };
const input = { environmentId: EnvironmentId.make("saved-ssh"), target };
const base = { host: "vps-1", runtimeVersion: "0.4.2", requestedVersion: "0.4.3" };
let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLDivElement;
let mounted: boolean;
let reply: SshHostResult;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mounted = true;
  reply = { kind: "ok", status: { ...base, state: "update_waiting" } };
  owner.status.mockReset().mockImplementation(async () => reply);
  owner.update.mockReset().mockImplementation(async () => reply);
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  registry.dispose();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(status?: SshHostStatus, enabled = true) {
  if (status) reply = { kind: "ok", status };
  await act(async () =>
    root.render(
      <RegistryContext value={registry}>
        <SshRuntimeSettingsRow {...input} enabled={enabled} />
      </RegistryContext>,
    ),
  );
  if (enabled)
    await act(async () => {
      await sshRuntime.refresh.run(registry, input);
    });
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === text,
  );
}
async function click(text: string, scope: ParentNode = document) {
  const node = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === text,
  );
  expect(node, `visible control: ${text}`).toBeDefined();
  await act(async () => node!.click());
}
async function settle() {
  await act(async () => {
    await sshRuntime.refresh.run(registry, input);
  });
}

describe("saved SSH runtime row", () => {
  it("hides runtime updates for the current ready version", async () => {
    await render({ ...base, state: "ready", runtimeVersion: "0.4.3" });
    expect(container.textContent).not.toContain("Runtime 0.4.3");
    expect(button("Update runtime")).toBeUndefined();
    expect(button("Update now")).toBeUndefined();
    expect(button("Update")).toBeUndefined();
  });
  it.each(["failed", "stopped", "ready"] as const)(
    "offers the owner update for %s without a generic Update",
    async (state) => {
      await render({
        ...base,
        state,
        ...(state === "failed"
          ? {
              failure: {
                reason: "start_timeout",
                fix: { actor: "agent", instruction: "Try again" },
              },
            }
          : {}),
      });
      await click("Update runtime");
      await settle();
      expect(owner.update).toHaveBeenCalledWith(target, "when_idle");
      expect(button("Update")).toBeUndefined();
      expect(button("Retry update")).toBeUndefined();
    },
  );
  it("keeps blocked-runtime actions in the canonical subtitle", async () => {
    await render({ ...base, state: "update_blocked", runtimeVersion: "0.5.0", detail: "newer" });
    expect(container.textContent).not.toContain("runs a newer GOAT");
    expect(button("Update runtime")).toBeUndefined();
    expect(button("Update now")).toBeUndefined();
  });
  it("cancels immediate updates without calling the owner, then confirms the original route", async () => {
    await render();
    await click("Update now");
    expect(document.body.textContent).toContain(
      "Running agent work gets up to a minute to finish, then continues on the new version.",
    );
    expect(owner.update).not.toHaveBeenCalled();
    await click("Cancel");
    expect(owner.update).not.toHaveBeenCalled();
    await click("Update now");
    const confirmation = document.querySelector('[role="alertdialog"]');
    expect(confirmation).not.toBeNull();
    await click("Update now", confirmation!);
    await settle();
    expect(owner.update).toHaveBeenCalledExactlyOnceWith(target, "now");
  });
  it("keeps archive metadata and recovery visible until a successful owner update", async () => {
    await render({
      ...base,
      state: "failed",
      runtimeVersion: null,
      failure: {
        reason: "archive_unavailable",
        archive: {
          requestedVersion: "0.4.3",
          platformKey: "linux-x64",
          sourcesTried: ["goat-releases"],
        },
        fix: { actor: "human", instruction: "Install a published release" },
      },
    });
    expect(container.textContent).not.toContain("isn't available to install");
    expect(container.textContent).not.toContain("Target");
    expect(container.textContent).toContain("Install a published release");
    expect(container.textContent).not.toContain("Up to date");
    owner.update.mockImplementation(async () => {
      reply = { kind: "ok", status: { ...base, state: "ready", runtimeVersion: "0.4.3" } };
      return reply;
    });
    await click("Update runtime");
    await settle();
    expect(container.textContent).not.toContain("Runtime 0.4.3");
    expect(container.textContent).not.toContain("isn't available to install");
    expect(button("Update runtime")).toBeUndefined();
    expect(button("Update now")).toBeUndefined();
  });
  it.each([
    ["preparing", 1_000],
    ["update_waiting", 10_000],
  ] as const)(
    "refreshes %s while mounted and clears the timer on unmount",
    async (state, interval) => {
      await render({ ...base, state, ...(state === "preparing" ? { phase: "checking" } : {}) });
      using _timers = fakeTimers();
      // A fresh snapshot schedules this row's next refresh using fake timers.
      await settle();
      const before = owner.status.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(interval);
      });
      expect(owner.status.mock.calls.length).toBeGreaterThan(before);
      await act(async () => root.unmount());
      mounted = false;
      const stopped = owner.status.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(interval * 2);
      });
      expect(owner.status).toHaveBeenCalledTimes(stopped);
    },
  );
  it("reads actual preparation phases while a manual update is still running", async () => {
    await render({ ...base, state: "stopped" });
    let finish!: (value: SshHostResult) => void;
    owner.update.mockImplementation(() => {
      reply = { kind: "ok", status: { ...base, state: "preparing", phase: "uploading" } };
      return new Promise<SshHostResult>((resolve) => {
        finish = resolve;
      });
    });
    await click("Update runtime");
    await settle();
    expect(container.textContent).toContain(
      "Installing GOAT runtime — first setup can take a few minutes",
    );
    const ready: SshHostResult = {
      kind: "ok",
      status: { ...base, state: "ready", runtimeVersion: "0.4.3" },
    };
    reply = ready;
    await act(async () => {
      finish(ready);
    });
    await settle();
    expect(container.textContent).not.toContain("Installing GOAT runtime");
    expect(button("Update runtime")).toBeUndefined();
  });
  it.each([false, true])(
    "shows one typed error and one recovery instruction (status: %s)",
    async (includeStatus) => {
      await render({ ...base, state: "stopped" });
      owner.update.mockImplementation(async () => {
        reply = {
          kind: "error",
          code: "operation_failed",
          message: "vps-1: the archive could not be read",
          fix: { actor: "human", instruction: "Try again" },
          ...(includeStatus
            ? {
                status: {
                  ...base,
                  state: "failed" as const,
                  failure: {
                    reason: "start_timeout" as const,
                    fix: { actor: "human" as const, instruction: "Try again" },
                  },
                },
              }
            : {}),
        };
        return reply;
      });
      await click("Update runtime");
      await settle();
      expect(
        [...container.querySelectorAll('[role="alert"]')].map((node) => node.textContent),
      ).toEqual(["vps-1: the archive could not be read"]);
      expect(container.textContent?.match(/Try again/g)).toHaveLength(1);
      expect(container.textContent).not.toContain("Couldn't update the runtime");
    },
  );
  it("names the host when the update command fails without a typed result", async () => {
    await render({ ...base, state: "stopped" });
    owner.update.mockRejectedValue(new Error("owner bridge disconnected"));
    await click("Update runtime");
    await settle();
    expect(container.textContent).toContain("Couldn't update the runtime on vps-1. Try again.");
  });
  it("explains an unreachable host without SSH output or a second retry", async () => {
    await render({ ...base, state: "stopped" });
    owner.update.mockImplementation(async () => {
      reply = {
        kind: "error",
        code: "host_unreachable",
        message: "vps-1: ssh: connect to host 203.0.113.9 port 22: Operation timed out",
        fix: { actor: "human", instruction: "Try again" },
        status: { ...base, state: "ready", runtimeVersion: base.requestedVersion },
      };
      return reply;
    });
    await click("Update runtime");
    await settle();
    expect(container.textContent).toContain(
      "Can't reach vps-1. Check that it's running and reachable, then try again.",
    );
    expect(container.textContent).not.toContain("Operation timed out");
    expect(container.textContent).not.toContain("Try again");
  });
  it("shows only the first provider recovery instruction", async () => {
    await render({
      ...base,
      state: "providers_not_ready",
      providers: {
        checkedAt: "2026-10-18T00:00:00.000Z",
        ready: false,
        fixes: [
          { actor: "human", instruction: "Sign in to the provider" },
          { actor: "human", instruction: "Install the provider" },
        ],
      },
    });
    expect(container.textContent).toContain("Sign in to the provider");
    expect(container.textContent).not.toContain("Install the provider");
    expect(container.textContent).not.toContain("Last checked");
    expect(container.textContent).not.toContain("2026-10-18T");
  });
  it("clears progress and stops refreshes when switched off", async () => {
    await render();
    await render(undefined, false);
    expect(registry.get(sshRuntime.statusAtom(input))).toBeNull();
    expect(button("Update runtime")).toBeUndefined();
    expect(button("Update now")).toBeUndefined();
    expect(owner.update).not.toHaveBeenCalled();
  });
});

describe("pending SSH host setup", () => {
  it("keeps the public key and origin instructions visible before the connection is saved", async () => {
    const publicKey = "ssh-ed25519 public-test-key goat";
    reply = { kind: "ok", status: { ...base, state: "auth_failed", publicKey } };
    const writeText = vi.fn(async (_value: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <SshRuntimeSettingsRow
            {...input}
            enabled
            pendingAdd
            originLabel="My Mac"
            onRetry={() => {
              reply = { kind: "ok", status: { ...base, state: "preparing", phase: "checking" } };
            }}
          />
        </RegistryContext>,
      ),
    );
    await settle();
    expect(container.textContent).toContain("GOAT created a key for vps-1");
    expect(container.textContent).toContain("Run this on My Mac");
    expect(container.textContent).toContain("GOAT connects with SSH keys only.");
    await click("Copy public key");
    expect(writeText).toHaveBeenCalledExactlyOnceWith(publicKey);
    await click("Retry");
    await settle();
    expect(container.textContent).toContain("Checking GOAT runtime");
    expect(button("Copy public key")).toBeUndefined();
  });
});

it("polls a pending Add while the Desktop connection has not published its first phase", async () => {
  reply = { kind: "ok", status: { ...base, state: "stopped" } };
  await act(async () =>
    root.render(
      <RegistryContext value={registry}>
        <SshRuntimeSettingsRow {...input} enabled pendingAdd connecting />
      </RegistryContext>,
    ),
  );
  using _timers = fakeTimers();
  await settle();
  reply = { kind: "ok", status: { ...base, state: "preparing", phase: "uploading" } };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(container.textContent).toContain(
    "Installing GOAT runtime — first setup can take a few minutes",
  );
});

describe("SSH runtime recovery actions", () => {
  async function renderActions(
    props: Pick<
      Parameters<typeof SshRuntimeSettingsRow>[0],
      "onReviewTrust" | "onOpenApproval" | "onRetry"
    >,
  ) {
    await act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <SshRuntimeSettingsRow {...input} enabled {...props} />
        </RegistryContext>,
      ),
    );
    await settle();
  }
  it("offers the fingerprint review action without a duplicate recovery sentence", async () => {
    reply = { kind: "ok", status: { ...base, state: "untrusted" } };
    const review = vi.fn();
    await renderActions({ onReviewTrust: review });
    expect(container.textContent).not.toContain("Add this host again to review its fingerprint.");
    await click("Review fingerprint");
    expect(review).toHaveBeenCalledOnce();
  });
  it("opens the pending approval through the shared link button", async () => {
    reply = { kind: "ok", status: { ...base, state: "trust_pending" } };
    const open = vi.fn();
    await renderActions({ onOpenApproval: open });
    expect(container.textContent).not.toContain("Review the request in its original thread.");
    await click("Open the host approval card");
    expect(open).toHaveBeenCalledOnce();
  });
  it("offers Retry instead of Refresh until key authentication succeeds", async () => {
    reply = { kind: "ok", status: { ...base, state: "auth_failed" } };
    const retry = vi.fn(() => {
      reply = {
        kind: "ok",
        status: { ...base, state: "ready", runtimeVersion: base.requestedVersion },
      };
    });
    await renderActions({ onRetry: retry });
    expect(button("Refresh status")).toBeUndefined();
    await click("Retry");
    await settle();
    expect(retry).toHaveBeenCalledOnce();
    expect(button("Retry")).toBeUndefined();
    expect(button("Refresh status")).toBeDefined();
  });
  it.each([true, false])("copies exactly one recovery value (public key: %s)", async (withKey) => {
    const command = "ssh-copy-id ops@vps-1";
    const publicKey = "ssh-ed25519 public-test-key";
    reply = {
      kind: "error",
      code: "operation_failed",
      message: "Register the SSH key.",
      status: { ...base, state: "auth_failed", ...(withKey ? { publicKey } : {}) },
      fix: { actor: "human", instruction: "Register the key and try again.", command },
    };
    const writeText = vi.fn(async (_value: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await renderActions({});
    const copyButtons = [...container.querySelectorAll("button")].filter((node) =>
      node.textContent?.startsWith("Copy "),
    );
    expect(copyButtons.map((node) => node.textContent)).toEqual([
      withKey ? "Copy public key" : "Copy setup command",
    ]);
    await click(withKey ? "Copy public key" : "Copy setup command");
    expect(writeText).toHaveBeenCalledExactlyOnceWith(withKey ? publicKey : command);
  });
});

it.each(["owner-key", "legacy-key", "command"] as const)(
  "uses the owner's key-auth recovery (%s)",
  async (source) => {
    const publicKey = "ssh-ed25519 owner-generated-key";
    const command = "ssh-copy-id -i '/origin/.ssh/goat-hosts/id_ed25519.pub' -p '2222' 'ops@vps-1'";
    reply = {
      kind: "error",
      code: "operation_failed",
      message: "Register the key.",
      status: {
        ...base,
        state: "auth_failed",
        ...(source !== "command" ? { publicKey } : {}),
        keyAuth: {
          originLabel: "SSH origin",
          instruction: "Register the key on the SSH origin, then retry.",
          command,
          ...(source === "owner-key" ? { publicKey } : {}),
        },
      },
      fix: { actor: "human", instruction: "Old recovery", command: "old-command" },
    };
    const writeText = vi.fn(async (_value: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <SshRuntimeSettingsRow {...input} enabled pendingAdd originLabel="Renderer machine" />
        </RegistryContext>,
      ),
    );
    await settle();
    expect(container.textContent).toContain("Register the key on the SSH origin, then retry.");
    expect(container.textContent).not.toContain("Run this on Renderer machine");
    const label = source === "command" ? "Copy setup command" : "Copy public key";
    expect(
      [...container.querySelectorAll("button")]
        .filter((node) => node.textContent?.startsWith("Copy "))
        .map((node) => node.textContent),
    ).toEqual([label]);
    await click(label);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(source === "command" ? command : publicKey);
  },
);

it("uses local phase before the owner poll and clears it immediately on terminal", async () => {
  const preparation = {
    operationId: "fixture-operation",
    phase: "uploading" as const,
    hostAnswered: true,
    remainingMs: 800_000,
  };
  reply = {
    kind: "ok",
    status: { ...base, state: "preparing", phase: "checking", runtimeVersion: null },
  };
  const draw = async (progress: import("@goat/contracts").DesktopSshPreparationProgress) => {
    await act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <SshRuntimeSettingsRow
            {...input}
            enabled
            pendingAdd
            connecting
            preparationProgress={progress}
          />
        </RegistryContext>,
      ),
    );
  };
  await draw(preparation);
  expect(container.textContent?.match(/Installing GOAT runtime/g)).toHaveLength(1);
  expect(container.textContent).not.toMatch(/Checking GOAT|Setting up GOAT|unknown/);
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Installing GOAT runtime — first setup can take a few minutes",
  );
  await draw({ ...preparation, phase: null, outcome: "pending" });
  expect(container.textContent).not.toMatch(/Installing|Checking GOAT|Setting up GOAT/);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("");
});
