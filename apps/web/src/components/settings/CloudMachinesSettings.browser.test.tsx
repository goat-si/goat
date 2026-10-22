import { it } from "@effect/vitest";
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  type CloudMachine,
  type DesktopSshPreparationProgress,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import { actEffect, makeSshProvisionGate } from "./sshPreparation.test-support";
import type { ConnectionOnboarding } from "@goat/client-runtime/connection";

const state = vi.hoisted(() => ({
  connect: vi.fn(),
  resume: vi.fn(),
  toast: vi.fn(),
  machines: null as unknown as Atom.Writable<unknown>,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../connection/onboarding", () => ({ connectSshEnvironment: state.connect }));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/server", async (original) => ({
  ...(await original<typeof import("../../state/server")>()),
  serverEnvironment: {
    cloudMachines: () => state.machines,
    resumeCloudMachine: state.resume,
    stopCloudMachine: vi.fn(),
    deleteCloudMachine: vi.fn(),
    forgetCloudMachine: vi.fn(),
    configureCloudMachines: vi.fn(),
    createCloudMachine: vi.fn(),
    disconnectCloudMachines: vi.fn(),
  },
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
import { CloudMachinesSettings } from "./CloudMachinesSettings";

const environmentId = EnvironmentId.make("cloud-fixture");
const machine: CloudMachine = {
  alias: "fixture-vps",
  sandboxId: "fixture-1",
  label: "Fixture VPS",
  provider: "boat",
  type: "small",
  ttlSeconds: 3600,
  presence: "present",
  state: "running",
  deletePending: false,
  lastError: null,
};
const progress: DesktopSshPreparationProgress = {
  operationId: "fixture-op",
  phase: "uploading",
  hostAnswered: true,
  remainingMs: 800000,
};
let root: Root;
let registry: AtomRegistry.AtomRegistry;
let container: HTMLDivElement;
let mounted: boolean;
let report: NonNullable<ConnectionOnboarding.SshConnectionInput["onPreparationProgress"]>;
let gate: ReturnType<typeof makeSshProvisionGate>;

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
  state.toast.mockReset();
  state.resume.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  gate = makeSshProvisionGate();
  state.connect.mockReset().mockImplementation(gate.command);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      resolveSshHost: async (alias: string) => ({
        alias,
        hostname: "example.invalid",
        username: null,
        port: null,
      }),
    },
  });
  registry = AtomRegistry.make();
  state.machines = Atom.make<unknown>(
    AsyncResult.success({ configured: true, machines: [machine], unconfirmedCreates: 0 }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mounted = true;
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  registry.dispose();
  container.remove();
  delete (window as { desktopBridge?: unknown }).desktopBridge;
  vi.unstubAllGlobals();
});
function mountAndConnect() {
  return Effect.gen(function* () {
    yield* Effect.forkChild(gate.worker);
    yield* Effect.promise(async () => {
      await act(async () =>
        root.render(
          <RegistryContext value={registry}>
            <CloudMachinesSettings environmentId={environmentId} />
          </RegistryContext>,
        ),
      );
      const section = [...container.querySelectorAll("button")].find((node) =>
        node.textContent?.includes("Cloud machines"),
      );
      if (!section) throw new Error("Missing section");
      await act(async () => section.click());
      await act(async () => {
        const button = [...container.querySelectorAll("button")].find(
          (node) => node.textContent === "Connect",
        );
        if (!button) throw new Error("Missing Connect");
        button.click();
      });
    });
    const input = yield* Deferred.await(gate.entered);
    report = input.onPreparationProgress!;
    yield* actEffect(report(progress));
  });
}
it.effect(
  "shows provision phases, clears terminal immediately, and drops neutral supersession without a toast",
  () =>
    Effect.gen(function* () {
      yield* mountAndConnect();
      expect(container.textContent).toContain(
        "Installing GOAT runtime — first setup can take a few minutes",
      );
      yield* actEffect(report({ ...progress, phase: null, outcome: "superseded" }));
      expect(container.textContent).not.toContain("Installing GOAT");
      yield* actEffect(
        Deferred.succeed(gate.release, {
          _tag: "Failure",
          cause: Cause.fail(new Error("SSH preparation superseded by a newer connection intent.")),
        }),
      );
      expect(state.toast).not.toHaveBeenCalled();
      expect(
        [...container.querySelectorAll("button")].find((node) => node.textContent === "Connect")
          ?.disabled,
      ).toBe(false);
      yield* actEffect(report(progress));
      expect(container.textContent).not.toContain("Installing GOAT");
    }),
);
it.effect("fences a switched machine and all reports/completion after unmount", () =>
  Effect.gen(function* () {
    yield* mountAndConnect();
    yield* actEffect(
      Effect.sync(() =>
        registry.set(
          state.machines,
          AsyncResult.success({
            configured: true,
            machines: [{ ...machine, alias: "fixture-other", label: "Other VPS" }],
          }),
        ),
      ),
    );
    yield* actEffect(report(progress));
    expect(container.textContent).toContain("Other VPS");
    expect(container.textContent).not.toContain("Installing GOAT");
    yield* Effect.promise(() => act(async () => root.unmount()));
    mounted = false;
    yield* report(progress);
    yield* Deferred.succeed(gate.release, {
      _tag: "Failure",
      cause: Cause.fail(new Error("late failure")),
    });
    expect(state.toast).not.toHaveBeenCalled();
  }),
);
