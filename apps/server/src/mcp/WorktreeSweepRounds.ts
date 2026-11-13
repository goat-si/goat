import type { OrchestratorMcpFailure, WorktreeMcpCleanupResult } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

// Removing sweeps of one scope, running or waiting, as ThreadForkWorkspace caps callers of one fork.
const MAX_REMOVING_SWEEPS_PER_SCOPE = 4;
// Repo scopes whose rounds are kept; an evicted idle scope only restarts its round on its next call.
const MAX_SWEEP_ROUNDS = 64;

/**
 * One repo scope's cleanup round: when each worktree's check last started (least recent goes
 * first), the worktrees decided since remaining last reached 0 (a repeat skips counting them, so it
 * ends), and the worktrees the last removing sweep listed, for a sweep left without budget.
 */
export interface SweepRound {
  readonly lastStart: Map<string, number>;
  readonly decided: Set<string>;
  readonly sweeping: Semaphore.Semaphore;
  removingSweeps: number;
  listed: ReadonlyArray<string> | undefined;
}

/**
 * Rounds by repo scope, least recently used first. Past the cap the oldest idle rounds go; one with
 * a sweep running or waiting stays, so only scopes with a call in flight can exceed it.
 */
export const makeSweepRounds = (maxRounds = MAX_SWEEP_ROUNDS) => {
  const rounds = new Map<string, SweepRound>();
  return (key: string): SweepRound => {
    const round: SweepRound = rounds.get(key) ?? {
      lastStart: new Map(),
      decided: new Set(),
      sweeping: Semaphore.makeUnsafe(1),
      removingSweeps: 0,
      listed: undefined,
    };
    rounds.delete(key);
    rounds.set(key, round);
    for (const [other, entry] of rounds) {
      if (rounds.size <= maxRounds) break;
      if (other !== key && entry.removingSweeps === 0) rounds.delete(other);
    }
    return round;
  };
};

// A fresh scan could run past the remote bound, so this counts the last sweep's list instead.
const pastBudget = (round: SweepRound, listed: ReadonlyArray<string>): WorktreeMcpCleanupResult => {
  const remaining = listed.filter((path) => !round.decided.has(path)).length;
  if (remaining === 0) round.decided.clear();
  return { dryRun: false, removed: [], kept: [], remaining };
};

type Sweep = (waited: boolean) => Effect.Effect<WorktreeMcpCleanupResult, OrchestratorMcpFailure>;

// Removing sweeps of a scope share its round, so they take turns; the wait counts against the budget.
const turn = (round: SweepRound, deadline: number, sweep: Sweep) =>
  Semaphore.withPermitsIfAvailable(round.sweeping, 1, sweep(false)).pipe(
    Effect.flatMap((now) =>
      Option.isSome(now)
        ? Effect.succeed(now.value)
        : round.sweeping.withPermits(1)(
            Effect.gen(function* () {
              const listed = round.listed;
              if (listed !== undefined && (yield* Clock.currentTimeMillis) >= deadline)
                return pastBudget(round, listed);
              return yield* sweep(true);
            }),
          ),
    ),
  );

/** Runs a removing sweep in its round's turn; none when the round admits no more sweeps. */
export const takeRemovingTurn = (round: SweepRound, deadline: number, sweep: Sweep) =>
  Effect.suspend(() => {
    if (round.removingSweeps >= MAX_REMOVING_SWEEPS_PER_SCOPE)
      return Effect.succeed(Option.none<WorktreeMcpCleanupResult>());
    round.removingSweeps++;
    return turn(round, deadline, sweep).pipe(
      Effect.asSome,
      Effect.ensuring(Effect.sync(() => void round.removingSweeps--)),
    );
  });
