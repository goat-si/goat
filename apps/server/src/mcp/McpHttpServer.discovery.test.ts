import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import { layerTestLoopback } from "@goat/shared/testing/loopbackHttpServer";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
it.effect("answers 2026-07-28 discovery and keeps 2025-06-18 as the initialize fallback", () =>
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
      const unauthenticated = yield* (yield* HttpClient.HttpClient).post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-method": "server/discover",
          "mcp-protocol-version": "2026-07-28",
        },
        body: HttpBody.text(
          '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}',
          "application/json",
        ),
      });
      expect(unauthenticated.status).toBe(401);
      const httpClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      );

      const discoverResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-method": "server/discover",
          "mcp-protocol-version": "2026-07-28",
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"mcp-test","version":"1.0.0"}}}}`,
          "application/json",
        ),
      });
      expect(discoverResponse.status).toBe(200);
      const discovered = (yield* discoverResponse.json) as {
        result: { supportedVersions: ReadonlyArray<string> };
      };
      expect(discovered.result.supportedVersions).toEqual(
        expect.arrayContaining(["2026-07-28", "2025-06-18"]),
      );

      const toolsResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-method": "tools/list",
          "mcp-protocol-version": "2026-07-28",
        },
        body: HttpBody.text(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/list",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": { name: "mcp-test", version: "1.0.0" },
              },
            },
          }),
          "application/json",
        ),
      });
      expect(toolsResponse.status).toBe(200);
      const tools = (yield* toolsResponse.json) as {
        error?: unknown;
        result: { tools: ReadonlyArray<{ name: string }> };
      };
      expect(tools.error).toBeUndefined();
      expect(tools.result.tools).toEqual([]);

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2099-01-01","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(initializeResponse.status).toBe(200);
      const initialized = (yield* initializeResponse.json) as {
        result: { protocolVersion: string };
      };
      expect(initialized.result.protocolVersion).toBe("2025-06-18");
    }),
  ).pipe(Effect.provide(layerTestLoopback)),
);
