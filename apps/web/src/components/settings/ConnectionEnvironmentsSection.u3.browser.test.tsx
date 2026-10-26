import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  type DesktopBridge,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshPreparationProgress,
  type SshHostResult,
  type SshHostStatus,
} from "@goat/contracts";
import {
  SshConnectionProfile,
  SshConnectionTarget,
  connectionRouteId,
  type EnvironmentConnectionPresentation,
} from "@goat/client-runtime/connection";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { act, render, stubGlobal } from "../../../test/render";
import { page, userEvent } from "vite-plus/test/browser";
import type { EnvironmentPresentation } from "~/state/environments";
import "~/index.css";

const state = vi.hoisted(() => {
  const bridge: Pick<
    DesktopBridge,
    | "supportsSshEnvironmentProgress"
    | "supportsSshPreparationPhases"
    | "ensureSshEnvironment"
    | "resolveSshHost"
    | "getSshHostStatus"
    | "updateSshRuntime"
    | "getLocalEnvironmentBootstraps"
  > = {
    supportsSshEnvironmentProgress: true,
    supportsSshPreparationPhases: true,
    ensureSshEnvironment: vi.fn(),
    resolveSshHost: vi.fn(),
    getSshHostStatus: vi.fn(),
    updateSshRuntime: vi.fn(),
    getLocalEnvironmentBootstraps: () => [],
  };
  return {
    bridge,
    environments: null as unknown as Atom.Writable<ReadonlyArray<EnvironmentPresentation>>,
    runtime: null as SshHostResult | null,
    connect: vi.fn(),
    toast: vi.fn(),
  };
});
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironments: () => ({ environments: useAtomValue(state.environments) }),
  usePrimaryEnvironment: () => ({
    environmentId: "primary",
    label: "Fixture Mac",
    entry: { target: { _tag: "PrimaryConnectionTarget", httpBaseUrl: "http://localhost:3773" } },
  }),
  useRelayEnvironmentDiscovery: () => ({ environments: new Map() }),
}));
vi.mock("../../state/use-atom-command", async (original) => ({
  ...(await original<typeof import("../../state/use-atom-command")>()),
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("../../connection/onboarding", async (original) => ({
  ...(await original<typeof import("../../connection/onboarding")>()),
  connectPairing: vi.fn(),
  connectSshEnvironment: state.connect,
}));
vi.mock("../../connection/catalog", async (original) => {
  const actual = await original<typeof import("../../connection/catalog")>();
  const stateAtom = Atom.make(AsyncResult.initial());
  return {
    ...actual,
    environmentCatalog: {
      remove: vi.fn(),
      register: vi.fn(),
      setEnabled: vi.fn(),
      stateAtom: () => stateAtom,
    },
  };
});
vi.mock("../../state/server", async (original) => {
  const actual = await original<typeof import("../../state/server")>();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@goat/shared/keybindings");
  const idle = Atom.make({ status: "idle" });
  const updates = Atom.make([{ status: "idle" }]);
  const permission = Atom.make(false);
  return {
    ...actual,
    primaryServerKeybindingsAtom: Atom.make(compileResolvedKeybindingsConfig([])),
    serverEnvironment: {
      ...actual.serverEnvironment,
      probeSshHost: vi.fn(),
      trustSshHost: Object.assign(vi.fn(), { permissionAtom: () => permission }),
      forgetSshHost: vi.fn(),
      updateStateAtom: () => idle,
    },
    environmentUpdateStatesAtom: () => updates,
  };
});
vi.mock("../../state/query", async (original) => ({
  ...(await original<typeof import("../../state/query")>()),
  useEnvironmentQuery: () => ({ data: null, isPending: false, error: null, refresh: () => {} }),
}));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  usePreparedConnection: () => Option.none(),
}));
vi.mock("../../state/sshRuntime", async () => {
  const { createSshRuntimeState } = await import("@goat/client-runtime/state/sshRuntime");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const { Atom } = await import("effect/reactivity");
  return {
    sshRuntime: createSshRuntimeState(Atom.runtime(Layer.empty), {
      status: () => Effect.sync(() => state.runtime!),
      update: () => Effect.sync(() => state.runtime!),
    }),
  };
});
vi.mock(import("../../cloud/publicConfig"), async (original) => ({
  ...(await original()),
  hasCloudPublicConfig: () => false,
}));
vi.mock("../ui/toast", async (original) => ({
  ...(await original<typeof import("../ui/toast")>()),
  toastManager: { add: state.toast },
  stackedThreadToast: (toast: unknown) => toast,
}));

import { ConnectionEnvironmentsSection } from "./ConnectionEnvironmentsSection";
import { sshRuntime } from "~/state/sshRuntime";
import { TooltipProvider } from "../ui/tooltip";

const environmentId = EnvironmentId.make("fixture-vps");
const target = { alias: "fixture-vps", hostname: "example.invalid", username: null, port: null };
const savedTarget = new SshConnectionTarget({
  environmentId,
  connectionId: "fixture-ssh",
  label: "Fixture VPS",
});
const entry = {
  enabled: true,
  target: savedTarget,
  profile: Option.some(
    new SshConnectionProfile({
      environmentId,
      connectionId: "fixture-ssh",
      label: "Fixture VPS",
      target,
    }),
  ),
};
const routeId = connectionRouteId(savedTarget);
const identity = { supervisorId: "fixture-window", attemptId: 2, routeId };
const readyStatus: SshHostStatus = {
  state: "ready",
  host: target.alias,
  runtimeVersion: "0.4.3",
  requestedVersion: "0.4.3",
};
const uploadingProgress: DesktopSshPreparationProgress = {
  operationId: "fixture-operation",
  phase: "uploading",
  hostAnswered: true,
  remainingMs: 642000,
};
const terminalReadyProgress: DesktopSshPreparationProgress = {
  ...uploadingProgress,
  phase: null,
  outcome: "ready",
  attachmentId: "fixture-attachment",
  runtimeStatus: readyStatus,
};
const readyBootstrap: DesktopSshEnvironmentBootstrap = {
  target,
  httpBaseUrl: "http://127.0.0.1:12345",
  wsBaseUrl: "ws://127.0.0.1:12345/ws",
  pairingToken: null,
  attachmentId: "fixture-attachment",
};
type Scene =
  | "preparing"
  | "runtime-ready"
  | "opening"
  | "synchronizing"
  | "connected"
  | "fresh-timeout-old-ready"
  | "superseded";

/**
 * Coordinator capture only: VITE_U3_CAPTURE_DIRECTORY=/absolute/outside/worktree and
 * VITE_U3_CAPTURE_BUILD=before|after. Without both, this fixture never takes screenshots.
 * Use this same overlay on baseline/changed sources. The bridge gate counts calls only;
 * manager single-flight and actual SSH acceptance are separate verifiers.
 */
export function createU3Fixture(registry: AtomRegistry.AtomRegistry, container: HTMLElement) {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const preparationGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = {
    ensureStarts: 0,
    progress: null as DesktopSshPreparationProgress | null,
    hold: () => entered,
    release: () => release(),
    async setScene(scene: Scene) {
      const failure = {
        kind: "retrying" as const,
        reason: "timeout" as const,
        detail: "The SSH host did not respond during connection setup",
      };
      const connection: EnvironmentConnectionPresentation = {
        phase: scene === "connected" ? "connected" : "reconnecting",
        error: scene === "connected" || scene === "superseded" ? null : failure.detail,
        traceId: null,
        stage:
          scene === "synchronizing"
            ? "synchronizing"
            : scene === "opening" || scene === "runtime-ready"
              ? "opening"
              : "preparing",
        ...(scene === "superseded" || scene === "connected"
          ? {}
          : {
              failure,
              failureOrigin: {
                ...identity,
                attemptId: scene === "fresh-timeout-old-ready" ? 3 : 1,
                stage: "preparing" as const,
                setupTimeout: true,
              },
            }),
        ...(scene === "preparing"
          ? {
              sshPreparation: {
                ...identity,
                operationId: uploadingProgress.operationId,
                phase: "uploading" as const,
                hostAnswered: true,
              },
            }
          : scene === "superseded"
            ? {}
            : {
                sshRuntimeReady: {
                  ...identity,
                  operationId: uploadingProgress.operationId,
                  attachmentId: "fixture-attachment",
                  runtimeStatus: readyStatus,
                },
              }),
      };
      state.runtime = {
        kind: "ok",
        status:
          scene === "preparing"
            ? { ...readyStatus, state: "preparing", runtimeVersion: null, phase: "uploading" }
            : readyStatus,
      };
      await act(async () => {
        registry.set(state.environments, [
          {
            environmentId,
            label: "Fixture VPS",
            displayUrl: null,
            relayManaged: false,
            entry,
            connection,
            serverConfig: null,
          },
        ]);
        await sshRuntime.refresh.run(registry, { environmentId, target });
      });
    },
    snapshot: () => ({
      ensureStarts: fixture.ensureStarts,
      text: container.textContent,
      tooltip: document.querySelector('[data-slot="tooltip-popup"]')?.textContent,
    }),
    async capture(theme: "light" | "dark", scene: "preparing" | "connected") {
      const directory: unknown = import.meta.env.VITE_U3_CAPTURE_DIRECTORY;
      const build: unknown = import.meta.env.VITE_U3_CAPTURE_BUILD;
      if (
        typeof directory !== "string" ||
        !directory.startsWith("/") ||
        (build !== "before" && build !== "after")
      )
        return;
      await document.fonts.ready;
      await page.screenshot({ path: `${directory}/u3-${build}-${theme}-${scene}.png` });
    },
  };
  vi.mocked(state.bridge.ensureSshEnvironment).mockImplementation(async (_target, options) => {
    fixture.ensureStarts += 1;
    options?.onHostAnswered?.();
    options?.onPreparationProgress?.(uploadingProgress);
    enter();
    await preparationGate;
    options?.onPreparationProgress?.(terminalReadyProgress);
    return readyBootstrap;
  });
  return fixture;
}

function setup() {
  vi.clearAllMocks();
  state.environments = Atom.make<ReadonlyArray<EnvironmentPresentation>>([]);
  state.runtime = {
    kind: "ok",
    status: { ...readyStatus, state: "preparing", runtimeVersion: null, phase: "checking" },
  };
}

function themeScope(theme: "light" | "dark"): Disposable {
  document.documentElement.classList.add(theme);
  return { [Symbol.dispose]: () => document.documentElement.classList.remove(theme) };
}

it.each(["light", "dark"] as const)(
  "holds and releases the actual saved row and tooltip (%s)",
  async (theme) => {
    setup();
    using _bridge = stubGlobal("desktopBridge", state.bridge);
    using _theme = themeScope(theme);
    await page.viewport(1280, 900);
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const container = document.createElement("div");
    container.className = "mx-auto mt-24 w-3xl bg-background text-foreground";
    const fixture = createU3Fixture(registry, container);
    await fixture.setScene("preparing");
    await using screen = await render(
      <RegistryContext value={registry}>
        <TooltipProvider delay={0}>
          <ConnectionEnvironmentsSection title="Connections" searchable={false} />
        </TooltipProvider>
      </RegistryContext>,
      { container },
    );
    let hostAnswered = false;
    const preparation = state.bridge.ensureSshEnvironment(target, {
      onPreparationProgress: (progress) => {
        fixture.progress = progress;
      },
      onHostAnswered: () => {
        hostAnswered = true;
      },
    });
    await fixture.hold();
    expect(hostAnswered).toBe(true);
    expect(fixture.progress?.phase).toBe("uploading");
    await fixture.setScene("preparing");
    const label = screen.container.querySelector("p.truncate");
    const status = label?.parentElement?.querySelector<HTMLElement>(
      '[data-slot="tooltip-trigger"]',
    );
    if (!status) throw new Error("Saved row status trigger missing");
    await act(() => userEvent.hover(page.elementLocator(status)));
    const popup = () => document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
    await vi.waitFor(() => expect(popup()).not.toBeNull());
    await expect.element(page.elementLocator(popup()!)).toBeVisible();
    expect(fixture.snapshot().ensureStarts).toBe(1);
    expect(container.textContent).toContain("Fixture VPS");
    const baselineCapture =
      import.meta.env.VITE_U3_CAPTURE_BUILD === "before" &&
      typeof import.meta.env.VITE_U3_CAPTURE_DIRECTORY === "string" &&
      import.meta.env.VITE_U3_CAPTURE_DIRECTORY.startsWith("/");
    if (!baselineCapture) {
      expect(status.textContent).toContain(
        "Installing GOAT runtime. First setup can take a few minutes",
      );
      expect(fixture.snapshot().tooltip).toBe(
        "Installing GOAT runtime. First setup can take a few minutes",
      );
      expect(status.textContent).not.toMatch(/did not respond|Runtime unknown/);
      expect(container.textContent?.match(/Installing GOAT runtime/g)).toHaveLength(1);
    }
    await fixture.capture(theme, "preparing");
    // A page screenshot can move the pointer off the trigger; reopen the tooltip before reading it.
    await act(() => userEvent.hover(page.elementLocator(status)));
    fixture.release();
    await preparation;
    expect(fixture.progress?.phase).toBeNull();
    expect(fixture.progress?.outcome).toBe("ready");
    await fixture.setScene("runtime-ready");
    if (!baselineCapture) {
      expect(status.textContent).toContain("Runtime ready");
      expect(fixture.snapshot().tooltip).toContain("Runtime ready");
      expect(status.textContent).not.toContain("Installing");
    }
    await fixture.setScene("opening");
    await fixture.setScene("synchronizing");
    await fixture.setScene("connected");
    expect(fixture.snapshot().tooltip).toContain("Connected");
    expect(status.textContent).toContain("Connected");
    await fixture.capture(theme, "connected");
    await fixture.setScene("fresh-timeout-old-ready");
    expect(status.textContent).toContain("did not respond");
    await fixture.setScene("superseded");
    expect(status.textContent).not.toContain("authentication");
  },
);
