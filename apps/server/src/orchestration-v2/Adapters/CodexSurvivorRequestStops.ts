import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as CodexClient from "effect-codex-app-server/client";
import type { CodexInstanceRecordKey, CodexStopObligation } from "../../provider/CodexSurvivors.ts";
import type { SurvivorEntry, SurvivorWaiting } from "./CodexSurvivorFenceMaintenance.ts";

export type SurvivorStopTarget = CodexInstanceRecordKey & CodexStopObligation;
export type SurvivorRequestStops = {
  readonly pending: Map<string, SurvivorStopTarget>;
  readonly done: Set<string>;
  running: boolean;
};

export const makeSurvivorRequestStops = (): SurvivorRequestStops => ({
  pending: new Map(),
  done: new Set(),
  running: false,
});

const MAX_STOP_TARGETS = 64;
const ROOT = "";

/**
 * Queues the stop of a turn whose request was refused. Replays of one turn share a pending slot and
 * one fiber per survivor sends the stops, so a stalled interrupt holds no growing set of waiters.
 */
export const queueSurvivorStop = (input: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly scope: Scope.Scope;
  readonly waiting: SurvivorWaiting;
  readonly entry: SurvivorEntry;
  readonly target: SurvivorStopTarget;
}) =>
  Effect.suspend(() => {
    const { entry, target } = input;
    const { stops } = entry;
    const key =
      target.nativeThreadId === entry.binding.nativeThreadId
        ? ROOT
        : `${target.nativeThreadId}\u0000${target.nativeTurnId}`;
    if (key === ROOT ? entry.interruptSent : stops.done.has(key)) return Effect.void;
    if (!stops.pending.has(key)) {
      // Past the bound, stopping the survivor's own turn stands in for its descendants.
      if (stops.pending.size + stops.done.size < MAX_STOP_TARGETS) stops.pending.set(key, target);
      else if (!entry.interruptSent) stops.pending.set(ROOT, entry.binding);
    }
    if (stops.running) return Effect.void;
    stops.running = true;
    return drainSurvivorStops(input).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          stops.running = false;
        }),
      ),
      Effect.forkIn(input.scope, { startImmediately: true }),
      Effect.asVoid,
    );
  });

const drainSurvivorStops = Effect.fn("CodexSurvivorRequestStops.drain")(function* (input: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly waiting: SurvivorWaiting;
  readonly entry: SurvivorEntry;
}) {
  const { client, entry } = input;
  const { stops } = entry;
  while (true) {
    const next = yield* Effect.sync(() => {
      const first = stops.pending.entries().next();
      if (first.done === true) {
        stops.running = false;
        return undefined;
      }
      stops.pending.delete(first.value[0]);
      return first.value;
    });
    if (next === undefined) return;
    const [key, target] = next;
    yield* entry.gate
      .withPermits(1)(
        Effect.gen(function* () {
          if (input.waiting.get(entry.binding.nativeThreadId) !== entry) return;
          if (key === ROOT && entry.interruptSent) return;
          // The stop is durable before the interrupt; a failed write leaves the turn running.
          yield* entry.service.recordStopObligation(target, target);
          if (key === ROOT) entry.stopRecorded = true;
          yield* client.request("turn/interrupt", {
            threadId: target.nativeThreadId,
            turnId: target.nativeTurnId,
          });
          if (key === ROOT) entry.interruptSent = true;
          else stops.done.add(key);
        }),
      )
      .pipe(
        Effect.catch((cause) => Effect.logWarning("Failed to stop a survivor request", { cause })),
      );
  }
});
