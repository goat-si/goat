import type { ComputerUseHumanInputSource } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makeAgentInputLog } from "./agentInputLog.ts";

export interface LeaseProxyInputOptions {
  /**
   * Tells the server of a keyboard or pointer event outside this agent's own input calls; the
   * server drops it if another agent's input covers it, else pauses every agent. True when the
   * server took it; until then each later event is offered again.
   */
  readonly onHumanInput?: (input: {
    readonly source: ComputerUseHumanInputSource;
    readonly at: number;
  }) => Effect.Effect<boolean>;
  /**
   * Tells the server one of this agent's calls that can post input started or ended, so another
   * agent's helper seeing that input is not taken for a person. Best effort, never awaited.
   */
  readonly onAgentInput?: (report: {
    readonly call: string;
    readonly state: "start" | "end";
    readonly at: number;
  }) => Effect.Effect<unknown>;
}

export const makeLeaseProxyInput = Effect.fn("ComputerUseLeaseProxy.makeInput")(function* (
  options: LeaseProxyInputOptions,
) {
  const scope = yield* Effect.scope;
  const log = makeAgentInputLog();
  const tell = (call: string, state: "start" | "end", at: number) =>
    options.onAgentInput === undefined
      ? Effect.void
      : options.onAgentInput({ call, state, at }).pipe(Effect.ignoreCause, Effect.forkIn(scope));
  return {
    started: Effect.fn("ComputerUseLeaseProxy.inputStarted")(function* (key: string) {
      const at = yield* Clock.currentTimeMillis;
      log.prune(at);
      log.started(key, at);
      yield* tell(key, "start", at);
    }),
    ended: Effect.fn("ComputerUseLeaseProxy.inputEnded")(function* (key: string) {
      const at = yield* Clock.currentTimeMillis;
      if (log.ended(key, at)) yield* tell(key, "end", at);
    }),
    cutoff: Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      for (const key of log.endAll(at)) yield* tell(key, "end", at);
    }),
    watch: Effect.fn("ComputerUseLeaseProxy.watchInput")(function* (
      input:
        | Stream.Stream<{ readonly source: ComputerUseHumanInputSource; readonly at: number }>
        | undefined,
      child: Scope.Scope,
      active: () => boolean,
    ) {
      if (input === undefined || options.onHumanInput === undefined) return;
      const report = options.onHumanInput;
      // Once the server took one, this child is done: the pause that follows stops it.
      let told = false;
      yield* input.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (told || !active() || log.isAgents(event.at)) return;
            told = yield* report(event);
          }),
        ),
        Effect.forkIn(child),
      );
    }),
  };
});
