import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  connectionProjectionPhase,
  RelayConnectionTarget,
  type SupervisorConnectionState,
  ConnectionBlockedError,
} from "./model.ts";
import {
  connectionProgressLabel,
  environmentMcpUrl,
  offlineSnapshotAgeLabel,
  connectionRowShowsSnapshotAge,
  connectionWaitsToRetry,
  connectionStatusText,
  connectionStatusTitle,
  presentEnvironmentConnection,
  presentConnectionState,
  reconcileSshConnectionPresentation,
  type EnvironmentConnectionPresentation,
} from "./presentation.ts";

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  connectionId: "connection-1",
});

const ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
  ),
  enabled: true,
};

function supervisorState(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connecting",
    stage: "preparing",
    attempt: 1,
    generation: 0,
    lastFailure: null,
    retryAt: null,
    ...overrides,
  };
}

describe("connection presentation", () => {
  it("copies the MCP address of the route this device is connected over", () => {
    const route = (connectionId: string, httpBaseUrl: string): ConnectionRoute => {
      const target = new BearerConnectionTarget({ ...TARGET, connectionId });
      return {
        target,
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId,
            environmentId: TARGET.environmentId,
            label: TARGET.label,
            httpBaseUrl,
            wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
          }),
        ),
      };
    };
    const lan = route("lan", "http://192.168.4.53:3773/");
    const tailnet = route("tailnet", "http://100.115.1.44:3773/");
    const serve = route("serve", "https://machine.tailnet.ts.net/");
    const entry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: lan.target,
      profile: lan.profile,
      alternateRoutes: [tailnet, serve],
    };

    expect(environmentMcpUrl({ entry, connectedTarget: tailnet.target })).toBe(
      "http://100.115.1.44:3773/mcp",
    );
    expect(environmentMcpUrl({ entry })).toBe("http://192.168.4.53:3773/mcp");
  });

  // regression: #16909 Copy MCP URL falls back to an alternate route when the relay route has no address
  it("passes over routes without an address of their own", () => {
    const relay = new RelayConnectionTarget({
      environmentId: TARGET.environmentId,
      label: TARGET.label,
    });
    const entry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: relay,
      profile: Option.none(),
      alternateRoutes: [{ target: ENTRY.target, profile: ENTRY.profile }],
    };

    expect(environmentMcpUrl({ entry, connectedTarget: relay })).toBe(
      "https://environment.example.test/mcp",
    );
    expect(
      environmentMcpUrl({
        entry,
        connectedTarget: relay,
        relayHttpBaseUrl: "https://tunnel.example.test",
      }),
    ).toBe("https://tunnel.example.test/mcp");
  });

  it("distinguishes initial connection, reconnect, and retry errors", () => {
    expect(presentConnectionState(supervisorState({ phase: "connecting", attempt: 1 }))).toEqual({
      phase: "connecting",
      error: null,
      traceId: null,
      stage: "preparing",
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "connecting",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Socket closed.",
            traceId: "trace-previous",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Socket closed.",
      traceId: "trace-previous",
      stage: "preparing",
      failure: {
        kind: "retrying",
        reason: "transport",
        detail: "Socket closed.",
        traceId: "trace-previous",
      },
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "backoff",
          attempt: 2,
          retryAt: 1,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
            traceId: "trace-1",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Disconnected.",
      traceId: "trace-1",
      retryAt: 1,
      failure: {
        kind: "retrying",
        reason: "transport",
        detail: "Disconnected.",
        traceId: "trace-1",
      },
    });
  });

  it("preserves the latest failure while the next attempt is active", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          phase: "connecting",
          stage: "opening",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Relay connection timed out.",
            traceId: "trace-retry",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Relay connection timed out.",
      traceId: "trace-retry",
      stage: "opening",
      failure: {
        kind: "retrying",
        reason: "transport",
        detail: "Relay connection timed out.",
        traceId: "trace-retry",
      },
    });
  });

  it("names the step a reconnect is on instead of a bare connecting label", () => {
    const failure = new ConnectionTransientError({ reason: "transport", detail: "Lost." });
    const label = (overrides: Partial<SupervisorConnectionState>) =>
      connectionProgressLabel(presentConnectionState(supervisorState(overrides)), 0);

    expect(label({ attempt: 1 })).toBe("Connecting");
    expect(label({ attempt: 2, lastFailure: failure })).toBe("Reconnecting");
    expect(label({ attempt: 2, lastFailure: failure, stage: "opening" })).toBe(
      "Opening connection",
    );
    expect(label({ attempt: 2, lastFailure: failure, stage: "synchronizing" })).toBe("Syncing");
    expect(label({ phase: "offline", stage: null })).toBe("Offline");
    expect(label({ phase: "blocked", stage: null, lastFailure: failure })).toBe(
      "Connection failed",
    );
  });

  it("counts down to the next retry and stops at zero", () => {
    const waiting = presentConnectionState(
      supervisorState({
        phase: "backoff",
        stage: null,
        attempt: 3,
        retryAt: 100_000,
        lastFailure: new ConnectionTransientError({ reason: "timeout", detail: "No answer." }),
      }),
    );

    expect(connectionProgressLabel(waiting, 88_000)).toBe("Retrying in 12s");
    // A partial second rounds up, so the label never reads 0s while still waiting.
    expect(connectionProgressLabel(waiting, 99_500)).toBe("Retrying in 1s");
    expect(connectionProgressLabel(waiting, 100_000)).toBe("Retrying");
    expect(connectionProgressLabel(waiting, 100_000 - 240_000)).toBe("Retrying in 4m");
  });

  it("shows an unreachable host quietly through backoff and the next attempt", () => {
    const failure = new ConnectionTransientError({
      reason: "host-unreachable",
      detail: "Cannot reach mbp over SSH (192.168.1.20:22: Operation timed out).",
    });
    const waiting = presentConnectionState(
      supervisorState({ phase: "backoff", attempt: 3, lastFailure: failure, retryAt: 241_000 }),
    );
    expect(waiting).toMatchObject({ phase: "reconnecting", unreachable: true });
    expect(connectionProgressLabel(waiting, 1_000)).toBe("Unreachable, retrying in 4m");
    expect(connectionProgressLabel(waiting, 236_000)).toBe("Unreachable, retrying in 5s");
    expect(connectionStatusTitle(waiting)).toBe("Host unreachable");
    expect(connectionStatusText(waiting)).toBe(
      "Host unreachable. Reconnecting... Reason: Cannot reach mbp over SSH (192.168.1.20:22: Operation timed out).",
    );

    const trying = presentConnectionState(
      supervisorState({ phase: "connecting", attempt: 4, lastFailure: failure }),
    );
    expect(trying).toMatchObject({ phase: "reconnecting", unreachable: true });
    expect(connectionProgressLabel(trying, 0)).toBe("Unreachable, retrying");

    const broken = presentConnectionState(
      supervisorState({
        phase: "backoff",
        attempt: 2,
        lastFailure: new ConnectionTransientError({
          reason: "remote-unavailable",
          detail: "Server stopped.",
        }),
        retryAt: 5_000,
      }),
    );
    expect(broken.unreachable).toBeUndefined();
    expect(connectionStatusTitle(broken)).toBe("Failed to connect. Reconnecting...");
  });

  it("preserves an explicitly available environment while offline", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          desired: false,
          network: "offline",
          phase: "available",
          stage: null,
          attempt: 0,
        }),
      ),
    ).toEqual({
      phase: "available",
      error: null,
      traceId: null,
    });
  });
});

describe("offlineSnapshotAgeLabel", () => {
  const captured = "2026-10-19T10:00:00.000Z";
  const at = (minutes: number) => Date.parse(captured) + minutes * 60_000;

  it("names the age of the captured snapshot in coarse steps", () => {
    expect(offlineSnapshotAgeLabel(captured, at(0.5))).toBe("last state just now");
    expect(offlineSnapshotAgeLabel(captured, at(7))).toBe("last state 7 min ago");
    expect(offlineSnapshotAgeLabel(captured, at(135))).toBe("last state 2 h ago");
    expect(offlineSnapshotAgeLabel(captured, at(60 * 72))).toBe("last state 3 d ago");
  });

  it("shows no age it cannot vouch for", () => {
    expect(offlineSnapshotAgeLabel(null, at(5))).toBeNull();
    expect(offlineSnapshotAgeLabel("not a time", at(5))).toBeNull();
    // A clock behind the hub's must not read as a negative age.
    expect(offlineSnapshotAgeLabel(captured, at(-3))).toBe("last state just now");
  });
});

describe("connection rows", () => {
  const row = (connection: Partial<EnvironmentConnectionPresentation>) =>
    connectionRowShowsSnapshotAge({ error: null, traceId: null, phase: "offline", ...connection });

  it("name the snapshot age only while nothing is trying to connect", () => {
    expect(row({ phase: "offline" })).toBe(true);
    expect(row({ phase: "error" })).toBe(true);
    expect(row({ phase: "unsupported" })).toBe(true);
  });

  it("leave a live attempt or retry countdown without a stale age beside it", () => {
    expect(row({ phase: "connecting", stage: "opening" })).toBe(false);
    expect(row({ phase: "reconnecting", retryAt: 3_000 })).toBe(false);
    expect(row({ phase: "connected" })).toBe(false);
  });

  it("pulls forward only a retry that is waiting on its backoff", () => {
    const base = { error: null, traceId: null } as const;
    expect(connectionWaitsToRetry({ ...base, phase: "reconnecting", retryAt: 1 })).toBe(true);
    expect(connectionWaitsToRetry({ ...base, phase: "reconnecting", retryAt: null })).toBe(false);
    expect(connectionWaitsToRetry({ ...base, phase: "error" })).toBe(false);
    expect(connectionWaitsToRetry({ ...base, phase: "connecting" })).toBe(false);
  });
});

describe("shared SSH reconciliation", () => {
  const origin = {
    supervisorId: "window-one",
    attemptId: 1,
    routeId: "ssh:fixture",
    stage: "preparing",
    setupTimeout: true,
  } as const;
  const ready = {
    supervisorId: "window-one",
    attemptId: 2,
    routeId: "ssh:fixture",
    operationId: "op-2",
    attachmentId: "attachment-2",
    runtimeStatus: {
      host: "fixture",
      state: "ready",
      runtimeVersion: null,
      requestedVersion: "1.0.0",
    },
  } as const;
  const failure = new ConnectionTransientError({
    reason: "timeout",
    detail: "Old setup timed out.",
    traceId: "old-trace",
  });
  const snapshot = (overrides: Partial<SupervisorConnectionState> = {}) =>
    supervisorState({
      attempt: 2,
      lastFailure: failure,
      failureOrigin: origin,
      sshRuntimeReady: ready,
      ...overrides,
    });

  it("suppresses the old timeout for every shared consumer while keeping diagnostic evidence", () => {
    const connection = presentConnectionState(snapshot({ stage: "opening" }));
    expect(connection).toMatchObject({
      phase: "reconnecting",
      error: null,
      traceId: null,
      failure: { detail: failure.detail },
      failureOrigin: origin,
      sshRuntimeReady: ready,
    });
    expect(connectionStatusText(connection)).toBe("Runtime ready · Opening connection");
    expect(connectionStatusTitle(connection)).toBe("Runtime ready · Opening connection");
    expect(connectionProgressLabel(connection, 0)).toBe("Opening connection");
    expect(connection.phase).not.toBe("connected");
  });

  it.each([
    { failureOrigin: { ...origin, attemptId: 2 }, sshRuntimeReady: { ...ready, attemptId: 1 } },
    { failureOrigin: { ...origin, attemptId: 2 } },
    { sshRuntimeReady: { ...ready, supervisorId: "other-window" } },
    { sshRuntimeReady: { ...ready, routeId: "ssh:other" } },
    { failureOrigin: { ...origin, setupTimeout: false } },
    {
      sshRuntimeReady: {
        ...ready,
        runtimeStatus: { ...ready.runtimeStatus, state: "providers_not_ready" as const },
      },
    },
  ])("keeps fresh, same-attempt, incomparable and non-setup failures visible: %j", (overrides) => {
    const connection = presentConnectionState(snapshot(overrides));
    expect(connection.error).toBe(failure.message);
    expect(connectionStatusText(connection)).toContain(failure.message);
    expect(connectionStatusTitle(connection)).toBe("Failed to connect. Reconnecting...");
  });

  it("does not assign attempt provenance to an owner poll or hide real auth/socket errors", () => {
    const { failureOrigin: _origin, ...noOrigin } = snapshot();
    const connection = presentConnectionState(noOrigin);
    expect(reconcileSshConnectionPresentation(connection, ready.runtimeStatus).error).toBe(
      failure.message,
    );
    for (const lastFailure of [
      new ConnectionBlockedError({ reason: "authentication", detail: "Key rejected." }),
      new ConnectionTransientError({ reason: "transport", detail: "Socket closed." }),
    ]) {
      expect(presentConnectionState(snapshot({ lastFailure })).error).toBe(lastFailure.message);
    }
  });

  it.each(["uploading", "checking", "starting", "connecting"] as const)(
    "puts active %s before retry text/title without leaking the old error",
    (phase) => {
      const sshPreparation = {
        ...origin,
        attemptId: 2,
        operationId: "op-2",
        phase,
        hostAnswered: true,
      };
      const connection = presentConnectionState(snapshot({ sshPreparation }));
      const text =
        phase === "uploading"
          ? "Installing GOAT runtime. First setup can take a few minutes"
          : phase === "checking"
            ? "Checking GOAT runtime"
            : phase === "starting"
              ? "Starting GOAT"
              : "Connecting to SSH host";
      expect(connection.error).toBeNull();
      expect(connection.failure?.detail).toBe(failure.detail);
      expect(connectionStatusText(connection)).toBe(text);
      expect(connectionStatusTitle(connection)).toBe(text);
      expect(connectionProgressLabel(connection, 0)).toBe(text);
      const terminal = presentConnectionState(snapshot({ stage: "synchronizing" }));
      expect(terminal.sshPreparation).toBeUndefined();
      expect(connectionProgressLabel(terminal, 0)).toBe("Syncing");
    },
  );

  it("invalidates ready suppression for current failed, stopped or untrusted owner evidence", () => {
    const connection = presentConnectionState(snapshot());
    for (const state of [
      "failed",
      "stopped",
      "untrusted",
      "auth_failed",
      "update_waiting",
    ] as const) {
      const reconciled = reconcileSshConnectionPresentation(connection, {
        ...ready.runtimeStatus,
        state,
      });
      expect(reconciled.error).toBe(failure.message);
      expect(reconciled.sshRuntimeReady).toBeUndefined();
      expect(connectionStatusText(reconciled)).toContain(failure.message);
    }
    // A delayed preparing poll cannot reintroduce the terminal-to-poll gap.
    expect(
      reconcileSshConnectionPresentation(connection, {
        ...ready.runtimeStatus,
        state: "preparing",
        phase: "starting",
      }).error,
    ).toBeNull();
  });

  it("clears active text when disconnected, offline or connected and never enables session actions from runtime ready", () => {
    const sshPreparation = {
      ...origin,
      operationId: "op",
      phase: "uploading",
      hostAnswered: true,
    } as const;
    for (const phase of ["available", "offline", "connected"] as const) {
      const connection = presentConnectionState(snapshot({ phase, sshPreparation }));
      expect(connectionStatusText(connection)).not.toContain("Installing");
      expect(connectionProgressLabel(connection, 0)).not.toContain("Installing");
    }
    const state = snapshot({ stage: "opening" });
    expect(connectionProjectionPhase(state)).toBe("synchronizing");
  });
});
