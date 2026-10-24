import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";

import {
  EnvironmentId,
  ExternalLauncherBrowserSpawnError,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redactable from "effect/Redactable";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestConsole from "effect/testing/TestConsole";

import { DEFAULT_SIGNAL_EXPORT } from "@goat/shared/observability";
import * as OtelEnvironment from "@goat/shared/otelEnvironment";

import * as ServerConfig from "./config.ts";
import * as McpHttpServer from "./mcp/McpHttpServer.ts";
import { McpInvocationContext, type McpInvocationScope } from "./mcp/McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./mcp/McpToolAccess.testkit.ts";
import * as McpToolAccess from "./mcp/McpToolAccess.ts";
import * as DefectReporter from "./observability/DefectReporter.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ServerLogger from "./serverLogger.ts";
import {
  announceStartupPairingUrl,
  logBrowserAutoOpenUnavailable,
  maybeOpenBrowser,
} from "./serverRuntimeStartup.ts";

interface ExportedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const layerCollector = (requests: Array<ExportedRequest>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({
          url: request.url,
          headers: request.headers,
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
      }),
    ),
  );

const layerConfig = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseDir = path.join(NodeOS.tmpdir(), "t3-server-logger-test");
      const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      return ServerConfig.make({
        logLevel: "Info",
        traceMinLevel: "Info",
        traceTimingEnabled: false,
        traceBatchWindowMs: 200,
        traceMaxBytes: 1024,
        traceMaxFiles: 1,
        otlpTracesUrl: undefined,
        otlpMetricsUrl: undefined,
        otlpLogsUrl: undefined,
        otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
        otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
        otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
        otelEnvironment: OtelEnvironment.none,
        cwd: baseDir,
        baseDir,
        ...derivedPaths,
        mode: "web",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        port: 0,
        host: undefined,
        desktopBootstrapToken: undefined,
        desktopTelemetryFd: undefined,
        desktopTelemetryControlFd: undefined,
        resourceMonitorPath: undefined,
        staticDir: undefined,
        devUrl: undefined,
        devAllowedOrigins: [],
        noBrowser: false,
        startupPresentation: "browser",
        ...overrides,
      });
    }),
  ).pipe(Layer.provide(NodePath.layer));

/**
 * Runs `program` (one log line by default) inside a span so the tracer logger
 * has somewhere to attach an event, then reports both what the collector
 * received and what landed on the span.
 */
const logInSpanThrough = (
  overrides: Partial<ServerConfig.ServerConfig["Service"]>,
  program: Effect.Effect<void> = Effect.log("server logger under test"),
) =>
  Effect.gen(function* () {
    const requests: Array<ExportedRequest> = [];
    const spans: Array<Tracer.NativeSpan> = [];
    const layerTracer = Layer.succeed(
      Tracer.Tracer,
      Tracer.make({
        span: (spanOptions) => {
          const span = new Tracer.NativeSpan(spanOptions);
          spans.push(span);
          return span;
        },
      }),
    );
    yield* program.pipe(
      Effect.withSpan("server-logger-test"),
      Effect.provide(
        Layer.mergeAll(
          ServerLogger.layer.pipe(
            Layer.provide(layerConfig(overrides)),
            Layer.provide(layerCollector(requests)),
          ),
          layerTracer,
        ),
      ),
    );
    return { requests, spans };
  });

/** Logs one warning through the server logger and returns what its console printed. */
const printThroughConsole = (fields: object) =>
  Effect.gen(function* () {
    const printed: Array<string> = [];
    const testConsole = {
      ...globalThis.console,
      log: (...args: ReadonlyArray<unknown>) => {
        printed.push(NodeUtil.format(...args));
      },
    } satisfies Console.Console;
    yield* Effect.logWarning("pull request watch check failed", fields).pipe(
      Effect.provide(
        ServerLogger.layer.pipe(Layer.provide(layerConfig({})), Layer.provide(layerCollector([]))),
      ),
      Effect.provideService(Console.Console, testConsole),
    );
    return printed.join("\n");
  });

/** Everything the server's console logger printed while `program` ran. */
const printedBy = <E>(program: Effect.Effect<unknown, E>) =>
  Effect.gen(function* () {
    const printed: Array<string> = [];
    const record = (...args: ReadonlyArray<unknown>) => {
      printed.push(NodeUtil.format(...args));
    };
    const testConsole = {
      ...globalThis.console,
      log: record,
      error: record,
    } satisfies Console.Console;
    yield* program.pipe(
      Effect.provide(
        ServerLogger.layer.pipe(Layer.provide(layerConfig({})), Layer.provide(layerCollector([]))),
      ),
      Effect.provideService(Console.Console, testConsole),
    );
    return printed.join("\n");
  });

// Synthetic canaries; none of them is a real credential.
const canaryJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnktand0In0.Y2FuYXJ5LWp3dC1zaWduYXR1cmU";
// A valid JWT whose header has spaces, so it does not start with "eyJ".
const spacedJwt =
  "eyAiYWxnIjogIkhTMjU2IiwgInR5cCI6ICJKV1QiIH0.eyJzdWIiOiJjYW5hcnktd3Mtand0In0.Y2FuYXJ5LXdzLXNpZw";
// A header that starts with a space, so it encodes as "IHsi…".
const leadingSpaceJwt = `${Buffer.from(' {"alg":"HS256"}').toString("base64url")}.eyJzdWIiOiJjYW5hcnktbGVhZCJ9.c2ln`;
const canaries = [
  leadingSpaceJwt,
  "canary-nested-cookie",
  "canary-escaped-key",
  "canaryGoatEnvToken0123456789",
  canaryJwt,
  spacedJwt,
  "canary-array-cookie",
  "canary-cookie-value",
  "canary-set-cookie",
  "canary-json-token",
  "canary-field-token",
  "canary-key-token",
  "canary-annotation-cookie",
  "canary-span-token",
];

/** An error whose message, own field and nested cause each carry a credential. */
const leakyError = (label: string) =>
  Object.assign(
    new Error(`${label} failed with requestid.${canaryJwt}, ${spacedJwt} and ${leadingSpaceJwt}`, {
      cause: new Error(
        'upstream echoed {"access_token":"canary-json-token","setCookie":["sid=canary-array-cookie"],"cookie":[["a"],"canary-nested-cookie"],"to\\u006ben":"canary-escaped-key"}',
      ),
    }),
    {
      headers: {
        authorization: "Bearer canary-field-token-0123456789",
        cookie: "sid=canary-cookie-value",
      },
    },
  );

const leakyLog = Effect.logError(
  "tool handler died",
  {
    detail:
      "Set-Cookie: sid=canary-set-cookie; Path=/ GOAT_MCP_BEARER_TOKEN=canaryGoatEnvToken0123456789",
    error: leakyError("field"),
    "Bearer canary-key-token-0123456789": "keyed",
  },
  Cause.fromReasons([
    Cause.makeFailReason(leakyError("failure")),
    Cause.makeDieReason(leakyError("defect")),
  ]),
).pipe(
  Effect.annotateLogs({ request: "Cookie: sid=canary-annotation-cookie" }),
  Effect.withLogSpan("token=canary-span-token"),
);

const assertRedacted = (output: string) => {
  for (const canary of canaries) assert.notInclude(output, canary);
};

const DyingTool = Tool.make("dying_tool", { success: Schema.String });
const DyingToolkit = Toolkit.make(DyingTool);
const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-server-logger"),
  requestNamespace: "server-logger",
  thread: {
    threadId: ThreadId.make("thread-server-logger"),
    providerSessionId: "server-logger",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"] as const),
  grantedScopes: [],
  reauthorize: () => Effect.void,
  issuedAt: 1,
};
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "server-logger-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "server-logger-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

describe("ServerLoggerLive", () => {
  describe("credential redaction (#1388)", () => {
    it.effect("keeps credentials out of the console while keeping the error context", () =>
      Effect.gen(function* () {
        const output = yield* printedBy(leakyLog);

        assert.include(output, "tool handler died");
        assert.include(output, "detail");
        assert.include(output, "defect failed with");
        assert.include(output, "upstream echoed");
        assertRedacted(output);
      }),
    );

    it.effect("keeps credentials out of the span events the trace file records", () =>
      Effect.gen(function* () {
        const { spans } = yield* logInSpanThrough({}, leakyLog);

        const events = JSON.stringify(
          spans.flatMap((span) => span.events.map(([name, , attributes]) => [name, attributes])),
        );
        assert.include(events, "tool handler died");
        assert.include(events, "defect failed with");
        assertRedacted(events);
      }).pipe(Effect.provide(TestConsole.layer)),
    );

    it.effect("keeps credentials out of exported OTLP log records", () =>
      Effect.gen(function* () {
        const { requests } = yield* logInSpanThrough(
          { otlpLogsUrl: "https://collector.example.com/v1/logs" },
          leakyLog,
        );

        const body = requests.map((request) => request.body).join("\n");
        assert.include(body, "tool handler died");
        assert.include(body, "failure failed with");
        assertRedacted(body);
      }).pipe(Effect.provide(TestConsole.layer)),
    );

    it.effect("logs a dying MCP tool handler's defect without its credentials", () =>
      Effect.gen(function* () {
        const registration = McpHttpServer.toolkitRegistration(
          DyingToolkit,
          McpToolAccess.toLayer(DyingToolkit, {
            dying_tool: McpToolAccess.reads(() => Effect.die(leakyError("tool"))),
          }),
        ).pipe(
          Layer.provide(DefectReporter.layer),
          Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provideMerge(NodeServices.layer),
        );
        let isError: boolean | undefined;
        const output = yield* printedBy(
          Effect.gen(function* () {
            const server = yield* McpServer.McpServer;
            const result = yield* server
              .callTool({ name: "dying_tool", arguments: {} })
              .pipe(
                Effect.provideService(McpInvocationContext, invocation),
                Effect.provideService(McpSchema.McpServerClient, mcpClient),
              );
            isError = result.isError;
          }).pipe(Effect.provide(registration)),
        );

        assert.isTrue(isError);
        // McpServer logs the cause, then reports it to DefectReporter, which logs it again.
        assert.include(output, "tool failed with");
        assert.include(output, "Unhandled defect");
        assertRedacted(output);
      }),
    );
  });

  it.effect("exports a resource that names whether the desktop app launched the server", () =>
    Effect.gen(function* () {
      const { requests } = yield* logInSpanThrough({
        otlpLogsUrl: "https://collector.example.com/v1/logs",
        mode: "desktop",
      });

      const body = requests.map((request) => request.body).join("\n");
      assert.include(body, '"key":"goat.server.managed_by","value":{"stringValue":"desktop"}');
      assert.notInclude(body, "service.mode");
    }),
  );

  it.effect("prints a cause passed as a log field instead of collapsing it", () =>
    Effect.gen(function* () {
      const output = yield* printThroughConsole({
        threadId: "thread-1",
        cause: Cause.fail(new Error("gh: HTTP 502 from api.github.com")),
      });

      assert.include(output, "threadId: 'thread-1'");
      assert.include(output, "gh: HTTP 502 from api.github.com");
      assert.notInclude(output, "[Object]");
    }),
  );

  // regression: #16642 logs printed causes as [Object]
  it.effect("leaves getters uncalled while printing a cause field", () =>
    Effect.gen(function* () {
      const output = yield* printThroughConsole({
        cause: Cause.fail(new Error("upstream refused")),
        get detail(): string {
          throw new Error("getter must not run");
        },
      });

      assert.include(output, "upstream refused");
      assert.notInclude(output, "getter must not run");
    }),
  );

  it.effect("lets a message's redaction hook decide what it shows", () =>
    Effect.gen(function* () {
      const output = yield* printThroughConsole({
        token: "secret-token-value",
        cause: Cause.fail(new Error("upstream refused")),
        [Redactable.symbolRedactable](this: { readonly cause: unknown }) {
          return { token: "<redacted>", cause: Cause.isCause(this.cause) ? "cause" : "missing" };
        },
      });

      // The hook ran (cause is its own marker); its credential field still gets the mask.
      assert.include(output, "token: '***'");
      assert.include(output, "cause: 'cause'");
      assert.notInclude(output, "secret-token-value");
    }),
  );

  describe("startup pairing URL", () => {
    const pairingToken = "PAIRTOKEN7Q4K9";
    const pairingUrl = `http://localhost:3773/pair#token=${pairingToken}`;
    const announce = announceStartupPairingUrl(pairingUrl).pipe(
      Effect.andThen(logBrowserAutoOpenUnavailable),
    );

    it.effect("prints the full URL but keeps its token out of exported log records", () =>
      Effect.gen(function* () {
        const { requests } = yield* logInSpanThrough(
          { otlpLogsUrl: "https://collector.example.com/v1/logs" },
          announce,
        );

        const body = requests.map((request) => request.body).join("\n");
        assert.include(body, "Authentication required");
        assert.notInclude(body, pairingToken);
        const printed = (yield* TestConsole.logLines).map((line) =>
          Array.isArray(line) ? line.join(" ") : String(line),
        );
        assert.isTrue(printed.some((line) => line.includes(`pairingUrl: ${pairingUrl}`)));
      }).pipe(Effect.provide(TestConsole.layer)),
    );

    it.effect("keeps the token off the span events the trace file records", () =>
      Effect.gen(function* () {
        const { spans } = yield* logInSpanThrough({}, announce);

        const events = JSON.stringify(
          spans.flatMap((span) => span.events.map(([name, , attributes]) => [name, attributes])),
        );
        assert.include(events, "Authentication required");
        assert.notInclude(events, pairingToken);
      }).pipe(Effect.provide(TestConsole.layer)),
    );

    it.effect("keeps the token out of traces when the browser fails to open", () =>
      Effect.gen(function* () {
        // A failed launch records its error, which names the target, on its span.
        const failingLaunch = maybeOpenBrowser(pairingUrl).pipe(
          Effect.provide(
            Layer.mergeAll(
              layerConfig({ noBrowser: false }),
              Layer.mock(ExternalLauncher.ExternalLauncher)({
                launchBrowser: (target) =>
                  Effect.fail(
                    new ExternalLauncherBrowserSpawnError({
                      target,
                      command: "xdg-open",
                      args: [target],
                      cause: new Error("spawn xdg-open ENOENT"),
                    }),
                  ).pipe(Effect.withSpan("externalLauncher.launchBrowser")),
              }),
            ),
          ),
        );
        const { spans } = yield* logInSpanThrough({}, failingLaunch);

        const recorded = JSON.stringify(
          spans.map((span) => ({
            name: span.name,
            events: span.events.map(([name, , attributes]) => [name, attributes]),
            exit:
              span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
                ? Cause.pretty(span.status.exit.cause)
                : null,
          })),
        );
        assert.include(recorded, "browser auto-open unavailable");
        assert.notInclude(recorded, pairingToken);
      }),
    );
  });
});
