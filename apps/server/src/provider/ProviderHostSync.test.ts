import { expect, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
  ProviderDriverKind,
  ProviderHostMatrixResult,
  ProviderInstanceId,
} from "@goat/contracts";
import { servedRuntimeProtocolRanges } from "@goat/shared/sshRuntimeProtocol";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as HostSync from "./ProviderHostSync.ts";
import {
  type Call,
  environmentId,
  harness,
  person,
  threadScope,
  viewer,
} from "./ProviderHostSync.testkit.ts";

it.effect("reports old, stopped, and mismatched hosts instead of failing the matrix", () => {
  const { layer, state } = harness({
    answer: (call) =>
      call.host === "old"
        ? Effect.fail(
            new Dispatch.SshRemoteDispatchError({
              reason: "remote_refused",
              message: "GOAT on old does not have goat_provider_host_matrix; update GOAT on old.",
            }),
          )
        : call.host === "stopped"
          ? Effect.fail(
              new Dispatch.SshRemoteDispatchError({
                reason: "host_unavailable",
                message: "Call goat_ssh_host_prepare for stopped, then call goat_ssh_host_status.",
              }),
            )
          : Effect.succeed({
              rows: [{ host: null, status: "ok", goatVersion: "0.0.1", providers: [] }],
            }),
  });
  return Effect.gen(function* () {
    const sync = yield* HostSync.ProviderHostSync;
    const result = yield* sync.matrix({}, { kind: "client", sessionId: viewer });
    const byHost = Object.fromEntries(result.rows.map((row) => [row.host ?? "local", row]));
    expect(byHost.local?.status).toBe("ok");
    expect(byHost.local).not.toHaveProperty("cloud");
    expect(state.diagnoses).toEqual([]);
    expect(
      state.calls.map(({ call }) => ({ arguments: call.arguments, timeoutMs: call.timeoutMs })),
    ).toEqual([
      { arguments: { localOnly: true }, timeoutMs: 20_000 },
      { arguments: { localOnly: true }, timeoutMs: 20_000 },
      { arguments: { localOnly: true }, timeoutMs: 20_000 },
    ]);
    expect(byHost.local?.providers.map((provider) => provider.driver)).toContain("codex");
    expect(byHost.old?.status).toBe("update_runtime");
    expect(byHost.stopped?.status).toBe("not_ready");
    expect(byHost.stopped?.message).toContain("no ready connection to GOAT on stopped");
    expect(byHost.box).toMatchObject({ status: "ok", versionMismatch: true });
    expect(result.rows.map((row) => row.host)).toEqual([null, "old", "stopped", "box"]);
  }).pipe(Effect.provide(layer));
});

it.effect("regression #1002: judges hosts by the protocols they serve, not by GOAT version", () => {
  const served = servedRuntimeProtocolRanges();
  const protocols: Record<string, unknown> = {
    nightly: served,
    behind: { ssh: { min: 1, max: served.ssh.min - 1 }, orchestration: served.orchestration },
    ahead: {
      ssh: served.ssh,
      orchestration: { min: served.orchestration.max + 1, max: served.orchestration.max + 1 },
    },
    same: served,
    malformed: { ssh: { min: 5, max: 1 }, orchestration: served.orchestration },
  };
  const { layer } = harness({
    answer: (call) =>
      Effect.succeed({
        rows: [
          {
            host: null,
            status: "ok",
            goatVersion: call.host === "same" ? packageJson.version : "0.0.1-nightly.20261023.246",
            ...(protocols[call.host] === undefined ? {} : { protocol: protocols[call.host] }),
            // What a remote says about itself never decides the verdict this machine shows.
            versionMismatch: true,
            compatibility: "incompatible",
            message: "Remote's own warning.",
            providers: [],
          },
        ],
      }),
  });
  return Effect.gen(function* () {
    const sync = yield* HostSync.ProviderHostSync;
    const result = yield* sync.matrix(
      { hosts: ["nightly", "behind", "ahead", "legacy", "same", "malformed"] },
      { kind: "client", sessionId: viewer },
    );
    const byHost = Object.fromEntries(result.rows.map((row) => [row.host ?? "local", row]));
    // A different build serving the same protocols is informational only: no warning.
    expect(byHost.nightly).not.toHaveProperty("message");
    expect(byHost.nightly).toMatchObject({ compatibility: "compatible", versionMismatch: true });
    expect(byHost.local?.protocol).toEqual(served);
    expect(byHost.behind?.compatibility).toBe("incompatible");
    expect(byHost.behind?.message).toMatch(/Update GOAT on behind\.$/);
    expect(byHost.ahead?.compatibility).toBe("incompatible");
    expect(byHost.ahead?.message).toMatch(/Update GOAT on this machine\.$/);
    expect(byHost.legacy?.compatibility).toBe("degraded");
    expect(byHost.legacy?.message).toContain("does not report the protocols it serves");
    expect(byHost.same).toMatchObject({ compatibility: "compatible" });
    expect(byHost.same).not.toHaveProperty("versionMismatch");
    expect(byHost.same).not.toHaveProperty("message");
    expect(byHost.malformed?.compatibility).toBe("degraded");
    expect(byHost.malformed?.message).toContain("does not report the protocols it serves");
  }).pipe(Effect.provide(layer));
});

it.effect("reports cloud readiness from diagnosis, not from the CLI signed-in flag", () => {
  const { layer, state } = harness({
    providers: [
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Claude",
        installed: true,
        version: "1.2.3",
        auth: { status: "authenticated", label: "api-key", profileId: "sk-live-SECRETPROFILE" },
        setup: { canAuthenticate: true },
      },
      {
        instanceId: ProviderInstanceId.make("cursorCloud"),
        driver: ProviderDriverKind.make("cursorCloud"),
        executionLocation: "cloud",
        auth: { status: "authenticated", label: "Jun", profileId: "sk-live-SECRETPROFILE" },
      },
    ],
    cloud: {
      cursorCloud: { ready: true },
      claudeCloud: { ready: false, reason: "forbidden_environment" },
      devinCloud: { ready: false, reason: "not_signed_in" },
    },
    answer: () => Effect.succeed({ rows: [{ host: null, status: "ok", providers: [] }] }),
  });
  return Effect.gen(function* () {
    const sync = yield* HostSync.ProviderHostSync;
    const result = yield* sync.matrix(
      { localOnly: true, cloud: true },
      {
        kind: "client",
        sessionId: viewer,
      },
    );
    const decoded = yield* Schema.decodeUnknownEffect(ProviderHostMatrixResult)(result);
    const row = decoded.rows[0];
    expect(row?.providers.find((provider) => provider.driver === "claudeAgent")?.auth).toBe(
      "signed_in",
    );
    expect(row?.cloud).toMatchObject({
      claudeCloud: {
        ready: false,
        reason:
          "The provider's environment overrides its sign-in (API key, proxy or Git variables).",
      },
      cursorCloud: { ready: true, instanceId: "cursorCloud", accountLabel: "Jun", activeRuns: 0 },
      devinCloud: { ready: false, reason: "Not signed in.", command: "devin auth login" },
    });
    expect(row?.cloud?.claudeCloud).not.toHaveProperty("command");
    expect(JSON.stringify(decoded)).not.toContain("SECRETPROFILE");
    expect([...state.diagnoses].sort()).toEqual(["claudeCloud", "cursorCloud", "devinCloud"]);
    yield* sync.matrix({ hosts: ["box"], cloud: true }, { kind: "client", sessionId: viewer });
    expect(
      state.calls.map(({ call }) => ({ arguments: call.arguments, timeoutMs: call.timeoutMs })),
    ).toEqual([{ arguments: { localOnly: true, cloud: true }, timeoutMs: 120_000 }]);
  }).pipe(Effect.provide(layer));
});

it.effect("marks every cloud cell on a hub that holds cloud launches, signed in or not", () => {
  const { layer } = harness({
    hub: true,
    cloud: { cursorCloud: { ready: true } },
    answer: () => Effect.succeed({ rows: [] }),
  });
  return Effect.gen(function* () {
    const sync = yield* HostSync.ProviderHostSync;
    const result = yield* sync.matrix(
      { localOnly: true, cloud: true },
      { kind: "client", sessionId: viewer },
    );
    const cloud = result.rows[0]?.cloud;
    expect([cloud?.claudeCloud.hub, cloud?.cursorCloud.hub, cloud?.devinCloud.hub]).toEqual([
      true,
      true,
      true,
    ]);
  }).pipe(Effect.provide(layer));
});

const outsideClient = (
  grantedScopes: ReadonlyArray<AuthEnvironmentScope>,
  reauthorize: (
    required: ReadonlyArray<AuthEnvironmentScope>,
  ) => Effect.Effect<void, EnvironmentAuthorizationError> = () => Effect.void,
): McpInvocationScope => ({
  environmentId,
  requestNamespace: "remote-sync",
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  thread: undefined,
  client: { sessionId: "remote-origin", label: "Origin", access: "full-access" },
  grantedScopes,
  reauthorize,
});

const remoteSyncAnswer = (call: Call) =>
  Effect.succeed(
    call.tool === "goat_provider_sync"
      ? {
          kind: "started",
          sync: {
            syncId: "remote-sync",
            driver: "opencode",
            version: "1.2.3",
            login: true,
            startedAt: "2026-10-20T00:00:00.000Z",
            done: true,
            hosts: [{ host: null, phase: "installed", version: "1.2.3" }],
          },
        }
      : {
          rows: [{ host: null, status: "ok", goatVersion: "0.0.1", providers: [] }],
        },
  );

it.effect("refuses a read-only thread before creating a sync approval", () => {
  const { layer, state } = harness({});
  return Effect.gen(function* () {
    const sync = yield* HostSync.ProviderHostSync;
    const error = yield* sync
      .sync(
        { driver: "opencode", hosts: ["box"] },
        { kind: "mcp", scope: { ...threadScope, readOnly: true } },
      )
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredScope: "providers:manage",
    });
    expect(state.handoffs).toEqual([]);
    expect(state.calls).toEqual([]);
    expect(state.spawned).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("an outside full-access client installs only while providers:manage is live", () => {
  const { layer, state } = harness({ answer: remoteSyncAnswer });
  return Effect.gen(function* () {
    const sync = yield* HostSync.ProviderHostSync;
    const ceilingOnly = outsideClient(["orchestration:read", "orchestration:operate"]);
    const refused = yield* sync
      .sync(
        { driver: "opencode", hosts: ["box"], version: "1.2.3" },
        { kind: "mcp", scope: ceilingOnly },
      )
      .pipe(Effect.flip);
    expect(refused).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredScope: "providers:manage",
    });
    expect(state.calls).toEqual([]);
    expect(state.spawned).toEqual([]);
    expect(state.handoffs).toEqual([]);

    const seen: Array<ReadonlyArray<string>> = [];
    const managing = outsideClient(["providers:manage"], (required) =>
      Effect.sync(() => void seen.push(required)),
    );
    const started = yield* sync.sync(
      { driver: "opencode", hosts: ["box"], version: "1.2.3" },
      { kind: "mcp", scope: managing },
    );
    expect(started.kind).toBe("started");
    if (started.kind !== "started") return;
    yield* sync.awaitDone(started.sync.syncId);
    expect(state.spawned).toEqual([]);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toMatchObject({
      ceiling: "full-access",
      call: {
        host: "box",
        tool: "goat_provider_sync",
        writes: true,
        providersManage: true,
      },
    });
    expect(seen).toEqual([["providers:manage"], ["providers:manage"]]);

    const revoked = yield* sync
      .sync(
        { driver: "opencode", hosts: ["box"] },
        {
          kind: "mcp",
          scope: outsideClient(["providers:manage"], () =>
            Effect.fail(
              new EnvironmentAuthorizationError({
                requiredScope: "providers:manage",
                message: "The grant is no longer live.",
              }),
            ),
          ),
        },
      )
      .pipe(Effect.flip);
    expect(revoked).toMatchObject({ message: "The grant is no longer live." });
    expect(state.calls).toHaveLength(1);
    expect(state.spawned).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("does not carry providers:manage on a read-only remote matrix call", () => {
  const { layer, state } = harness({ answer: remoteSyncAnswer });
  return Effect.gen(function* () {
    const sync = yield* HostSync.ProviderHostSync;
    const result = yield* sync.matrix(
      { hosts: ["box"] },
      { kind: "mcp", scope: outsideClient(["orchestration:read", "orchestration:operate"]) },
    );
    expect(result.rows.map((row) => row.host)).toEqual([null, "box"]);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.call.writes).toBe(false);
    expect(state.calls[0]?.call).not.toHaveProperty("providersManage");
    expect(state.spawned).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses a person without providers:manage", () => {
  const { layer, state } = harness({});
  return Effect.gen(function* () {
    const sync = yield* HostSync.ProviderHostSync;
    const exit = yield* Effect.exit(
      sync.sync({ driver: "opencode", hosts: ["box"] }, { kind: "client", sessionId: viewer }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(state.calls).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("installs with the official argv and never relays the installer's output", () => {
  const { layer, state } = harness({
    installer: {
      stdout: "added 1 package",
      stderr: "npm ERR! //registry.npmjs.org/:_authToken=npm_SECRETTOKEN123\nnpm ERR! code E403",
      code: 1,
    },
  });
  return Effect.gen(function* () {
    const sync = yield* HostSync.ProviderHostSync;
    const started = yield* sync.sync(
      { driver: "grok", version: "1.2.3", login: false },
      { kind: "client", sessionId: person },
    );
    expect(started.kind).toBe("started");
    if (started.kind !== "started") return;
    const done = yield* sync.awaitDone(started.sync.syncId);
    expect(state.spawned.at(-1)?.args).toEqual(["install", "-g", "@xai-official/grok@1.2.3"]);
    expect(done.done).toBe(true);
    expect(done.hosts[0]).toMatchObject({ host: null, phase: "failed" });
    const wire = JSON.stringify(done);
    expect(wire).not.toContain("SECRETTOKEN");
    expect(wire).not.toContain("npm ERR");
  }).pipe(Effect.provide(layer));
});
