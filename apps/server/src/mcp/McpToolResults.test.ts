import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { ComputerUseToolkit } from "./toolkits/computerUse/tools.ts";

const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-tool-results"),
  requestNamespace: "tool-results",
  thread: {
    threadId: ThreadId.make("thread-tool-results"),
    providerSessionId: "tool-results",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"] as const),
  grantedScopes: [],
  reauthorize: () => Effect.void,
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "tool-results", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "tool-results", version: "1" },
  },
  getClient: Effect.die("unused"),
});

// A computer use approval card carries its expiry, a DateTime the tool's result schema holds (#1368).
const expiresAt = DateTime.makeUnsafe("2030-01-01T00:05:00.000Z");
const layer = McpHttpServer.toolkitRegistration(
  ComputerUseToolkit,
  McpToolAccess.toLayer(ComputerUseToolkit, {
    goat_computer_use_request: McpToolAccess.reads(() =>
      Effect.succeed({
        kind: "needs_human" as const,
        handoff: {
          handoffId: TurnItemId.make("handoff:computer-use"),
          kind: "approval" as const,
          title: "Allow notepad.exe on MINI?",
          state: "pending" as const,
          expiresAt,
          targetPath: "computer_use.grant",
        },
        next: { after: "approval" as const, call: "goat_computer_use_request" as const },
        message: "A person must approve this in a GOAT app.",
      }),
    ),
  }),
).pipe(
  Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ComputerUseLeases.ComputerUseLeases)({ proxy: undefined }),
      Layer.mock(Handoffs.Handoffs)({}),
      Layer.mock(ServerEnvironment.ServerEnvironment)({}),
    ),
  ),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("MCP tool results", (it) => {
  it.effect("a result holding a DateTime reaches the caller as JSON, not an internal error", () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "goat_computer_use_request",
          arguments: { purpose: "Set the note", apps: ["notepad.exe"], minutes: 5 },
        })
        .pipe(
          Effect.provideService(McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      assert.isFalse(result.isError ?? false);
      assert.deepInclude(result.structuredContent as object, {
        kind: "needs_human",
        handoff: {
          handoffId: "handoff:computer-use",
          kind: "approval",
          title: "Allow notepad.exe on MINI?",
          state: "pending",
          expiresAt: "2030-01-01T00:05:00.000Z",
          targetPath: "computer_use.grant",
        },
      });
    }),
  );
});
