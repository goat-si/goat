import { isGoatBotSessionThreadId, OrchestratorMcpFailure } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SessionReceiptGate from "../orchestration-v2/goat/SessionReceiptGate.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const refused = () =>
  new OrchestratorMcpFailure({
    code: "provider_unavailable",
    reason: "session_receipt_pending",
    message:
      "The session receipt has not settled or this run no longer owns its task. No action was reserved or started; retry after the receipt settles.",
    mayHaveStarted: false,
  });

export class ChannelSessionReceiptGate extends Context.Service<
  ChannelSessionReceiptGate,
  {
    readonly require: (
      caller: McpInvocationContext.McpThreadCaller,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
  }
>()("goat/mcp/ChannelSessionReceiptGate") {}

export const requireSessionReceipt = Effect.fn("ChannelSessionReceiptGate.requireSessionReceipt")(
  function* () {
    const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
    const caller = Option.getOrUndefined(scope)?.thread;
    if (caller === undefined || !isGoatBotSessionThreadId(caller.threadId)) return;
    const gate = yield* Effect.serviceOption(ChannelSessionReceiptGate);
    if (Option.isNone(gate)) return yield* refused();
    yield* gate.value.require(caller);
    if (Option.isSome(scope) && scope.value.reauthorize !== undefined)
      yield* scope.value.reauthorize([]).pipe(Effect.mapError(() => refused()));
  },
);

export const layer = Layer.effect(
  ChannelSessionReceiptGate,
  Effect.gen(function* () {
    const gate = yield* SessionReceiptGate.SessionReceiptGate;
    return ChannelSessionReceiptGate.of({
      require: Effect.fn("ChannelSessionReceiptGate.require")(function* (caller) {
        if (caller.runId === undefined) return yield* refused();
        const runId = caller.runId;
        const ready = Effect.gen(function* () {
          const state = yield* gate.inspect(caller.threadId, runId);
          if (
            state.state === "invalid" ||
            state.state === "absent" ||
            (state.status !== "running" && state.status !== "waiting")
          )
            return yield* refused();
          return state.state === "settled";
        });
        const waited = yield* Effect.scoped(
          Effect.gen(function* () {
            const changes = yield* gate.subscribe;
            const awaitReady: Effect.Effect<void, OrchestratorMcpFailure> = Effect.suspend(() =>
              ready.pipe(
                Effect.flatMap((settled) =>
                  settled ? Effect.void : changes.pipe(Effect.andThen(awaitReady)),
                ),
              ),
            );
            yield* awaitReady;
          }),
        ).pipe(Effect.timeoutOption("10 seconds"));
        if (Option.isNone(waited) || !(yield* ready)) return yield* refused();
      }),
    });
  }),
).pipe(Layer.provideMerge(SessionReceiptGate.layer));
