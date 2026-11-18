import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layerTestLoopback } from "@goat/shared/testing/loopbackHttpServer";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as UserDocs from "../userDocs/UserDocs.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import { layerPermissionProfilesOff, liveThreadShell } from "./McpToolAccess.testkit.ts";

const token = "providerTokenWithoutDots";
const clientInfo = { name: "mcp-test", version: "1.0.0" };
const scope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("environment-mcp-test"),
  requestNamespace: "provider-session",
  thread: {
    threadId: ThreadId.make("thread-provider"),
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

// /mcp as the server mounts it, serving goat_call and the real docs.read it dispatches to.
const layerServer = McpHttpServer.layerMcpTransport(
  Layer.mergeAll(
    McpHttpServer.catalogRegistrations.docs,
    McpHttpServer.catalogRegistrations.agentSurface,
  ).pipe(
    Layer.provide(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(1)),
      }),
    ),
    Layer.provide(Layer.mock(HostThreadsMcpService.HostThreadsMcpService)({})),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
      }),
    ),
    Layer.provide(layerPermissionProfilesOff),
    Layer.provide(UserDocs.layer),
    Layer.provide(NodeServices.layer),
  ),
).pipe(
  Layer.provide(
    Layer.mock(McpSessionRegistry.McpSessionRegistry)({
      explainRefusal: () => Effect.succeed({ reason: "unknown" as const }),
      isRegistryToken: () => false,
      resolve: (presented) => Effect.succeed(presented === token ? scope : undefined),
    }),
  ),
);

type ToolCallAnswer = {
  readonly error?: unknown;
  readonly result?: {
    readonly isError?: boolean;
    readonly structuredContent?: { readonly status?: string; readonly error?: unknown };
  };
};

/** The JSON-RPC answer, whether the server replied with JSON or a one-message event stream. */
const answerOf = (text: string): ToolCallAnswer => {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as ToolCallAnswer;
  const data = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.startsWith("{"));
  return JSON.parse(data.at(-1) ?? "{}") as ToolCallAnswer;
};

const goatCall = { name: "goat_call", arguments: { path: "docs.read" } };
const accept = "application/json, text/event-stream";

/** goat_call as Claude Code sends it: sessionless 2026-07-28, identity in each request's _meta. */
const callStateless = Effect.fnUntraced(function* (client: HttpClient.HttpClient) {
  const response = yield* client.post("/mcp", {
    headers: {
      accept,
      "mcp-method": "tools/call",
      "mcp-name": "goat_call",
      "mcp-protocol-version": "2026-07-28",
    },
    body: HttpBody.text(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          ...goatCall,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": clientInfo,
          },
        },
      }),
      "application/json",
    ),
  });
  expect(response.status).toBe(200);
  return answerOf(yield* response.text);
});

/** goat_call as Codex sends it: initialize a 2025-06-18 session, then call within it. */
const callInSession = Effect.fnUntraced(function* (client: HttpClient.HttpClient) {
  const initialized = yield* client.post("/mcp", {
    headers: { accept },
    body: HttpBody.text(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo },
      }),
      "application/json",
    ),
  });
  expect(initialized.status).toBe(200);
  const session = initialized.headers["mcp-session-id"];
  expect(session).toBeDefined();
  const headers = {
    accept,
    "mcp-protocol-version": "2025-06-18",
    "mcp-session-id": session ?? "",
  };
  yield* client.post("/mcp", {
    headers,
    body: HttpBody.text(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "application/json",
    ),
  });
  const response = yield* client.post("/mcp", {
    headers,
    body: HttpBody.text(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: goatCall }),
      "application/json",
    ),
  });
  expect(response.status).toBe(200);
  return answerOf(yield* response.text);
});

it.effect.each([
  ["2026-07-28", callStateless],
  ["2025-06-18", callInSession],
] as const)("goat_call dispatches over /mcp with protocol %s", ([, call]) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(layerServer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      );
      const answer = yield* call(client);
      expect(answer.error).toBeUndefined();
      // Before the fix a 2026-07-28 caller got { status: "error", error: { code: "internal",
      // reason: "tool_error" } }: the dispatched call died on a missing McpServerClient.
      expect(answer.result?.structuredContent?.error).toBeUndefined();
      expect(answer.result?.structuredContent?.status).toBe("ok");
      expect(answer.result?.isError).not.toBe(true);
    }),
  ).pipe(Effect.provide(layerTestLoopback)),
);
