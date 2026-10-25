import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import { CodexSettings, ProviderSessionId, RunAttemptId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  makeCodexTestTurnInput,
  makeReplayServerConfig,
  withReplayRequestId,
} from "./CodexAdapterV2.testkit.ts";
import {
  codexReplayPreamble,
  makeCodexReplayTranscript,
  makeCodexReplayTurn,
} from "./CodexReplay.testkit.ts";

const layerAdapterTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);
const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
// Every memory tool by the name /mcp lists, which is what Codex disables.
const GOAT_MEMORY_TOOLS = [
  "goat_memory_list",
  "goat_memory_search",
  "goat_memory_read",
  "goat_memory_history",
  "goat_memory_sync_status",
  "goat_memory_source_read",
  "goat_memory_upsert",
  "goat_memory_forget",
  "goat_memory_revert_resolution",
];
const unusedRegistry = {
  issue: () => Effect.die("unused"),
  resolve: () => Effect.succeed(undefined),
  touch: () => Effect.void,
  revokeProviderSession: () => Effect.void,
  revokeThread: () => Effect.void,
  revokeAll: Effect.void,
  currentMemoryPolicy: () => Effect.succeed(undefined),
} satisfies McpSessionRegistry.McpSessionRegistry["Service"];

/** Opens one replayed Codex session and records the thread requests the adapter sends. */
const openReplay = Effect.fn("CodexComputerUseTest.openReplay")(function* (
  transcript: CodexReplay.CodexAppServerReplayTranscript,
) {
  const driver = yield* CodexReplay.makeReplayDriver(transcript);
  const threadConfigs: Array<Record<string, unknown>> = [];
  const record = (method: string, params: unknown) =>
    Effect.sync(() => {
      if (method === "thread/start" || method === "thread/resume")
        threadConfigs.push((params as { config: Record<string, unknown> }).config);
    });
  const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
    instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    settings: DEFAULT_CODEX_SETTINGS,
    environment: {},
    clientFactory: {
      open: (openInput) =>
        Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
          Effect.flatMap((context) =>
            Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
          ),
          Effect.map(
            (client) =>
              ({
                ...client,
                request: (method, params) =>
                  record(method, params).pipe(Effect.andThen(client.request(method, params))),
                raw: {
                  ...client.raw,
                  request: (method, params) =>
                    record(method, params).pipe(Effect.andThen(client.raw.request(method, params))),
                },
              }) satisfies CodexClient.CodexAppServerClient["Service"],
          ),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                providerSessionId: openInput.providerSessionId,
                cause,
              }),
          ),
        ),
    },
    crypto: yield* Crypto.Crypto,
    fileSystem: yield* FileSystem.FileSystem,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    serverConfig: yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie),
  });
  const threadId = ThreadId.make(`thread-${transcript.scenario}`);
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
  });
  const terminals = yield* Queue.unbounded<void>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      event.type === "turn.terminal" ? Queue.offer(terminals, undefined) : Effect.void,
    ),
    Effect.forkScoped,
  );
  const startTurn = (ordinal: number) =>
    Effect.gen(function* () {
      yield* runtime.startTurn(
        makeCodexTestTurnInput({
          threadId,
          providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make(`${transcript.scenario}-${ordinal}`),
          text: `turn-${ordinal}`,
        }),
      );
    });
  return { threadConfigs, startTurn, terminal: Queue.take(terminals) };
});

/** The replayed Codex thread every test drives, with the frames it expects in order. */
const fixture = (scenario: string) => {
  const nativeThreadId = scenario;
  const threadId = ThreadId.make(`thread-${scenario}`);
  const config: McpProviderSession.McpProviderSessionConfig = {
    environmentId: M.EnvironmentId.make("fixture"),
    threadId,
    providerSessionId: "credential-cua",
    providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer fixture-cua",
    browserToolsAvailable: false,
    grantedScopes: [],
  };
  // GOAT's lease proxy names its control in its arguments; Stop mints a new one (#1564).
  const driver = (control: string): M.CuaDriverMcpConfiguration => ({
    command: "/resources/cua-driver",
    args: ["mcp", "--socket", "/tmp/cua.sock", "--control", control],
    environment: [{ name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" }],
    socketPath: "/tmp/cua.sock",
  });
  // The wire shape Codex receives: each server under its own dotted path.
  const managed = (control: string) => ({
    command: "/resources/cua-driver",
    args: ["mcp", "--socket", "/tmp/cua.sock", "--control", control],
    env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" },
  });
  const threadParams = (cua?: Record<string, unknown>) => ({
    cwd: "/workspace",
    model: CODEX_TEST_MODEL_SELECTION.model,
    config: {
      "tools.update_plan.enabled": true,
      mcp_optional_startup_grace_ms: 10_000,
      "mcp_servers.goat": {
        url: config.endpoint,
        disabled_tools: GOAT_MEMORY_TOOLS,
        tool_timeout_sec: 3900,
        http_headers: { Authorization: config.authorizationHeader },
      },
      ...(cua === undefined ? {} : { "mcp_servers.cua-driver": cua }),
    },
  });
  const preamble = codexReplayPreamble({
    nativeThreadId,
    nativeTurnId: "unused",
    prompt: "unused",
  });
  const threadResult = preamble[4]!;
  const entries: CodexReplay.CodexAppServerReplayEntry[] = [...preamble.slice(0, 3)];
  const start = (cua?: Record<string, unknown>) =>
    entries.push(
      {
        type: "expect_outbound",
        frame: { id: 2, method: "thread/start", params: threadParams(cua) },
      },
      threadResult,
    );
  // Codex ignores resume overrides on a thread a client holds: a reload unsubscribes first.
  const reload = (id: number, cua: Record<string, unknown>) =>
    entries.push(
      {
        type: "expect_outbound",
        frame: { id, method: "thread/unsubscribe", params: { threadId: nativeThreadId } },
      },
      { type: "emit_inbound", frame: { id, result: { status: "unsubscribed" } } },
      {
        type: "expect_outbound",
        frame: {
          id: id + 1,
          method: "thread/resume",
          params: { threadId: nativeThreadId, excludeTurns: true, ...threadParams(cua) },
        },
      },
      withReplayRequestId(threadResult, id + 1),
    );
  const turnStart = (id: number, ordinal: number, computerUse: boolean) =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId,
        codexInput: [{ type: "text", text: `turn-${ordinal}` }],
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        hasGoatMcp: true,
        browserToolsAvailable: false,
        computerUse,
      });
      entries.push(
        { type: "expect_outbound", frame: { id, method: "turn/start", params } },
        {
          type: "emit_inbound",
          frame: {
            id,
            result: { turn: makeCodexReplayTurn({ id: `turn-${ordinal}`, status: "inProgress" }) },
          },
        },
      );
    });
  const turnCompleted = (ordinal: number) =>
    entries.push({
      type: "emit_inbound",
      frame: {
        method: "turn/completed",
        params: {
          threadId: nativeThreadId,
          turn: makeCodexReplayTurn({ id: `turn-${ordinal}`, status: "completed" }),
        },
      },
    });
  const open = Effect.gen(function* () {
    return yield* openReplay(makeCodexReplayTranscript({ scenario, entries })).pipe(
      Effect.provideService(McpSessionRegistry.McpSessionRegistry, unusedRegistry),
    );
  });
  return {
    config,
    driver,
    managed,
    entries,
    start,
    reload,
    turnStart,
    turnCompleted,
    open,
  };
};

describe("Codex computer use attachment", () => {
  it.effect.each(["managed", "user", "override"] as const)(
    "reloads a live thread when computer use attaches, its control changes after Stop, or it detaches, unless the user defines it (%s)",
    (mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = fixture(`cua-live-${mode}`);
          const withCua = (control: string) => ({
            ...f.config,
            cuaDriver: f.driver(control),
            ...(mode === "override" ? { cuaDriverOverridesUserConfig: true } : {}),
          });
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(f.config);
          f.start();
          // Turn 1 runs before computer use is enabled.
          yield* f.turnStart(3, 1, false);
          f.turnCompleted(1);
          let id = 4;
          // Unless the decision overrides it, the user's config is read once for the directory.
          if (mode !== "override") {
            f.entries.push(
              {
                type: "expect_outbound",
                frame: {
                  id,
                  method: "config/read",
                  params: { cwd: "/workspace", includeLayers: false },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  id,
                  result: {
                    config: {
                      mcp_servers:
                        mode === "user" ? { "cua-driver": { command: "/opt/my/cua-driver" } } : {},
                    },
                    origins: {},
                  },
                },
              },
            );
            id++;
          }
          if (mode === "user") {
            // The user's own cua-driver wins: no reload and no instructions.
            for (const ordinal of [2, 3, 4]) {
              yield* f.turnStart(id++, ordinal, false);
              f.turnCompleted(ordinal);
            }
          } else {
            // Turn 2 attaches control A; turn 3 runs under control B, minted after a Stop.
            const turns = [
              [2, f.managed("control:a"), true],
              [3, f.managed("control:b"), true],
              // Turn 4: disabled again. The managed entry is switched off, not left behind.
              [4, { ...f.managed("control:b"), enabled: false }, false],
            ] as const;
            for (const [ordinal, cua, computerUse] of turns) {
              f.reload(id, cua);
              id += 2;
              yield* f.turnStart(id++, ordinal, computerUse);
              f.turnCompleted(ordinal);
            }
          }
          const replay = yield* f.open;
          for (const [ordinal, attachment] of [
            f.config,
            withCua("control:a"),
            withCua("control:b"),
            f.config,
          ].entries()) {
            yield* sessions.set(attachment);
            yield* replay.startTurn(ordinal + 1);
            yield* replay.terminal;
          }
          assert.deepEqual(
            replay.threadConfigs.map((threadConfig) => threadConfig["mcp_servers.cua-driver"]),
            mode === "user"
              ? [undefined]
              : [
                  undefined,
                  f.managed("control:a"),
                  f.managed("control:b"),
                  { ...f.managed("control:b"), enabled: false },
                ],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );

  it.effect(
    "keeps a thread with a running turn subscribed and reloads its new control at the next idle turn (#1564)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = fixture("cua-running-turn");
          const withCua = (control: string) => ({
            ...f.config,
            cuaDriver: f.driver(control),
            cuaDriverOverridesUserConfig: true,
          });
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          yield* sessions.set(withCua("control:a"));
          f.start(f.managed("control:a"));
          // Turn 1 is still running when the control changes. Input sent to it (turn 2) goes
          // straight to turn/start: no unsubscribe could drop the running turn's events.
          yield* f.turnStart(3, 1, true);
          yield* f.turnStart(4, 2, true);
          f.turnCompleted(1);
          f.turnCompleted(2);
          // Between turns, the new control reaches Codex through a reload.
          f.reload(5, f.managed("control:b"));
          yield* f.turnStart(7, 3, true);
          f.turnCompleted(3);
          const replay = yield* f.open;
          yield* replay.startTurn(1);
          yield* sessions.set(withCua("control:b"));
          yield* replay.startTurn(2);
          yield* replay.terminal;
          yield* replay.terminal;
          yield* replay.startTurn(3);
          yield* replay.terminal;
          assert.deepEqual(
            replay.threadConfigs.map((threadConfig) => threadConfig["mcp_servers.cua-driver"]),
            [f.managed("control:a"), f.managed("control:b")],
          );
        }),
      ).pipe(Effect.provide(layerAdapterTest)),
  );
});
