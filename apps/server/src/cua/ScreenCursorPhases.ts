import type { AgentCursorEvent, AgentCursorOwner, ScreenTargetRef } from "@goat/contracts";
import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";

type CallKey = number | string;
type Owner = Omit<AgentCursorOwner, "sequence">;
type Sink = (event: AgentCursorEvent) => void;
type State = {
  owner: Owner;
  refGeneration: number;
  sequence: number;
  pending: Map<CallKey, number>;
  ended: boolean;
};

/** Host-owned phase port. A guest can request a host call but cannot publish cursor state. */
export class ScreenCursorPhases {
  private readonly targets = new Map<string, State>();
  private readonly terminalGenerations = new Map<string, number>();
  private readonly turnGenerations = new Map<string, { targetId: string; generation: number }>();
  private readonly publish: Sink;

  constructor(publish: Sink) {
    this.publish = publish;
  }

  private key(ref: ScreenTargetRef) {
    return `${ref.environmentId}\u0000${ref.runId}\u0000${ref.turnId}\u0000${ref.id}`;
  }

  private turnKey(ref: ScreenTargetRef) {
    return `${ref.environmentId}\u0000${ref.runId}\u0000${ref.turnId}\u0000${ref.kind}`;
  }

  private state(ref: ScreenTargetRef): State {
    const key = this.key(ref);
    let state = this.targets.get(key);
    if (state === undefined && (this.terminalGenerations.get(key) ?? -1) >= ref.generation)
      return {
        owner: {
          environmentId: EnvironmentId.make(ref.environmentId),
          runId: ref.runId,
          turnId: ref.turnId,
          targetId: ref.id,
          generation: ref.generation,
        },
        refGeneration: ref.generation,
        sequence: 0,
        pending: new Map(),
        ended: true,
      };
    if (state !== undefined && state.refGeneration > ref.generation) return state;
    if (!state || state.refGeneration !== ref.generation) {
      state = {
        owner: {
          environmentId: EnvironmentId.make(ref.environmentId),
          runId: ref.runId,
          turnId: ref.turnId,
          targetId: ref.id,
          generation: ref.generation,
        },
        refGeneration: ref.generation,
        sequence: 0,
        pending: new Map(),
        ended: false,
      };
      this.targets.set(key, state);
    }
    return state;
  }

  /** The cursor generation captured for a call on this target ref, including after an A -> B -> A switch. */
  generationOf(ref: ScreenTargetRef, callId?: CallKey): number {
    const state = this.targets.get(this.key(ref));
    if (!state || state.ended || state.refGeneration !== ref.generation) return ref.generation;
    return (callId !== undefined ? state.pending.get(callId) : undefined) ?? state.owner.generation;
  }

  hostCallStarted(ref: ScreenTargetRef, callId: CallKey) {
    const state = this.state(ref);
    if (state.ended || state.refGeneration !== ref.generation || state.pending.has(callId)) return;
    const tKey = this.turnKey(ref);
    const active = this.turnGenerations.get(tKey);
    if (active && active.targetId !== ref.id && state.owner.generation <= active.generation) {
      state.owner = { ...state.owner, generation: active.generation + 1 };
      state.sequence = 0;
    }
    this.turnGenerations.set(tKey, {
      targetId: ref.id,
      generation: Math.max(active?.generation ?? 0, state.owner.generation),
    });
    state.pending.set(callId, state.owner.generation);
    this.publish({
      op: "show",
      identity: { ...state.owner, sequence: ++state.sequence },
      phase: "thinking",
    });
  }

  hostCallSettled(ref: ScreenTargetRef, callId: CallKey) {
    const state = this.targets.get(this.key(ref));
    if (!state || state.ended || state.refGeneration !== ref.generation) return;
    const callGeneration = state.pending.get(callId);
    if (callGeneration === undefined || !state.pending.delete(callId)) return;
    if (callGeneration !== state.owner.generation) return;
    for (const pendingGeneration of state.pending.values())
      if (pendingGeneration === state.owner.generation) return;
    // Keep "resting" as the shipped six-phase wire name while clients and the helper consume it.
    this.publish({
      op: "show",
      identity: { ...state.owner, sequence: ++state.sequence },
      phase: "resting",
    });
  }

  track<A, E, R>(ref: ScreenTargetRef, callId: CallKey, effect: Effect.Effect<A, E, R>) {
    return Effect.sync(() => this.hostCallStarted(ref, callId)).pipe(
      Effect.andThen(effect),
      Effect.ensuring(Effect.sync(() => this.hostCallSettled(ref, callId))),
    );
  }

  /** Settles a finished or failed cell's in-flight calls to resting without hiding the target. */
  endCell(ref: ScreenTargetRef, cellId: string) {
    const state = this.targets.get(this.key(ref));
    if (!state || state.ended || state.refGeneration !== ref.generation) return;
    const prefix = `${cellId}\u0000`;
    let removedCurrent = false;
    for (const [call, callGeneration] of state.pending) {
      if (typeof call === "string" && call.startsWith(prefix)) {
        state.pending.delete(call);
        if (callGeneration === state.owner.generation) removedCurrent = true;
      }
    }
    if (!removedCurrent) return;
    for (const pendingGeneration of state.pending.values())
      if (pendingGeneration === state.owner.generation) return;
    this.publish({
      op: "show",
      identity: { ...state.owner, sequence: ++state.sequence },
      phase: "resting",
    });
  }

  ended(ref: ScreenTargetRef, reason: "ended" | "private" | "takeover" = "ended") {
    const key = this.key(ref);
    const state = this.targets.get(key);
    if (!state || state.ended || state.refGeneration !== ref.generation) return;
    state.ended = true;
    state.pending.clear();
    this.publish({
      op: "hide",
      identity: { ...state.owner, sequence: ++state.sequence },
      phase: reason === "takeover" ? "yielded" : "hidden",
      reason,
    });
    this.targets.delete(key);
    this.terminalGenerations.set(key, ref.generation);
  }

  finishTurn(runId: string, turnId: string) {
    const suffix = `\u0000${runId}\u0000${turnId}\u0000`;
    for (const key of this.targets.keys()) if (key.includes(suffix)) this.targets.delete(key);
    for (const key of this.terminalGenerations.keys())
      if (key.includes(suffix)) this.terminalGenerations.delete(key);
    for (const key of this.turnGenerations.keys())
      if (key.includes(suffix)) this.turnGenerations.delete(key);
  }
}
