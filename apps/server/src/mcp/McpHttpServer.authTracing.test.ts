import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { layerTestLoopback } from "@goat/shared/testing/loopbackHttpServer";
const environmentId = EnvironmentId.make("environment-mcp-test");
const recordSpans = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const order: Array<string> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      order.push(`start ${span.spanId}`);
      const end = span.end.bind(span);
      span.end = (time, exit) => {
        end(time, exit);
        order.push(`end ${span.spanId}`);
      };
      return span;
    },
  });
  return { spans, order, tracer };
};
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
                request.headers.authorization?.toLowerCase().startsWith("bearer ") === true &&
                  request.headers.authorization.slice(7) === clientToken
                  ? clientScope
                  : undefined,
              ),
          }),
        ),
      );
      const traced = recordSpans();
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
        Effect.withTracer(traced.tracer),
      );
      const httpClient = yield* HttpClient.HttpClient;
      const call = (token: string | undefined, scheme = "Bearer") =>
        Effect.gen(function* () {
          const headers = {
            accept: "application/json, text/event-stream",
            ...(token === undefined ? {} : { authorization: `${scheme} ${token}` }),
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
      const toolSpan = traced.spans.find((span) => span.name === "mcp.tool.probe");
      expect(Object.fromEntries(toolSpan?.attributes ?? [])).toEqual({
        "rpc.system": "mcp",
        "rpc.method": "tools/call",
        "mcp.tool.name": "probe",
      });
      const authSpan = traced.spans.find(
        (span) =>
          span.name === "McpHttpServer.authenticateRequest" && span.traceId === toolSpan?.traceId,
      );
      expect(authSpan).toBeDefined();
      expect(traced.order.slice(0, traced.order.indexOf(`start ${toolSpan?.spanId}`))).toContain(
        `end ${authSpan?.spanId}`,
      );
      expect((yield* call(clientToken)).status).toBe(200);
      expect(seen.map((scope) => scope.requestNamespace)).toEqual([
        "provider-session",
        "client:session-1",
      ]);

      expect((yield* call(providerToken, "bEaReR")).status).toBe(200);
      expect((yield* call(clientToken, "bearer")).status).toBe(200);
      expect((yield* call(providerToken, "Basic")).status).toBe(401);

      const missing = yield* call(undefined);
      expect(missing.status).toBe(401);
      expect(missing.headers["www-authenticate"]).toMatch(
        /^Bearer resource_metadata="http:\/\/[^"]+\/\.well-known\/oauth-protected-resource\/mcp"$/,
      );

      const expiredClient = yield* call("stale-payload.stale-signature");
      expect(expiredClient.headers["www-authenticate"]).toContain("resource_metadata=");
      expect(expiredClient.headers["www-authenticate"]).toContain('error="invalid_token"');

      const beforeRejection = traced.spans.length;
      const deadProvider = yield* call("deadProviderToken");
      expect(deadProvider.status).toBe(401);
      expect(
        traced.spans.slice(beforeRejection).filter((span) => span.name.startsWith("mcp.tool.")),
      ).toEqual([]);
      expect(deadProvider.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
    }),
  ).pipe(Effect.provide(layerTestLoopback)),
);
