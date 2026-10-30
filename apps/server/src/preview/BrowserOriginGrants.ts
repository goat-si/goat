import {
  BrowserOrigin,
  type BrowserOriginGrant,
  type EnvironmentId,
  type LiveTabClaim,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";

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
  readonly publish: (union: Union) => Effect.Effect<void, Error>;
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
  const version = yield* SubscriptionRef.make(0);
  const publish = (value: Union) =>
    SubscriptionRef.update(version, (current) => current + 1).pipe(
      Effect.andThen(deps.publish(value)),
    );
  const pending = new Map<string, Pending>();
  const claims = new Map<string, LiveTabClaim>();
  const grants = new Map<string, BrowserOriginGrant>();
  const ended = new Map<
    string,
    { readonly threadId: ThreadId; readonly reason: "origin_changed" }
  >();
  let sequence = 0;
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
        const grantKey = key(entry.threadId, entry.origin);
        const existed = grants.has(grantKey);
        grants.set(grantKey, {
          environmentId: deps.environmentId,
          threadId: entry.threadId,
          origin: entry.origin,
        });
        entry.granted = true;
        const rollback = Effect.gen(function* () {
          pending.delete(claimId);
          claims.delete(claimId);
          if (!existed) grants.delete(grantKey);
          yield* publish(union());
        });
        const result = yield* Effect.gen(function* () {
          yield* publish(union());
          const tab = yield* deps.bind(entry);
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
          claims.set(claimId, claim);
          pending.delete(claimId);
          yield* publish(union());
          return { agentResult: { status: "attached" as const, claim } };
        }).pipe(Effect.catch((error) => rollback.pipe(Effect.andThen(Effect.fail(error)))));
        return result;
      }),
    ),
  );
  const list = Effect.fn("BrowserOriginGrants.list")((threadId: ThreadId) =>
    lock.withPermits(1)(
      Effect.sync(() => ({
        claims: [...claims.values()].filter((claim) => claim.threadId === threadId),
        grants: [...grants.values()].filter((grant) => grant.threadId === threadId),
      })),
    ),
  );
  const revoke = Effect.fn("BrowserOriginGrants.revoke")((threadId: ThreadId, origin: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        grants.delete(key(threadId, origin));
        for (const [id, entry] of pending)
          if (entry.threadId === threadId && entry.origin === origin) pending.delete(id);
        for (const [id, claim] of claims)
          if (claim.threadId === threadId && claim.origin === origin) claims.delete(id);
        yield* publish(union());
      }),
    ),
  );
  const stop = Effect.fn("BrowserOriginGrants.stop")((threadId: ThreadId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        for (const [id, entry] of pending) if (entry.threadId === threadId) pending.delete(id);
        for (const [id, claim] of claims) if (claim.threadId === threadId) claims.delete(id);
        yield* publish(union());
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
          yield* publish(union());
          return true;
        }),
      ),
  );
  const endReason = Effect.fn("BrowserOriginGrants.endReason")(
    (threadId: ThreadId, claimId: string) =>
      lock.withPermits(1)(
        Effect.sync(() => {
          const entry = ended.get(claimId);
          return entry?.threadId === threadId ? entry.reason : undefined;
        }),
      ),
  );
  const driverRestarted = lock.withPermits(1)(
    Effect.gen(function* () {
      pending.clear();
      claims.clear();
      yield* publish(union());
    }),
  );
  const claimsFor = Effect.fn("BrowserOriginGrants.claimsFor")((threadId: ThreadId) =>
    lock.withPermits(1)(
      Effect.sync(() => {
        const origins = [...grants.values()]
          .filter((grant) => grant.threadId === threadId)
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
    ),
  );
  const claimedPids = Effect.fn("BrowserOriginGrants.claimedPids")(() =>
    lock.withPermits(1)(
      Effect.sync(() => [...new Set([...claims.values()].map((claim) => claim.tab.pid))]),
    ),
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
