import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type SshHostResult,
  type SshHostStatus,
} from "@goat/contracts";
import * as SshConfig from "@goat/ssh/config";
import { SshLaunchError } from "@goat/ssh/errors";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as SshHostSetup from "./SshHostSetup.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

const instruction =
  "Choose Update now in Settings → Connections on the desktop app that owns this connection.";
const target = { alias: "box", hostname: "box", username: null, port: null };
const stopped: SshHostStatus = {
  host: "box",
  state: "stopped",
  runtimeVersion: "0.4.2",
  requestedVersion: "0.4.3-owner",
};
const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("owner"),
  requestNamespace: "client:ssh",
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  thread: undefined,
  client: { sessionId: "client", label: "Agent", access: "full-access" },
  grantedScopes: ["environment:maintain"],
  reauthorize: () => Effect.void,
};

const fixture = Effect.gen(function* () {
  let snapshot: SshHostResult = { kind: "ok", status: stopped };
  const events: string[] = [];
  const updates: { host: string; confirmReplacement: boolean }[] = [];
  const dispatch = Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
    runtimeStatus: () => Effect.sync(() => snapshot),
    runtimeUpdate: (host, options) =>
      Effect.sync(() => {
        events.push("update");
        updates.push({ host, ...options });
        snapshot = { kind: "ok", status: { ...stopped, state: "update_waiting" } };
        return snapshot;
      }),
  });
  const setup = yield* SshHostSetup.SshHostSetup.pipe(
    Effect.provide(SshHostSetup.layer.pipe(Layer.provide(dispatch))),
  );
  const scope: McpInvocationScope = {
    ...invocation,
    reauthorize: (required) =>
      Effect.sync(() => {
        expect(required).toEqual(["environment:maintain"]);
        events.push("authorize");
      }),
  };
  return { setup, scope, events, updates };
});

it.effect("uses the dispatch owner version", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    expect(yield* f.setup.status({ host: "box" })).toEqual({ kind: "ok", status: stopped });
    expect(f.updates).toEqual([]);
  }),
);

it.effect.each([undefined, "when_idle"] as const)(
  "defaults to when_idle after live authorization (mode=%s)",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f.setup.update(
        { host: "box", ...(mode === undefined ? {} : { mode }) },
        { kind: "mcp", scope: f.scope },
      );
      expect(result).toMatchObject({ kind: "ok", status: { state: "update_waiting" } });
      expect(yield* f.setup.status({ host: "box" })).toEqual(result);
      expect(f.events).toEqual(["authorize", "update"]);
      expect(f.updates).toEqual([{ host: "box", confirmReplacement: false }]);
    }),
);

it.effect.each([false, true])(
  "MCP now returns unsupported inside and outside threads without touching runtime (thread=%s)",
  (insideThread) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f.setup.update(
        { host: "box", mode: "now" },
        {
          kind: "mcp",
          scope: {
            ...f.scope,
            thread: insideThread
              ? {
                  threadId: ThreadId.make("caller"),
                  providerSessionId: "session",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                }
              : undefined,
          },
        },
      );
      expect(result).toEqual({
        kind: "error",
        code: "unsupported",
        message: `${instruction} For an agent update, call again with mode when_idle.`,
        fix: { actor: "human", instruction },
      });
      expect(f.events).toEqual(["authorize"]);
      expect(f.updates).toEqual([]);
      expect(yield* f.setup.status({ host: "box" })).toEqual({ kind: "ok", status: stopped });
    }),
);

it.effect.each(["read-only", "missing-grant", "missing-reauthorize", "revoked"] as const)(
  "rejects %s before runtime mutation",
  (reason) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const { reauthorize, ...scopeWithoutAuthorization } = f.scope;
      const scope: McpInvocationScope = {
        ...scopeWithoutAuthorization,
        ...(reason === "read-only" ? { readOnly: true } : {}),
        ...(reason === "missing-grant" ? { grantedScopes: [] } : {}),
        ...(reason === "revoked"
          ? {
              reauthorize: () =>
                Effect.fail(
                  new EnvironmentAuthorizationError({
                    requiredScope: "environment:maintain",
                    message: "The session was revoked.",
                  }),
                ),
            }
          : reason === "missing-reauthorize" || reauthorize === undefined
            ? {}
            : { reauthorize }),
      };
      const result = yield* f.setup
        .update({ host: "box" }, { kind: "mcp", scope })
        .pipe(Effect.flip);
      expect(result.requiredScope).toBe("environment:maintain");
      expect(f.updates).toEqual([]);
    }),
);

it.effect.each(["host_unknown", "invalid_request", "ssh_failed"] as const)(
  "returns the known dispatch error %s in the common envelope",
  (reason) =>
    Effect.gen(function* () {
      const setup = yield* SshHostSetup.SshHostSetup.pipe(
        Effect.provide(
          SshHostSetup.layer.pipe(
            Layer.provide(
              Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
                runtimeStatus: () =>
                  Effect.fail(
                    new SshRemoteDispatch.SshRemoteDispatchError({ reason, message: "box failed" }),
                  ),
              }),
            ),
          ),
        ),
      );
      expect(yield* setup.status({ host: "box" })).toMatchObject({
        kind: "error",
        code: reason === "ssh_failed" ? "operation_failed" : reason,
      });
    }),
);

it.effect("shares the dispatch manager", () =>
  Effect.gen(function* () {
    let snapshot: SshHostResult = { kind: "ok", status: stopped };
    let ensures = 0;
    let statusReads = 0;
    const manager = SshTunnel.SshEnvironmentManager.of({
      status: () =>
        Effect.sync(() => {
          statusReads++;
          return snapshot;
        }),
      ensureEnvironment: (received, options) =>
        Effect.gen(function* () {
          ensures++;
          expect(received).toEqual(target);
          expect(options).toEqual({
            keyOnly: true,
            issuePairingToken: false,
            refreshRuntime: true,
            confirmReplacement: false,
          });
          snapshot = {
            kind: "ok",
            status: {
              ...stopped,
              state: "failed",
              failure: {
                reason: "archive_unavailable",
                archive: {
                  requestedVersion: stopped.requestedVersion,
                  platformKey: "linux-x64",
                  sourcesTried: ["https"],
                },
                fix: {
                  actor: "human",
                  instruction: "Install a published GOAT release, or set a release mirror.",
                },
              },
            },
          };
          return yield* new SshLaunchError({
            reason: "archive-unavailable",
            message: "No archive",
            stdout: "",
          });
        }),
      disconnectEnvironment: () => Effect.die("Unexpected disconnect"),
      revalidateTunnels: () => Effect.void,
      issueMcpClientSession: () => Effect.die("Unexpected pairing/session mutation"),
      runRemoteScript: () => Effect.die("Unexpected remote command"),
    });
    const discover = vi
      .spyOn(SshConfig, "discoverSshHosts")
      .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
    const managerLayer = vi
      .spyOn(SshTunnel.SshEnvironmentManager, "layer")
      .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
    try {
      yield* Effect.gen(function* () {
        const setup = yield* SshHostSetup.SshHostSetup;
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        expect(yield* setup.status({ host: "box" })).toEqual({ kind: "ok", status: stopped });
        const result = yield* setup.update({ host: "box" }, { kind: "mcp", scope: invocation });
        expect(result).toMatchObject({
          kind: "ok",
          status: { state: "failed", failure: { reason: "archive_unavailable" } },
        });
        expect(yield* dispatch.runtimeStatus("box")).toEqual(result);
        expect(yield* setup.status({ host: "box" })).toEqual(result);
        expect(ensures).toBe(1);
        expect(statusReads).toBe(4);
        expect(
          yield* setup.update({ host: "unknown" }, { kind: "mcp", scope: invocation }),
        ).toMatchObject({ kind: "error", code: "host_unknown" });
        expect(ensures).toBe(1);
      }).pipe(
        Effect.provide(
          SshHostSetup.layer.pipe(
            Layer.provideMerge(SshRemoteDispatch.layer),
            Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "ssh-host-setup-" })),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    } finally {
      managerLayer.mockRestore();
      discover.mockRestore();
    }
  }),
);
