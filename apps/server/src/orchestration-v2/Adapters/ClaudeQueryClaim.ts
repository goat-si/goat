import * as Ref from "effect/Ref";

export function claimClaudeQuery<
  T,
  Q extends { query: unknown; stopping: boolean; lastTurn: T | null },
>(ref: Ref.Ref<Q | null>, session: Q, turn: T) {
  return Ref.modify(ref, (current) => {
    if (current?.query !== session.query || session.stopping) return [false, current];
    session.lastTurn = turn;
    return [true, current];
  });
}
