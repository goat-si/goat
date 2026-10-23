import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentAuthorizationError,
  type AuthEnvironmentScope,
  type AuthClientSession,
  EnvironmentId,
  HandoffError,
  type HandoffState,
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

interface StoredHandoff {
  state: HandoffState;
  readonly args: Readonly<Record<string, unknown>>;
  readonly threadId: ThreadId;
  approvedBy?: AuthSessionId;
  finished?: boolean;
  progress?: unknown;
}
/** Persisted handoffs; sharing one across harnesses is a server restart in between. */
type HandoffStore = Map<string, StoredHandoff>;

const handoffView = (handoffId: string, record: StoredHandoff, state = record.state) =>
  ({
    handoffId,
    kind: "approval",
    state,
    requestedBy: {
      threadId: record.threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      path: HostSync.HOST_SYNC_PATH,
    },
    target: { environmentId, path: HostSync.HOST_SYNC_PATH },
  }) as never;

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
  readonly providersBroken?: boolean;
  /** The persisted state of the approval handoff, read when no sync started. */
  readonly handoffState?: () => HandoffState;
  readonly handoffStore?: HandoffStore;
  readonly hub?: boolean;
  readonly cloud?: Partial<
    Record<
      "claudeCloud" | "cursorCloud" | "devinCloud",
      { readonly ready: boolean; readonly reason?: ProviderDiagnosisReason }
    >
  >;
}) => {
  const state: Harness = { calls: [], spawned: [], handoffs: [], diagnoses: [] };
  const stored: HandoffStore = options.handoffStore ?? new Map();
  const lookup = (handoffId: string) =>
    Effect.suspend(() => {
      const record = stored.get(handoffId);
      return record === undefined
        ? Effect.fail(new HandoffError({ reason: "not_found" }))
        : Effect.succeed(record);
    });
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
          getProviders: options.providersBroken
            ? Effect.die("provider registry unavailable")
            : Effect.succeed((options.providers ?? []) as never),
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
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            hub: { enabled: options.hub === true, cloudHolder: "hub", devices: {} },
          }),
        }),
        Layer.mock(Handoffs.Handoffs)({
          create: (input) =>
            Effect.sync(() => {
              state.handoffs.push(input);
              if (!stored.has("handoff:sync"))
                stored.set("handoff:sync", {
                  state: "pending",
                  args: input.args,
                  threadId: input.requestedBy.threadId,
                });
              return {
                handoffId: TurnItemId.make("handoff:sync"),
                kind: "approval" as const,
                title: input.title,
                state: "pending" as const,
                targetPath: input.target.path,
                expiresAt: input.expiresAt ?? null,
              };
            }),
          // Like the real service, answering again with the same action replays its result.
          respond: (input, sessionId) =>
            lookup(input.handoffId).pipe(
              Effect.flatMap((record) => {
                if (record.state === "pending" || record.state === "opened") {
                  if (input.action === "completed") record.approvedBy = sessionId;
                  record.state = input.action;
                }
                if (record.state === "expired")
                  return Effect.fail(new HandoffError({ reason: "expired" }));
                return record.state === input.action
                  ? Effect.succeed(handoffView(input.handoffId, record))
                  : Effect.fail(new HandoffError({ reason: "conflict" }));
              }),
            ),
          read: (input) =>
            lookup(input.handoffId).pipe(
              Effect.map((record) =>
                handoffView(input.handoffId, record, options.handoffState?.() ?? record.state),
              ),
            ),
          completedProviderContinuations: () =>
            Effect.sync(() =>
              [...stored].flatMap(([handoffId, record]) =>
                record.state === "completed" && !record.finished && record.approvedBy
                  ? [
                      {
                        handoff: handoffView(handoffId, record),
                        args: record.args,
                        approvedBySessionId: record.approvedBy,
                      },
                    ]
                  : [],
              ),
            ),
          finishProviderContinuation: (input, progress) =>
            lookup(input.handoffId).pipe(
              Effect.map((record) => {
                record.finished = true;
                record.progress = progress;
              }),
            ),
          readProviderProgress: (input) =>
            lookup(input.handoffId).pipe(Effect.map((record) => record.progress)),
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
  grantedScopes: ["orchestration:read"],
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
    // Two clicks racing both succeed, as the handoff replays its answer, but start one sync.
    const raced = yield* Effect.all([Effect.exit(approve), Effect.exit(approve)], {
      concurrency: "unbounded",
    });
    expect(raced.filter(Exit.isSuccess)).toHaveLength(2);
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
        providersManage: true,
        arguments: { driver: "opencode", version: "1.2.3", login: true },
      },
    });

    yield* approve;
    expect(state.calls).toHaveLength(1);
  }).pipe(Effect.provide(layer));
});

it.effect("answers status for an approval that started no sync with how it ended", () => {
  let handoffState: HandoffState = "opened";
  const { layer } = harness({ providersBroken: true, handoffState: () => handoffState });
  return Effect.gen(function* () {
    const sync = yield* HostSync.ProviderHostSync;
    const agent = { kind: "mcp", scope: threadScope } as const;
    const requested = yield* sync.sync({ driver: "opencode", hosts: ["box"] }, agent);
    expect(requested.kind).toBe("needs_human");
    const status = sync.status({ handoffId: "handoff:sync" }, agent).pipe(Effect.flip);

    expect(yield* status).toMatchObject({ code: "not_found", detail: /not started a sync yet/ });
    for (const ended of ["declined", "expired", "cancelled"] as const) {
      handoffState = ended;
      expect(yield* status, ended).toMatchObject({ code: ended });
    }

    // Approved, but the sync cannot start: status says so instead of "not started yet".
    handoffState = "completed";
    yield* sync.respondHandoff(
      {
        threadId: ThreadId.make("agent-thread"),
        handoffId: TurnItemId.make("handoff:sync"),
        action: "completed",
      },
      person,
    );
    expect(yield* status).toMatchObject({
      code: "start_failed",
      detail:
        "The person approved this sync, but it did not start: an unexpected error stopped it.",
    });
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

it.effect("approves and answers status from the persisted handoff after restarts", () => {
  const agent = { kind: "mcp", scope: threadScope } as const;
  const approve = {
    threadId: ThreadId.make("agent-thread"),
    handoffId: TurnItemId.make("handoff:sync"),
    action: "completed",
  } as const;
  // Each run builds a fresh ProviderHostSync over the same persisted handoffs.
  const run = <A, E>(
    handoffStore: HandoffStore,
    program: (sync: HostSync.ProviderHostSync["Service"]) => Effect.Effect<A, E>,
    providersBroken = false,
  ) => {
    const { layer, state } = harness({ answer: remoteSyncAnswer, handoffStore, providersBroken });
    return HostSync.ProviderHostSync.pipe(
      Effect.flatMap(program),
      Effect.map((value) => ({ value, calls: state.calls })),
      Effect.provide(layer),
    );
  };
  const status = (sync: HostSync.ProviderHostSync["Service"]) =>
    sync.status({ handoffId: "handoff:sync" }, agent).pipe(Effect.flip);
  return Effect.gen(function* () {
    const started: HandoffStore = new Map();
    yield* run(started, (sync) => sync.sync({ driver: "opencode", hosts: ["box"] }, agent));
    // Approved after a restart: the request comes from the handoff, not from memory.
    const approved = yield* run(started, (sync) =>
      sync.respondHandoff(approve, person).pipe(
        Effect.andThen(sync.status({ handoffId: "handoff:sync" }, agent)),
        Effect.flatMap((state) => sync.awaitDone(state.syncId)),
      ),
    );
    expect(approved.value.done).toBe(true);
    expect(approved.calls.map(({ call }) => [call.host, call.tool, call.arguments])).toEqual([
      ["box", "goat_provider_sync", { driver: "opencode", version: "latest", login: true }],
    ]);
    const afterRestart = yield* run(started, status);
    expect(afterRestart.value).toMatchObject({ code: "not_found", detail: /server restarted/ });
    expect(afterRestart.value.message).not.toMatch(/not started a sync yet/);

    const broken: HandoffStore = new Map();
    yield* run(broken, (sync) => sync.sync({ driver: "opencode" }, agent));
    yield* run(broken, (sync) => sync.respondHandoff(approve, person), true);
    const failed = yield* run(broken, status);
    expect(failed.value).toMatchObject({
      code: "start_failed",
      detail:
        "The person approved this sync, but it did not start: an unexpected error stopped it.",
    });
  });
});

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
