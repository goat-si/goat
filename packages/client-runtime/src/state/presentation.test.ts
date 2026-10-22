import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type ServerConfig, type SshHostStatus } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  ConnectionTransientError,
} from "../connection/model.ts";
import {
  createEnvironmentPresentationAtoms,
  createEnvironmentSummaryAtoms,
  createEnvironmentShellSyncAtom,
  shellSyncMessage,
} from "./presentation.ts";
import {
  connectionStatusText,
  connectionStatusTitle,
  connectionProgressLabel,
} from "../connection/presentation.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import type { EnvironmentShellState } from "./shell.ts";
import { v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";

describe("shell sync presentation", () => {
  it.each([false, true])(
    "exposes shell-only failure with cached snapshot=%s and clears it after recovery",
    (cached) => {
      const registry = AtomRegistry.make();
      const shell = Atom.make<EnvironmentShellState>({
        status: "synchronizing",
        snapshot: cached ? Option.some(v2ShellSnapshot) : Option.none(),
        error: Option.none(),
      });
      const sync = createEnvironmentShellSyncAtom(() => shell)(FIRST);
      const stop = registry.subscribe(sync, () => {});
      try {
        expect(registry.get(sync)).toBe("synchronizing");
        registry.set(shell, {
          ...registry.get(shell),
          status: cached ? "cached" : "empty",
          error: Option.some("Permission denied: private-id"),
        });
        expect(registry.get(sync)).toBe(cached ? "stale" : "error");
        expect(shellSyncMessage(registry.get(sync))).toContain("Could not sync environment data");
        expect(shellSyncMessage(registry.get(sync))).not.toContain("private-id");
        registry.set(shell, {
          ...registry.get(shell),
          status: "synchronizing",
          error: Option.none(),
        });
        expect(registry.get(sync)).toBe("synchronizing");
        registry.set(shell, {
          snapshot: Option.some(v2ShellSnapshot),
          status: "live",
          error: Option.none(),
        });
        expect(shellSyncMessage(registry.get(sync))).toBeNull();
      } finally {
        stop();
        registry.dispose();
      }
    },
  );

  it("does not notify sync consumers for live snapshot updates", () => {
    const registry = AtomRegistry.make();
    const shell = Atom.make<EnvironmentShellState>({
      snapshot: Option.some(v2ShellSnapshot),
      status: "live",
      error: Option.none(),
    });
    const sync = createEnvironmentShellSyncAtom(() => shell)(FIRST);
    registry.get(sync);
    let notifications = 0;
    const stop = registry.subscribe(sync, () => notifications++);
    try {
      registry.set(shell, {
        ...registry.get(shell),
        snapshot: Option.some({ ...v2ShellSnapshot, snapshotSequence: 2 }),
      });
      expect(registry.get(sync)).toBe("live");
      expect(notifications).toBe(0);
    } finally {
      stop();
      registry.dispose();
    }
  });
});

const FIRST = EnvironmentId.make("first");
const SECOND = EnvironmentId.make("second");
function entry(environmentId: EnvironmentId, label = environmentId as string) {
  return {
    target: new PrimaryConnectionTarget({
      environmentId,
      label,
      httpBaseUrl: "https://example.test",
      wsBaseUrl: "wss://example.test",
    }),
    enabled: true,
    profile: Option.none(),
  };
}
function config(pullRequests = false, cwd = "/workspace"): ServerConfig {
  return {
    cwd,
    environment: { capabilities: { pullRequests }, platform: { machine: "desktop" } },
  } as ServerConfig;
}
function harness() {
  const catalog = Atom.make<EnvironmentCatalogState>({
    isReady: true,
    entries: new Map([
      [FIRST, entry(FIRST)],
      [SECOND, entry(SECOND)],
    ]),
  });
  const configs = Atom.family((_id: EnvironmentId) => Atom.make<ServerConfig | null>(config()));
  const state = Atom.make(AsyncResult.success(AVAILABLE_CONNECTION_STATE));
  const runtimeStatus = Atom.make<SshHostStatus | undefined>(undefined);
  const full = createEnvironmentPresentationAtoms({
    catalogValueAtom: catalog,
    stateAtom: () => state,
    serverConfigValueAtom: configs,
    sshRuntimeStatusAtom: () => runtimeStatus,
  });
  const summaries = createEnvironmentSummaryAtoms({
    catalogValueAtom: catalog,
    presentationAtom: full.presentationAtom,
  });
  return {
    catalog,
    configs,
    state,
    runtimeStatus,
    full,
    ...summaries,
    registry: AtomRegistry.make(),
  };
}

describe("environment summary subscriptions", () => {
  it("tracks capabilities across environments, config loss and removal", () => {
    const h = harness();
    const stop = h.registry.subscribe(h.pullRequestsSupportedAtom, () => {});
    try {
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(false);
      h.registry.set(h.configs(FIRST), config(true));
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(true);
      h.registry.set(h.configs(SECOND), config(true));
      h.registry.set(h.configs(FIRST), null);
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(true);
      h.registry.set(h.catalog, { isReady: true, entries: new Map([[FIRST, entry(FIRST)]]) });
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(false);
      expect(h.registry.get(h.environmentIdsAtom)).toEqual([FIRST]);
      expect(h.registry.get(h.identitiesAtom)).toEqual([{ environmentId: FIRST, label: "first" }]);
      h.registry.set(h.catalog, {
        isReady: true,
        entries: new Map([
          [SECOND, entry(SECOND)],
          [FIRST, entry(FIRST)],
        ]),
      });
      expect(h.registry.get(h.environmentIdsAtom)).toEqual([SECOND, FIRST]);
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(true);
      h.registry.set(h.configs(SECOND), config(false));
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(false);
      h.registry.set(h.catalog, { isReady: true, entries: new Map() });
      expect(h.registry.get(h.environmentIdsAtom)).toEqual([]);
      expect(h.registry.get(h.identitiesAtom)).toEqual([]);
      expect(h.registry.get(h.environmentsAtom)).toEqual([]);
    } finally {
      stop();
      h.registry.dispose();
    }
  });
});

describe("shared SSH owner invalidation", () => {
  it("updates every status consumer on owner failure and keeps attempt provenance", () => {
    const h = harness();
    const identity = { supervisorId: "fixture", attemptId: 2, routeId: "ssh:fixture" };
    const ready = {
      ...identity,
      operationId: "op-2",
      attachmentId: "attachment-2",
      runtimeStatus: {
        host: "fixture",
        state: "ready",
        runtimeVersion: null,
        requestedVersion: "1.0.0",
      } as const,
    };
    const failureOrigin = {
      ...identity,
      attemptId: 1,
      stage: "preparing",
      setupTimeout: true,
    } as const;
    const snapshot = {
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      phase: "connecting",
      stage: "opening",
      attempt: 2,
      lastFailure: new ConnectionTransientError({
        reason: "timeout",
        detail: "Old setup timed out.",
      }),
      failureOrigin,
    } as const;
    h.registry.set(h.state, AsyncResult.success(snapshot));
    const atom = h.full.presentationAtom(FIRST);
    const stop = h.registry.subscribe(atom, () => {});
    try {
      expect(h.registry.get(atom)?.connection.error).toBe("Old setup timed out.");
      h.registry.set(h.state, AsyncResult.success({ ...snapshot, sshRuntimeReady: ready }));
      const initial = h.registry.get(atom)!.connection;
      expect(connectionStatusText(initial)).toBe("Runtime ready · Opening connection");
      expect(initial.sshRuntimeReady).toBe(ready);
      for (const state of ["failed", "stopped", "untrusted"] as const) {
        h.registry.set(h.runtimeStatus, { ...ready.runtimeStatus, state });
        const connection = h.registry.get(atom)!.connection;
        expect(connectionStatusText(connection)).toContain("Old setup timed out.");
        expect(connectionStatusTitle(connection)).not.toContain("Runtime ready");
        expect(connectionProgressLabel(connection, 0)).toBe("Opening connection");
        expect(connection.sshRuntimeReady).toBeUndefined();
        expect(connection.failureOrigin).toBe(failureOrigin);
        expect(connection.failure?.detail).toBe("Old setup timed out.");
        expect(Option.getOrThrow(AsyncResult.value(h.registry.get(h.state)))).toEqual({
          ...snapshot,
          sshRuntimeReady: ready,
        });
      }
    } finally {
      stop();
      h.registry.dispose();
    }
  });
});
