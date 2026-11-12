import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  type AuthEnvironmentScope,
  type AuthClientSession,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderDiagnosisReason,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
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
import * as ProviderCliGate from "./ProviderCliGate.ts";
import * as HostSync from "./ProviderHostSync.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

export const person = AuthSessionId.make("person");
export const viewer = AuthSessionId.make("viewer");
export const environmentId = EnvironmentId.make("origin");
const encoder = new TextEncoder();

export const session = (
  sessionId: AuthSessionId,
  permissions: ReadonlyArray<AuthEnvironmentScope>,
  now: DateTime.Utc,
): AuthClientSession => ({
  sessionId,
  subject: "test",
  principalKind: "person",
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

export type Call = Parameters<Dispatch.SshRemoteDispatch["Service"]["callHostTool"]>[0];
interface Harness {
  readonly calls: Array<{ readonly call: Call; readonly ceiling: string }>;
  readonly spawned: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
  readonly handoffs: Array<unknown>;
  readonly diagnoses: Array<string>;
  readonly downloads: Array<string>;
  /** Matrix reads a remote install makes before it starts, answered by `remoteRow`. */
  readonly preflights: Array<string>;
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

export const harness = (options: {
  readonly answer?: (call: Call) => Effect.Effect<unknown, Dispatch.SshRemoteDispatchError>;
  /** Matrix calls go to `answer`; otherwise each is a remote install's preflight read. */
  readonly answersMatrix?: boolean;
  /** What a remote's preflight matrix row says; by default a host with verified installs. */
  readonly remoteRow?: Record<string, unknown>;
  readonly installer?: { readonly stdout: string; readonly stderr: string; readonly code: number };
  /** The body every download returns; none answers 404. */
  readonly download?: Uint8Array;
  /** What the fake installer leaves on disk before it exits. */
  readonly onInstall?: Effect.Effect<void>;
  readonly providers?: ReadonlyArray<unknown>;
  readonly providersBroken?: boolean;
  /** Real handoffs for approval tests; the default records create and serves nothing else. */
  readonly handoffs?: Handoffs.Handoffs["Service"];
  readonly snapshot?: Threads.ThreadManagementService["Service"]["getThreadSnapshot"];
  /** The person's live grants, read on every check, so a test can revoke them. */
  readonly personScopes?: () => ReadonlyArray<AuthEnvironmentScope>;
  readonly hub?: boolean;
  /** Managed sign-in: the auth service and the provider instances it signs in. */
  readonly auth?: Partial<ProviderAuth.ProviderAuthService["Service"]>;
  readonly instances?: ReadonlyArray<{ readonly instanceId: string; readonly driverKind: string }>;
  readonly cloud?: Partial<
    Record<
      "claudeCloud" | "cursorCloud" | "devinCloud",
      { readonly ready: boolean; readonly reason?: ProviderDiagnosisReason }
    >
  >;
  /** The provider CLI gate a local install asks; none unless given. */
  readonly cliGate?: Layer.Layer<ProviderCliGate.ProviderCliGate>;
  /** An installer that runs until stopped, and whose stopping waits for killed. */
  readonly running?: {
    readonly started: Deferred.Deferred<void>;
    readonly killing: Deferred.Deferred<void>;
    readonly killed: Deferred.Deferred<void>;
  };
}) => {
  const state: Harness = {
    calls: [],
    spawned: [],
    handoffs: [],
    diagnoses: [],
    downloads: [],
    preflights: [],
  };
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        state.downloads.push(request.url);
        return HttpClientResponse.fromWeb(
          request,
          options.download === undefined
            ? new Response(null, { status: 404 })
            : new Response(new Uint8Array(options.download), { status: 200 }),
        );
      }),
    ),
  );
  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const child = command as unknown as { command: string; args: ReadonlyArray<string> };
      state.spawned.push({ command: child.command, args: child.args });
      const result = options.installer ?? { stdout: "", stderr: "", code: 0 };
      const running = options.running;
      return Effect.as(
        (options.onInstall ?? Effect.void).pipe(
          Effect.andThen(
            running === undefined ? Effect.void : Deferred.succeed(running.started, undefined),
          ),
        ),
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode:
            running === undefined
              ? Effect.succeed(ChildProcessSpawner.ExitCode(result.code))
              : Effect.never,
          isRunning: Effect.succeed(false),
          kill: () =>
            running === undefined
              ? Effect.void
              : Deferred.succeed(running.killing, undefined).pipe(
                  Effect.andThen(Deferred.await(running.killed)),
                ),
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
                  options.personScopes?.() ?? [
                    "orchestration:read",
                    "orchestration:operate",
                    "providers:manage",
                  ],
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
                if (call.tool === "goat_provider_host_matrix" && options.answersMatrix !== true) {
                  state.preflights.push(call.host);
                  return Effect.succeed({
                    rows: [
                      options.remoteRow ?? {
                        host: null,
                        status: "ok",
                        installs: "verified",
                        providers: [],
                      },
                    ],
                  });
                }
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
          listInstances: Effect.succeed((options.instances ?? []) as never),
        }),
        Layer.mock(ProviderAuth.ProviderAuthService)(options.auth ?? {}),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            hub: { ...DEFAULT_SERVER_SETTINGS.hub, enabled: options.hub === true },
          }),
        }),
        options.handoffs === undefined
          ? Layer.mock(Handoffs.Handoffs)({
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
            })
          : Layer.succeed(Handoffs.Handoffs, options.handoffs),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadSnapshot:
            options.snapshot ??
            (() =>
              Effect.succeed({
                projection: { runs: [{ id: "run-1", rootNodeId: "node-1" }] },
              } as never)),
        }),
        Layer.mock(Environment.ServerEnvironmentIdentity)({
          getEnvironmentId: Effect.succeed(environmentId),
        }),
        options.cliGate ?? Layer.empty,
        spawner,
        http,
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { state, layer };
};

export const threadScope: McpInvocationScope = {
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

export const openCodeInstance = ProviderInstanceId.make("opencode");
/** OpenCode as a snapshot reports it before its probe ran: installed, version unknown. */
export const pendingOpenCode = {
  instanceId: openCodeInstance,
  driver: ProviderDriverKind.make("opencode"),
  displayName: "OpenCode",
  enabled: true,
  installed: true,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-11-12T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

/** A CLI probe that says it started, then answers missing once released. */
export const heldGate = (probing: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  Layer.succeed(
    ProviderCliGate.ProviderCliGate,
    ProviderCliGate.ProviderCliGate.of({
      require: () => Effect.void,
      missing: () => Effect.void.pipe(Effect.as(undefined)),
      probe: () =>
        Deferred.succeed(probing, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({ kind: "missing", provider: { ...pendingOpenCode, cli: "missing" } } as const),
        ),
    }),
  );
