import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { asyncEventStream, makeOpenCodeRuntimeHarness } from "./adapter.harness.testkit.ts";

it.effect("holds a retiring session while a child session runs, until OpenCode says it ended", () =>
  Effect.gen(function* () {
    const root = "live-work-root";
    const child = "live-work-child";
    const nativeEvents = asyncEventStream();
    const push = (event: unknown) => Effect.promise(() => nativeEvents.push(event));
    const status = (sessionID: string, type: "busy" | "idle") => ({
      type: "session.status",
      properties: { sessionID, status: { type } },
    });
    const statusReplies: Array<Record<string, { type: string }>> = [
      { [child]: { type: "busy" } },
      {},
    ];
    const payloads: Array<{ messageID: string }> = [];
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    yield* sessions.set({
      environmentId: EnvironmentId.make("fixture"),
      threadId: ThreadId.make("thread-opencode-live-work"),
      providerSessionId: "session-opencode-live-work",
      providerInstanceId: ProviderInstanceId.make("opencode-live-work"),
      endpoint: "http://fixture.invalid/mcp",
      authorizationHeader: "Bearer live-work",
      browserToolsAvailable: false,
    });
    const harness = yield* makeOpenCodeRuntimeHarness("live-work", root, {
      event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
      session: {
        create: async () => ({
          data: { id: root, time: { created: 1, updated: 1 }, permission: [] },
        }),
        get: async (input: { sessionID: string }) => ({
          data: {
            id: input.sessionID,
            parentID: root,
            permission: [],
            time: { created: 2, updated: 2 },
          },
        }),
        update: async (input: { sessionID: string }) => ({
          data: { id: input.sessionID, time: { created: 1, updated: 1 } },
        }),
        status: async () => ({ data: statusReplies.shift() ?? {} }),
        promptAsync: async (input: { messageID: string }) => {
          payloads.push(input);
          return { data: true };
        },
        abort: async () => ({ data: true }),
        children: async () => ({ data: [] }),
        messages: async () => ({ data: [] }),
      },
    });
    yield* harness.startTurn("work");
    const terminal = yield* harness.runtime.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* push({
      type: "message.updated",
      properties: {
        sessionID: root,
        info: { id: payloads.at(-1)?.messageID, role: "user", time: { created: 1 } },
      },
    });
    yield* push(status(root, "busy"));
    yield* push({
      type: "session.created",
      properties: { info: { id: child, parentID: root, time: { created: 2, updated: 2 } } },
    });
    yield* push(status(child, "busy"));
    yield* push(status(root, "idle"));
    yield* Fiber.join(terminal);

    const holdsLiveWork = harness.runtime.holdsLiveWork;
    assert.isDefined(holdsLiveWork);
    if (holdsLiveWork === undefined) return;
    assert.isTrue(yield* holdsLiveWork({ pastPinCeiling: false }));
    // Past the pin ceiling the cached state is confirmed with OpenCode.
    assert.isTrue(yield* holdsLiveWork({ pastPinCeiling: true }));
    assert.isFalse(yield* holdsLiveWork({ pastPinCeiling: true }));
  }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)), Effect.scoped),
);
