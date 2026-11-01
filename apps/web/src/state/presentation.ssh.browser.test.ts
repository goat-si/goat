import { expect, it, vi } from "vite-plus/test";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { EnvironmentId, type SshHostStatus } from "@goat/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  SshConnectionProfile,
  SshConnectionTarget,
  connectionRouteId,
  connectionStatusText,
} from "@goat/client-runtime/connection";
import type { EnvironmentCatalogState } from "@goat/client-runtime/state/connections";

vi.mock("../connection/catalog", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { AVAILABLE_CONNECTION_STATE } = await import("@goat/client-runtime/connection");
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make({ isReady: true, entries: new Map() }),
      stateAtom: Atom.family(() => Atom.make(AsyncResult.success(AVAILABLE_CONNECTION_STATE))),
    },
  };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { serverEnvironment: { configValueAtom: () => Atom.make(null) } };
});
vi.mock("./shell", () => ({ environmentShell: { stateValueAtom: vi.fn() } }));
vi.mock("./sshRuntime", async () => {
  const { createSshRuntimeState } = await import("@goat/client-runtime/state/sshRuntime");
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  return {
    sshRuntime: createSshRuntimeState(Atom.runtime(Layer.empty), {
      status: () => Effect.never,
      update: () => Effect.never,
    }),
  };
});

import { environmentCatalog } from "../connection/catalog";
import { sshRuntime } from "./sshRuntime";
import { environmentPresentations } from "./presentation";

it("invalidates shared ready text only from the owner of the proven SSH route", () => {
  const registry = AtomRegistry.make();
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: {} });
  const environmentId = EnvironmentId.make("fixture");
  const route = (alias: string) => ({
    target: new SshConnectionTarget({ environmentId, connectionId: alias, label: alias }),
    profile: Option.some(
      new SshConnectionProfile({
        environmentId,
        connectionId: alias,
        label: alias,
        target: { alias, hostname: "example.invalid", username: null, port: null },
      }),
    ),
  });
  const other = route("other");
  const current = route("current");
  const identity = {
    supervisorId: "fixture",
    attemptId: 2,
    routeId: connectionRouteId(current.target),
  };
  const runtimeStatus = {
    host: "current",
    state: "ready",
    runtimeVersion: null,
    requestedVersion: "1.0.0",
  } as const;
  const snapshot = {
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connecting",
    stage: "opening",
    attempt: 2,
    lastFailure: new ConnectionTransientError({ reason: "timeout", detail: "Old timeout" }),
    failureOrigin: { ...identity, attemptId: 1, stage: "preparing", setupTimeout: true },
    sshRuntimeReady: { ...identity, operationId: "op", attachmentId: "attachment", runtimeStatus },
  } as const;
  registry.set(environmentCatalog.catalogValueAtom as Atom.Writable<EnvironmentCatalogState>, {
    isReady: true,
    entries: new Map([[environmentId, { ...other, enabled: true, alternateRoutes: [current] }]]),
  });
  registry.set(
    environmentCatalog.stateAtom(environmentId) as Atom.Writable<
      AsyncResult.AsyncResult<typeof AVAILABLE_CONNECTION_STATE>
    >,
    AsyncResult.success(snapshot),
  );
  const ownerAtom = (profile: typeof current.profile) =>
    sshRuntime.statusAtom({ environmentId, target: Option.getOrThrow(profile).target });
  registry.set(ownerAtom(other.profile), {
    kind: "ok",
    status: { ...runtimeStatus, state: "failed" },
  });
  const atom = environmentPresentations.presentationAtom(environmentId);
  const stop = registry.subscribe(atom, () => {});
  const connection = () => registry.get(atom)!.connection;
  try {
    expect(connectionStatusText(connection())).toContain("Runtime ready");
    for (const state of ["failed", "stopped", "untrusted"] as const satisfies ReadonlyArray<
      SshHostStatus["state"]
    >) {
      registry.set(ownerAtom(current.profile), { kind: "ok", status: { ...runtimeStatus, state } });
      expect(connectionStatusText(connection())).toContain("Old timeout");
      expect(connectionStatusText(connection())).not.toContain("Runtime ready");
      expect(connection().failureOrigin).toBe(snapshot.failureOrigin);
    }
  } finally {
    stop();
    registry.dispose();
    delete window.desktopBridge;
  }
});
