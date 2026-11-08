import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderSessionId, RunAttemptId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

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

const layer = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);

const settings = Schema.decodeSync(CodexSettings)({});

function threadIdOf(params: unknown): string {
  return typeof params === "object" &&
    params !== null &&
    "threadId" in params &&
    typeof params.threadId === "string"
    ? params.threadId
    : "unknown";
}

function recordedNativeThreadId(event: unknown): string | undefined {
  return typeof event === "object" &&
    event !== null &&
    "nativeThreadId" in event &&
    typeof event.nativeThreadId === "string"
    ? event.nativeThreadId
    : undefined;
}

type ProtocolLogEvent = {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
};

it.effect("writes two root threads' frames to their own logs on one shared session", () =>
  Effect.gen(function* () {
    const opener = ThreadId.make("thread-event-log-a");
    const other = ThreadId.make("thread-event-log-b");
    const writes: Array<{ readonly event: unknown; readonly threadId: ThreadId | null }> = [];
    const nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger = {
      filePath: "/tmp/events.log",
      write: (event, threadId) =>
        Effect.sync(() => {
          writes.push({ event, threadId });
        }),
      close: () => Effect.void,
    };
    let protocolLogger: ((event: ProtocolLogEvent) => Effect.Effect<void, never>) | undefined;
    const transcript = makeCodexReplayTranscript({
      scenario: "event-log-shared",
      entries: [
        ...codexReplayPreamble({
          nativeThreadId: "native-a",
          nativeTurnId: "unused",
          prompt: "unused",
        }).slice(0, 5),
        ...codexReplayPreamble({
          nativeThreadId: "native-b",
          nativeTurnId: "unused",
          prompt: "unused",
        })
          .slice(3, 5)
          .map((entry) => withReplayRequestId(entry, 3)),
      ],
    });
    const clientFactory: CodexAdapterV2.CodexAppServerClientFactoryShape = {
      open: (openInput) =>
        Effect.gen(function* () {
          protocolLogger = CodexAdapterV2.makeCodexAppServerProtocolLogger({
            nativeEventLogger,
            threadId: openInput.threadId,
            providerSessionId: openInput.providerSessionId,
            ...(openInput.logThreadFor === undefined ? {} : { threadFor: openInput.logThreadFor }),
          });
          const driver = yield* CodexReplay.makeReplayDriver(transcript);
          const context = yield* Layer.build(CodexReplay.layerReplayWithDriver(driver));
          const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
            Effect.provide(context),
          );
          return CodexClient.CodexAppServerClient.of({
            ...client,
            request: (method, params) => {
              if (method !== "turn/start") return client.request(method, params);
              return Effect.succeed({
                turn: makeCodexReplayTurn({
                  id: "turn-" + threadIdOf(params),
                  status: "inProgress",
                }),
              }) as never;
            },
          });
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                providerSessionId: openInput.providerSessionId,
                cause,
              }),
          ),
        ),
    };
    const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings,
      environment: {},
      clientFactory,
      crypto: yield* Crypto.Crypto,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* makeReplayServerConfig("event-log-shared").pipe(Effect.orDie),
    });
    const runtime = yield* adapter.openSession({
      threadId: opener,
      providerSessionId: ProviderSessionId.make("provider-session-event-log"),
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const ensure = (threadId: ThreadId) =>
      runtime.ensureThread({
        threadId,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
    const first = yield* ensure(opener);
    const second = yield* ensure(other);
    const start = (threadId: ThreadId, providerThread: typeof first, ordinal: number) =>
      runtime.startTurn(
        makeCodexTestTurnInput({
          threadId,
          providerThread,
          now: DateTime.nowUnsafe(),
          attemptId: RunAttemptId.make("event-log-" + String(ordinal)),
          text: "turn-" + String(ordinal),
        }),
      );
    yield* start(opener, first, 1);
    yield* start(other, second, 2);
    const logger = protocolLogger;
    if (logger === undefined) return yield* Effect.die("expected a protocol logger");
    yield* logger({
      direction: "incoming",
      stage: "decoded",
      payload: { method: "thread/event", params: { threadId: "native-a" } },
    });
    yield* logger({
      direction: "incoming",
      stage: "decoded",
      payload: { method: "item/completed", params: { threadId: "native-b" } },
    });
    yield* logger({
      direction: "incoming",
      stage: "decoded",
      payload: { method: "initialized" },
    });
    assert.deepEqual(
      writes.map((write) => ({
        threadId: write.threadId,
        nativeThreadId: recordedNativeThreadId(write.event),
      })),
      [
        { threadId: opener, nativeThreadId: "native-a" },
        { threadId: other, nativeThreadId: "native-b" },
        { threadId: opener, nativeThreadId: undefined },
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
