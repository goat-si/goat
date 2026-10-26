import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
} from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as ThreadResultService from "../threadResults/ThreadResultService.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const invocation = {
  environmentId,
  requestNamespace: "provider-session-mcp-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-mcp-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const layerTest = McpHttpServer.layerPreviewToolkit.pipe(
  Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "goat-mcp-http-server-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const layerPullRequestsTest = McpHttpServer.layerPullRequestsToolkit.pipe(
  Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      NodeServices.layer,
    ),
  ),
);

const snapshotResult = {
  url: "http://example.test/",
  title: "Example",
  loading: false,
  visibleText: "Example",
  interactiveElements: [],
  accessibilityTree: {},
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: {
    mimeType: "image/png",
    data: Buffer.from("png").toString("base64"),
    width: 10,
    height: 5,
  },
};

const serveSnapshots = (clientId: string, result: unknown) =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const connected = yield* Deferred.make<void>();
    const inputs: Array<unknown> = [];
    const events = yield* broker.connect({ clientId, environmentId });
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "connected") return Deferred.succeed(connected, undefined);
      inputs.push(event.request.input);
      return broker.respond({
        clientId,
        connectionId: event.connectionId,
        requestId: event.request.requestId,
        ok: true,
        result,
      });
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
    return inputs;
  });

const callTool = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const callSnapshot = (args: Record<string, unknown>) => callTool("goat_preview_snapshot", args);

const layerRecordingTools = (calls: Array<unknown>) => {
  const RecordingToolkit = Toolkit.make(
    OrchestratorToolkit.tools.delegate_task,
    OrchestratorToolkit.tools.goat_thread_read,
    OrchestratorToolkit.tools.goat_thread_wait,
    ProjectToolkit.tools.goat_project_update,
  );
  const record = McpToolAccess.reads((params: unknown) =>
    Effect.sync(() => calls.push(params)).pipe(
      Effect.andThen(
        Effect.fail(new OrchestratorMcpFailure({ code: "thread_not_found", message: "Recorded." })),
      ),
    ),
  );
  return McpHttpServer.toolkitRegistration(
    RecordingToolkit,
    McpToolAccess.toLayer(RecordingToolkit, {
      delegate_task: record,
      goat_thread_read: record,
      goat_thread_wait: record,
      goat_project_update: record,
    }),
  ).pipe(
    Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mergeAll(
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(HostThreadsMcpService.HostThreadsMcpService)({}),
        Layer.mock(ThreadResultService.ThreadResultService)({}),
        NodeServices.layer,
      ),
    ),
  );
};

it.effect.each([{}, { includeImage: false }])(
  "returns bounded structural preview snapshot failures %#",
  (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        const events = yield* broker.connect({
          clientId: "mcp-failure-client",
          environmentId,
        });
        yield* Stream.runForEach(events, (event) =>
          event.type === "connected"
            ? Effect.void
            : broker.respond({
                clientId: "mcp-failure-client",
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: false,
                error: {
                  _tag: "PreviewAutomationExecutionError",
                  message: "sensitive renderer failure",
                  detail: { consoleOutput: "sensitive browser output" },
                },
              }),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const snapshot = yield* server
          .callTool({ name: "goat_preview_snapshot", arguments: input })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

        const message = "Preview automation snapshot failed on client mcp-failure-client.";
        expect(snapshot.isError).toBe(true);
        expect(snapshot.content).toEqual([
          { type: "text", text: `Preview snapshot failed: ${message}` },
        ]);
        expect(snapshot.structuredContent).toEqual({
          error: {
            _tag: "PreviewAutomationExecutionError",
            operation: "snapshot",
            failureCount: 1,
            message,
          },
        });
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { mode: "default", input: {}, images: false },
  { mode: "explicit image", input: { includeImage: true }, images: true },
  { mode: "text only", input: { includeImage: false }, images: false },
])("returns fresh $mode snapshots on repeated MCP calls", ({ input, images }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
      const page = {
        url: "http://example.test/",
        loading: false,
        visibleText: "Save your changes",
        interactiveElements: [
          {
            tag: "button",
            role: "button",
            name: "Save",
            selector: "#save",
            x: 0,
            y: 0,
            width: 20,
            height: 10,
          },
        ],
        accessibilityTree: { role: "document", name: "Example" },
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
      };
      const screenshot = { mimeType: "image/png", width: 1, height: 1 };
      let requests = 0;
      const events = yield* broker.connect({ clientId: "mcp-image-option-client", environmentId });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        requests += 1;
        expect(event.request).toMatchObject({
          operation: "snapshot",
          tabId: alternateTabId,
          threadId,
        });
        // Only a shown or saved image needs the browser to capture one.
        // The seventh call is a default one after six in this mode.
        expect(event.request.input).toEqual({ captureImage: requests <= 6 && images });
        return broker.respond({
          clientId: "mcp-image-option-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: {
            ...page,
            title: `Snapshot ${requests}`,
            screenshot: { ...screenshot, data: png },
          },
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      for (const call of [1, 2, 3, 4, 5, 6]) {
        const snapshot = yield* server
          .callTool({
            name: "goat_preview_snapshot",
            arguments: { ...input, tabId: alternateTabId },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        const metadata = { ...page, title: `Snapshot ${call}`, screenshot };
        const { accessibilityTree: _tree, ...boundedMetadata } = metadata;
        const omitted =
          "accessibilityTree (use interactiveElements locators or goat_preview_evaluate)";
        expect(snapshot.isError).toBe(false);
        expect(snapshot.structuredContent).toEqual(
          images ? undefined : { ...boundedMetadata, omitted: [omitted] },
        );
        const [identity, text, ...rest] = snapshot.content;
        expect(identity?.type === "text" ? decodeJsonText(identity.text) : null).toEqual({
          url: page.url,
        });
        expect(text?.type === "text" ? decodeJsonText(text.text) : null).toEqual(boundedMetadata);
        expect(rest).toEqual([
          {
            type: "text",
            text: `Snapshot text was bounded. Omitted: ${omitted}.`,
          },
          ...(images
            ? [
                {
                  type: "image",
                  mimeType: "image/png",
                  data: new Uint8Array(Buffer.from(png, "base64")),
                },
              ]
            : []),
        ]);
      }

      const nextDefault = yield* server
        .callTool({
          name: "goat_preview_snapshot",
          arguments: { tabId: alternateTabId },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(nextDefault.content.map((content) => content.type)).toEqual(["text", "text", "text"]);
      expect(nextDefault.structuredContent).toMatchObject({ title: "Snapshot 7", screenshot });
      expect(nextDefault.structuredContent).not.toHaveProperty("accessibilityTree");
      expect(requests).toBe(7);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("refuses preview tools to a client outside a thread before they run", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const readOnly = {
      ...invocation,
      thread: undefined,
      requestNamespace: "client:session-1",
      client: { sessionId: "session-1", label: "Claude Code", access: "read-only" as const },
    };
    const click = yield* server
      .callTool({ name: "goat_preview_click", arguments: { locator: "text=Send" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, readOnly),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(click.isError).toBe(true);
    expect(click.content).toEqual([
      { type: "text", text: expect.stringContaining("needs an agent running inside GOAT") },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("saves full-page captures without replaying images and keeps clipping metadata", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fullPage = {
        ...snapshotResult,
        screenshot: { ...snapshotResult.screenshot, fullPage: true, clipped: true, byteLength: 3 },
      };
      const inputs = yield* serveSnapshots("mcp-fullpage-client", fullPage);
      const saved = yield* callSnapshot({ fullPage: true, save: true });
      expect(saved.isError).toBe(false);
      expect(inputs).toEqual([{ fullPage: true, captureImage: true }]);
      expect(saved.content.map((content) => content.type)).toEqual(["text"]);
      expect(saved.structuredContent).toEqual({
        url: snapshotResult.url,
        screenshotPath: expect.any(String),
        screenshot: {
          mimeType: "image/png",
          width: 10,
          height: 5,
          fullPage: true,
          clipped: true,
          byteLength: 3,
        },
      });
      const metadata = saved.structuredContent as { readonly screenshotPath: string };
      expect(Buffer.from(yield* fileSystem.readFile(metadata.screenshotPath)).toString()).toBe(
        "png",
      );
      const image = yield* callSnapshot({ fullPage: true, includeImage: true });
      expect(image.content.map((content) => content.type)).toContain("image");
      expect(image.structuredContent).toBeUndefined();
      expect(JSON.stringify(image.content)).toContain('\\"clipped\\":true,\\"byteLength\\":3');
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("rejects non-boolean fullPage before selecting a browser host", () =>
  Effect.gen(function* () {
    // A null option decodes like an omitted one (see the null snapshot options test).
    for (const fullPage of ["true", 1]) {
      const result = yield* callSnapshot({ fullPage });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { _tag: "AiError" } });
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("decodes null optional arguments the way it decodes omitted ones", () => {
  const calls: Array<unknown> = [];
  return Effect.gen(function* () {
    const thread = { threadId: "thread-null-arguments" };
    yield* callTool("goat_thread_read", thread);
    yield* callTool("goat_thread_read", { ...thread, afterPosition: null, view: null });
    yield* callTool("goat_task_create", { task: "Inspect", target: {} });
    yield* callTool("goat_task_create", { task: "Inspect", title: null, target: { model: null } });
    // A null the schema declares keeps its meaning: here it clears the project icon.
    yield* callTool("goat_project_update", { projectId: "project-1", projectIcon: null });

    expect(calls).toHaveLength(5);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[3]).toEqual(calls[2]);
    expect(calls[4]).toStrictEqual({ projectId: "project-1", projectIcon: null });
  }).pipe(Effect.provide(layerRecordingTools(calls)));
});

it.effect(
  "clamps goat_thread_read page sizes above their maximum instead of rejecting the call",
  () => {
    const calls: Array<unknown> = [];
    return Effect.gen(function* () {
      const thread = { threadId: "thread-clamped-arguments" };
      // Codex never shows the model these bounds, so an over-large page must still read.
      yield* callTool("goat_thread_read", {
        ...thread,
        limit: 150,
        runLimit: 80,
        maxCharsPerItem: 60_000,
      });
      yield* callTool("goat_thread_read", {
        ...thread,
        limit: 100,
        runLimit: 50,
        maxCharsPerItem: 50_000,
      });
      yield* callTool("goat_thread_read", { ...thread, limit: 7, runLimit: 1, maxCharsPerItem: 1 });

      expect(calls).toEqual([
        { ...thread, limit: 100, runLimit: 50, maxCharsPerItem: 50_000 },
        { ...thread, limit: 100, runLimit: 50, maxCharsPerItem: 50_000 },
        { ...thread, limit: 7, runLimit: 1, maxCharsPerItem: 1 },
      ]);
    }).pipe(Effect.provide(layerRecordingTools(calls)));
  },
);

it.effect.each(["limit", "runLimit", "maxCharsPerItem"])(
  "still rejects a goat_thread_read %s below its minimum",
  (field) => {
    const calls: Array<unknown> = [];
    return Effect.gen(function* () {
      // Zero is a different request than one item, so it fails rather than answering another question.
      const rejected = yield* callTool("goat_thread_read", {
        threadId: "thread-below-minimum",
        [field]: 0,
      }).pipe(Effect.flip);

      expect(String(rejected)).toContain("greater than or equal to 1");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layerRecordingTools(calls)));
  },
);

it("keeps GOAT task isolation and completion guidance in the delegate_task description", () => {
  const description = OrchestratorToolkit.tools.delegate_task.description ?? "";
  expect(description).toContain("Delegate a child task");
  expect(description).toContain("GOAT-managed checkout");
  expect(description).toContain("Completion wakes this thread");
  expect(description).not.toContain("goat_thread_send");
  expect(description).not.toContain("Prefer native");
});

it.effect(
  "registers the pull request toolkit and surfaces a missing capability as a tool error",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "goat_pull_request_link",
          "goat_pull_request_unlink",
          "goat_pull_request_list",
        ]),
      );
      const linkTool = server.tools.find(({ tool }) => tool.name === "goat_pull_request_link");
      expect(linkTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(linkTool?.tool.annotations?.openWorldHint).toBe(false);
      expect(linkTool?.tool.description).toContain("Register every pull request you open");
      expect(linkTool?.tool.description).toContain("link every layer");

      const denied = yield* server
        .callTool({ name: "goat_pull_request_list", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([
        { type: "text", text: "MCP credential does not grant the pull-requests capability." },
      ]);
    }).pipe(Effect.provide(layerPullRequestsTest)),
);

it.effect("bounds large ARIA trees without dropping every server locator", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const accessibilityTree = Array.from(
        { length: 2_000 },
        (_, index) => `- button "删除 ${index}" [ref=t3-snapshot-e${index}]`,
      ).join("\n");
      yield* serveSnapshots("mcp-large-server-refs", { ...snapshotResult, accessibilityTree });
      const result = yield* callSnapshot({ includeImage: false });
      expect(result.isError).toBe(false);
      const metadata = result.structuredContent as { accessibilityTree: string };
      expect(metadata.accessibilityTree).toContain("[ref=t3-snapshot-e0]");
      expect(metadata.accessibilityTree.length).toBeLessThan(accessibilityTree.length);
      const body = result.content[1];
      expect(Buffer.byteLength(body?.type === "text" ? body.text : "", "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("keeps the snapshot text under the agent's output ceiling", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pageText = "/Users/theo/Code/project\nClaude, Codex · 79 threads\n".repeat(600);
      const element = (name: string, index: number) => ({
        tag: "div",
        role: "presentation",
        name,
        selector: `div:nth-of-type(${index})`,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      });
      const oversized = {
        ...snapshotResult,
        visibleText: pageText,
        interactiveElements: [
          element(pageText, 1),
          element(pageText, 2),
          element(pageText, 3),
          element("Continue", 4),
        ],
        accessibilityTree: { nodes: Array.from({ length: 2_000 }, (_, i) => ({ nodeId: `${i}` })) },
        consoleEntries: Array.from({ length: 100 }, (_, i) => ({
          level: "log",
          text: `entry ${i}`,
          timestamp: "t",
        })),
      };
      yield* serveSnapshots("mcp-bounded-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      expect(snapshot.isError).toBe(false);
      const [identity, text, notice] = snapshot.content;
      expect(identity?.type === "text" ? decodeJsonText(identity.text) : null).toEqual({
        url: oversized.url,
      });
      expect(text?.type).toBe("text");
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly accessibilityTree?: unknown;
        readonly visibleText: string;
        readonly interactiveElements: ReadonlyArray<{ readonly name: string }>;
        readonly consoleEntries: ReadonlyArray<{ readonly text: string }>;
      };
      expect(parsed.accessibilityTree).toBeUndefined();
      expect(parsed.visibleText.length).toBeLessThanOrEqual(8_001);
      expect(parsed.interactiveElements).toHaveLength(4);
      expect(parsed.interactiveElements[0]?.name.length).toBeLessThanOrEqual(201);
      expect(parsed.interactiveElements[3]?.name).toBe("Continue");
      expect(parsed.consoleEntries).toHaveLength(40);
      expect(parsed.consoleEntries[0]?.text).toBe("entry 60");
      expect(notice?.type === "text" ? notice.text : "").toContain("accessibilityTree");
      expect(notice?.type === "text" ? notice.text : "").toContain("60 older console entries");
      expect(snapshot.structuredContent).toEqual({
        ...parsed,
        omitted: expect.arrayContaining(["60 older console entries"]),
      });
    }),
  ).pipe(Effect.provide(layerTest)),
);

// regression: #10501 keep preview snapshots usable by the agent
it.effect("bounds the snapshot text even when nothing but logs and the title are large", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const oversized = {
        ...snapshotResult,
        title: "t".repeat(70_000),
        interactiveElements: [],
        consoleEntries: [{ level: "log", text: "x".repeat(70_000), timestamp: "t" }],
      };
      yield* serveSnapshots("mcp-bounded-logs-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      const [, text] = snapshot.content;
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly title: string;
        readonly consoleEntries: ReadonlyArray<{ readonly text: string }>;
      };
      expect(parsed.title.length).toBe(2_049);
      expect(parsed.consoleEntries[0]?.text.length).toBe(501);
      const notice = snapshot.content[2];
      const noticeText = notice?.type === "text" ? notice.text : "";
      expect(noticeText).toContain("url or title after 2048 characters");
      expect(noticeText).toContain("console entries text after 500 characters");
    }),
  ).pipe(Effect.provide(layerTest)),
);

// regression: #13558 preview snapshots overflowed the agent's tool output
it.effect("bounds page text made of wide characters before dropping locators", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveSnapshots("mcp-wide-text-client", {
        ...snapshotResult,
        visibleText: "界".repeat(9_000),
        interactiveElements: Array.from({ length: 20 }, (_, i) => ({
          tag: "button",
          role: "button",
          name: `Button ${i}`,
          selector: `#button-${i}`,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        })),
      });

      const snapshot = yield* callSnapshot({ includeImage: false });

      const [, text, notice] = snapshot.content;
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly visibleText: string;
        readonly interactiveElements: ReadonlyArray<unknown>;
      };
      expect(parsed.visibleText).toMatch(/^界+…$/);
      expect(parsed.interactiveElements).toHaveLength(20);
      expect(notice?.type === "text" ? notice.text : "").toContain(
        "visibleText after 4000 characters",
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const token = "providerTokenWithoutDots";
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId: ThreadId.make("thread-provider"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const layerServer = McpHttpServer.layerMcpTransport.pipe(
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            explainRefusal: () => Effect.succeed({ reason: "unknown" as const }),
            isRegistryToken: () => false,
            resolve: (presented) =>
              Effect.succeed(
                presented === token
                  ? (scope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(layerServer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      );

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      const initializeText = yield* initializeResponse.text;
      const initializeData = initializeText.split(/\r?\n/).find((line) => line.startsWith("data:"));
      expect(
        decodeJsonText(initializeData === undefined ? initializeText : initializeData.slice(5)),
      ).toMatchObject({ result: { serverInfo: { name: "GOAT" } } });
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tabId = "preview-tab";
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const logsResult = {
        console: {
          entries: [{ level: "warning", text: "fixture", timestamp: "2026-10-15T00:00:00.000Z" }],
          droppedCount: 2,
          omittedCount: 1,
        },
        errors: { entries: [], droppedCount: 0, omittedCount: 0 },
        network: { entries: [], droppedCount: 0, omittedCount: 0 },
      };
      const toolIcon = {
        _tag: "website" as const,
        pageUrl: "http://example.test/",
      };
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
        supportedOperations: PREVIEW_AUTOMATION_SERVER_OPERATIONS,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? snapshotResult
              : event.request.operation === "logs"
                ? logsResult
                : event.request.operation === "evaluate"
                  ? ["Connect", "Continue"]
                  : event.request.operation === "press"
                    ? undefined
                    : {
                        available: true,
                        visible: true,
                        tabId,
                        url: "http://example.test/",
                        title: "Example",
                        loading: false,
                      },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "goat_preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "goat_preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(false);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "goat_preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);
      expect(clickTool?.tool.outputSchema).toMatchObject({
        type: "object",
        additionalProperties: true,
      });

      const navigateTool = server.tools.find(({ tool }) => tool.name === "goat_preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "goat_preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const logsTool = server.tools.find(({ tool }) => tool.name === "goat_preview_logs");
      expect(logsTool?.tool.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
      });
      const beforeLogs = routedRequests.length;
      const logs = yield* server
        .callTool({
          name: "goat_preview_logs",
          arguments: { tabId: alternateTabId, consoleLevels: ["warning"] },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(logs.isError).toBe(false);
      expect(logs.structuredContent).toEqual(logsResult);
      expect(logs.content.every((content) => content.type === "text")).toBe(true);
      expect(routedRequests.slice(beforeLogs)).toMatchObject([
        { operation: "logs", tabId: alternateTabId },
      ]);
      expect(routedRequests.length).toBe(beforeLogs + 1);

      const malformed = yield* server
        .callTool({ name: "goat_preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const snapshot = yield* server
        .callTool({
          name: "goat_preview_snapshot",
          arguments: { tabId: alternateTabId, includeImage: true },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toBeUndefined();
      expect(JSON.stringify(snapshot.content)).toContain('\\"width\\":10,\\"height\\":5');
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      // Arrays and primitives are wrapped so structuredContent stays a JSON object.
      // Claude Code rejects the whole result otherwise.
      const evaluateTool = server.tools.find(({ tool }) => tool.name === "goat_preview_evaluate");
      expect(evaluateTool?.tool.outputSchema).toMatchObject({ type: "object" });
      const evaluated = yield* server
        .callTool({ name: "goat_preview_evaluate", arguments: { expression: "buttons()" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(evaluated.isError).toBe(false);
      expect(evaluated.structuredContent).toEqual({ value: ["Connect", "Continue"], toolIcon });
      const evaluatedText = evaluated.content[0];
      expect(evaluatedText?.type === "text" ? decodeJsonText(evaluatedText.text) : null).toEqual({
        toolIcon,
        value: ["Connect", "Continue"],
      });

      const actionRequests = [
        { name: "goat_preview_click", arguments: { x: 10, y: 10 } },
        { name: "goat_preview_type", arguments: { text: "Hello" } },
        { name: "goat_preview_press", arguments: { key: "Enter" } },
        { name: "goat_preview_scroll", arguments: { deltaY: 100 } },
        { name: "goat_preview_wait", arguments: { text: "Example" } },
      ];
      for (const request of actionRequests) {
        const result = yield* server
          .callTool(request)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({ toolIcon });
        expect(routedRequests.at(-1)?.operation).toBe("status");
        const text = result.content[0];
        expect(text?.type === "text" ? decodeJsonText(text.text) : null).toEqual({ toolIcon });
      }
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("admits provider and OAuth client credentials and points only clients at OAuth", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const providerToken = "providerTokenWithoutDots";
      const clientToken = "client-payload.client-signature";
      const providerScope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId: ThreadId.make("thread-provider"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const clientScope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "client:session-1",
        thread: undefined,
        client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const seen: Array<McpInvocationContext.McpInvocationScope> = [];
      const ProbeToolkit = Toolkit.make(
        Tool.make("probe", {
          description: "Reports the caller.",
          success: Schema.Struct({ ok: Schema.Boolean }),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
          dependencies: [McpInvocationContext.McpInvocationContext],
        }),
      );
      const serverLayer = McpHttpServer.toolkitRegistration(
        ProbeToolkit,
        McpToolAccess.toLayer(ProbeToolkit, {
          probe: McpToolAccess.reads(() =>
            McpInvocationContext.McpInvocationContext.pipe(
              Effect.tap((scope) => Effect.sync(() => seen.push(scope))),
              Effect.as({ ok: true }),
            ),
          ),
        }),
      ).pipe(
        Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            explainRefusal: () => Effect.succeed({ reason: "unknown" as const }),
            isRegistryToken: () => false,
            resolve: (token) =>
              Effect.succeed(
                token === providerToken
                  ? (providerScope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
        Layer.provide(
          Layer.succeed(McpHttpServer.McpClientAuthenticator, {
            authenticate: (request) =>
              Effect.succeed(
                request.headers.authorization === `Bearer ${clientToken}` ? clientScope : undefined,
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const call = (token: string | undefined) =>
        Effect.gen(function* () {
          const headers = {
            accept: "application/json, text/event-stream",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          if (initialize.status !== 200) return initialize;
          return yield* httpClient.post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"probe","arguments":{}}}`,
              "application/json",
            ),
          });
        });

      expect((yield* call(providerToken)).status).toBe(200);
      expect((yield* call(clientToken)).status).toBe(200);
      expect(seen.map((scope) => scope.requestNamespace)).toEqual([
        "provider-session",
        "client:session-1",
      ]);

      const missing = yield* call(undefined);
      expect(missing.status).toBe(401);
      expect(missing.headers["www-authenticate"]).toMatch(
        /^Bearer resource_metadata="http:\/\/[^"]+\/\.well-known\/oauth-protected-resource\/mcp"$/,
      );

      const expiredClient = yield* call("stale-payload.stale-signature");
      expect(expiredClient.headers["www-authenticate"]).toContain("resource_metadata=");
      expect(expiredClient.headers["www-authenticate"]).toContain('error="invalid_token"');

      const deadProvider = yield* call("deadProviderToken");
      expect(deadProvider.status).toBe(401);
      expect(deadProvider.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "explains a refused thread credential to the agent and keeps 401 for everything else",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let timestamp = 1_000;
        const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(environmentId),
          getDescriptor: Effect.die("unused"),
        });
        const makeRegistry = McpSessionRegistry.__testing
          .make({ now: () => timestamp, livenessWindowMs: 100 })
          .pipe(
            Effect.provideService(
              HttpServer.HttpServer,
              HttpServer.HttpServer.of({
                address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
                serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
              }),
            ),
            Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
            Effect.provide(NodeServices.layer),
          );
        const registry = yield* makeRegistry;
        const earlierRun = yield* makeRegistry;
        const tokenOf = (issued: McpSessionRegistry.McpIssuedCredential) =>
          issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
        const issue = (from: McpSessionRegistry.McpSessionRegistryShape, thread: string) =>
          from
            .issue({
              threadId: ThreadId.make(thread),
              providerInstanceId: ProviderInstanceId.make("codex"),
            })
            .pipe(Effect.map(tokenOf));

        yield* HttpRouter.serve(
          McpHttpServer.layerMcpTransport.pipe(
            Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
          ),
          { disableListenLog: true, disableLogger: true },
        ).pipe(Layer.build);
        const httpClient = yield* HttpClient.HttpClient;
        const post = (token: string, body: string) =>
          httpClient.post("/mcp", {
            headers: {
              accept: "application/json, text/event-stream",
              authorization: "Bearer " + token,
            },
            body: HttpBody.text(body, "application/json"),
          });
        const toolCall =
          '{"jsonrpc":"2.0","id":"call-7","method":"tools/call","params":{"name":"link_pull_request","arguments":{}}}';
        const initialize =
          '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}';
        const refusedText = (token: string) =>
          Effect.gen(function* () {
            const response = yield* post(token, toolCall);
            expect(response.status).toBe(200);
            const body = (yield* response.json) as {
              readonly id: unknown;
              readonly result: {
                readonly isError: boolean;
                readonly content: ReadonlyArray<{ readonly text: string }>;
              };
            };
            expect(body.id).toBe("call-7");
            expect(body.result.isError).toBe(true);
            return body.result.content[0]!.text;
          });

        const released = yield* issue(registry, "thread-released");
        yield* registry.revokeThread(ThreadId.make("thread-released"));
        expect(yield* refusedText(released)).toBe(
          McpHttpServer.credentialRefusalMessage("revoked"),
        );
        const releasedInitialize = yield* post(released, initialize);
        expect(releasedInitialize.status).toBe(401);
        expect(((yield* releasedInitialize.json) as { message: string }).message).toContain(
          "next turn",
        );

        const fromEarlierRun = yield* issue(earlierRun, "thread-before-restart");
        expect(yield* refusedText(fromEarlierRun)).toContain("restarted or updated");
        // A chunked body declares no length and still gets the explanation.
        const chunked = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: "Bearer " + fromEarlierRun,
          },
          body: HttpBody.stream(
            Stream.make(
              new TextEncoder().encode(toolCall.slice(0, 20)),
              new TextEncoder().encode(toolCall.slice(20)),
            ),
            "application/json",
          ),
        });
        expect(chunked.status).toBe(200);
        expect(JSON.stringify(yield* chunked.json)).toContain("restarted or updated");
        const streamed = (body: Stream.Stream<Uint8Array>) =>
          httpClient.post("/mcp", {
            headers: {
              accept: "application/json, text/event-stream",
              authorization: "Bearer " + fromEarlierRun,
            },
            body: HttpBody.stream(body, "application/json"),
          });
        // Over the bound, or never finished, the body is not read as a tool call. The
        // server answers before the oversized upload ends, so the client may see the close.
        const oversized = yield* streamed(
          Stream.make(new TextEncoder().encode(toolCall), new Uint8Array(1024 * 1024)),
        ).pipe(
          Effect.map((response) => response.status),
          Effect.catchTags({ HttpClientError: () => Effect.succeed("closed before upload ended") }),
        );
        expect([401, "closed before upload ended"]).toContain(oversized);

        const idle = yield* issue(registry, "thread-idle");
        timestamp += 101;
        expect(yield* registry.resolve(idle)).toBeUndefined();
        expect(yield* refusedText(idle)).toBe(McpHttpServer.credentialRefusalMessage("expired"));

        // Session tokens and garbage are never answered as tool results.
        const sessionToken = yield* post("payload.signature", toolCall);
        expect(sessionToken.status).toBe(401);
        expect(((yield* sessionToken.json) as { message: string }).message).toBe(
          "A valid GOAT MCP credential is required.",
        );
        expect((yield* post("not-a-goat-token", toolCall)).status).toBe(401);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a refused body that never finishes stops being read at its deadline", () =>
  Effect.gen(function* () {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) =>
        controller.enqueue(
          new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"tools/call"'),
        ),
    });
    const request = HttpServerRequest.fromWeb(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        body,
        duplex: "half",
        headers: { "content-type": "application/json" },
      } as RequestInit),
    );
    const read = yield* McpHttpServer.__testing
      .refusedToolCallId(request)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(read)).toBeUndefined();
  }),
);

it.effect("serves llms.txt whole without a credential and filtered with one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = {
        environmentId,
        requestNamespace: "llms",
        capabilities: new Set<McpInvocationContext.McpCapability>(),
        issuedAt: 1,
      };
      const threadScope: McpInvocationContext.McpThreadInvocationScope = {
        ...base,
        thread: {
          threadId,
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
      };
      const clientScope = (
        access: McpInvocationContext.McpClientCaller["access"],
      ): McpInvocationContext.McpInvocationScope => ({
        ...base,
        thread: undefined,
        client: { sessionId: access, label: access, access },
      });
      const clients: Record<string, McpInvocationContext.McpInvocationScope> = {
        "Bearer client.full": clientScope("auto"),
        "Bearer client.readonly": clientScope("read-only"),
      };
      yield* HttpRouter.serve(
        McpHttpServer.layerLlmsTxtRoute.pipe(
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              explainRefusal: () => Effect.succeed({ reason: "unknown" as const }),
              isRegistryToken: () => false,
              resolve: (token) => Effect.succeed(token === "threadToken" ? threadScope : undefined),
            }),
          ),
          Layer.provide(
            Layer.succeed(McpHttpServer.McpClientAuthenticator, {
              authenticate: (request) =>
                Effect.succeed(clients[request.headers.authorization ?? ""]),
            }),
          ),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;
      const paths = (token?: string) =>
        Effect.gen(function* () {
          const response = yield* httpClient.get("/llms.txt", {
            headers: token === undefined ? {} : { authorization: "Bearer " + token },
          });
          expect(response.status).toBe(200);
          expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
          const body = yield* response.text;
          return new Set(
            body
              .split("\n")
              .filter((line) => line.startsWith("- "))
              .map((line) => line.slice(2, line.indexOf(":"))),
          );
        });

      const all = yield* paths();
      expect(all.size).toBe(Object.keys(agentSurfaceRegistry).length);

      const thread = yield* paths("threadToken");
      expect(thread.has("device.screenshot")).toBe(true);
      expect(thread.has("permission_profile.sync")).toBe(false);

      const client = yield* paths("client.full");
      expect(client.has("permission_profile.sync")).toBe(true);
      expect(client.has("device.screenshot")).toBe(false);

      const reader = yield* paths("client.readonly");
      expect(reader.has("decision.list")).toBe(true);
      expect(reader.has("decision.request")).toBe(false);

      const refused = yield* httpClient.get("/llms.txt", {
        headers: { authorization: "Bearer stale.token" },
      });
      expect(refused.status).toBe(401);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
