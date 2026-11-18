import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Continuations from "@goat/provider-core/server/ProviderContinuationRequests";
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
        status: async () => {
          const reply = statusReplies.shift();
          if (reply === undefined) throw new Error("server gone");
          return { data: reply };
        },
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
    // A server that cannot answer holds nothing, so a dead server never pins its session.
    yield* push(status(child, "busy"));
    assert.isFalse(yield* holdsLiveWork({ pastPinCeiling: true }));
  }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)), Effect.scoped),
);

it.effect.each([
  "running",
  "settled",
  "foreground",
  "stop",
  "end-without-starting",
  "stream-ended",
  "buffer-limit",
] as const)("adopts OpenCode's native background work when %s", (ending) =>
  Effect.gen(function* () {
    const root = "background-root";
    const nativeEvents = asyncEventStream();
    const push = (event: unknown) => Effect.promise(() => nativeEvents.push(event));
    const status = (type: "busy" | "idle") => ({
      type: "session.status",
      properties: { sessionID: root, status: { type } },
    });
    const user = (id: string) => ({
      type: "message.updated",
      properties: {
        sessionID: root,
        info: { id, role: "user", sessionID: root, time: { created: 1 } },
      },
    });
    const prompts: string[] = [];
    const aborts: string[] = [];
    const offers: Continuations.ProviderContinuationRequest[] = [];
    const harness = yield* makeOpenCodeRuntimeHarness("background", root, {
      event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
      session: {
        create: async () => ({ data: { id: root, time: { created: 1, updated: 1 } } }),
        promptAsync: async (input: { messageID: string }) => {
          prompts.push(input.messageID);
          return { data: true };
        },
        abort: async (input: { sessionID: string }) => {
          aborts.push(input.sessionID);
          return { data: true };
        },
        children: async () => ({ data: [] }),
      },
    }).pipe(
      Effect.provideService(Continuations.ProviderContinuationRequests, {
        offer: (request) =>
          Effect.sync(() => {
            offers.push(request);
          }),
        take: Effect.never,
      }),
    );
    yield* harness.startTurn();
    const foreground = yield* harness.runtime.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* push(user(prompts[0]!));
    yield* push(status("idle"));
    assert.equal((yield* Fiber.join(foreground)).at(-1)?.type, "turn.terminal");

    yield* push(user(prompts[0]!));
    yield* push(user("saved-without-reply"));
    yield* push(status("idle"));
    assert.lengthOf(offers, 0, "a repeat or an idle-only user message does not start work");
    yield* push(user("wake-prompt"));
    yield* push(status("busy"));
    assert.lengthOf(offers, 1);
    const offer = offers[0]!;
    assert.equal(offer.threadId, harness.threadId);
    assert.equal(offer.providerThreadId, harness.providerThread.id);
    assert.equal(offer.delivery, "adapter_buffered");
    const finish = Effect.gen(function* () {
      yield* push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "wake-text",
            messageID: "wake-answer",
            sessionID: root,
            type: "text",
            text: "Background result",
          },
        },
      });
      yield* push(status("idle"));
    });
    if (ending === "stop" || ending === "end-without-starting") {
      if (ending === "stop") {
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: ProviderTurnId.make("stopped-before-admission"),
          requestRuntimeRestart: true,
        });
      } else {
        assert.isDefined(offer.onRunEndedWithoutStarting);
        yield* offer.onRunEndedWithoutStarting!();
      }
      assert.deepEqual(aborts, [root]);
      assert.isTrue(Option.isNone(yield* offer.dispatchIfCurrent!(Effect.void)));
      assert.isFalse(yield* harness.runtime.hasPendingBackgroundWork!);
      assert.lengthOf(prompts, 1);
      return;
    }
    if (ending === "stream-ended" || ending === "buffer-limit") {
      const broken = yield* harness.runtime.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "provider_session.updated" && event.providerSession.status === "error",
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );
      if (ending === "stream-ended") {
        nativeEvents.close();
      } else {
        yield* push({
          type: "message.part.updated",
          properties: {
            part: {
              id: "oversized",
              messageID: "wake-answer",
              sessionID: root,
              type: "text",
              text: "x".repeat(4 * 1024 * 1024),
            },
          },
        });
        assert.deepEqual(aborts, [root]);
      }
      assert.equal((yield* Fiber.join(broken)).at(-1)?.type, "provider_session.updated");
      assert.isTrue(Option.isNone(yield* offer.dispatchIfCurrent!(Effect.void)));
      assert.isFalse(yield* harness.runtime.hasPendingBackgroundWork!);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(harness.startTurn())));
      assert.lengthOf(prompts, 1);
      return;
    }
    if (ending === "foreground") {
      const installing = yield* harness.runtime.events.pipe(
        Stream.takeUntil(
          (event) => event.type === "provider_turn.updated" && event.providerTurn.ordinal === 2,
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      const runId = RunId.make("foreground-follow-up");
      const submitting = yield* harness
        .startTurn("follow up", harness.providerThread, harness.policy, {
          runId,
          runOrdinal: 2,
          providerTurnOrdinal: 2,
          attemptId: RunAttemptId.make("foreground-follow-up-attempt"),
        })
        .pipe(Effect.forkScoped);
      yield* Fiber.join(installing);
      assert.lengthOf(prompts, 1, "foreground waits for the native background execution to idle");
      yield* finish;
      yield* Fiber.join(submitting);
      assert.lengthOf(prompts, 2);
      assert.isTrue(Option.isNone(yield* offer.dispatchIfCurrent!(Effect.void)));
      const done = yield* harness.runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* push(user(prompts[1]!));
      yield* push(status("idle"));
      const events = yield* Fiber.join(done);
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.text === "Background result" &&
            event.turnItem.runId === runId,
        ),
      );
      assert.include(events.at(-1), { status: "completed", runOrdinal: 2 });
      return;
    }
    if (ending === "settled") yield* finish;
    assert.isTrue(yield* harness.runtime.hasPendingBackgroundWork!);
    const observed = yield* harness.runtime.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* harness.startTurn("", harness.providerThread, harness.policy, {
      runId: RunId.make("background-run"),
      runOrdinal: 2,
      providerTurnOrdinal: 2,
      attemptId: RunAttemptId.make("background-attempt"),
      message: {
        messageId: offer.messageId!,
        createdBy: "agent",
        creationSource: "provider",
        text: "",
        attachments: [],
      },
    });
    if (ending === "running") yield* finish;
    const events = yield* Fiber.join(observed);
    assert.isTrue(
      events.some(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          event.turnItem.text === "Background result" &&
          event.turnItem.runId === RunId.make("background-run"),
      ),
    );
    assert.include(events.at(-1), { type: "turn.terminal", status: "completed", runOrdinal: 2 });
    assert.lengthOf(prompts, 1, "admission never submits a second native prompt");
    assert.isFalse(yield* harness.runtime.hasPendingBackgroundWork!);
  }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)), Effect.scoped),
);
