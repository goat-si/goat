import * as RepositoryReferenceMcpService from "../../RepositoryReferenceMcpService.ts";
import * as RepositoryLaunchMcpService from "../../RepositoryLaunchMcpService.ts";
import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import { goatclawRoleTemplate } from "../../../goatclaw/RoleTemplates.ts";
import * as PermissionSettings from "../../../serverSettings.ts";
import * as ConnectionCatalogBroker from "../../../connections/ConnectionCatalogBroker.ts";
import * as HubNodes from "../../../hubNodes/HubNodes.ts";
import * as SshDeviceAdd from "../../../sshRemote/SshDeviceAdd.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as DateTime from "effect/DateTime";
import * as ErrorReporter from "effect/ErrorReporter";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Handoffs from "../../../handoffs/Handoffs.ts";
import { FetchHttpClient } from "effect/http";
import {
  dependencies as setupDependencies,
  projection,
} from "../../../sshRemote/testkit/SshHostSetupTestkit.ts";
import * as ServerConfig from "../../../config.ts";
import { resolveAttachmentPath } from "../../../attachmentStore.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";
import * as McpHttpServer from "../../McpHttpServer.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type RepositoryLaunchSelection,
  SSH_PREFLIGHT_STEP_ORDER,
  type SshPreflightReport,
  TurnItemId,
  handoffSummary,
  EnvironmentAuthorizationError,
  ProjectId,
  ProviderInstanceId,
  SshWorkspaceError,
  type ServerActivityBlocker,
  SshHostResult,
  ThreadId,
  type ChatFileAttachment,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDispatchCoordinator from "../../../remoteReports/RemoteDispatchCoordinator.ts";
import * as CloudMachineService from "../../../cloudMachines/CloudMachineService.ts";
import * as SshRemoteDispatch from "../../../sshRemote/SshRemoteDispatch.ts";
import * as SshHostSetup from "../../../sshRemote/SshHostSetup.ts";
import * as SshWorkspaceSync from "../../../sshRemote/SshWorkspaceSync.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import { newLaunchWatch } from "../../launchWatch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as HostStatusMcpService from "../../HostStatusMcpService.ts";
import * as SshHandlers from "./handlers.ts";
import { profileLayer, scope, threadId } from "./handlers.testkit.ts";
import { SshToolkit } from "./tools.ts";

const decodeSshHostResult = Schema.decodeUnknownEffect(Schema.toCodecJson(SshHostResult));
const decodeStructuredJson = Schema.decodeUnknownEffect(Schema.Json);
const decodeFailureText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodedMcpFailure = (response: McpSchema.CallToolResult) =>
  response.content.map((item) =>
    item.type === "text" ? Option.getOrElse(decodeFailureText(item.text), () => item.text) : item,
  );

type Registration = Parameters<LaunchWatchService.LaunchWatchServiceShape["register"]>[0];
type ExternalWatch = Parameters<LaunchWatchService.LaunchWatchServiceShape["watchExternal"]>[0];
type Route = Parameters<LaunchWatchService.LaunchWatchServiceShape["releaseRoute"]>[0];

type LaunchOptions = {
  readonly repository?: RepositoryLaunchSelection;
  readonly repositoryRefused?: boolean;
  readonly profile?: string;
  readonly notifyOnCompletion?: boolean;
  readonly notifyWebhook?: boolean;
  readonly reportsSupported?: boolean;
  readonly registerError?: LaunchWatchService.LaunchWatchStoreError;
  /** An outside MCP client launches instead of a GOAT thread. */
  readonly outsideClient?: boolean;
  /** The outside client's approved access; full-access by default. */
  readonly clientAccess?: "full-access" | "auto" | "read-only";
  /** Whether the completion webhook takes an outside client's launch. */
  readonly webhookWatchesExternal?: boolean;
  readonly workspace?: SshRemoteDispatch.SshLaunchInput["workspace"];
  /** Routes the launch to this named webhook target. */
  readonly notifyTarget?: { readonly name: string };
  /** The launch is interrupted while its watch is being saved, after the remote thread exists. */
  readonly registerInterrupted?: boolean;
  readonly goatclawRole?: "issue-sweeper";
  readonly references?: boolean;
  readonly dispatchError?: SshRemoteDispatch.SshRemoteDispatchError;
  readonly coordinationError?: RemoteDispatchCoordinator.RemoteDispatchError;
};

/** Calls goat_ssh_thread_launch over mocks; returns its last response and what it asked for. */
const launchRaw = (options: LaunchOptions = {}) =>
  Effect.gen(function* () {
    const callerThreadId = ThreadId.make("caller");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = {
      id: callerThreadId,
      title: "Orchestrator",
      projectId: ProjectId.make("caller-project"),
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const registrations: Array<Registration> = [];
    const externalWatches: Array<ExternalWatch> = [];
    const released: Array<Route> = [];
    const launchInputs: Array<SshRemoteDispatch.SshLaunchInput> = [];
    const deliveries: Array<string> = [];
    const remoteResult: SshRemoteDispatch.SshLaunchResult = {
      host: "box",
      cwd: "/remote/project",
      projectId: "remote-project",
      projectCreated: false,
      threadId: "remote-thread",
      runId: "remote-run",
      reportsSupported: options.reportsSupported ?? true,
      workspaceStrategy: { type: "root" },
      runtimeMode: "full-access",
      remoteServerKind: "external",
      notes: ["Remote launch succeeded."],
    };
    const dependencies = Layer.mergeAll(
      profileLayer(options.profile),
      PermissionSettings.layerTest(),
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread:
          options.outsideClient === true
            ? undefined
            : { threadId: callerThreadId, providerSessionId: "session", providerInstanceId },
        client:
          options.outsideClient === true
            ? {
                sessionId: "client",
                label: "Outside agent",
                access: options.clientAccess ?? "full-access",
              }
            : undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("launcher-environment"),
          label: "studio",
        } as never),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({}),
      Layer.mock(RepositoryReferenceMcpService.RepositoryReferenceMcpService)({
        prepareBrief: (_scope, input) =>
          Effect.succeed(
            (input.message ?? "") + "\nPINNED REFERENCE: source.ts at fixture-revision",
          ),
      }),
      Layer.mock(RepositoryLaunchMcpService.RepositoryLaunchMcpService)({
        check: () =>
          options.repositoryRefused
            ? Effect.fail(
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message:
                    "Repository launch refused: selected checkout missing; candidate: /repos/project",
                }),
              )
            : Effect.succeed(["Repository verified; dependency freshness unknown."]),
      }),
      Layer.mock(SshDeviceAdd.SshDeviceAdd)({}),
      Layer.mock(SshHostSetup.SshHostSetup)({}),
      Layer.mock(CloudMachineService.CloudMachineService)({}),
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        validateLaunchAttachments: (requested) => Effect.succeed(requested),
        launchThread: (input, beforeLaunch) => {
          launchInputs.push(input);
          const outcome: Effect.Effect<
            typeof remoteResult,
            SshRemoteDispatch.SshRemoteDispatchError
          > =
            options.dispatchError === undefined
              ? Effect.succeed(remoteResult)
              : Effect.fail(options.dispatchError);
          return beforeLaunch.pipe(Effect.andThen(outcome));
        },
      }),
      // A calling thread launches through the report coordinator, which wraps the SSH launch.
      Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
        launch: (input, beforeLaunch) => {
          const failure = options.coordinationError ?? options.dispatchError;
          const outcome: Effect.Effect<
            { correlationId: string; launch: typeof remoteResult; reportsSupported: boolean },
            RemoteDispatchCoordinator.RemoteDispatchError | SshRemoteDispatch.SshRemoteDispatchError
          > =
            failure === undefined
              ? Effect.succeed({
                  correlationId: "rr-test",
                  launch: remoteResult,
                  reportsSupported: true,
                })
              : Effect.fail(failure);
          return Effect.sync(() => {
            deliveries.push(input.delivery);
            launchInputs.push(input.launch);
          }).pipe(Effect.andThen(beforeLaunch), Effect.andThen(outcome));
        },
      }),
      Layer.mock(LaunchWatchService.LaunchWatchService)({
        register: (input) =>
          Effect.gen(function* () {
            if (options.registerInterrupted === true) return yield* Effect.interrupt;
            registrations.push(input);
            if (options.registerError !== undefined) return yield* options.registerError;
            return newLaunchWatch({
              ...input,
              host: input.host ?? null,
              incarnation: "ssh-watch",
              notifyWebhook: input.notifyWebhook ?? false,
              now: 0,
            });
          }),
        watchExternal: (input) =>
          Effect.sync(() => {
            externalWatches.push(input);
            return options.webhookWatchesExternal === true
              ? newLaunchWatch({
                  ...input,
                  launcherThreadId: null,
                  host: input.host ?? null,
                  incarnation: "external-watch",
                  notifyWebhook: input.route.notifyWebhook,
                  webhookTarget: input.route.webhookTarget,
                  now: 0,
                })
              : null;
          }),
        resolveRoute: (input) =>
          Effect.succeed({
            notifyWebhook: false,
            webhookTarget: { type: "named" as const, name: input.notifyTarget?.name ?? "" },
          }),
        releaseRoute: (route) => Effect.sync(() => void released.push(route)),
      }),
    );
    const toolkit = yield* SshToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(SshHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const responses = yield* toolkit
      .handle("goat_ssh_thread_launch", {
        host: "box",
        cwd: "/remote/project",
        title: "Audit",
        message: "Review the change",
        ...(options.references
          ? {
              references: [
                {
                  mode: "snapshot" as const,
                  repositoryKey: "example.test/owner/repo",
                  files: ["source.ts"],
                },
              ],
            }
          : {}),
        ...(options.repository === undefined ? {} : { repository: options.repository }),
        ...(options.notifyOnCompletion === undefined
          ? {}
          : { notifyOnCompletion: options.notifyOnCompletion }),
        ...(options.notifyWebhook === undefined ? {} : { notifyWebhook: options.notifyWebhook }),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
        ...(options.notifyTarget === undefined ? {} : { notifyTarget: options.notifyTarget }),
        ...(options.goatclawRole === undefined ? {} : { goatclawRole: options.goatclawRole }),
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies), Effect.exit);
    return {
      response: Exit.isSuccess(responses) ? responses.value.at(-1)?.result : undefined,
      interrupted: Exit.hasInterrupts(responses),
      registrations,
      externalWatches,
      released,
      launchInputs,
      deliveries,
      callerThreadId,
      remoteResult,
    };
  });

const launchFromThread = (options: LaunchOptions = {}) =>
  Effect.gen(function* () {
    const { response, ...launched } = yield* launchRaw(options);
    if (response === undefined || !("notes" in response))
      return yield* Effect.die("Expected a successful SSH launch result.");
    return { result: response, ...launched };
  });

it.effect("refuses an unverified repository before launching or registering a watch", () =>
  Effect.gen(function* () {
    const result = yield* launchRaw({
      repository: { key: "github.com/owner/repo" },
      repositoryRefused: true,
    });
    expect(result.response).toMatchObject({ code: "invalid_request" });
    expect(result.launchInputs).toEqual([]);
    expect(result.registrations).toEqual([]);
  }),
);

it.effect("includes repository warnings in a successful SSH launch", () =>
  Effect.gen(function* () {
    const result = yield* launchFromThread({ repository: { key: "github.com/owner/repo" } });
    expect(result.result.notes).toContain("Repository verified; dependency freshness unknown.");
    expect(result.launchInputs).toHaveLength(1);
  }),
);

it.effect("keeps the dispatch reason and whether the launch may have started", () =>
  Effect.gen(function* () {
    const uncertain = new SshRemoteDispatch.SshRemoteDispatchError({
      reason: "ssh_failed",
      message: "Calling goat_thread_launch on box failed: connection reset",
      launchMayHaveStarted: true,
    });
    // A calling thread launches through the report coordinator; an outside client directly.
    for (const outsideClient of [false, true]) {
      const { response } = yield* launchRaw({ dispatchError: uncertain, outsideClient });
      expect(response, `outsideClient=${outsideClient}`).toMatchObject({
        code: "orchestration_error",
        message: uncertain.message,
        reason: "ssh_failed",
        mayHaveStarted: true,
      });
    }

    const refused = yield* launchRaw({
      dispatchError: new SshRemoteDispatch.SshRemoteDispatchError({
        reason: "remote_refused",
        message: "box refused: this credential cannot launch threads.",
        remoteCode: "capability_denied",
      }),
    });
    expect(refused.response).toMatchObject({
      reason: "remote_refused",
      remoteCode: "capability_denied",
    });
    expect(refused.response).not.toHaveProperty("mayHaveStarted");

    // Recording the dispatch can fail after the remote accepted the launch.
    const unrecorded = yield* launchRaw({
      coordinationError: new RemoteDispatchCoordinator.RemoteDispatchError({ stage: "storage" }),
    });
    expect(unrecorded.response).toMatchObject({
      code: "orchestration_error",
      message: "SSH report coordination failed.",
      mayHaveStarted: true,
    });
  }),
);

it.effect("forwards the calling thread and this machine as the remote thread's launcher", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread();
    expect(launched.launchInputs.map((input) => input.launchedBy)).toEqual([
      {
        kind: "launch",
        threadId: launched.callerThreadId,
        environmentId: "launcher-environment",
        environmentLabel: "studio",
        threadTitle: "Orchestrator",
        via: "ssh_thread_launch",
      },
    ]);
  }),
);

it.effect("starts a dispatched worktree from origin unless the caller opts out", () =>
  Effect.gen(function* () {
    const defaulted = yield* launchFromThread({
      workspace: { type: "worktree", baseRef: "dev", branch: "feat/x" },
    });
    const explicit = yield* launchFromThread({
      workspace: {
        type: "worktree",
        baseRef: "stack-parent",
        branch: "feat/y",
        startFromOrigin: false,
      },
    });
    expect(
      [...defaulted.launchInputs, ...explicit.launchInputs].map((input) => input.workspace),
    ).toEqual([
      { type: "worktree", baseRef: "dev", branch: "feat/x", startFromOrigin: true },
      { type: "worktree", baseRef: "stack-parent", branch: "feat/y", startFromOrigin: false },
    ]);
  }),
);

it.effect("launches for an outside client without naming a launcher", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({ outsideClient: true });
    expect(launched.launchInputs).toHaveLength(1);
    expect(launched.launchInputs[0]?.launchedBy).toBeUndefined();
    expect(launched.registrations).toEqual([]);
  }),
);

it.effect("leaves an outside client's launch unwatched while the webhook does not take it", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({ outsideClient: true });
    expect(launched.externalWatches).toEqual([
      expect.objectContaining({ route: { notifyWebhook: false, webhookTarget: null } }),
    ]);
    expect(launched.result).toEqual({
      ...launched.remoteResult,
      correlationId: null,
      watching: false,
      notes: launched.remoteResult.notes,
    });
  }),
);

it.effect("watches an outside client's launch for the webhook at the client's ceiling", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({
      outsideClient: true,
      notifyWebhook: true,
      webhookWatchesExternal: true,
    });
    expect(launched.registrations).toEqual([]);
    expect(launched.externalWatches).toEqual([
      {
        // The watch belongs to the launching client alone.
        owner: "session",
        host: "box",
        threadId: "remote-thread",
        projectId: null,
        title: "Audit",
        runId: "remote-run",
        ceiling: "full-access",
        route: { notifyWebhook: true, webhookTarget: null },
      },
    ]);
    expect(launched.result).toMatchObject({
      watching: true,
      notes: expect.arrayContaining([expect.stringContaining("completion webhook")]),
    });

    const optedOut = yield* launchFromThread({
      outsideClient: true,
      notifyWebhook: true,
      notifyOnCompletion: false,
      webhookWatchesExternal: true,
    });
    expect(optedOut.externalWatches).toEqual([]);
    expect(optedOut.result).toMatchObject({ watching: false });
  }),
);

it.effect("refuses an outside client below full access before launching or watching", () =>
  Effect.gen(function* () {
    const refused = yield* launchRaw({
      outsideClient: true,
      clientAccess: "auto",
      notifyWebhook: true,
      webhookWatchesExternal: true,
    });
    expect(refused.response).toMatchObject({ code: "capability_denied" });
    expect(refused.launchInputs).toEqual([]);
    expect(refused.externalWatches).toEqual([]);
  }),
);

it.effect("watches the remote run for its calling thread and explains how to stop reports", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread();
    expect(launched.registrations).toEqual([
      {
        launcherThreadId: launched.callerThreadId,
        host: "box",
        threadId: "remote-thread",
        runId: "remote-run",
        projectId: null,
        title: "Audit",
        notifyWebhook: false,
        webhookTarget: null,
      },
    ]);
    expect(launched.result).toMatchObject({
      ...launched.remoteResult,
      watching: true,
      notes: expect.arrayContaining([expect.stringContaining("goat_thread_unwatch")]),
    });
    expect(launched.deliveries).toEqual(["wake"]);
  }),
);

it.effect("records a launch's webhook opt-in on its watch, not on the remote launch", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({ notifyWebhook: true });
    expect(launched.registrations.map((registration) => registration.notifyWebhook)).toEqual([
      true,
    ]);
    expect(launched.launchInputs[0]).not.toHaveProperty("notifyWebhook");
  }),
);

it.effect("launches without registering a watch when completion notifications are disabled", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({ notifyOnCompletion: false });
    expect(launched.registrations).toEqual([]);
    expect(launched.deliveries).toEqual(["wake"]);
    expect(launched.result).toEqual({
      ...launched.remoteResult,
      correlationId: "rr-test",
      watching: false,
      notes: [...launched.remoteResult.notes, expect.stringContaining("Run ends are not followed")],
    });
  }),
);

it.effect("keeps a notify target with the watch that saved it", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({ notifyTarget: { name: "bot-a" } });
    expect(launched.registrations).toEqual([
      expect.objectContaining({ webhookTarget: { type: "named", name: "bot-a" } }),
    ]);
    expect(launched.released).toEqual([]);
  }),
);

it.effect("releases a notify target when the launch is interrupted before its watch is saved", () =>
  Effect.gen(function* () {
    const launched = yield* launchRaw({
      notifyTarget: { name: "bot-a" },
      registerInterrupted: true,
    });
    expect(launched.interrupted).toBe(true);
    // The remote thread exists, but no watch holds the route, so what it kept is freed.
    expect(launched.launchInputs).toHaveLength(1);
    expect(launched.released).toEqual([
      { notifyWebhook: false, webhookTarget: { type: "named", name: "bot-a" } },
    ]);
  }),
);

it.effect("returns the successful remote launch even when its watch cannot be saved", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({
      registerError: new LaunchWatchService.LaunchWatchStoreError({ message: "Disk full" }),
    });
    expect(launched.registrations).toHaveLength(1);
    expect(launched.result).toEqual({
      ...launched.remoteResult,
      correlationId: "rr-test",
      watching: false,
      notes: [...launched.remoteResult.notes, expect.stringContaining("Run ends are not followed")],
    });
  }),
);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "ssh-attachments", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "ssh-attachments", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const attachment: ChatFileAttachment = {
  type: "file",
  id: "pending-00000000-0000-4000-8000-000000000001-bin",
  name: "payload.bin",
  mimeType: "application/octet-stream",
  sizeBytes: 5,
};
const args = {
  host: "build-box",
  cwd: "/home/agent/repo",
  title: "Attachments",
  attachments: [attachment],
  runtimeMode: "approval-required",
};
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};
const clientScope = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  ...scope,
  requestNamespace: "client:ssh-client",
  thread: undefined,
  client: { sessionId: "ssh-client", label: "fixture", access },
});
const fixture = (sourceFault?: "missing" | "size") =>
  Effect.gen(function* () {
    const shell = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const paused = yield* Ref.make(false);
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const coordinated: RemoteDispatchCoordinator.RemoteLaunchInput[] = [];
    const direct: SshRemoteDispatch.SshLaunchInput[] = [];
    const launchResult = (
      input: SshRemoteDispatch.SshLaunchInput,
    ): SshRemoteDispatch.SshLaunchResult => ({
      host: input.host ?? input.target.alias,
      cwd: input.cwd,
      projectId: "remote-project",
      projectCreated: false,
      threadId: "remote-thread",
      workspaceStrategy: { type: "root" },
      runtimeMode: input.runtimeMode,
      remoteServerKind: null,
      notes: [],
      reportsSupported: true,
      runId: "remote-run",
    });
    const dependencies = Layer.unwrap(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const localDispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
        if (path === null) throw new Error("Fixture attachment path must resolve");
        if (sourceFault !== "missing")
          yield* fs.writeFile(path, new Uint8Array(sourceFault === "size" ? 1 : 5));
        return Layer.mergeAll(
          Profiles.layer.pipe(Layer.provide(PermissionSettings.layerTest())),
          PermissionSettings.layerTest(),
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Ref.get(shell),
          }),
          Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({}),
          Layer.mock(RepositoryReferenceMcpService.RepositoryReferenceMcpService)({}),
          Layer.mock(RepositoryLaunchMcpService.RepositoryLaunchMcpService)({}),
          Layer.mock(SshDeviceAdd.SshDeviceAdd)({}),
          Layer.mock(SshHostSetup.SshHostSetup)({}),
          Layer.mock(CloudMachineService.CloudMachineService)({}),
          Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
            validateLaunchAttachments: localDispatch.validateLaunchAttachments,
            launchThread: (input, check) =>
              Effect.gen(function* () {
                direct.push(input);
                yield* check;
                return launchResult(input);
              }),
          }),
          Layer.mock(LaunchWatchService.LaunchWatchService)({
            register: (input) =>
              Effect.succeed(
                newLaunchWatch({
                  ...input,
                  host: input.host ?? null,
                  incarnation: "attachment-watch",
                  notifyWebhook: input.notifyWebhook ?? false,
                  now: 0,
                }),
              ),
            // The completion webhook is off, as by default.
            watchExternal: () => Effect.succeed(null),
          }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getDescriptor: Effect.succeed({
              environmentId: EnvironmentId.make("launcher-environment"),
              label: "studio",
            } as never),
          }),
          Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
            launch: (input, check) =>
              Effect.gen(function* () {
                coordinated.push(input);
                if (yield* Ref.get(paused)) {
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                }
                yield* check;
                return {
                  correlationId: "ssh-correlation",
                  reportsSupported: true,
                  launch: launchResult(input.launch),
                };
              }),
          }),
        );
      }),
    ).pipe(
      Layer.provide(SshRemoteDispatch.layer.pipe(Layer.provide(PermissionSettings.layerTest()))),
      Layer.provideMerge(
        ServerConfig.layerTest("/fixture", { prefix: "ssh-handler-attachments-" }),
      ),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(NodeServices.layer),
    );
    const layer = McpHttpServer.toolkitRegistration(SshToolkit, SshHandlers.layer).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(dependencies),
      Layer.provide(NodeCrypto.layer),
    );
    const call = (arguments_: Record<string, unknown> = args, caller = scope) =>
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        return yield* server
          .callTool({ name: "goat_ssh_thread_launch", arguments: arguments_ })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      });
    return {
      shell,
      paused,
      started,
      release,
      coordinated,
      direct,
      layer,
      call,
      assertNoDispatch: () => {
        expect(coordinated).toEqual([]);
        expect(direct).toEqual([]);
      },
    };
  });

it.effect("rejects non-pending SSH attachments before dispatch", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const result = yield* f
      .call({
        ...args,
        attachments: [{ ...attachment, id: attachment.id.replace("pending-", "caller-") }],
      })
      .pipe(Effect.provide(f.layer));
    expect(declaredFailure(result)).toMatchObject({ code: "invalid_request" });
    f.assertNoDispatch();
  }),
);
it.effect("rejects nested reference write and root grants before SSH dispatch", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    for (const extra of [
      { roots: ["/arbitrary"] },
      { access: "read-write" },
      { operation: "write" },
    ]) {
      const result = yield* f
        .call({
          ...args,
          references: [
            {
              mode: "snapshot",
              repositoryKey: "invalid.example/acme/sibling",
              files: ["source.ts"],
              ...extra,
            },
          ],
        })
        .pipe(Effect.provide(f.layer));
      expect(declaredFailure(result)).toMatchObject({ code: "invalid_request" });
    }
    f.assertNoDispatch();
  }),
);
it.effect("passes pending SSH attachments and the authority check to the launch service", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.gen(function* () {
      const successful = yield* f.call({ ...args, reportDelivery: "next_turn" });
      expect(successful.isError).toBe(false);
      expect(successful.structuredContent).toMatchObject({
        correlationId: "ssh-correlation",
        reportsSupported: true,
        runId: "remote-run",
      });
      expect(f.coordinated).toHaveLength(1);
      expect(f.coordinated[0]).toMatchObject({
        kind: "thread",
        originThreadId: threadId,
        delivery: "next_turn",
        launch: {
          attachments: [attachment],
          runtimeMode: "approval-required",
          callerRuntimeMode: "full-access",
        },
      });
      expect(f.direct).toEqual([]);
      yield* Ref.set(f.paused, true);
      const fiber = yield* f.call().pipe(Effect.forkChild);
      yield* Deferred.await(f.started);
      yield* Ref.update(f.shell, (s) => ({ ...s, activeRunId: null }));
      yield* Deferred.succeed(f.release, undefined);
      const rejected = yield* Fiber.join(fiber);
      expect(declaredFailure(rejected)).toMatchObject({ code: "parent_not_active" });
      expect(f.coordinated).toHaveLength(2);
      expect(f.direct).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  }),
);
it.effect("rejects SSH launch attachment arrays above eight through MCP decoding", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const error = yield* f
      .call({
        ...args,
        attachments: Array.from({ length: 9 }, (_, n) => ({
          ...attachment,
          id: `pending-00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}-bin`,
        })),
      })
      .pipe(Effect.flip, Effect.provide(f.layer));
    // Like core.test.ts, invalid schema parameters fail callTool with InvalidParams.
    // The MCP protocol encodes this RPC error; it is not a returned tool isError payload.
    expect(error._tag).toBe("InvalidParams");
    f.assertNoDispatch();
  }),
);
it.effect("rejects SSH attachment launches from read-only clients", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const result = yield* f.call(args, clientScope("read-only")).pipe(Effect.provide(f.layer));
    expect(declaredFailure(result)).toMatchObject({ code: "capability_denied" });
    f.assertNoDispatch();
  }),
);
it.effect.each(["thread", "client"] as const)(
  "rejects SSH attachment launches from approval-required callers (%s)",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      if (kind === "thread")
        yield* Ref.update(f.shell, (s) => ({ ...s, runtimeMode: "approval-required" as const }));
      const result = yield* f
        .call(args, kind === "thread" ? scope : clientScope("approval-required"))
        .pipe(Effect.provide(f.layer));
      expect(declaredFailure(result)).toMatchObject({ code: "capability_denied" });
      f.assertNoDispatch();
    }),
);
it.effect.each(["thread", "client"] as const)(
  "rejects SSH attachment launches without orchestration capability (%s)",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const result = yield* f
        .call(args, {
          ...(kind === "thread" ? scope : clientScope("full-access")),
          capabilities: new Set<never>(),
        })
        .pipe(Effect.provide(f.layer));
      expect(declaredFailure(result)).toMatchObject({ code: "capability_denied" });
      f.assertNoDispatch();
    }),
);
it.effect("rejects SSH attachment launches after the caller turn ended", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Ref.update(f.shell, (s) => ({ ...s, activeRunId: null }));
    const result = yield* f.call().pipe(Effect.provide(f.layer));
    expect(declaredFailure(result)).toMatchObject({ code: "parent_not_active" });
    f.assertNoDispatch();
  }),
);
it.effect.each(["missing", "size"] as const)(
  "rejects a local attachment source %s before coordination",
  (sourceFault) =>
    Effect.gen(function* () {
      const f = yield* fixture(sourceFault);
      const result = yield* f.call().pipe(Effect.provide(f.layer));
      expect(declaredFailure(result)).toMatchObject({ code: "invalid_request" });
      f.assertNoDispatch();
    }),
);
it.effect("passes pending attachments to direct client launches", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const result = yield* f.call(args, clientScope("full-access")).pipe(Effect.provide(f.layer));
    expect(result.isError).toBe(false);
    expect(f.coordinated).toEqual([]);
    expect(f.direct).toHaveLength(1);
    expect(f.direct[0]?.attachments).toEqual([attachment]);
  }),
);
it.effect.each([
  { name: "duplicate", attachments: [attachment, attachment] },
  { name: "metadata", attachments: [{ ...attachment, type: "image", mimeType: "image/svg+xml" }] },
  {
    name: "limit",
    attachments: [1, 2].map((n) => ({
      ...attachment,
      id: `pending-00000000-0000-4000-8000-${String(n).padStart(12, "0")}-bin`,
      mimeType: "image/png",
      sizeBytes: 50 * 1024 * 1024,
    })),
  },
])("rejects attachment $name before coordination", ({ attachments }) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const result = yield* f.call({ ...args, attachments }).pipe(Effect.provide(f.layer));
    expect(declaredFailure(result)).toMatchObject({ code: "invalid_request" });
    f.assertNoDispatch();
  }),
);

it.effect.each([true, false])(
  "disabled watch does not claim a watch failure (reportsSupported=%s)",
  (reportsSupported) =>
    Effect.gen(function* () {
      const launched = yield* launchFromThread({ notifyOnCompletion: false, reportsSupported });
      const notes = launched.result.notes.join(" ");
      expect(notes).toContain("completion notifications are disabled");
      expect(notes).not.toContain("no launch watch was recorded");
      expect(notes.includes("Agent reports still arrive")).toBe(reportsSupported);
      expect(launched.registrations).toEqual([]);
    }),
);

it.effect("legacy launch with a failed watch does not promise agent reports", () =>
  Effect.gen(function* () {
    const launched = yield* launchFromThread({
      reportsSupported: false,
      registerError: new LaunchWatchService.LaunchWatchStoreError({ message: "Disk full" }),
    });
    expect(launched.result.notes.join(" ")).toContain("no launch watch was recorded");
    expect(launched.result.notes.join(" ")).not.toContain("Agent reports still arrive");
    expect(launched.registrations).toHaveLength(1);
  }),
);

it.effect.each([undefined, 2])("passes the SSH report limit to the coordinator (%s)", (limit) =>
  Effect.gen(function* () {
    const limits: Array<number | undefined> = [];
    const dependencies = Layer.mergeAll(
      Profiles.layer.pipe(Layer.provide(PermissionSettings.layerTest())),
      PermissionSettings.layerTest(),
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(LaunchWatchService.LaunchWatchService)({}),
      Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({}),
      Layer.mock(RepositoryReferenceMcpService.RepositoryReferenceMcpService)({}),
      Layer.mock(RepositoryLaunchMcpService.RepositoryLaunchMcpService)({}),
      Layer.mock(SshDeviceAdd.SshDeviceAdd)({}),
      Layer.mock(SshHostSetup.SshHostSetup)({}),
      Layer.mock(CloudMachineService.CloudMachineService)({}),
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({}),
      Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
        listForOrigin: (originThreadId, requestedLimit) =>
          Effect.sync(() => {
            expect(originThreadId).toBe(threadId);
            limits.push(requestedLimit);
            return [];
          }),
      }),
    );
    const toolkit = yield* SshToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(SshHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const responses = yield* toolkit
      .handle("goat_ssh_reports", limit === undefined ? {} : { limit })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(responses.at(-1)?.result).toEqual({ dispatches: [] });
    expect(limits).toEqual([limit ?? 50]);
  }),
);

type HandoffInput = Parameters<SshWorkspaceSync.SshWorkspaceSync["Service"]["handoffThread"]>[0];
type HandoffParameters = Partial<
  Pick<HandoffInput, "message" | "modelSelection" | "runtimeMode" | "interactionMode">
> & { readonly threadId?: ThreadId; readonly host?: string };

const handoff = (
  parameters: HandoffParameters = {},
  options: {
    readonly error?: SshWorkspaceError;
    readonly invocation?: McpInvocationContext.McpInvocationScope;
    readonly caller?: OrchestrationV2ThreadShell;
    readonly callerAfterTransfer?: OrchestrationV2ThreadShell;
  } = {},
) =>
  Effect.gen(function* () {
    const inputs: HandoffInput[] = [];
    const probes: boolean[] = [];
    const caller = options.caller ?? liveThreadShell(threadId);
    let currentCaller = caller;
    let callerReads = 0;
    const dependencies = Layer.mergeAll(
      Profiles.layer.pipe(Layer.provide(PermissionSettings.layerTest())),
      PermissionSettings.layerTest(),
      NodeCrypto.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.sync(() => {
            callerReads++;
            return currentCaller;
          }),
      }),
      Layer.mock(CloudMachineService.CloudMachineService)({}),
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        listHosts: ({ probe }) =>
          Effect.sync(() => {
            probes.push(probe);
            return [{ alias: "box", source: "ssh-config" as const }];
          }),
      }),
      Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({
        handoffThread: (input) =>
          Effect.gen(function* () {
            inputs.push(input);
            if (options.error !== undefined) return yield* options.error;
            currentCaller = options.callerAfterTransfer ?? caller;
            if (input.beforeRemoteChange !== undefined) yield* input.beforeRemoteChange;
            return {
              operationId: "1234abcd",
              snapshotRef: "refs/goat/ssh/1234abcd",
              snapshotOid: "a".repeat(40),
              remoteEnvironmentId: EnvironmentId.make("remote-environment"),
              remoteProjectId: ProjectId.make("remote-project"),
              remoteThreadId: ThreadId.make("remote-thread"),
              remoteRepoPath: "/remote/.goat/repos/project",
              branch: "goat/ssh/1234abcd",
            };
          }),
      }),
      Layer.mock(RepositoryReferenceMcpService.RepositoryReferenceMcpService)({}),
      Layer.mock(RepositoryLaunchMcpService.RepositoryLaunchMcpService)({}),
      Layer.mock(LaunchWatchService.LaunchWatchService)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({}),
      Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({}),
    );
    const registered = McpHttpServer.toolkitRegistration(SshToolkit, SshHandlers.layer).pipe(
      Layer.provide(
        Layer.mergeAll(
          Profiles.layer.pipe(Layer.provide(PermissionSettings.layerTest())),
          PermissionSettings.layerTest(),
          NodeCrypto.layer,
          Layer.mock(SshHostSetup.SshHostSetup)({}),
          Layer.mock(SshDeviceAdd.SshDeviceAdd)({}),
        ),
      ),
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(dependencies),
    );
    const response = yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server.callTool({
        name: "goat_ssh_thread_handoff",
        arguments: { host: "box", ...parameters },
      });
    }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, options.invocation ?? scope),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(registered),
    );
    return {
      result: response.isError ? declaredFailure(response) : response.structuredContent,
      inputs,
      probes,
      caller,
      callerReads,
    };
  });

it.effect.each([undefined, threadId])(
  "handoff resolves a known alias and permits only the caller's own run (threadId=%s)",
  (sourceThreadId) =>
    Effect.gen(function* () {
      const transferred = yield* handoff(
        sourceThreadId === undefined ? {} : { threadId: sourceThreadId },
      );
      expect(transferred.probes).toEqual([false]);
      expect(transferred.inputs).toEqual([
        {
          sourceThreadId: threadId,
          target: { alias: "box", hostname: "box", username: null, port: null },
          expectedEnvironmentId: null,
          beforeRemoteChange: expect.anything(),
          allowRunId: transferred.caller.activeRunId,
        },
      ]);
      expect(transferred.result).toMatchObject({
        host: "box",
        operationId: "1234abcd",
        remoteThreadId: "remote-thread",
        remoteProjectId: "remote-project",
        remoteRepoPath: "/remote/.goat/repos/project",
        branch: "goat/ssh/1234abcd",
        notes: [
          expect.stringContaining("goat_thread_read"),
          expect.stringContaining("Fetch branch"),
        ],
      });
    }),
);

it.effect("handoff forwards overrides for another thread without exempting the caller's run", () =>
  Effect.gen(function* () {
    const parameters = {
      threadId: ThreadId.make("other-thread"),
      message: "Continue the implementation",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "auto" as const,
      interactionMode: "plan" as const,
    };
    const transferred = yield* handoff(parameters);
    expect(transferred.inputs).toHaveLength(1);
    expect(transferred.inputs[0]).toMatchObject({
      sourceThreadId: parameters.threadId,
      message: parameters.message,
      modelSelection: parameters.modelSelection,
      runtimeMode: parameters.runtimeMode,
      interactionMode: parameters.interactionMode,
    });
    expect(transferred.inputs[0]?.allowRunId).toBeUndefined();
  }),
);

it.effect("handoff rejects an unknown alias before transferring files", () =>
  Effect.gen(function* () {
    const transferred = yield* handoff({ host: "unknown-host" });
    expect(transferred.result).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("goat_ssh_host_list"),
    });
    expect(transferred.inputs).toEqual([]);
  }),
);

it.effect.each([
  { code: "thread_busy", stage: "validate", message: "active or queued run" },
  { code: "caller_not_authorized", stage: "validate", message: "no longer authorized" },
  { code: "secret_candidate", stage: "snapshot", message: "credential-like files" },
  { code: "push_failed", stage: "push", message: "push_failed" },
] as const)("handoff preserves the workspace error code $code", ({ code, stage, message }) =>
  Effect.gen(function* () {
    const transferred = yield* handoff({}, { error: new SshWorkspaceError({ code, stage }) });
    expect(transferred.result).toMatchObject({ code, message: expect.stringContaining(message) });
    expect(transferred.inputs).toHaveLength(1);
  }),
);

it.effect.each([
  { runtimeMode: "auto" as const },
  { interactionMode: "plan" as const },
  { activeRunId: null },
])("handoff re-checks caller authority through the supplied callback (%j)", (modes) =>
  Effect.gen(function* () {
    const transferred = yield* handoff(
      {},
      { callerAfterTransfer: liveThreadShell(threadId, modes) },
    );
    expect(transferred.inputs).toHaveLength(1);
    expect(transferred.inputs[0]?.beforeRemoteChange).toBeDefined();
    expect(transferred.callerReads).toBeGreaterThan(2);
    expect(transferred.result).toMatchObject({
      code: "caller_not_authorized",
      message: expect.stringContaining("no longer authorized"),
    });
  }),
);

it.effect.each(["auto", "read-only"] as const)(
  "handoff refuses a client approved for %s before host resolution",
  (access) =>
    Effect.gen(function* () {
      const transferred = yield* handoff({ threadId }, { invocation: clientScope(access) });
      expect(transferred.result).toMatchObject({ code: "capability_denied" });
      expect(transferred.inputs).toEqual([]);
      expect(transferred.probes).toEqual([]);
    }),
);

it.effect.each([
  { runtimeMode: "auto" as const },
  { interactionMode: "plan" as const },
  { activeRunId: null },
])("handoff refuses a caller whose modes or run do not authorize it (%j)", (modes) =>
  Effect.gen(function* () {
    const transferred = yield* handoff({}, { caller: liveThreadShell(threadId, modes) });
    expect(transferred.result).toMatchObject({
      code: modes.activeRunId === null ? "parent_not_active" : "capability_denied",
    });
    expect(transferred.inputs).toEqual([]);
    expect(transferred.probes).toEqual([]);
  }),
);

it.effect("an outside full-access client must name a thread and cannot exempt an active run", () =>
  Effect.gen(function* () {
    const invocation = clientScope("full-access");
    const missing = yield* handoff({}, { invocation });
    expect(missing.result).toMatchObject({ code: "target_required" });
    expect(missing.inputs).toEqual([]);
    const transferred = yield* handoff({ threadId }, { invocation });
    expect(transferred.inputs).toHaveLength(1);
    expect(transferred.inputs[0]?.allowRunId).toBeUndefined();
  }),
);

const runtimeStatus: SshHostResult = {
  kind: "ok",
  status: {
    host: "box",
    state: "stopped",
    runtimeVersion: "0.4.2",
    requestedVersion: "0.4.3",
  },
};
const runtimeScope: McpInvocationContext.McpInvocationScope = {
  ...clientScope("full-access"),
  grantedScopes: ["environment:maintain"],
  reauthorize: () => Effect.void,
};

/** Registers the real toolkit and setup service, with dispatch as the remote boundary. */
const runtimeFixture = (
  result = runtimeStatus,
  remote?: Pick<SshRemoteDispatch.SshRemoteDispatch["Service"], "runtimeStatus" | "runtimeUpdate">,
  preflightReady = true,
  hostBlockers?: ReadonlyArray<ServerActivityBlocker>,
) => {
  const updates: { host: string; confirmReplacement: boolean }[] = [];
  const blockerReads: string[] = [];
  const catalogWrites: string[] = [];
  const preflight: SshPreflightReport = {
    host: "box",
    destination: { alias: "box", hostname: "box.example", user: "deploy", port: 22 },
    ready: preflightReady,
    steps: SSH_PREFLIGHT_STEP_ORDER.map((id) => ({
      id,
      state: !preflightReady && id === "host_key" ? "needs_review" : "passed",
      summary: "Checked.",
      ...(!preflightReady && id === "host_key" ? { fingerprint: "SHA256:human-only" } : {}),
    })),
  };
  let statusReads = 0;
  const defects: string[] = [];
  const reporter: ErrorReporter.ErrorReporter = {
    [ErrorReporter.TypeId]: ErrorReporter.TypeId,
    report: ({ cause }) => {
      defects.push(Cause.pretty(cause));
    },
  };
  const handoffs: Array<Parameters<Handoffs.Handoffs["Service"]["create"]>[0]> = [];
  const run = projection.runs[0]!;
  const callerProjection = {
    ...projection,
    thread: { ...projection.thread, id: threadId },
    runs: projection.runs.map((entry) => ({ ...entry, threadId })),
  };
  const dependencies = Layer.mergeAll(
    Profiles.layer.pipe(Layer.provide(PermissionSettings.layerTest())),
    PermissionSettings.layerTest(),
    NodeCrypto.layer,
    setupDependencies,
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadSnapshot: () =>
        Effect.succeed({ schemaVersion: 1, snapshotSequence: 0, projection: callerProjection }),
      getThreadShell: () => Effect.succeed(liveThreadShell(threadId, { activeRunId: run.id })),
    }),
    Layer.mock(Handoffs.Handoffs)({
      create: (input) =>
        Effect.gen(function* () {
          handoffs.push(input);
          expect(input.requestedBy.threadId).toBe(threadId);
          expect(input.runId).toBe(run.id);
          expect(input.nodeId).toBe(run.rootNodeId);
          return handoffSummary({
            handoffId: TurnItemId.make("runtime-approval"),
            kind: input.kind,
            title: input.title,
            reason: input.reason,
            requestedBy: input.requestedBy,
            target: input.target,
            dedupeKey: "runtime-approval",
            state: "pending",
            expiresAt: input.expiresAt ?? null,
            createdAt: yield* DateTime.now,
            actor: { type: "agent", threadId },
          });
        }),
    }),
    Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
      publishSetupOutcome: () => Effect.succeed(true),
      beginSetupOperation: (_host, { operationId }) =>
        Effect.succeed({ operationId, generation: 1, stage: "runtime" }),
      runtimeStatus: () =>
        Effect.sync(() => {
          statusReads++;
          return result;
        }).pipe(
          Effect.flatMap((value) => (remote ? remote.runtimeStatus("box") : Effect.succeed(value))),
        ),
      runtimeUpdate: (host, options) =>
        Effect.sync(() => {
          updates.push({ host, confirmReplacement: options.confirmReplacement });
        }).pipe(
          Effect.andThen(remote ? remote.runtimeUpdate(host, options) : Effect.succeed(result)),
        ),
    }),
    Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({}),
    Layer.mock(RepositoryReferenceMcpService.RepositoryReferenceMcpService)({}),
    Layer.mock(RepositoryLaunchMcpService.RepositoryLaunchMcpService)({}),
    Layer.mock(CloudMachineService.CloudMachineService)({}),
    Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({}),
    Layer.mock(LaunchWatchService.LaunchWatchService)({}),
    hostBlockers === undefined
      ? Layer.empty
      : Layer.mock(HostStatusMcpService.HostStatusMcpService)({
          read: (_scope, input) =>
            Effect.sync(() => {
              blockerReads.push(input.host ?? "");
              // Only the fields the busy-status enrichment reads.
              return {
                hosts: [
                  {
                    host: input.host ?? null,
                    reachability: "ok",
                    metrics: {
                      threads: { running: 1, waiting: 0, queued: 0, blockers: hostBlockers },
                    },
                  },
                ],
              } as never;
            }),
        }),
  );
  const registered = McpHttpServer.toolkitRegistration(SshToolkit, SshHandlers.layer).pipe(
    Layer.provide(
      SshDeviceAdd.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Profiles.layer.pipe(Layer.provide(PermissionSettings.layerTest())),
            PermissionSettings.layerTest(),
            NodeCrypto.layer,
            Layer.mock(ConnectionCatalogBroker.ConnectionCatalogBroker)({
              invoke: (operation) =>
                Effect.sync(() => {
                  expect(operation.type).toBe("add_ssh");
                  catalogWrites.push("add_ssh");
                  return {
                    type: "add_ssh" as const,
                    created: true,
                    connection: {
                      environmentId: EnvironmentId.make("box"),
                      label: "Box",
                      enabled: true,
                      routes: [],
                    },
                  };
                }),
            }),
            Layer.mock(HubNodes.HubNodes)({
              add: (input, options) =>
                options.beforeSave.pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      expect(input).toMatchObject({ kind: "ssh", alias: "box" });
                      catalogWrites.push("hub");
                      return {
                        created: true,
                        node: {
                          nodeId: EnvironmentId.make("box"),
                          environmentId: EnvironmentId.make("box"),
                          label: "Box",
                          kind: "ssh" as const,
                          status: "online" as const,
                          lastSeenAt: null,
                          addedBy: null,
                          routes: [
                            {
                              routeId: "ssh:box",
                              source: "registered" as const,
                              target: {
                                kind: "ssh" as const,
                                alias: "box",
                                hostname: null,
                                username: null,
                                port: null,
                              },
                              status: "online" as const,
                              checkedAt: null,
                              lastSeenAt: null,
                              lastError: null,
                            },
                          ],
                        },
                      };
                    }),
                  ),
                ),
            }),
          ),
        ),
      ),
    ),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          // The approval producer reads managed alias metadata; never consult the runner's real SSH home.
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-runtime-tools-" });
          yield* fs.makeDirectory(`${home}/.ssh`, { recursive: true });
          yield* fs.writeFileString(
            `${home}/.ssh/config`,
            "Host box\n  HostName box.example\n  User deploy\n",
          );
          return Layer.effect(
            SshHostSetup.SshHostSetup,
            SshHostSetup.make({
              home,
              runPreflight: () => Effect.succeed(preflight),
            }),
          );
        }),
      ),
    ),
    Layer.provide(ErrorReporter.layer([reporter])),
    Layer.provide(dependencies),
  );
  const call = (
    name:
      | "goat_ssh_host_status"
      | "goat_ssh_runtime_update"
      | "goat_ssh_host_add"
      | "goat_ssh_host_prepare"
      | "goat_ssh_host_forget",
    arguments_: Record<string, unknown>,
    invocation = runtimeScope,
  ) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server.callTool({ name, arguments: arguments_ });
    }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(registered),
    );
  return {
    registered,
    call,
    updates,
    handoffs,
    defects,
    preflight,
    catalogWrites,
    statusReads: () => statusReads,
    blockerReads,
  };
};

it.effect("discovers both runtime tools", () =>
  Effect.gen(function* () {
    const f = runtimeFixture();
    const tools = yield* McpServer.McpServer.pipe(
      Effect.map((server) => server.tools.map(({ tool }) => tool)),
      Effect.provide(f.registered),
    );
    expect(tools.find((tool) => tool.name === "goat_ssh_host_status")).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(tools.find((tool) => tool.name === "goat_ssh_runtime_update")).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: false },
    });
    const response = yield* f.call(
      "goat_ssh_host_status",
      { host: "box" },
      clientScope("read-only"),
    );
    expect(response.isError).toBe(false);
    expect(yield* decodeSshHostResult(response.structuredContent)).toEqual(runtimeStatus);
    expect(f.statusReads()).toBe(1);
    expect(f.updates).toEqual([]);
  }),
);

it.effect("names a busy host's blockers only for callers that may reach that host", () =>
  Effect.gen(function* () {
    const blockers = [
      {
        threadId: "thread-1",
        title: "Nightly build",
        reason: "running" as const,
        since: "2026-10-23T03:00:00.000Z",
      },
    ];
    const waiting: SshHostResult = {
      kind: "ok",
      status: {
        host: "box",
        state: "update_waiting",
        runtimeVersion: "0.4.2",
        requestedVersion: "0.4.3",
        waitingReason: "busy",
        detail: "Update to 0.4.3 waits for running work",
      },
    };
    const f = runtimeFixture(waiting, undefined, true, blockers);
    const named = yield* decodeSshHostResult(
      (yield* f.call("goat_ssh_host_status", { host: "box" }, runtimeScope)).structuredContent,
    );
    expect(named.kind === "ok" && named.status.blockers).toEqual(blockers);
    expect(named.kind === "ok" && named.status.detail).toContain('"Nightly build" (thread-1)');
    const plain = yield* decodeSshHostResult(
      (yield* f.call("goat_ssh_host_status", { host: "box" }, clientScope("read-only")))
        .structuredContent,
    );
    expect(plain).toEqual(waiting);
    expect(f.blockerReads).toEqual(["box"]);
  }),
);

it.effect("returns the same archive failure as desktop IPC", () =>
  Effect.gen(function* () {
    const failure = {
      kind: "ok",
      status: {
        host: "box",
        state: "failed",
        runtimeVersion: "0.4.2",
        requestedVersion: "0.4.3",
        failure: {
          reason: "archive_unavailable",
          archive: {
            requestedVersion: "0.4.3",
            platformKey: "linux-x64",
            sourcesTried: ["https", "gh"],
          },
          fix: {
            actor: "human",
            instruction:
              "This build has no published server archive. Install a published GOAT release, or set a release mirror.",
          },
        },
      },
    } satisfies SshHostResult;
    const f = runtimeFixture(failure);
    const updated = yield* f.call("goat_ssh_runtime_update", { host: "box" });
    const observed = yield* f.call("goat_ssh_host_status", { host: "box" });
    expect(updated.isError).toBe(false);
    expect(yield* decodeSshHostResult(updated.structuredContent)).toEqual(failure);
    expect(yield* decodeSshHostResult(observed.structuredContent)).toEqual(failure);
    expect(f.updates).toEqual([{ host: "box", confirmReplacement: false }]);
  }),
);

it.effect.each(["read-only", "missing-maintain", "revoked"] as const)(
  "read-only callers cannot update (grant=%s)",
  (grant) =>
    Effect.gen(function* () {
      const f = runtimeFixture();
      const invocation: McpInvocationContext.McpInvocationScope = {
        ...runtimeScope,
        ...(grant === "read-only" ? clientScope("read-only") : {}),
        ...(grant === "missing-maintain" ? { grantedScopes: [] } : {}),
        ...(grant === "revoked"
          ? {
              reauthorize: () =>
                Effect.fail(
                  new EnvironmentAuthorizationError({
                    message: "The session was revoked.",
                    requiredScope: "environment:maintain",
                  }),
                ),
            }
          : {}),
      };
      const response = yield* f.call("goat_ssh_runtime_update", { host: "box" }, invocation);
      expect(declaredFailure(response)).toMatchObject({ code: "capability_denied" });
      expect(f.updates).toEqual([]);
      expect(f.statusReads()).toBe(0);
    }),
);

it.effect.each([false, true])(
  "now asks for approval only within a real thread (thread=%s)",
  (insideThread) =>
    Effect.gen(function* () {
      const f = runtimeFixture();
      const response = yield* f.call(
        "goat_ssh_runtime_update",
        { host: "box", mode: "now" },
        {
          ...runtimeScope,
          ...(insideThread
            ? {
                ...scope,
                environmentId: EnvironmentId.make("owner"),
                grantedScopes: ["orchestration:read"],
              }
            : {}),
        },
      );
      expect(
        response.isError,
        JSON.stringify({ failure: decodedMcpFailure(response), defects: f.defects }),
      ).toBe(false);
      if (insideThread) {
        expect(response.structuredContent).toMatchObject({
          handoff: { expiresAt: expect.any(String) },
        });
        yield* decodeStructuredJson(response.structuredContent);
      }
      const result = yield* decodeSshHostResult(response.structuredContent);
      expect(result).toMatchObject(
        insideThread
          ? { kind: "needs_human", next: { after: "approval", call: "goat_ssh_host_status" } }
          : {
              kind: "error",
              code: "unsupported",
              fix: {
                actor: "human",
                instruction: "Ask from a GOAT thread so you can approve it there.",
              },
            },
      );
      expect(f.handoffs).toHaveLength(insideThread ? 1 : 0);
      if (insideThread)
        expect(f.handoffs[0]).toMatchObject({
          kind: "approval",
          target: { environmentId: EnvironmentId.make("owner"), path: "ssh.runtime_update" },
          requestedBy: { threadId },
          runId: projection.runs[0]!.id,
          nodeId: projection.runs[0]!.rootNodeId,
        });
      expect(f.updates).toEqual([]);
      expect(f.statusReads()).toBe(insideThread ? 1 : 0);
    }),
);

it.effect(
  "the actual when_idle MCP handler returns its first phase before installation is released",
  () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      let snapshot = runtimeStatus;
      const fixture = runtimeFixture(runtimeStatus, {
        runtimeStatus: () => Effect.sync(() => snapshot),
        runtimeUpdate: (_host, options) =>
          Effect.gen(function* () {
            snapshot = {
              kind: "ok",
              status: { ...runtimeStatus.status!, state: "preparing", phase: "uploading" },
            };
            options.onPhase?.({
              target: { alias: "box", hostname: "box", username: null, port: null },
              phase: "uploading",
            });
            yield* Deferred.await(gate);
            snapshot = { kind: "ok", status: { ...runtimeStatus.status!, state: "ready" } };
            yield* Deferred.succeed(completed, undefined);
            return snapshot;
          }),
      });
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const response = yield* server.callTool({
          name: "goat_ssh_runtime_update",
          arguments: { host: "box" },
        });
        expect(response.isError).toBe(false);
        expect(yield* decodeSshHostResult(response.structuredContent)).toMatchObject({
          status: { state: "preparing", phase: "uploading" },
        });
        expect(yield* Deferred.isDone(gate)).toBe(false);
        yield* Deferred.succeed(gate, undefined);
        yield* Deferred.await(completed);
        const observed = yield* server.callTool({
          name: "goat_ssh_host_status",
          arguments: { host: "box" },
        });
        expect(yield* decodeSshHostResult(observed.structuredContent)).toMatchObject({
          status: { state: "ready" },
        });
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, runtimeScope),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provide(fixture.registered),
      );
    }),
);

it.effect(
  "an update that fails authentication before a phase still returns its actual result",
  () =>
    Effect.gen(function* () {
      const expected: SshHostResult = {
        kind: "ok",
        status: { ...runtimeStatus.status!, state: "auth_failed" },
      };
      const f = runtimeFixture(expected);
      const result = yield* f.call("goat_ssh_runtime_update", { host: "box" });
      expect(result.isError).toBe(false);
      expect(yield* decodeSshHostResult(result.structuredContent)).toEqual(expected);
    }),
);

it.effect.each([
  ["goat_ssh_host_prepare", { host: "box" }],
  ["goat_ssh_host_forget", { host: "box", stopRuntime: "no" }],
] as const)("%s maps missing live authority to capability_denied before SSH", ([name, input]) =>
  Effect.gen(function* () {
    const f = runtimeFixture();
    const response = yield* f.call(name, input, { ...runtimeScope, grantedScopes: [] });
    expect(declaredFailure(response)).toMatchObject({ code: "capability_denied" });
    expect(f.updates).toEqual([]);
    expect(f.statusReads()).toBe(0);
  }),
);

it.effect(
  "SSH add saves a configured alias for a full-access outside client without settings:write",
  () =>
    Effect.gen(function* () {
      const f = runtimeFixture();
      const response = yield* f.call(
        "goat_ssh_host_add",
        { host: "box" },
        {
          ...runtimeScope,
          grantedScopes: ["orchestration:read", "orchestration:operate"],
        },
      );
      expect(response.isError).toBe(false);
      expect(response.structuredContent).toMatchObject({
        outcome: "connected",
        preflight: f.preflight,
        created: true,
        hub: { saved: true, node: { environmentId: "box" } },
        desktopCatalog: "saved",
      });
      expect(f.catalogWrites).toEqual(["add_ssh", "hub"]);
      expect(f.handoffs).toEqual([]);
    }),
);
it.effect("SSH add returns preflight when a new fingerprint needs settings:write", () =>
  Effect.gen(function* () {
    const f = runtimeFixture(runtimeStatus, undefined, false);
    const response = yield* f.call(
      "goat_ssh_host_add",
      { host: "box" },
      {
        ...runtimeScope,
        grantedScopes: ["orchestration:read", "orchestration:operate"],
      },
    );
    expect(response.isError).toBe(false);
    expect(response.structuredContent).toMatchObject({
      outcome: "capability_denied",
      preflight: {
        ready: false,
        steps: expect.arrayContaining([
          { id: "host_key", state: "needs_review", summary: "Checked." },
        ]),
      },
      saved: false,
      reason: expect.stringContaining("settings:write"),
    });
    expect(f.preflight.steps.find((step) => step.id === "host_key")?.fingerprint).toBe(
      "SHA256:human-only",
    );
    expect(JSON.stringify(response)).not.toContain("fingerprint");
    expect(JSON.stringify(response)).not.toContain("SHA256:human-only");
    expect(f.catalogWrites).toEqual([]);
    expect(f.handoffs).toEqual([]);
  }),
);

it.effect.each(["worker", "manager", "owner"])(
  "SSH launch enforces profile %s before remote effects",
  (profile) =>
    Effect.gen(function* () {
      const result = yield* launchRaw({ outsideClient: true, profile });
      if (profile === "worker") {
        expect(result.response).toMatchObject({ code: "capability_denied" });
        expect(result.launchInputs).toHaveLength(0);
      } else {
        expect(result.response).toHaveProperty("threadId");
        expect(result.launchInputs[0]?.permissionProfileCeiling?.id).toBe(profile);
      }
    }),
);

it.effect.each([false, true])(
  "SSH role launch forwards the narrowed ceiling and brief (references: %s)",
  (references) =>
    Effect.gen(function* () {
      const result = yield* launchRaw({
        outsideClient: true,
        profile: "manager",
        goatclawRole: "issue-sweeper",
        references,
      });
      const forwarded = result.launchInputs[0];
      expect(forwarded?.permissionProfileCeiling).toMatchObject({
        id: "worker",
        capabilities: ["threads.launch", "worktree.create", "pr.open"],
        runtimeModeCeiling: "auto",
      });
      expect(forwarded?.runtimeMode).toBe("auto");
      expect(forwarded?.message?.startsWith(goatclawRoleTemplate("issue-sweeper").preamble)).toBe(
        true,
      );
      expect(
        forwarded?.message?.endsWith(
          references
            ? "Review the change\nPINNED REFERENCE: source.ts at fixture-revision"
            : "Review the change",
        ),
      ).toBe(true);
    }),
);
