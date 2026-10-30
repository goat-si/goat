import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PreviewAutomationConnectionId,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationTimeoutError,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { McpSchema, McpServer } from "effect/ai";

import {
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
} from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { layerPermissionProfilesOff, liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewHandlers from "./handlers.ts";
import { claimPreviewRecording } from "./handlers.ts";
import { PreviewStandardToolkit } from "./tools.ts";

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "preview-retry-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "preview-retry-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect(
  "opens one preview tab on a keyed retry and rechecks browser access before replay",
  () => {
    const opened: Array<unknown> = [];
    const runIds: Array<string | undefined> = [];
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("preview-retry-environment"),
      requestNamespace: "preview-retry-session",
      thread: {
        threadId: ThreadId.make("preview-retry-thread"),
        providerSessionId: "preview-retry-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["preview"]),
      issuedAt: 0,
    };
    const open = (
      clientRequestId: string | undefined,
      url = "https://example.com",
      invocation = scope,
    ) =>
      McpServer.McpServer.pipe(
        Effect.flatMap((server) =>
          server.callTool({
            name: "goat_preview_open",
            arguments: { reuseExistingTab: false, url, clientRequestId },
          }),
        ),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      );
    const dependencies = Layer.mergeAll(
      layerPermissionProfilesOff,
      liveThreadsLayer,
      ServerConfig.layerTest(process.cwd(), { prefix: "goat-preview-retry-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
      Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
        invoke: <A>(
          request: Parameters<
            PreviewAutomationBroker.PreviewAutomationBroker["Service"]["invoke"]
          >[0],
        ) =>
          Effect.sync(() => {
            opened.push(request.input);
            runIds.push(request.runId);
            return {
              available: true,
              visible: true,
              tabId: PreviewTabId.make(`tab-${opened.length}`),
              url: "https://example.com",
              title: "Example",
              loading: false,
            } as A;
          }),
      }),
    );
    return Effect.gen(function* () {
      const first = yield* open("preview-1");
      expect(first.isError, JSON.stringify(first)).not.toBe(true);
      expect(yield* open("preview-1")).toEqual(first);
      expect(opened).toHaveLength(1);
      expect(runIds).toEqual(["run:mcp-test"]);
      expect(opened[0]).not.toHaveProperty("clientRequestId");
      expect((yield* open("preview-1", "https://example.org")).isError).toBe(true);
      expect(
        (yield* open("preview-1", undefined, { ...scope, capabilities: new Set() })).isError,
      ).toBe(true);
      expect(opened).toHaveLength(1);
      yield* open("preview-2");
      yield* open(undefined);
      expect(opened).toHaveLength(3);
    }).pipe(
      Effect.provide(
        McpHttpServer.toolkitRegistration(
          PreviewStandardToolkit,
          PreviewHandlers.layerStandard,
        ).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(dependencies),
          Layer.provideMerge(Sqlite.layerMemory),
        ),
      ),
    );
  },
);

it.effect("preview results and failures expose safety and a next step after MCP encoding", () => {
  const scope: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("preview-safety-env"),
    requestNamespace: "preview-safety",
    thread: {
      threadId: ThreadId.make("preview-safety-thread"),
      providerSessionId: "safety",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["preview"]),
    issuedAt: 0,
  };
  const dependencies = Layer.mergeAll(
    layerPermissionProfilesOff,
    liveThreadsLayer,
    ServerConfig.layerTest(process.cwd(), { prefix: "goat-preview-safety-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
    Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
      invoke: <A>(
        request: Parameters<
          PreviewAutomationBroker.PreviewAutomationBroker["Service"]["invoke"]
        >[0],
      ) => {
        if (request.operation === "type")
          return Effect.fail(
            new PreviewAutomationTimeoutError({
              environmentId: scope.environmentId,
              threadId: ThreadId.make("preview-safety-thread"),
              providerSessionId: "safety",
              providerInstanceId: ProviderInstanceId.make("codex"),
              clientId: "browser",
              connectionId: PreviewAutomationConnectionId.make("connection"),
              operation: "type",
              requestId: "safety-request",
              timeoutMs: 1,
            }),
          );
        if (request.operation === "hover")
          return Effect.fail(
            new PreviewAutomationTimeoutError({
              environmentId: scope.environmentId,
              threadId: ThreadId.make("preview-safety-thread"),
              providerSessionId: "safety",
              providerInstanceId: ProviderInstanceId.make("codex"),
              clientId: "browser",
              connectionId: PreviewAutomationConnectionId.make("connection"),
              operation: "hover",
              requestId: "safety-request",
              timeoutMs: 1,
              interceptedBy:
                "Pointer intercepted by <div> (dialog). Now at the target: <div> (dialog) #consent.",
            }),
          );
        if (request.operation === "drag")
          return Effect.fail(
            new PreviewAutomationControlInterruptedError({
              environmentId: scope.environmentId,
              threadId: ThreadId.make("preview-safety-thread"),
              providerSessionId: "safety",
              providerInstanceId: ProviderInstanceId.make("codex"),
              clientId: "browser",
              connectionId: PreviewAutomationConnectionId.make("connection"),
              operation: "drag",
              requestId: "safety-request",
              timeoutMs: 1,
              remoteTag: "PreviewAutomationControlInterruptedError",
              remoteMessageLength: 0,
              cause: undefined,
              reason: "stopped",
              dispatched: true,
            }),
          );
        if (request.operation === "press")
          return Effect.fail(
            new PreviewAutomationControlInterruptedError({
              environmentId: scope.environmentId,
              threadId: ThreadId.make("preview-safety-thread"),
              providerSessionId: "safety",
              providerInstanceId: ProviderInstanceId.make("codex"),
              clientId: "browser",
              connectionId: PreviewAutomationConnectionId.make("connection"),
              operation: "press",
              requestId: "safety-request",
              timeoutMs: 1,
              remoteTag: "PreviewAutomationControlInterruptedError",
              remoteMessageLength: 0,
              cause: undefined,
              reason: "stopped",
              dispatched: false,
            }),
          );
        if (request.operation === "fillSecret")
          return Effect.succeed({
            filled: true,
            origin: "https://x.test",
            privateMode: false,
          } as A);
        return Effect.succeed((request.operation === "evaluate" ? 42 : {}) as A);
      },
    }),
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const click = yield* server.callTool({
      name: "goat_preview_click",
      arguments: { selector: "button" },
    });
    expect(click.isError, JSON.stringify(click)).not.toBe(true);
    expect(click.structuredContent).toMatchObject({
      safety: { possibleCommit: true, retryClass: "never", code: "write_committed" },
    });
    const evaluated = yield* server.callTool({
      name: "goat_preview_evaluate",
      arguments: { expression: "42" },
    });
    expect(evaluated.structuredContent).toMatchObject({
      value: 42,
      safety: { possibleCommit: true, retryClass: "never" },
    });
    const failed = yield* server.callTool({
      name: "goat_preview_type",
      arguments: { selector: "input", text: "hello" },
    });
    expect(failed.isError).toBe(true);
    expect(
      JSON.parse(
        failed.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      ),
    ).toMatchObject({
      _tag: "PreviewAutomationTimeoutError",
      safety: { possibleCommit: true, retryClass: "never" },
      next: expect.stringMatching(/^Observe first: the input may have landed/),
    });
    // A real interception may have pressed: the hint names the cover and still says observe first.
    const covered = yield* server.callTool({
      name: "goat_preview_hover",
      arguments: { selector: "button" },
    });
    const coveredText = covered.content.find((part) => part.type === "text");
    expect(coveredText?.type === "text" ? JSON.parse(coveredText.text) : null).toMatchObject({
      safety: { possibleCommit: true },
      next: expect.stringMatching(/^Something covered the target .*Observe first/),
    });
    // Stop while input was going out is still final: safety stays cautious and no hint is given.
    const stoppedMidway = yield* server.callTool({
      name: "goat_preview_drag",
      arguments: { source: "#a", target: "#b" },
    });
    const midwayText = stoppedMidway.content.find((part) => part.type === "text");
    const midway = midwayText?.type === "text" ? JSON.parse(midwayText.text) : {};
    expect(midway).toMatchObject({ reason: "stopped" });
    expect(midway).not.toHaveProperty("next");
    // A tab stopped before the key went out sent nothing.
    const stopped = yield* server.callTool({ name: "goat_preview_press", arguments: { key: "a" } });
    expect(stopped.isError).toBe(true);
    const stoppedText = stopped.content.find((part) => part.type === "text");
    expect(stoppedText?.type === "text" ? JSON.parse(stoppedText.text) : null).toMatchObject({
      reason: "stopped",
      safety: { possibleCommit: false },
    });
    // Stop is final: no hint invites another attempt.
    expect(stoppedText?.type === "text" ? JSON.parse(stoppedText.text) : {}).not.toHaveProperty(
      "next",
    );
    const filled = yield* server.callTool({
      name: "goat_preview_fill_secret",
      arguments: { secretRef: "secret-ref" },
    });
    expect(filled.isError, JSON.stringify(filled)).not.toBe(true);
    expect(filled.structuredContent).toMatchObject({
      filled: true,
      safety: { possibleCommit: true, retryClass: "never" },
    });
  }).pipe(
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provide(
      McpHttpServer.toolkitRegistration(PreviewStandardToolkit, PreviewHandlers.layerStandard).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(dependencies),
        Layer.provideMerge(Sqlite.layerMemory),
      ),
    ),
  );
});

describe("claimPreviewRecording", () => {
  it.effect("overlapping and repeated claims return the same retained recording", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const uploadedAttachmentId = createPendingAttachmentId(".webm");
      const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(pendingPath, "video!");
      const response = {
        id: "desktop-recording",
        tabId: "tab-1",
        path: "/desktop/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 6,
        createdAt: "2026-09-07T00:00:00.000Z",
        uploadedAttachmentId,
      };
      const claim = claimPreviewRecording(ThreadId.make("thread-1"), response);
      const [first, second] = yield* Effect.all([claim, claim], { concurrency: "unbounded" });
      expect(first).toEqual(second);
      expect(yield* claim).toEqual(first);
      expect(yield* fileSystem.readFileString(first.path)).toBe("video!");
      expect(yield* fileSystem.exists(pendingPath)).toBe(false);
      const wrongThread = yield* claimPreviewRecording(ThreadId.make("thread-2"), response).pipe(
        Effect.result,
      );
      expect(wrongThread._tag).toBe("Failure");
      const wrongPath = yield* claimPreviewRecording(ThreadId.make("thread-1"), {
        ...response,
        uploadedAttachmentId: `../${uploadedAttachmentId}`,
      }).pipe(Effect.result);
      expect(wrongPath._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "goat-preview-recording-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([6, 5])(
    "claims only a complete uploaded recording (reported bytes: %s)",
    (sizeBytes) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const uploadedAttachmentId = createPendingAttachmentId(".webm");
        const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
        yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(pendingPath, "video!");
        const response = {
          id: "desktop-recording",
          tabId: "tab-1",
          path: "/desktop/recording.webm",
          mimeType: "video/webm",
          sizeBytes,
          createdAt: "2026-09-07T00:00:00.000Z",
          uploadedAttachmentId,
        };
        const result = yield* claimPreviewRecording(ThreadId.make("thread-1"), response).pipe(
          Effect.result,
        );
        if (sizeBytes === 6) {
          expect(result._tag).toBe("Success");
          if (result._tag !== "Success") return;
          expect(result.success.path).not.toBe(response.path);
          expect(parseThreadSegmentFromAttachmentId(result.success.id)).toBe("thread-1");
          expect(yield* fileSystem.readFileString(result.success.path)).toBe("video!");
          expect(yield* fileSystem.exists(pendingPath)).toBe(false);
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag !== "Failure") return;
          expect(result.failure._tag).toBe("PreviewAutomationRecordingTransferError");
          expect(yield* fileSystem.exists(pendingPath)).toBe(true);
        }
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "goat-preview-recording-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );
});

it.effect(
  "explains an empty browser and refuses page reads on an older host or a disabled capability",
  () => {
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("read-mcp-environment"),
      requestNamespace: "read-mcp-session",
      thread: {
        threadId: ThreadId.make("read-mcp-thread"),
        providerSessionId: "read-mcp-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["preview"]),
      issuedAt: 0,
    };
    return Effect.scoped(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        const ready = yield* Deferred.make<void>();
        const events = yield* broker.connect({
          clientId: "read-older-host",
          environmentId: scope.environmentId,
        });
        yield* Stream.runForEach(events, (event) =>
          event.type === "connected"
            ? Deferred.succeed(ready, undefined)
            : broker.respond({
                clientId: "read-older-host",
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: true,
                result: {
                  available: false,
                  visible: false,
                  tabId: null,
                  url: null,
                  title: null,
                  loading: false,
                },
              }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(ready);
        const status = yield* server.callTool({ name: "goat_preview_status", arguments: {} });
        expect(status.structuredContent).toMatchObject({
          next: "No tab yet: call goat_preview_open with a url.",
        });
        const readTool = server.tools.find(({ tool }) => tool.name === "goat_preview_read");
        expect(readTool?.tool.description).toContain("rendered page text");
        const older = yield* server.callTool({ name: "goat_preview_read", arguments: {} });
        expect(older.isError).toBe(true);
        expect(JSON.stringify(older.content)).toContain(
          "This browser host cannot read pages; use goat_preview_snapshot.",
        );
        const disabled = yield* server.callTool({ name: "goat_preview_read", arguments: {} }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            ...scope,
            capabilities: new Set<McpInvocationContext.McpCapability>(),
          }),
        );
        expect(disabled.isError).toBe(true);
        expect(JSON.stringify(disabled.content)).toContain("browser preview tools are off");
      }),
    ).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
      Effect.provide(
        McpHttpServer.layerPreviewToolkit.pipe(
          Layer.provide(layerPermissionProfilesOff),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(liveThreadsLayer),
          Layer.provideMerge(PreviewAutomationBroker.layer),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-read-mcp-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  },
);
