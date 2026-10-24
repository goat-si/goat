import { it } from "@effect/vitest";
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  type DesktopSshPreparationProgress,
  type RemoteLaunch,
} from "@goat/contracts";
import { actEffect, makeSshProvisionGate } from "./sshPreparation.test-support";
import type { ConnectionOnboarding } from "@goat/client-runtime/connection";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  connect: vi.fn(),
  toast: vi.fn(),
  presentations: null as unknown as Atom.Writable<
    ReadonlyMap<EnvironmentId, { connection: { phase: string } }>
  >,
  launches: null as unknown as Atom.Writable<unknown>,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../connection/onboarding", () => ({ connectSshEnvironment: state.connect }));
vi.mock("../../state/entities", async (original) => ({
  ...(await original<typeof import("../../state/entities")>()),
  useThreadShells: () => [],
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "dispatcher",
        label: "Fixture dispatcher",
        connection: { phase: "connected" },
        serverConfig: null,
      },
    ],
  }),
}));
vi.mock("../../state/presentation", async (original) => ({
  ...(await original<typeof import("../../state/presentation")>()),
  environmentPresentations: {
    get presentationsAtom() {
      return state.presentations;
    },
  },
}));
vi.mock("../../state/server", async (original) => ({
  ...(await original<typeof import("../../state/server")>()),
  serverEnvironment: { remoteLaunches: () => state.launches },
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
import { RemoteLaunchesSettings } from "./RemoteLaunchesSettings";

const dispatcher = EnvironmentId.make("dispatcher");
const launch: RemoteLaunch = {
  host: "fixture-vps",
  threadId: null,
  title: "Fixture launch",
  launcherThreadId: ThreadId.make("launcher"),
  source: "watch",
  state: "running",
  latest: null,
  hostUnavailableSince: null,
  updatedAt: "2026-10-20T00:00:00Z",
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
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: {} });
  state.toast.mockReset();
  gate = makeSshProvisionGate();
  state.connect.mockReset().mockImplementation(gate.command);
  state.presentations = Atom.make<ReadonlyMap<EnvironmentId, { connection: { phase: string } }>>(
    new Map([[dispatcher, { connection: { phase: "connected" } }]]),
  );
  state.launches = Atom.make<unknown>(
    AsyncResult.success({ launches: [launch], truncated: false }),
  );
  registry = AtomRegistry.make();
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
            <RemoteLaunchesSettings />
          </RegistryContext>,
        ),
      );
      const section = [...container.querySelectorAll("button")].find((node) =>
        node.textContent?.includes("Remote launches"),
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
it.effect("shows provision progress, clears terminal, and silently settles supersession", () =>
  Effect.gen(function* () {
    yield* mountAndConnect();
    expect(container.textContent).toContain(
      "Installing GOAT runtime. First setup can take a few minutes",
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
it.effect("ignores reports from a replaced host and completion after unmount", () =>
  Effect.gen(function* () {
    yield* mountAndConnect();
    yield* actEffect(
      Effect.sync(() =>
        registry.set(
          state.launches,
          AsyncResult.success({
            launches: [{ ...launch, host: "fixture-other" }],
            truncated: false,
          }),
        ),
      ),
    );
    yield* actEffect(report(progress));
    expect(container.textContent).toContain("fixture-other");
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
