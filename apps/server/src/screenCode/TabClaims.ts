import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
}
export interface CleanupOutcome {
  readonly tabId: string;
  readonly status: "closed" | "kept" | "released" | "failed";
}
const keyOf = (claim: Pick<TabIdentity, "environmentId" | "browserInstanceId" | "tabId">) =>
  `${claim.environmentId}\u0000${claim.browserInstanceId}\u0000${claim.tabId}`;
const turnOf = (claim: Pick<TabIdentity, "runId" | "turnId">) =>
  `${claim.runId}\u0000${claim.turnId}`;

export class TabClaims extends Context.Service<TabClaims, {
  readonly claimUserTab: (input: TabIdentity & { readonly owner: "unclaimed" | "agent" | "human"; readonly ownedByCaller: boolean }) => Effect.Effect<TabClaim, TabClaimError>;
  readonly recordOpened: (input: TabIdentity) => Effect.Effect<TabClaim, TabClaimError>;
  readonly assertCurrent: (input: TabIdentity) => Effect.Effect<TabClaim, TabClaimError>;
  readonly keep: (input: TabIdentity, reason: "deliverable" | "handoff") => Effect.Effect<void, TabClaimError>;
  readonly releaseClaim: (input: TabIdentity) => Effect.Effect<void, TabClaimError>;
  readonly captureCleanup: (identity: Pick<TabIdentity, "runId" | "turnId">) => Effect.Effect<CleanupAuthority>;
  readonly releaseTurn: (identity: Pick<TabIdentity, "runId" | "turnId">, authority: CleanupAuthority) => Effect.Effect<readonly CleanupOutcome[]>;
}>()("goat/screenCode/TabClaims") {}

export const makeTabClaims = (close: (tab: TabClaim) => Effect.Effect<void>) => Effect.gen(function* () {
  const claims = yield* SynchronizedRef.make(new Map<string, TabClaim>());
  const consumed = yield* SynchronizedRef.make(new Set<string>());
  const fencedTurns = new Set<string>();
  let epoch = 0;
  const claim = (input: TabIdentity, provenance: TabClaim["provenance"]) =>
    SynchronizedRef.modify(claims, (current) => {
      const key = keyOf(input);
      if (fencedTurns.has(turnOf(input))) return [{ code: "stale" } satisfies TabClaimError, current] as
        readonly [TabClaim | TabClaimError, Map<string, TabClaim>];
      const existing = current.get(key);
      if (existing) return [{ code: "conflict" } satisfies TabClaimError, current] as
        readonly [TabClaim | TabClaimError, Map<string, TabClaim>];
      const next = new Map(current);
      const value: TabClaim = { ...input, claimEpoch: ++epoch, provenance };
      next.set(key, value);
      return [value, next] as readonly [TabClaim | TabClaimError, Map<string, TabClaim>];
    }).pipe(Effect.flatMap((result) => "code" in result
      ? Effect.fail(result as TabClaimError) : Effect.succeed(result as TabClaim)));
  const current = (input: TabIdentity) => SynchronizedRef.get(claims).pipe(
    Effect.flatMap((all) => {
      const found = all.get(keyOf(input));
      return found && found.runId === input.runId && found.turnId === input.turnId &&
        found.threadId === input.threadId && found.connectionId === input.connectionId &&
        found.controlGeneration === input.controlGeneration
        ? Effect.succeed(found) : Effect.fail({ code: "stale" } as const);
    }),
  );
  return TabClaims.of({
    claimUserTab: (input) => {
      if (input.owner === "human" || (input.owner === "agent" && !input.ownedByCaller))
        return Effect.fail({ code: "unavailable" } as const);
      return claim(input, input.owner === "agent" ? "existing-agent" : "user-claimed");
    },
    recordOpened: (input) => claim(input, "agent-created"),
    assertCurrent: current,
    keep: (input, reason) => current(input).pipe(Effect.flatMap(() => SynchronizedRef.update(claims, (all) => {
      const next = new Map(all);
      const found = next.get(keyOf(input));
      if (found) next.set(keyOf(input), { ...found, keepReason: reason });
      return next;
    }))),
    releaseClaim: (input) => current(input).pipe(Effect.flatMap(() => SynchronizedRef.update(claims, (all) => {
      const next = new Map(all); next.delete(keyOf(input)); return next;
    }))),
    captureCleanup: (identity) => SynchronizedRef.modify(claims, (all) => {
      fencedTurns.add(turnOf(identity));
      return [{ ...identity, epoch: ++epoch,
        tabs: [...all.values()].filter((tab) => turnOf(tab) === turnOf(identity)) }, all] as const;
    }),
    releaseTurn: (identity, authority) => Effect.gen(function* () {
      if (authority.runId !== identity.runId || authority.turnId !== identity.turnId) return [];
      const token = `${turnOf(identity)}\u0000${authority.epoch}`;
      const fresh = yield* SynchronizedRef.modify(consumed, (all) => {
        if (all.has(token)) return [false, all] as const;
        const next = new Set(all); next.add(token);
        return [true, next] as const;
      });
      if (!fresh) return [];
      const outcomes: CleanupOutcome[] = [];
      for (const tab of authority.tabs) {
        const found = yield* SynchronizedRef.modify(claims, (all) => {
          const live = all.get(keyOf(tab));
          if (!live || live.claimEpoch !== tab.claimEpoch) return [undefined, all] as const;
          const next = new Map(all); next.delete(keyOf(tab));
          return [live, next] as const;
        });
        if (!found) continue;
        if (found.provenance !== "agent-created") {
          outcomes.push({ tabId: found.tabId, status: "released" });
        } else if (found.keepReason) {
          outcomes.push({ tabId: found.tabId, status: "kept" });
        } else {
          const result = yield* close(found).pipe(Effect.result);
          outcomes.push({ tabId: found.tabId, status: result._tag === "Success" ? "closed" : "failed" });
        }
      }
      return outcomes;
    }),
  });
});

export const layer = (close: (tab: TabClaim) => Effect.Effect<void>) =>
  Layer.effect(TabClaims, makeTabClaims(close));
