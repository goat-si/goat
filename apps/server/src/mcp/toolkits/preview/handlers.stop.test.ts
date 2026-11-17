import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as SiteNotes from "../../../preview/SiteNotes.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { layerPermissionProfilesOff, liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewHandlers from "./handlers.ts";
import { PreviewStandardToolkit } from "./tools.ts";

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "preview-stop-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "preview-stop-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("preview-stop-environment"),
  requestNamespace: "preview-stop-session",
  thread: {
    threadId: ThreadId.make("preview-stop-thread"),
    providerSessionId: "preview-stop-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"]),
  issuedAt: 0,
};

/** Calls goat_preview_stop on a server whose descriptor does or does not advertise Stop. */
const callStop = (serverBrowserStopLoading: boolean | undefined) => {
  const operations: Array<{ operation: string; tabId: unknown }> = [];
  const descriptor = {
    capabilities: serverBrowserStopLoading === undefined ? {} : { serverBrowserStopLoading },
  } as unknown as ExecutionEnvironmentDescriptor;
  const dependencies = Layer.mergeAll(
    layerPermissionProfilesOff,
    liveThreadsLayer,
    ServerConfig.layerTest(process.cwd(), { prefix: "goat-preview-stop-" }).pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(scope.environmentId),
      getDescriptor: Effect.succeed(descriptor),
    }),
    Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
      invoke: <A>(
        request: Parameters<
          PreviewAutomationBroker.PreviewAutomationBroker["Service"]["invoke"]
        >[0],
      ) =>
        Effect.sync(() => {
          operations.push({ operation: request.operation, tabId: request.tabId });
          return {
            available: true,
            visible: true,
            tabId: request.tabId ?? null,
            url: "https://example.com/slow",
            title: null,
            loading: false,
          } as A;
        }),
    }),
  );
  return McpServer.McpServer.pipe(
    Effect.flatMap((server) =>
      server.callTool({ name: "goat_preview_stop", arguments: { tabId: "tab-1" } }),
    ),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.map((result) => ({ result, operations })),
    Effect.provide(
      McpHttpServer.toolkitRegistration(PreviewStandardToolkit, PreviewHandlers.layerStandard).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(dependencies),
        Layer.provide(SiteNotes.layer),
        Layer.provideMerge(Sqlite.layerMemory),
      ),
    ),
  );
};

it.effect.each([{ advertised: undefined }, { advertised: false }])(
  "goat_preview_stop refuses on a server that does not advertise Stop ($advertised) and sends nothing",
  ({ advertised }) =>
    Effect.gen(function* () {
      const { result, operations } = yield* callStop(advertised);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("cannot stop a loading page");
      expect(operations).toEqual([]);
    }),
);

it.effect("goat_preview_stop asks the tab's browser host to stop loading it", () =>
  Effect.gen(function* () {
    const { result, operations } = yield* callStop(true);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(operations).toEqual([{ operation: "stopLoading", tabId: PreviewTabId.make("tab-1") }]);
    expect(JSON.stringify(result)).toContain('"loading":false');
  }),
);
