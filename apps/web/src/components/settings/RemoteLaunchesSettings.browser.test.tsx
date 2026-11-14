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
  preflight: vi.fn(),
  canPreflight: true,
  toast: vi.fn(),
  presentations: null as unknown as Atom.Writable<
    ReadonlyMap<EnvironmentId, { connection: { phase: string } }>
  >,
  launches: null as unknown as Atom.Writable<unknown>,
}));
vi.mock(import("@tanstack/react-router"), { spy: true });
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../connection/onboarding", () => ({ connectSshEnvironment: state.connect }));
vi.mock(import("../../state/entities"), { spy: true });
vi.mock(import("../../state/environments"), { spy: true });
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
import { useNavigate } from "@tanstack/react-router";
import { useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { RemoteLaunchesSettings } from "./RemoteLaunchesSettings";

const realPresentationsAtom = environmentPresentations.presentationsAtom;
const realPreflight = serverEnvironment.preflightSshHost;
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
const preflightReport = (
  failed: ReadonlyArray<{ readonly id: "host_key"; readonly detail: string }>,
) => ({
  host: "pen-cc-07",
  destination: { alias: "pen-cc-07", hostname: "pen-cc-07", user: "me", port: 22 },
  ready: failed.length === 0,
  steps: failed.map((step) => ({
    ...step,
    state: "failed",
    summary: "This is a disposable machine.",
  })),
});
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
  vi.mocked(useNavigate).mockReturnValue(vi.fn());
  vi.mocked(useThreadShells).mockReturnValue([]);
  vi.mocked(useEnvironments).mockReturnValue({
    environments: [
      {
        environmentId: dispatcher,
        label: "Fixture dispatcher",
        connection: { phase: "connected" },
        serverConfig: null,
      },
    ],
  } as never);
  Object.assign(environmentPresentations, { presentationsAtom: state.presentations });
  vi.spyOn(serverEnvironment, "remoteLaunches").mockReturnValue(state.launches as never);
  // The dispatcher's guarded SSH preflight; it passes unless a test says otherwise.
  state.preflight.mockReset().mockResolvedValue({ _tag: "Success", value: preflightReport([]) });
  state.canPreflight = true;
  Object.assign(state.preflight, { permissionAtom: () => Atom.make(state.canPreflight) });
  Object.assign(serverEnvironment, { preflightSshHost: state.preflight });
  // This desktop's own server is the dispatcher unless a test says otherwise.
  vi.mocked(usePrimaryEnvironment).mockReturnValue({ environmentId: dispatcher } as never);
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
  Object.assign(environmentPresentations, { presentationsAtom: realPresentationsAtom });
  Object.assign(serverEnvironment, { preflightSshHost: realPreflight });
  vi.restoreAllMocks();
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
    // The dispatcher is this desktop's own server here: one guarded preflight, before the connect.
    expect(state.preflight).toHaveBeenCalledOnce();
    expect(state.preflight.mock.invocationCallOrder[0]).toBeLessThan(
      state.connect.mock.invocationCallOrder[0] ?? 0,
    );
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

it.effect(
  "Connect asks the dispatcher's guarded preflight first: a disposable machine under Pen's pen-<name> is refused with its text and never connected",
  () =>
    Effect.gen(function* () {
      state.launches = Atom.make<unknown>(
        AsyncResult.success({ launches: [{ ...launch, host: "pen-cc-07" }], truncated: false }),
      );
      vi.spyOn(serverEnvironment, "remoteLaunches").mockReturnValue(state.launches as never);
      state.preflight.mockResolvedValue({
        _tag: "Success",
        value: preflightReport([
          {
            id: "host_key",
            detail: "pen-cc-07 is a disposable machine (attach a-1, matched by its Pen alias).",
          },
        ]),
      });
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
        const button = [...container.querySelectorAll("button")].find(
          (node) => node.textContent === "Connect",
        );
        if (!button) throw new Error("Missing Connect");
        await act(async () => button.click());
      });
      expect(state.preflight).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: dispatcher, input: { host: "pen-cc-07" } }),
      );
      expect(state.connect).not.toHaveBeenCalled();
      expect(state.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          description: expect.stringContaining("pen-cc-07 is a disposable machine"),
        }),
      );
    }),
);

const openConnect = (click: boolean) =>
  Effect.promise(async () => {
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
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Connect",
    );
    if (click && button) await act(async () => button.click());
    return button;
  });

it.effect(
  "Connect also asks this desktop's own server, whose SSH config it dials: its refusal stops the connect though the dispatcher's check passes",
  () =>
    Effect.gen(function* () {
      const own = EnvironmentId.make("desktop-own");
      vi.mocked(usePrimaryEnvironment).mockReturnValue({ environmentId: own } as never);
      state.preflight.mockImplementation((args: { readonly environmentId: EnvironmentId }) =>
        Promise.resolve({
          _tag: "Success",
          value: preflightReport(
            args.environmentId === own
              ? [{ id: "host_key", detail: "fixture-vps is a disposable machine (attach a-1)." }]
              : [],
          ),
        }),
      );
      const button = yield* openConnect(true);
      expect(button).toBeDefined();
      expect(state.preflight).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: own, input: { host: "fixture-vps" } }),
      );
      expect(state.connect).not.toHaveBeenCalled();
      expect(state.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          description: expect.stringContaining("fixture-vps is a disposable machine"),
        }),
      );
    }),
);

it.effect("offers no Connect to a person who may not run the SSH check there", () =>
  Effect.gen(function* () {
    state.canPreflight = false;
    expect(yield* openConnect(false)).toBeUndefined();
    expect(container.textContent).toContain("Pair fixture-vps under Environments");
  }),
);
