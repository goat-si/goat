import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import {
  asyncEventStream,
  makeOpenCodeRuntimeHarness,
  promiseGate,
} from "./adapter.harness.testkit.ts";

it.effect("keeps an admitted native command running when its HTTP request times out", () =>
  Effect.gen(function* () {
    const nativeEvents = asyncEventStream();
    const commandCalled = promiseGate<string>();
    let rejectCommand!: (cause: unknown) => void;
    const commandResponse = new Promise<never>((_, reject) => {
      rejectCommand = reject;
    });
    const sessionId = "native-command-timeout";
    const harness = yield* makeOpenCodeRuntimeHarness("native-command-timeout", sessionId, {
      event: {
        subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
          options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
          return { stream: nativeEvents.stream };
        },
      },
      command: { list: async () => ({ data: [{ name: "review" }] }) },
      session: {
        create: async () => ({ data: { id: sessionId, time: { created: 1, updated: 1 } } }),
        command: (input: { messageID: string }) => {
          commandCalled.resolve(input.messageID);
          return commandResponse;
        },
      },
    });
    const start = yield* harness.startTurn("/review staged changes").pipe(Effect.forkScoped);
    const messageID = yield* Effect.promise(() => commandCalled.promise);
    yield* Effect.promise(() =>
      nativeEvents.push({
        type: "message.updated",
        properties: {
          sessionID: sessionId,
          info: {
            id: messageID,
            sessionID: sessionId,
            role: "user",
            time: { created: DateTime.toEpochMillis(harness.now) },
          },
        },
      }),
    );
    yield* Fiber.join(start);
    const terminal = yield* harness.runtime.events.pipe(
      Stream.filter((event) => event.type === "turn.terminal"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped,
    );

    // Node's fetch gives up on a command still running in OpenCode after 300 s.
    rejectCommand(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("Headers Timeout Error"), {
          name: "HeadersTimeoutError",
          code: "UND_ERR_HEADERS_TIMEOUT",
        }),
      }),
    );
    yield* Effect.promise(() =>
      nativeEvents.push({
        type: "session.status",
        properties: { sessionID: sessionId, status: { type: "busy" } },
      }),
    );
    yield* Effect.promise(() =>
      nativeEvents.push({ type: "session.idle", properties: { sessionID: sessionId } }),
    );

    const [event] = yield* Fiber.join(terminal);
    assert.equal(
      event?.type === "turn.terminal" ? event.status : undefined,
      "completed",
      "a command admitted by its user receipt must not fail when its HTTP request times out",
    );
  }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)), Effect.scoped),
);
