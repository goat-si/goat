import {
  BrowserOrigin,
  type BrowserOriginGrant,
  type EnvironmentId,
  type LiveTabClaim,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { manifestApplied } from "../cua/ComputerUseLeaseProxyBrowserClaims.ts";

export interface Request {
  readonly threadId: ThreadId;
  readonly pid: number;
  readonly windowId: number;
  readonly origin: string;
  readonly windowTitle: string;
}

interface Pending extends Request {
  readonly claimId: string;
  granted: boolean;
}

export interface Union {
  readonly existingProfiles: ReadonlyArray<{ readonly pid: number; readonly windowId: number }>;
  readonly origins: ReadonlyArray<string>;
}

interface Dependencies {
  readonly environmentId: EnvironmentId;
  readonly supported: () => boolean;
  readonly bindAvailable?: () => boolean;
  readonly publish: (union: Union) => Effect.Effect<string, Error>;
  readonly confirm: (sha256: string) => Effect.Effect<unknown, Error>;
  readonly bind: (input: Request) => Effect.Effect<
    {
      readonly tabId: string;
      readonly title: string;
      readonly url: string;
      readonly driverGeneration: number;
    },
    Error
  >;
}

class BrowserManifestNotApplied extends Schema.TaggedError<BrowserManifestNotApplied>()(
  "BrowserManifestNotApplied",
  {},
) {}

const decline = {
  status: "refused",
  code: "declined",
  message: "The person did not approve this request.",
} as const;
const unavailable = {
  status: "refused",
  code: "unavailable",
  message: "Needs a newer GOAT Computer Use.",
} as const;
const invalidOrigin = {
  status: "refused",
  code: "invalid_origin",
  message: "Expected a canonical HTTP origin.",
} as const;
const isOrigin = Schema.is(BrowserOrigin);
const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

export const makeBrowserOriginGrants = Effect.fn("BrowserOriginGrants.make")(function* (
  deps: Dependencies,
) {
  const lock = yield* Semaphore.make(1);
  const writeLock = yield* Semaphore.make(1);
  const version = yield* SubscriptionRef.make(0);
  const confirm = Effect.fn("BrowserOriginGrants.confirmManifest")(function* (sha: string) {
    if (!manifestApplied(yield* deps.confirm(sha), sha))
      return yield* new BrowserManifestNotApplied();
  });
  const write = (value: Union) =>
    writeLock.withPermits(1)(
      SubscriptionRef.update(version, (current) => current + 1).pipe(
        Effect.andThen(deps.publish(value)),
      ),
    );
  const publish = Effect.fn("BrowserOriginGrants.publishExpansion")(function* (value: Union) {
    yield* confirm(yield* write(value));
  });
  const shrink = Effect.fn("BrowserOriginGrants.publishShrink")(function* (value: Union) {
    const sha = yield* write(value);
    yield* confirm(sha).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Browser manifest shrink confirmation failed", { cause }),
      ),
      Effect.forkDetach({ startImmediately: true }),
    );
  });
  const pending = new Map<string, Pending>();
  const claims = new Map<string, LiveTabClaim>();
  const grants = new Map<string, BrowserOriginGrant>();
  const uncommittedGrants = new Set<string>();
  const ended = new Map<
    string,
    { readonly threadId: ThreadId; readonly reason: "origin_changed" | "driver_restarted" }
  >();
  let sequence = 0;
  let driverEpoch = 0;
  let restartSignal = yield* Deferred.make<void>();
  const untilRestart = Effect.fn("BrowserOriginGrants.untilRestart")(function* <A, E>(
    effect: Effect.Effect<A, E>,
    signal: Deferred.Deferred<void>,
  ) {
    const task = yield* effect.pipe(Effect.forkDetach({ startImmediately: true }));
    return yield* Effect.raceFirst(
      Fiber.join(task).pipe(Effect.asSome),
      Deferred.await(signal).pipe(Effect.as(Option.none<A>())),
    );
  });
  const key = (threadId: ThreadId, origin: string) => JSON.stringify([threadId, origin]);
  const union = (): Union => {
    const live = [...claims.values()].map((claim) => ({
      threadId: claim.threadId,
      pid: claim.tab.pid,
      windowId: claim.tab.windowId,
    }));
    live.push(
      ...[...pending.values()]
        .filter((entry) => entry.granted)
        .map((entry) => ({ threadId: entry.threadId, pid: entry.pid, windowId: entry.windowId })),
    );
    const pairs = new Map(
      live.map(({ pid, windowId }) => [JSON.stringify([pid, windowId]), { pid, windowId }]),
    );
    const threads = new Set(live.map((entry) => entry.threadId));
    return {
      existingProfiles: [...pairs.values()],
      origins: [
        ...new Set(
          [...grants.values()]
            .filter((grant) => threads.has(grant.threadId))
            .map((grant) => grant.origin),
        ),
      ],
    };
  };
  const request = Effect.fn("BrowserOriginGrants.request")((input: Request) =>
    lock.withPermits(1)(
      Effect.sync(() => {
        if (!deps.supported()) return unavailable;
        if (!isOrigin(input.origin)) return invalidOrigin;
        const claimId = `browser-claim:${++sequence}`;
        pending.set(claimId, { ...input, claimId, granted: false });
        return { status: "pending" as const, claimId };
      }),
    ),
  );
  const answer = Effect.fn("BrowserOriginGrants.answer")((claimId: string, approved: boolean) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const entry = pending.get(claimId);
        if (entry === undefined || !approved || !deps.supported()) {
          pending.delete(claimId);
          return { agentResult: decline };
        }
        if (deps.bindAvailable?.() === false) {
          pending.delete(claimId);
          return { agentResult: unavailable };
        }
        const epoch = driverEpoch;
        const signal = restartSignal;
        const grantKey = key(entry.threadId, entry.origin);
        const existed = grants.has(grantKey);
        if (!existed) uncommittedGrants.add(grantKey);
        grants.set(grantKey, {
          environmentId: deps.environmentId,
          threadId: entry.threadId,
          origin: entry.origin,
        });
        entry.granted = true;
        const rollback = Effect.gen(function* () {
          pending.delete(claimId);
          claims.delete(claimId);
          if (!existed) {
            grants.delete(grantKey);
            uncommittedGrants.delete(grantKey);
          }
          yield* shrink(union());
        });
        const result = yield* Effect.gen(function* () {
          const applied = yield* untilRestart(publish(union()), signal);
          if (Option.isNone(applied)) return { agentResult: decline };
          if (epoch !== driverEpoch) return { agentResult: decline };
          if (!deps.supported()) return yield* rollback.pipe(Effect.as({ agentResult: decline }));
          const bound = yield* untilRestart(deps.bind(entry), signal);
          if (Option.isNone(bound)) return { agentResult: decline };
          const tab = bound.value;
          if (epoch !== driverEpoch) return { agentResult: decline };
          if (!deps.supported()) return yield* rollback.pipe(Effect.as({ agentResult: decline }));
          if (originOf(tab.url) !== entry.origin) {
            yield* rollback;
            return { agentResult: decline, personMessage: `This tab is not on ${entry.origin}` };
          }
          const claim: LiveTabClaim = {
            claimId,
            environmentId: deps.environmentId,
            threadId: entry.threadId,
            tab: { pid: entry.pid, windowId: entry.windowId, tabId: tab.tabId },
            title: tab.title,
            origin: entry.origin,
            driverGeneration: tab.driverGeneration,
            claimGeneration: ++sequence,
            status: "attached",
          };
          uncommittedGrants.delete(grantKey);
          claims.set(claimId, claim);
          pending.delete(claimId);
          yield* SubscriptionRef.update(version, (current) => current + 1);
          if (epoch !== driverEpoch) return { agentResult: decline };
          return { agentResult: { status: "attached" as const, claim } };
        }).pipe(
          Effect.catch(() =>
            epoch !== driverEpoch
              ? Effect.succeed({ agentResult: decline })
              : rollback.pipe(Effect.as({ agentResult: decline })),
          ),
        );
        return result;
      }),
    ),
  );
  const list = Effect.fn("BrowserOriginGrants.list")((threadId: ThreadId) =>
    Effect.sync(() => ({
      claims: [...claims.values()].filter((claim) => claim.threadId === threadId),
      grants: [...grants.values()].filter(
        (grant) =>
          grant.threadId === threadId && !uncommittedGrants.has(key(grant.threadId, grant.origin)),
      ),
    })),
  );
  const revoke = Effect.fn("BrowserOriginGrants.revoke")((threadId: ThreadId, origin: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        grants.delete(key(threadId, origin));
        uncommittedGrants.delete(key(threadId, origin));
        for (const [id, entry] of pending)
          if (entry.threadId === threadId && entry.origin === origin) pending.delete(id);
        for (const [id, claim] of claims)
          if (claim.threadId === threadId && claim.origin === origin) claims.delete(id);
        yield* shrink(union());
      }),
    ),
  );
  const stop = Effect.fn("BrowserOriginGrants.stop")((threadId: ThreadId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        for (const [id, entry] of pending) if (entry.threadId === threadId) pending.delete(id);
        for (const [id, claim] of claims) if (claim.threadId === threadId) claims.delete(id);
        yield* shrink(union());
      }),
    ),
  );
  const end = Effect.fn("BrowserOriginGrants.end")(
    (threadId: ThreadId, claimId: string, generation: number, reason: "origin_changed") =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const claim = claims.get(claimId);
          if (claim?.threadId !== threadId || claim.claimGeneration !== generation) return false;
          claims.delete(claimId);
          ended.set(claimId, { threadId, reason });
          yield* shrink(union());
          return true;
        }),
      ),
  );
  const endReason = Effect.fn("BrowserOriginGrants.endReason")(
    (threadId: ThreadId, claimId: string) =>
      Effect.sync(() => {
        const entry = ended.get(claimId);
        return entry?.threadId === threadId ? entry.reason : undefined;
      }),
  );
  const driverRestarted = Effect.fn("BrowserOriginGrants.driverRestarted")(function* (
    fence: () => void,
  ) {
    const nextSignal = yield* Deferred.make<void>();
    let previousSignal = restartSignal;
    yield* Effect.sync(() => {
      previousSignal = restartSignal;
      restartSignal = nextSignal;
      fence();
      driverEpoch++;
      for (const entry of pending.values()) {
        ended.set(entry.claimId, { threadId: entry.threadId, reason: "driver_restarted" });
        sequence++;
      }
      for (const claim of claims.values()) {
        ended.set(claim.claimId, { threadId: claim.threadId, reason: "driver_restarted" });
        sequence++;
      }
      pending.clear();
      claims.clear();
      uncommittedGrants.clear();
    });
    yield* Deferred.succeed(previousSignal, undefined);
    yield* shrink(union());
  });
  const claimsFor = Effect.fn("BrowserOriginGrants.claimsFor")((threadId: ThreadId) =>
    Effect.sync(() => {
      const origins = [...grants.values()]
        .filter(
          (grant) =>
            grant.threadId === threadId &&
            !uncommittedGrants.has(key(grant.threadId, grant.origin)),
        )
        .map((grant) => grant.origin);
      return [...claims.values()]
        .filter((claim) => claim.threadId === threadId)
        .map((claim) => ({
          claimId: claim.claimId,
          claimGeneration: claim.claimGeneration,
          pid: claim.tab.pid,
          windowId: claim.tab.windowId,
          tabId: claim.tab.tabId,
          origins,
        }));
    }),
  );
  const claimedPids = Effect.fn("BrowserOriginGrants.claimedPids")(() =>
    Effect.sync(() => [...new Set([...claims.values()].map((claim) => claim.tab.pid))]),
  );
  return {
    request,
    answer,
    list,
    revoke,
    stop,
    end,
    endReason,
    driverRestarted,
    claimsFor,
    claimedPids,
    changes: SubscriptionRef.changes(version),
  };
});
