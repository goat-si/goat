import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { McpSchema, McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../../config.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("mcp-html-path-thread");
const fullAccessThreadId = ThreadId.make("mcp-html-path-full-access-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("mcp-html-path-environment"),
  requestNamespace: "mcp-html-path-session",
  thread: {
    threadId,
    providerSessionId: "mcp-html-path-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-html-path", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-html-path", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const layerTest = McpHttpServer.layerHtmlToolkit.pipe(
  Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(PreviewBrowser.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-mcp-html-path-" })),
  Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed({
          id,
          deletedAt: null,
          archivedAt: null,
          activeRunId: RunId.make("mcp-html-path-run"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: id === fullAccessThreadId ? "full-access" : "approval-required",
          interactionMode: "default",
        } as OrchestrationV2ThreadShell),
    }),
  ),
);

const callTool = (
  name: string,
  args: Record<string, unknown>,
  caller: McpInvocationContext.McpInvocationScope,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    // html_preview reports failures as plain text, html_render as a declared failure.
    return result.isError ? JSON.stringify(result.content) : undefined;
  });

it.effect("reads an HTML file only for a full-access thread", () =>
  Effect.gen(function* () {
    const fullAccess = { ...scope, thread: { ...scope.thread!, threadId: fullAccessThreadId } };
    const missing = "/goat-missing-dir/revenue.html";
    for (const name of ["goat_html_preview", "goat_html_render"]) {
      const args =
        name === "goat_html_render"
          ? { path: missing, title: "Revenue", height: 240 }
          : { path: missing };
      expect(yield* callTool(name, args, scope), name).toContain("only full-access threads");
      expect(yield* callTool(name, args, fullAccess), name).toContain(
        "not a readable HTML document",
      );
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("takes exactly one of html and path", () =>
  Effect.gen(function* () {
    const both = yield* callTool(
      "goat_html_render",
      { html: "<p>x</p>", path: "/tmp/x.html", title: "X", height: 200 },
      scope,
    );
    expect(both).toContain("Pass exactly one of html or path.");
    const neither = yield* callTool("goat_html_preview", {}, scope);
    expect(neither).toContain("Pass exactly one of html or path.");
  }).pipe(Effect.provide(layerTest)),
);
