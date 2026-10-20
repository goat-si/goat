import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  type AuthEnvironmentScope,
  type AuthClientSession,
  EnvironmentId,
  ProviderDriverKind,
  ProviderHostMatrixResult,
  ProviderInstanceId,
  type ProviderDiagnosisReason,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as SessionStore from "../auth/SessionStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ProviderAuth from "./ProviderAuthService.ts";
import * as Diagnosis from "./ProviderDiagnosisService.ts";
import * as HostSync from "./ProviderHostSync.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const person = AuthSessionId.make("person");
const viewer = AuthSessionId.make("viewer");
const environmentId = EnvironmentId.make("origin");
const encoder = new TextEncoder();

const session = (
  sessionId: AuthSessionId,
  permissions: ReadonlyArray<AuthEnvironmentScope>,
  now: DateTime.Utc,
): AuthClientSession => ({
  sessionId,
  subject: "test",
  method: "browser-session-cookie",
  scopes: permissions,
  permissions,
  client: { label: "Test", deviceType: "unknown" },
  issuedAt: now,
  expiresAt: DateTime.add(now, { days: 1 }),
  lastConnectedAt: now,
  connected: true,
  current: true,
});

type Call = Parameters<Dispatch.SshRemoteDispatch["Service"]["callHostTool"]>[0];
interface Harness {
  readonly calls: Array<{ readonly call: Call; readonly ceiling: string }>;
  readonly spawned: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
  readonly handoffs: Array<unknown>;
  readonly diagnoses: Array<string>;
}

const cloudDriver = (driver: string, ready: boolean, reason?: ProviderDiagnosisReason) => ({
  checkedBy: "server" as const,
  diagnoses: [
    {
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      configured: true,
      ready,
      checks: ready
        ? [{ id: "auth", status: "pass" as const, summary: "Ready." }]
        : [
            {
              id: "auth",
              status: "fail" as const,
              summary: "Not ready.",
              ...(reason === undefined ? {} : { reason }),
            },
          ],
    },
  ],
});

const harness = (options: {
  readonly answer?: (call: Call) => Effect.Effect<unknown, Dispatch.SshRemoteDispatchError>;
  readonly installer?: { readonly stdout: string; readonly stderr: string; readonly code: number };
  readonly providers?: ReadonlyArray<unknown>;
  readonly cloud?: Partial<
    Record<
      "claudeCloud" | "cursorCloud" | "devinCloud",
      { readonly ready: boolean; readonly reason?: ProviderDiagnosisReason }
    >
  >;
}) => {
  const state: Harness = { calls: [], spawned: [], handoffs: [], diagnoses: [] };
  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const child = command as unknown as { command: string; args: ReadonlyArray<string> };
      state.spawned.push({ command: child.command, args: child.args });
      const result = options.installer ?? { stdout: "", stderr: "", code: 0 };
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(result.stdout)),
          stderr: Stream.make(encoder.encode(result.stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );
  const layer = HostSync.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(SessionStore.SessionStore)({
          cookieName: "goat-session",
          legacyCookieName: undefined,
          listActive: () =>
            DateTime.now.pipe(
              Effect.map((now) => [
                session(
                  person,
                  ["orchestration:read", "orchestration:operate", "providers:manage"],
                  now,
                ),
                session(viewer, ["orchestration:read", "orchestration:operate"], now),
              ]),
            ),
        }),
        Layer.mock(Dispatch.SshRemoteDispatch)({
          connectedHosts: Effect.succeed(["old", "stopped", "box"]),
          listHosts: () =>
            Effect.succeed([
              { alias: "box", source: "ssh-config" as const },
              { alias: "github.com", source: "known-hosts" as const },
            ]),
          callHostTool: <E, R>(call: Call, authorize: Effect.Effect<string, E, R>) =>
            authorize.pipe(
              Effect.flatMap((ceiling) => {
                state.calls.push({ call, ceiling });
                return options.answer?.(call) ?? Effect.die("unexpected remote call");
              }),
            ) as never,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed((options.providers ?? []) as never),
          refreshInstance: () => Effect.succeed([]) as never,
        }),
        Layer.mock(Diagnosis.ProviderDiagnosisService)({
          diagnose: (input) => {
            const driver = String(input.driver ?? "");
            state.diagnoses.push(driver);
            const cloud = options.cloud?.[driver as "claudeCloud"];
            return Effect.succeed(
              cloudDriver(driver, cloud?.ready === true, cloud?.reason ?? "not_signed_in"),
            );
          },
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          listInstances: Effect.succeed([]),
        }),
        Layer.mock(ProviderAuth.ProviderAuthService)({}),
        Layer.mock(ServerSettings.ServerSettingsService)({}),
        Layer.mock(Handoffs.Handoffs)({
          create: (input) =>
            Effect.sync(() => {
              state.handoffs.push(input);
              return {
                handoffId: TurnItemId.make("handoff:sync"),
                kind: "approval" as const,
                title: input.title,
                state: "pending" as const,
                targetPath: input.target.path,
                expiresAt: input.expiresAt ?? null,
              };
            }),
          respond: (input) =>
            Effect.succeed({ handoffId: input.handoffId, state: input.action } as never),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadSnapshot: () =>
            Effect.succeed({
              projection: { runs: [{ id: "run-1", rootNodeId: "node-1" }] },
            } as never),
        }),
        Layer.mock(Environment.ServerEnvironmentIdentity)({
          getEnvironmentId: Effect.succeed(environmentId),
        }),
        spawner,
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { state, layer };
};

const threadScope: McpInvocationScope = {
  environmentId,
  requestNamespace: "test",
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  thread: {
    threadId: ThreadId.make("agent-thread"),
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  grantedScopes: ["orchestration:read", "orchestration:operate"],
  reauthorize: () => Effect.void,
};

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
    expect(byHost.box).toMatchObject({ status: "ok", versionMismatch: true });
    expect(result.rows.map((row) => row.host)).toEqual([null, "old", "stopped", "box"]);
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

it.effect("asks a person before an agent's sync touches any host, then runs it as them", () => {
  const { layer, state } = harness({
    answer: (call) =>
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
                hosts: [
                  {
                    host: null,
                    phase: "installed",
                    version: "1.2.3",
                    login: { type: "terminal", command: "opencode auth login" },
                  },
                ],
              },
            }
          : null,
      ),
  });
  return Effect.gen(function* () {
    const sync = yield* HostSync.ProviderHostSync;
    const requested = yield* sync.sync(
      { driver: "opencode", hosts: ["box"], version: "1.2.3" },
      { kind: "mcp", scope: threadScope },
    );
    expect(requested.kind).toBe("needs_human");
    expect(state.calls).toEqual([]);
    expect(state.handoffs).toHaveLength(1);

    const declinedByViewer = yield* Effect.exit(
      sync.respondHandoff(
        {
          threadId: ThreadId.make("agent-thread"),
          handoffId: TurnItemId.make("handoff:sync"),
          action: "completed",
        },
        viewer,
      ),
    );
    expect(Exit.isFailure(declinedByViewer)).toBe(true);
    expect(state.calls).toEqual([]);

    const approve = sync.respondHandoff(
      {
        threadId: ThreadId.make("agent-thread"),
        handoffId: TurnItemId.make("handoff:sync"),
        action: "completed",
      },
      person,
    );
    // Two clicks racing: exactly one starts the sync.
    const raced = yield* Effect.all([Effect.exit(approve), Effect.exit(approve)], {
      concurrency: "unbounded",
    });
    expect(raced.filter(Exit.isSuccess)).toHaveLength(1);
    const followed = yield* sync.status(
      { handoffId: "handoff:sync" },
      { kind: "mcp", scope: threadScope },
    );
    const finished = yield* sync.awaitDone(followed.syncId);
    expect(finished.hosts).toEqual([
      {
        host: "box",
        phase: "installed",
        version: "1.2.3",
        login: { type: "terminal", command: "opencode auth login" },
      },
    ]);
    const bystander = yield* sync.status(
      { syncId: followed.syncId },
      { kind: "client", sessionId: viewer },
    );
    expect(bystander.hosts[0]).not.toHaveProperty("login");
    const stopByBystander = yield* Effect.exit(
      sync.cancel({ syncId: followed.syncId }, { kind: "client", sessionId: viewer }),
    );
    expect(Exit.isFailure(stopByBystander)).toBe(true);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toMatchObject({
      ceiling: "full-access",
      call: {
        host: "box",
        tool: "goat_provider_sync",
        writes: true,
        arguments: { driver: "opencode", version: "1.2.3", login: true },
      },
    });

    const replay = yield* Effect.exit(
      sync.respondHandoff(
        {
          threadId: ThreadId.make("agent-thread"),
          handoffId: TurnItemId.make("handoff:sync"),
          action: "completed",
        },
        person,
      ),
    );
    expect(Exit.isFailure(replay)).toBe(true);
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
