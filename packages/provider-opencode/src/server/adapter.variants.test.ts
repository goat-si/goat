import { assert, it } from "@effect/vitest";
import { MessageId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  asyncEventStream,
  makeOpenCodeRuntimeHarness,
  promiseGate,
} from "./adapter.harness.testkit.ts";
it.effect.each([
  ["empty", "prompt"],
  ["unsupported", "command"],
  ["supported", "command"],
  ["unknown", "prompt"],
  ["failure", "prompt"],
  ["unset", "prompt"],
] as const)("normalizes reasoning variants for %s inventory at %s dispatch", ([kind, request]) =>
  Effect.gen(function* () {
    const suffix = `variant-${kind}-${request}`;
    const nativeEvents = asyncEventStream();
    const inputs: Array<Record<string, unknown>> = [];
    let inventoryCalls = 0;
    const receive = async (input: Record<string, unknown>) => {
      inputs.push(input);
      return { data: true };
    };
    const harness = yield* makeOpenCodeRuntimeHarness(
      suffix,
      suffix,
      {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        provider: {
          list: async () => {
            inventoryCalls++;
            if (kind === "failure") throw new Error("inventory unavailable");
            return {
              data: {
                all: [
                  {
                    id: "opencode",
                    models:
                      kind === "unknown"
                        ? {}
                        : {
                            "big-pickle": {
                              id: "big-pickle",
                              variants:
                                kind === "supported"
                                  ? { medium: {} }
                                  : kind === "unsupported"
                                    ? { high: {} }
                                    : {},
                            },
                          },
                  },
                ],
              },
            };
          },
        },
        command: { list: async () => ({ data: [{ name: "review" }] }) },
        session: {
          create: async () => ({ data: { id: suffix, time: { created: 1, updated: 1 } } }),
          promptAsync: receive,
          command: receive,
        },
      },
      {
        model: "opencode/big-pickle",
        modelOptions: [
          ...(kind === "unset" ? [] : [{ id: "variant", value: "medium" }]),
          { id: "agent", value: "plan" },
        ],
      },
    );
    yield* harness.startTurn(request === "command" ? "/review staged changes" : "hello");
    assert.equal(inputs.length, 1);
    const payload = inputs[0]!;
    assert.equal(payload.agent, "plan");
    if (kind === "supported" || kind === "unknown" || kind === "failure") {
      assert.equal(payload.variant, "medium");
    } else {
      assert.equal(Object.hasOwn(payload, "variant"), false);
    }
    if (kind === "unset") assert.equal(inventoryCalls, 0);
  }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)), Effect.scoped),
);

it.effect("reuses successful model variants for the session and retries failed inventories", () =>
  Effect.gen(function* () {
    const sessionId = "variant-cache";
    const nativeEvents = asyncEventStream();
    const inputs: Array<Record<string, unknown>> = [];
    let inventoryCalls = 0;
    let variants: Record<string, object> = {};
    const harness = yield* makeOpenCodeRuntimeHarness(
      sessionId,
      sessionId,
      {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        provider: {
          list: async () => {
            inventoryCalls++;
            if (inventoryCalls === 1) throw new Error("inventory unavailable");
            return {
              data: {
                all: [{ id: "opencode", models: { "big-pickle": { variants } } }],
              },
            };
          },
        },
        session: {
          create: async () => ({ data: { id: sessionId, time: { created: 1, updated: 1 } } }),
          promptAsync: async (input: Record<string, unknown>) => {
            inputs.push(input);
            return { data: true };
          },
        },
      },
      { model: "opencode/big-pickle", modelOptions: [{ id: "variant", value: "medium" }] },
    );
    const submit = Effect.fnUntraced(function* () {
      yield* harness.startTurn();
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: sessionId,
            info: {
              id: inputs.at(-1)!.messageID,
              sessionID: sessionId,
              role: "user",
              time: { created: 1 },
            },
          },
        }),
      );
      yield* Effect.promise(() =>
        nativeEvents.push({ type: "session.idle", properties: { sessionID: sessionId } }),
      );
      yield* harness.runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.take(1),
        Stream.runDrain,
      );
      return inputs.at(-1)!;
    });

    assert.equal((yield* submit()).variant, "medium");
    assert.equal(inventoryCalls, 1);
    assert.isFalse(Object.hasOwn(yield* submit(), "variant"));
    assert.equal(inventoryCalls, 2);
    variants = { medium: {} };
    assert.isFalse(Object.hasOwn(yield* submit(), "variant"));
    assert.equal(inventoryCalls, 2);
  }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)), Effect.scoped),
);

it.effect("keeps queued steers behind a cold catalog lookup and cancels them on stop", () =>
  Effect.gen(function* () {
    const sessionId = "catalog-admission";
    const nativeEvents = asyncEventStream();
    const catalogStarted = promiseGate<void>();
    const calls: string[] = [];
    const harness = yield* makeOpenCodeRuntimeHarness(
      sessionId,
      sessionId,
      {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        provider: {
          list: async (_input: unknown, { signal }: { signal: AbortSignal }) => {
            calls.push("catalog");
            catalogStarted.resolve();
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  calls.push("catalog-aborted");
                  reject(signal.reason);
                },
                { once: true },
              );
            });
            return { data: { all: [] } };
          },
        },
        session: {
          create: async () => ({ data: { id: sessionId, time: { created: 1, updated: 1 } } }),
          get: async () => ({ data: { id: sessionId, time: { created: 1, updated: 1 } } }),
          messages: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
          promptAsync: async (_input: unknown, { signal }: { signal: AbortSignal }) => {
            signal.throwIfAborted();
            calls.push("prompt");
            return { data: true };
          },
          abort: async () => {
            calls.push("abort");
            return { data: true };
          },
        },
      },
      { model: "opencode/big-pickle", modelOptions: [{ id: "variant", value: "medium" }] },
    );
    const start = yield* harness.startTurn().pipe(Effect.forkScoped);
    yield* Effect.promise(() => catalogStarted.promise);
    const snapshot = yield* harness.runtime.readThreadSnapshot({
      providerThread: harness.providerThread,
    });
    const activeTurn = snapshot.providerTurns.at(-1)!;
    const steer = (message: string) =>
      harness.runtime
        .steerTurn({
          threadId: harness.threadId,
          runId: harness.runId,
          providerThread: harness.providerThread,
          providerTurnId: activeTurn.id,
          message: {
            messageId: MessageId.make(message),
            text: message,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }));
    const firstSteer = yield* steer("first follow-up");
    const secondSteer = yield* steer("second follow-up");
    yield* TestClock.adjust("5 seconds");
    assert.deepEqual(calls, ["catalog"]);

    yield* harness.runtime.interruptTurn({
      providerThread: harness.providerThread,
      providerTurnId: activeTurn.id,
    });
    yield* Fiber.join(start);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(firstSteer)));
    assert.isTrue(Exit.isFailure(yield* Fiber.join(secondSteer)));
    assert.deepEqual(calls, ["catalog", "catalog-aborted", "abort"]);
  }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)), Effect.scoped),
);
