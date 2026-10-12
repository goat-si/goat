import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
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
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ChatFileAttachment,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDispatchCoordinator from "../../../remoteReports/RemoteDispatchCoordinator.ts";
import * as SshRemoteDispatch from "../../../sshRemote/SshRemoteDispatch.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import { newLaunchWatch } from "../../launchWatch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as SshHandlers from "./handlers.ts";
import { SshToolkit } from "./tools.ts";

type Registration = Parameters<LaunchWatchService.LaunchWatchServiceShape["register"]>[0];
type ExternalWatch = Parameters<LaunchWatchService.LaunchWatchServiceShape["watchExternal"]>[0];

type LaunchOptions = {
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
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        validateLaunchAttachments: (requested) => Effect.succeed(requested),
        launchThread: (input, beforeLaunch) => {
          launchInputs.push(input);
          return beforeLaunch.pipe(Effect.as(remoteResult));
        },
      }),
      // A calling thread launches through the report coordinator, which wraps the SSH launch.
      Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
        launch: (input, beforeLaunch) =>
          Effect.sync(() => {
            deliveries.push(input.delivery);
            launchInputs.push(input.launch);
          }).pipe(
            Effect.andThen(beforeLaunch),
            Effect.as({ correlationId: "rr-test", launch: remoteResult, reportsSupported: true }),
          ),
      }),
      Layer.mock(LaunchWatchService.LaunchWatchService)({
        register: (input) =>
          Effect.gen(function* () {
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
                  notifyWebhook: input.requested,
                  now: 0,
                })
              : null;
          }),
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
        ...(options.notifyOnCompletion === undefined
          ? {}
          : { notifyOnCompletion: options.notifyOnCompletion }),
        ...(options.notifyWebhook === undefined ? {} : { notifyWebhook: options.notifyWebhook }),
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return {
      response: responses.at(-1)?.result,
      registrations,
      externalWatches,
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
    expect(launched.externalWatches).toEqual([expect.objectContaining({ requested: false })]);
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
        host: "box",
        threadId: "remote-thread",
        projectId: null,
        title: "Audit",
        runId: "remote-run",
        ceiling: "full-access",
        requested: true,
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

const threadId = ThreadId.make("ssh-caller");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:ssh-attachments"),
  requestNamespace: "provider:ssh-attachments",
  thread: {
    threadId,
    providerSessionId: "provider:ssh-attachments",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
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
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Ref.get(shell),
          }),
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
      Layer.provide(SshRemoteDispatch.layer),
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
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(LaunchWatchService.LaunchWatchService)({}),
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
