import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";

export interface TabIdentity {
  readonly environmentId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly browserInstanceId: string;
  readonly connectionId: string;
  readonly tabId: string;
  readonly controlGeneration: number;
}
export interface TabClaim extends TabIdentity {
  readonly claimEpoch: number;
  readonly provenance: "user-claimed" | "agent-created" | "existing-agent";
  readonly keepReason?: "deliverable" | "handoff";
}
export interface TabClaimError {
  readonly code: "conflict" | "stale" | "unavailable";
}
export interface CleanupAuthority {
  readonly runId: string;
  readonly turnId: string;
  readonly epoch: number;
  readonly tabs: readonly TabClaim[];
  readonly afterStop: boolean;
}
export interface CleanupOutcome {
  readonly tabId: string;
  readonly status: "closed" | "kept" | "released" | "failed";
}
const keyOf = (claim: Pick<TabIdentity, "environmentId" | "browserInstanceId" | "tabId">) =>
  `${claim.environmentId}\u0000${claim.browserInstanceId}\u0000${claim.tabId}`;
const turnOf = (claim: Pick<TabIdentity, "runId" | "turnId">) =>
  `${claim.runId}\u0000${claim.turnId}`;
// Turn IDs never repeat, and a late claim is bounded by the 660 s open timeout, so the oldest
// turns can be forgotten once this many newer turns have ended.
const TURN_MEMORY = 4096;
const forgetOldest = (turns: Set<string> | Map<string, unknown>) => {
  if (turns.size <= TURN_MEMORY) return;
  const oldest = turns.keys().next().value;
  if (oldest !== undefined) turns.delete(oldest);
};

export class TabClaims extends Context.Service<
  TabClaims,
  {
    readonly acquireTab: (
      input: TabIdentity & {
        readonly owner: "unclaimed" | "agent" | "human";
        readonly ownedByCaller: boolean;
      },
    ) => Effect.Effect<TabClaim, TabClaimError>;
    readonly recordOpened: (input: TabIdentity) => Effect.Effect<TabClaim, TabClaimError>;
    readonly assertCurrent: (input: TabIdentity) => Effect.Effect<TabClaim, TabClaimError>;
    readonly keep: (
      input: TabIdentity,
      reason: "deliverable" | "handoff",
    ) => Effect.Effect<void, TabClaimError>;
    readonly releaseClaim: (input: TabIdentity) => Effect.Effect<void, TabClaimError>;
    readonly suspendClaims: (
      identity: Pick<TabIdentity, "runId" | "turnId">,
      tabId?: string,
    ) => Effect.Effect<void>;
    readonly captureCleanup: (
      identity: Pick<TabIdentity, "runId" | "turnId">,
      options?: { readonly fence?: boolean; readonly tabId?: string; readonly afterStop?: boolean },
    ) => Effect.Effect<CleanupAuthority>;
    readonly releaseTurn: (
      identity: Pick<TabIdentity, "runId" | "turnId">,
      authority: CleanupAuthority,
    ) => Effect.Effect<readonly CleanupOutcome[]>;
  }
>()("goat/screenCode/TabClaims") {}

export const makeTabClaims = Effect.fn("TabClaims.make")(function* (
  close: (tab: TabClaim, afterStop: boolean) => Effect.Effect<void>,
) {
  const claims = yield* SynchronizedRef.make(new Map<string, TabClaim>());
  const deferred = new Map<string, TabClaim[]>();
  // Epochs of each turn's cleanup authorities already released, so none runs twice.
  const consumed = new Map<string, Set<number>>();
  const fencedTurns = new Set<string>();
  const consume = (turn: string, authorityEpoch: number) => {
    let epochs = consumed.get(turn);
    if (!epochs) {
      epochs = new Set();
      consumed.set(turn, epochs);
      forgetOldest(consumed);
    }
    if (epochs.has(authorityEpoch)) return false;
    epochs.add(authorityEpoch);
    return true;
  };
  let epoch = 0;
  const claim = (input: TabIdentity, provenance: TabClaim["provenance"]) =>
    SynchronizedRef.modify(claims, (current) => {
      const key = keyOf(input);
      if (fencedTurns.has(turnOf(input)))
        return [{ code: "stale" } satisfies TabClaimError, current] as readonly [
          TabClaim | TabClaimError,
          Map<string, TabClaim>,
        ];
      const existing = current.get(key);
      if (existing)
        return [{ code: "conflict" } satisfies TabClaimError, current] as readonly [
          TabClaim | TabClaimError,
          Map<string, TabClaim>,
        ];
      const next = new Map(current);
      const value: TabClaim = { ...input, claimEpoch: ++epoch, provenance };
      next.set(key, value);
      return [value, next] as readonly [TabClaim | TabClaimError, Map<string, TabClaim>];
    }).pipe(
      Effect.flatMap((result) =>
        "code" in result
          ? Effect.fail(result as TabClaimError)
          : Effect.succeed(result as TabClaim),
      ),
    );
  const current = (input: TabIdentity) =>
    SynchronizedRef.get(claims).pipe(
      Effect.flatMap((all) => {
        const found = all.get(keyOf(input));
        return found &&
          found.runId === input.runId &&
          found.turnId === input.turnId &&
          found.threadId === input.threadId &&
          found.connectionId === input.connectionId &&
          found.controlGeneration === input.controlGeneration
          ? Effect.succeed(found)
          : Effect.fail({ code: "stale" } as const);
      }),
    );
  return TabClaims.of({
    acquireTab: (input) => {
      if (input.owner === "human" || (input.owner === "agent" && !input.ownedByCaller))
        return Effect.fail({ code: "unavailable" } as const);
      return claim(input, input.owner === "agent" ? "existing-agent" : "user-claimed");
    },
    recordOpened: (input) => claim(input, "agent-created"),
    assertCurrent: current,
    keep: (input, reason) =>
      current(input).pipe(
        Effect.flatMap(() =>
          SynchronizedRef.update(claims, (all) => {
            const next = new Map(all);
            const found = next.get(keyOf(input));
            if (found) next.set(keyOf(input), { ...found, keepReason: reason });
            return next;
          }),
        ),
      ),
    releaseClaim: (input) =>
      current(input).pipe(
        Effect.flatMap(() =>
          SynchronizedRef.update(claims, (all) => {
            const next = new Map(all);
            next.delete(keyOf(input));
            return next;
          }),
        ),
      ),
    suspendClaims: (identity, tabId) =>
      SynchronizedRef.update(claims, (all) => {
        const next = new Map(all);
        for (const [key, claim] of all) {
          if (turnOf(claim) !== turnOf(identity) || (tabId !== undefined && claim.tabId !== tabId))
            continue;
          next.delete(key);
          if (claim.provenance === "agent-created") {
            const pending = deferred.get(turnOf(identity)) ?? [];
            pending.push(claim);
            deferred.set(turnOf(identity), pending);
          }
        }
        return next;
      }),
    captureCleanup: (identity, options) =>
      SynchronizedRef.modify(claims, (all) => {
        if (options?.fence !== false && !fencedTurns.has(turnOf(identity))) {
          fencedTurns.add(turnOf(identity));
          forgetOldest(fencedTurns);
        }
        return [
          {
            ...identity,
            epoch: ++epoch,
            afterStop: options?.afterStop === true,
            tabs: [...(deferred.get(turnOf(identity)) ?? []), ...all.values()].filter(
              (tab) =>
                turnOf(tab) === turnOf(identity) &&
                (options?.tabId === undefined || tab.tabId === options.tabId),
            ),
          },
          all,
        ] as const;
      }),
    releaseTurn: Effect.fn("TabClaims.releaseTurn")(function* (identity, authority) {
      if (authority.runId !== identity.runId || authority.turnId !== identity.turnId) return [];
      const fresh = yield* Effect.sync(() => consume(turnOf(identity), authority.epoch));
      if (!fresh) return [];
      const outcomes: CleanupOutcome[] = [];
      for (const tab of authority.tabs) {
        const found = yield* SynchronizedRef.get(claims).pipe(
          Effect.map((all) => {
            const live = all.get(keyOf(tab));
            return live?.claimEpoch === tab.claimEpoch
              ? live
              : deferred.get(turnOf(tab))?.find((pending) => pending.claimEpoch === tab.claimEpoch);
          }),
        );
        if (!found) continue;
        if (found.provenance !== "agent-created") {
          outcomes.push({ tabId: found.tabId, status: "released" });
        } else if (found.keepReason) {
          outcomes.push({ tabId: found.tabId, status: "kept" });
        } else {
          const result = yield* Effect.exit(close(found, authority.afterStop));
          outcomes.push({
            tabId: found.tabId,
            status: Exit.isSuccess(result) ? "closed" : "failed",
          });
        }
        yield* SynchronizedRef.update(claims, (all) => {
          if (all.get(keyOf(tab))?.claimEpoch !== tab.claimEpoch) return all;
          const next = new Map(all);
          next.delete(keyOf(tab));
          return next;
        });
        const pending = deferred.get(turnOf(tab));
        if (pending) {
          const remaining = pending.filter((claim) => claim.claimEpoch !== tab.claimEpoch);
          if (remaining.length) deferred.set(turnOf(tab), remaining);
          else deferred.delete(turnOf(tab));
        }
      }
      return outcomes;
    }),
  });
});

export const layer = (close: (tab: TabClaim, afterStop: boolean) => Effect.Effect<void>) =>
  Layer.effect(TabClaims, makeTabClaims(close));
