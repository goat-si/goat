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
import * as CodexSurvivors from "../../provider/CodexSurvivors.ts";
import * as CodexAdapter from "./CodexAdapterV2.ts";
import * as Survivor from "./CodexSurvivorContinuation.ts";

it.effect("replayed approval receives a protocol error and fences the native turn", () =>
  Effect.gen(function* () {
    const incoming = yield* Queue.unbounded<string, Cause.Done<void>>();
    const outgoing = yield* Queue.unbounded<string>();
    const interrupted = yield* Deferred.make<void>();
    const order: string[] = [];
    const binding = {
      instanceId: CodexAdapter.CODEX_DEFAULT_INSTANCE_ID,
      recordName: "instance",
      threadId: ThreadId.make("thread"),
      sourceRunId: RunId.make("run"),
      nativeThreadId: "native",
      nativeTurnId: "turn",
    };
    const service = CodexSurvivors.CodexSurvivors.of({
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
      recordStopObligation: () =>
        Effect.sync(() => {
          order.push("record");
        }),
      clearStopObligation: () => Effect.void,
      recordGoalBlock: () => Effect.void,
      clearGoalBlock: () => Effect.void,
      hasGoalBlock: () => Effect.succeed(false),
      ensureAdmission: () => Effect.void,
    });
    const context = yield* Layer.build(
      CodexClient.layerMessageChannel({
        incoming: Stream.fromQueue(incoming),
        send: (message) => Queue.offer(outgoing, message).pipe(Effect.asVoid),
        closed: Effect.never,
      }),
    );
    const real = Context.get(context, CodexClient.CodexAppServerClient);
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
    yield* Queue.offer(
      incoming,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "item/tool/requestUserInput",
        params: { threadId: "native", turnId: "turn", itemId: "item", questions: [] },
      }),
    );
    const response: { error?: { message: string } } = JSON.parse(yield* Queue.take(outgoing));
    assert.isDefined(response.error);
    yield* Deferred.await(interrupted);
    assert.deepEqual(order, ["record", "interrupt"]);
  }).pipe(Effect.scoped),
);
