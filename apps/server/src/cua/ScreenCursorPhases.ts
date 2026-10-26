import type {
  ComputerUseCursorEvent,
  ComputerUseCursorIdentity,
  ScreenTargetRef,
} from "@goat/contracts";
import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";

type Owner = Omit<ComputerUseCursorIdentity, "sequence">;
type Sink = (event: ComputerUseCursorEvent) => void;
type State = { owner: Owner; sequence: number; pending: Set<number>; ended: boolean };

/** Host-owned phase port. A guest can request a host call but cannot publish cursor state. */
export class ScreenCursorPhases {
  private readonly targets = new Map<string, State>();
  private readonly publish: Sink;

  constructor(publish: Sink) { this.publish = publish; }

  private key(ref: ScreenTargetRef) {
    return `${ref.environmentId}\u0000${ref.runId}\u0000${ref.turnId}\u0000${ref.id}`;
  }

  private state(ref: ScreenTargetRef): State {
    const key = this.key(ref);
    let state = this.targets.get(key);
    if (state !== undefined && state.owner.generation > ref.generation) return state;
    if (!state || state.owner.generation !== ref.generation) {
      state = {
        owner: {
          environmentId: EnvironmentId.make(ref.environmentId),
          runId: ref.runId,
          turnId: ref.turnId,
          targetId: ref.id,
          generation: ref.generation,
        },
        sequence: 0,
        pending: new Set(),
        ended: false,
      };
      this.targets.set(key, state);
    }
    return state;
  }

  hostCallStarted(ref: ScreenTargetRef, callId: number) {
    const state = this.state(ref);
    if (state.ended || state.owner.generation !== ref.generation || state.pending.has(callId)) return;
    state.pending.add(callId);
    this.publish({
      op: "show",
      identity: { ...state.owner, sequence: ++state.sequence },
      phase: "thinking",
    });
  }

  hostCallSettled(ref: ScreenTargetRef, callId: number) {
    const state = this.targets.get(this.key(ref));
    if (!state || state.ended || state.owner.generation !== ref.generation) return;
    if (!state.pending.delete(callId) || state.pending.size > 0) return;
    this.publish({
      op: "show",
      identity: { ...state.owner, sequence: ++state.sequence },
      phase: "resting",
    });
  }

  track<A, E, R>(ref: ScreenTargetRef, callId: number, effect: Effect.Effect<A, E, R>) {
    return Effect.sync(() => this.hostCallStarted(ref, callId)).pipe(
      Effect.andThen(effect),
      Effect.ensuring(Effect.sync(() => this.hostCallSettled(ref, callId))),
    );
  }

  ended(ref: ScreenTargetRef, reason: "ended" | "private" | "takeover" = "ended") {
    const state = this.targets.get(this.key(ref));
    if (!state || state.ended || state.owner.generation !== ref.generation) return;
    state.ended = true;
    state.pending.clear();
    this.publish({
      op: "hide",
      identity: { ...state.owner, sequence: ++state.sequence },
      phase: reason === "takeover" ? "yielded" : "hidden",
      reason,
    });
  }
}
