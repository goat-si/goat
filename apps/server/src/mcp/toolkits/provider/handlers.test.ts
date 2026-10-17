import { expect, it } from "@effect/vitest";
import { EnvironmentId, OrchestratorMcpFailure } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Routing from "../../../provider/ProviderDiagnosisRouting.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import { ProviderToolkit } from "./tools.ts";
import * as Handlers from "./handlers.ts";
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("owner"),
  requestNamespace: "test",
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  thread: undefined,
  client: { sessionId: "reader", label: "test", access: "read-only" },
};
it.effect.each([undefined, "box"])("uses one routing entry point for host=%s", (host) =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const registered = McpHttpServer.toolkitRegistration(ProviderToolkit, Handlers.layer).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(liveThreadsLayer),
      Layer.provide(
        Layer.mock(Routing.ProviderDiagnosisRouting)({
          diagnose: (input, caller) =>
            Effect.sync(() => {
              calls.push({ input, caller });
              return { checkedBy: "server", diagnoses: [], ...(host ? { host } : {}) };
            }),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server.callTool({
        name: "goat_provider_diagnose",
        arguments: { ...(host ? { host } : {}), cwd: "/repo" },
      });
      expect(result.isError).toBe(false);
      expect(calls).toEqual([
        { input: { ...(host ? { host } : {}), cwd: "/repo" }, caller: { kind: "mcp", scope } },
      ]);
      const advertised = server.tools.find(({ tool }) => tool.name === "goat_provider_diagnose");
      expect(advertised?.tool.inputSchema.properties).toHaveProperty("host");
    }).pipe(
      Effect.provideService(Invocation.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(registered),
    );
  }),
);
it.effect(
  "returns the stopped-runtime recovery as an MCP error without manufacturing diagnosis rows",
  () =>
    Effect.gen(function* () {
      const registered = McpHttpServer.toolkitRegistration(ProviderToolkit, Handlers.layer).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(liveThreadsLayer),
        Layer.provide(
          Layer.mock(Routing.ProviderDiagnosisRouting)({
            diagnose: () =>
              Effect.fail(
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message:
                    "Call goat_ssh_host_prepare for box, then call goat_ssh_host_status until setup completes; retry goat_provider_diagnose.",
                }),
              ),
          }),
        ),
      );
      const result = yield* McpServer.McpServer.pipe(
        Effect.flatMap((server) =>
          server.callTool({ name: "goat_provider_diagnose", arguments: { host: "box" } }),
        ),
        Effect.provideService(Invocation.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provide(registered),
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent ?? {}).not.toHaveProperty("diagnoses");
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("goat_ssh_host_prepare") }),
        ]),
      );
    }),
);
