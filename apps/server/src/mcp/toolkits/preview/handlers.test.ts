import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, PreviewTabId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
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
