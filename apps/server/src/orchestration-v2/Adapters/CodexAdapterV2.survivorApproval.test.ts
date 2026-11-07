import { assert, it } from "@effect/vitest";
import { RunId, ThreadId } from "@goat/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as CodexSurvivors from "../../provider/CodexSurvivors.ts";
import * as CodexAdapter from "./CodexAdapterV2.ts";
import { withCodexRequestDeadlines } from "./CodexRequestDeadline.ts";
import * as Survivor from "./CodexSurvivorContinuation.ts";

const binding = {
  instanceId: CodexAdapter.CODEX_DEFAULT_INSTANCE_ID,
  recordName: "instance",
  threadId: ThreadId.make("thread"),
  sourceRunId: RunId.make("run"),
  nativeThreadId: "native",
  nativeTurnId: "turn",
};

const makeService = (order: string[]) =>
  CodexSurvivors.CodexSurvivors.of({
    list: Effect.succeed([binding]),
    startBlockedThreads: Effect.succeed([]),
    setStartWake: () => Effect.void,
    release: () => Effect.void,
    classifyRecord: () => Effect.succeed({ type: "unverifiable" }),
    classifyExisting: () => Effect.succeed("survivor" as const),
    replace: () => Effect.void,
    get: () => Effect.succeed(binding),
    getGoalBlocks: () => Effect.succeed([]),
    listGoalBlocksByInstance: () => Effect.succeed([]),
    getStopObligations: () => Effect.succeed([]),
    recordStopObligation: (_record, obligation) =>
      Effect.sync(() => {
        order.push(`record:${obligation.nativeTurnId}`);
      }),
    clearStopObligation: () => Effect.void,
    recordGoalBlock: () => Effect.void,
    clearGoalBlock: () => Effect.void,
    hasGoalBlock: () => Effect.succeed(false),
    ensureAdmission: () => Effect.void,
  });

const makeChannel = Effect.fn("survivorApprovalTest.channel")(function* () {
  const incoming = yield* Queue.unbounded<string, Cause.Done<void>>();
  const outgoing = yield* Queue.unbounded<string>();
  const context = yield* Layer.build(
    CodexClient.layerMessageChannel({
      incoming: Stream.fromQueue(incoming),
      send: (message) => Queue.offer(outgoing, message).pipe(Effect.asVoid),
      closed: Effect.never,
    }),
  );
  return { incoming, outgoing, real: Context.get(context, CodexClient.CodexAppServerClient) };
});

const serverRequest = (id: number, threadId: string, turnId: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "item/tool/requestUserInput",
    params: { threadId, turnId, itemId: `item-${id}`, questions: [] },
  });

it.effect("replayed approval receives a protocol error and fences the native turn", () =>
  Effect.gen(function* () {
    const interrupted = yield* Deferred.make<void>();
    const order: string[] = [];
    const service = makeService(order);
    const { incoming, outgoing, real } = yield* makeChannel();
    const client = {
      ...real,
      request: ((method: string, params: unknown) =>
        Effect.gen(function* () {
          assert.equal(method, "turn/interrupt");
          assert.deepEqual(params, { threadId: "native", turnId: "turn" });
          order.push("interrupt");
          yield* Deferred.succeed(interrupted, undefined);
          return {};
        })) as typeof real.request,
    };
    yield* Survivor.makeSurvivorNotifications({
      client,
      survivors: Option.some(service),
      instanceId: binding.instanceId,
      scope: yield* Scope.Scope,
    });
    yield* Queue.offer(incoming, serverRequest(7, "native", "turn"));
    const response: { error?: { message: string } } = JSON.parse(yield* Queue.take(outgoing));
    assert.isDefined(response.error);
    yield* Deferred.await(interrupted);
    assert.deepEqual(order, ["record:turn", "interrupt"]);
  }).pipe(Effect.scoped),
);

it.effect("replayed requests share one stalled interrupt and are all answered at once", () =>
  Effect.gen(function* () {
    const order: string[] = [];
    const service = makeService(order);
    const { incoming, outgoing, real } = yield* makeChannel();
    const attempts = yield* Queue.unbounded<{ threadId: string; turnId: string }>();
    const client = yield* withCodexRequestDeadlines({
      ...real,
      request: ((method: string, params: unknown) =>
        Effect.gen(function* () {
          if (method === "thread/read") return { thread: { parentThreadId: "native" } };
          if (method === "config/read") return {};
          assert.equal(method, "turn/interrupt");
          const target = params as { threadId: string; turnId: string };
          order.push(`interrupt:${target.turnId}`);
          yield* Queue.offer(attempts, target);
          return yield* Effect.never;
        })) as typeof real.request,
    });
    yield* Survivor.makeSurvivorNotifications({
      client,
      survivors: Option.some(service),
      instanceId: binding.instanceId,
      scope: yield* Scope.Scope,
    });
    for (let id = 1; id <= 50; id++)
      yield* Queue.offer(incoming, serverRequest(id, "native", "turn"));
    for (let id = 1; id <= 50; id++) {
      const response: { id: number; error?: unknown } = JSON.parse(yield* Queue.take(outgoing));
      assert.isDefined(response.error);
    }
    assert.deepEqual(yield* Queue.take(attempts), { threadId: "native", turnId: "turn" });
    yield* Queue.offer(incoming, serverRequest(51, "child", "child-turn"));
    assert.isDefined(JSON.parse(yield* Queue.take(outgoing)).error);
    yield* TestClock.adjust("30 seconds");
    assert.deepEqual(yield* Queue.take(attempts), { threadId: "native", turnId: "turn" });
    yield* TestClock.adjust("30 seconds");
    // The fifty replays coalesced into one retry, so the descendant's stop is next.
    assert.deepEqual(yield* Queue.take(attempts), { threadId: "child", turnId: "child-turn" });
    assert.deepEqual(order, [
      "record:turn",
      "interrupt:turn",
      "record:turn",
      "interrupt:turn",
      "record:child-turn",
      "interrupt:child-turn",
    ]);
  }).pipe(Effect.scoped),
);
