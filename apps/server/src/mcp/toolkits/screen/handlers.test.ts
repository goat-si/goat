import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type ScreenRunResult,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ScreenRunService from "../../../screenCode/ScreenRunService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import { dependencies } from "../../agentSurface.testkit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  idleThreadProjection,
  layerPermissionProfilesOff,
  liveThreadShell,
} from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("screen-thread");
const providerInstanceId = ProviderInstanceId.make("codex");
const runId = RunId.make("screen-run");
const turnId = RunAttemptId.make("screen-attempt");
const shell = liveThreadShell(threadId, { activeRunId: runId });
const now = DateTime.makeUnsafe("2026-10-27T00:00:00.000Z");
const run: OrchestrationV2Run = {
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "test" },
  providerThreadId: null,
  userMessageId: MessageId.make("screen-message"),
  rootNodeId: null,
  activeAttemptId: turnId,
  status: "running",
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const image = {
  imageRef: "image-one",
  callId: 1,
  targetId: "tab-one",
  observationId: "observation-one",
  regionId: "viewport-one",
  region: { kind: "viewport" as const, x: 0, y: 0, width: 1, height: 1 },
  pixelWidth: 1,
  pixelHeight: 1,
  scale: 1,
  mimeType: "image/png" as const,
};
const bytes = Buffer.from("captured image").toString("base64");
const result: ScreenRunResult = {
  runId,
  turnId,
  cellId: "cell-one",
  status: "completed",
  console: [],
  journal: [],
  truncated: [],
  availability: [{ kind: "tab", available: true }],
  imageMetadata: [image],
  images: [{ ...image, bytes }],
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "screen-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "screen-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect(
  "direct MCP and goat_call forward screen images and refuse a bad title before the cell runs, while an outside read-only client is denied",
  () => {
    const calls: ScreenRunService.ScreenRunInput[] = [];
    const scope: McpInvocationContext.McpThreadInvocationScope = {
      environmentId: EnvironmentId.make("environment-one"),
      requestNamespace: "screen-test",
      thread: { threadId, providerInstanceId, providerSessionId: "screen-session" },
      client: undefined,
      capabilities: new Set(["preview"]),
      issuedAt: 0,
      screenBindingHints: {
        browserRequested: true,
        computerRequested: false,
        appIds: [],
        tabs: [
          {
            mentionId: "mention-one",
            environmentId: "environment-one",
            browserInstanceId: "browser-one",
            tabId: "tab-one",
            titleAtMention: "Docs",
            urlAtMention: "https://example.test/docs",
          },
        ],
      },
    };
    const screen = McpHttpServer.catalogRegistrations.screen.pipe(
      Layer.provide(layerPermissionProfilesOff),
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
          getThreadRecords: (() =>
            Effect.succeed({
              thread: idleThreadProjection(shell).thread,
              runs: [run],
            })) as ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"],
        }),
      ),
      Layer.provide(
        Layer.mock(ScreenRunService.ScreenRunService)({
          runCell: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return result;
            }),
        }),
      ),
    );
    const layer = Layer.mergeAll(
      McpHttpServer.catalogRegistrations.agentSurface.pipe(Layer.provide(dependencies)),
      screen,
    ).pipe(Layer.provideMerge(McpServer.McpServer.layer));
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const response = yield* server
        .callTool({
          name: "goat_screen_run",
          arguments: { code: "return await screen.list_tabs({})" },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      const forwarded = yield* server
        .callTool({
          name: "goat_call",
          arguments: {
            path: "surface.screen_run",
            args: { code: "return await screen.list_tabs({})" },
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        runId,
        turnId,
        threadId,
        environmentId: scope.environmentId,
        bindingHints: scope.screenBindingHints,
      });
      expect(response.isError).toBe(false);
      expect(response.content.filter((part) => part.type === "image")).toHaveLength(1);
      expect(forwarded.content.filter((part) => part.type === "image")).toEqual(
        response.content.filter((part) => part.type === "image"),
      );
      expect(JSON.stringify(response.structuredContent)).not.toContain(bytes);
      expect(JSON.stringify(forwarded.structuredContent)).not.toContain(bytes);
      const outside: McpInvocationContext.McpInvocationScope = {
        ...scope,
        thread: undefined,
        client: { sessionId: "outside", label: "Outside", access: "read-only" },
      };
      const denied = yield* server
        .callTool({
          name: "goat_screen_run",
          arguments: { code: "return await screen.list_tabs({})" },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, outside),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(denied.isError).toBe(true);
      expect(calls).toHaveLength(2);
      const withTitle = (name: string, title: string) =>
        server
          .callTool(
            name === "goat_call"
              ? {
                  name,
                  arguments: { path: "surface.screen_run", args: { code: "return 1", title } },
                }
              : { name, arguments: { code: "return 1", title } },
          )
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      expect((yield* withTitle("goat_screen_run", "Docs: read the page")).isError).toBe(false);
      expect(calls).toHaveLength(3);
      // goat_call reports a refusal in its own {status: "error"} envelope.
      const refused = (response: McpSchema.CallToolResult) =>
        response.isError === true ||
        JSON.stringify(response.content).includes('\\"status\\":\\"error\\"');
      for (const name of ["goat_screen_run", "goat_call"])
        for (const title of ["   ", "two\u2028lines", "x".repeat(81)])
          expect(refused(yield* withTitle(name, title))).toBe(true);
      expect(calls).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  },
);
