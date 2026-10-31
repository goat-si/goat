import {
  BrowserOrigin,
  type BrowserOriginGrant,
  type EnvironmentId,
  type LiveTabClaim,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
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
  readonly createdAt: number;
  readonly stopped: Deferred.Deferred<void>;
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
  /** Restarts the driver; true when it could. */
  readonly fence?: () => Effect.Effect<boolean>;
  readonly windowTitle?: (
    input: Pick<Request, "threadId" | "pid" | "windowId">,
  ) => Effect.Effect<string, Error>;
  readonly bind: (
    input: Request & { readonly claimId: string; readonly bindingVersion: number },
  ) => Effect.Effect<
    {
      readonly targetId: string;
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
  let currentRevision = 0;
  const advance = SubscriptionRef.update(version, (current) => {
    currentRevision = current + 1;
    return currentRevision;
  });
  const confirm = Effect.fn("BrowserOriginGrants.confirmManifest")(function* (sha: string) {
    if (!manifestApplied(yield* deps.confirm(sha), sha))
      return yield* new BrowserManifestNotApplied();
  });
  let writes = 0;
  const confirming = new Set<Deferred.Deferred<void>>();
  const write = (value: Union) =>
    writeLock.withPermits(1)(
      Effect.sync(() => ++writes).pipe(
        Effect.tap(() => advance),
        Effect.flatMap((written) =>
          deps.publish(value).pipe(Effect.map((sha) => ({ sha, written }))),
        ),
      ),
    );
  const publish = Effect.fn("BrowserOriginGrants.publishExpansion")(function* (value: Union) {
    yield* confirm((yield* write(value)).sha);
  });
  /**
   * Narrowing never fails or waits on the driver, but a driver that may keep a wider manifest is
   * restarted so it stops counting. Only the latest write can be judged: a newer one carries its
   * own confirmation, and its union already leaves out what this one removed.
   */
  const fenceUnless = (written: number | undefined, cause: unknown) =>
    written !== undefined && written !== writes
      ? Effect.void
      : Effect.logWarning("Browser manifest narrowing was not applied; restarting the driver", {
          cause,
        }).pipe(
          Effect.andThen(deps.fence?.() ?? Effect.succeed(false)),
          Effect.flatMap((fenced) =>
            fenced ? Effect.void : Effect.logError("No driver fence is available"),
          ),
        );
  const shrink = Effect.fn("BrowserOriginGrants.publishShrink")(function* (value: Union) {
    const result = yield* write(value).pipe(Effect.result);
    if (result._tag === "Failure") return yield* fenceUnless(undefined, result.failure);
    const { sha, written } = result.success;
    const done = yield* Deferred.make<void>();
    confirming.add(done);
    yield* confirm(sha).pipe(
      Effect.catch((cause) => fenceUnless(written, cause)),
      Effect.ensuring(
        Effect.sync(() => confirming.delete(done)).pipe(
          Effect.andThen(Deferred.succeed(done, undefined)),
        ),
      ),
      Effect.forkDetach({ startImmediately: true }),
    );
  });
  /** Waits for every narrowing confirmation already started. */
  const settled = Effect.suspend(() =>
    Effect.forEach([...confirming], (done) => Deferred.await(done), { discard: true }),
  );
  const pending = new Map<string, Pending>();
  const claims = new Map<string, LiveTabClaim>();
  // The bind's driver target, kept off LiveTabClaim so people and agents never see it.
  const targets = new WeakMap<LiveTabClaim, string>();
  const grants = new Map<string, BrowserOriginGrant>();
  const uncommittedGrants = new Set<string>();
  const ended = new Map<
    string,
    {
      readonly threadId: ThreadId;
      readonly reason: "origin_changed" | "driver_restarted" | "stopped";
    }
  >();
  let sequence = 0;
  let driverEpoch = 0;
  let restartSignal = yield* Deferred.make<void>();
  const untilRestart = Effect.fn("BrowserOriginGrants.untilRestart")(function* <A, E>(
    effect: Effect.Effect<A, E>,
    signal: Deferred.Deferred<void>,
    stopped: Deferred.Deferred<void>,
  ) {
    const task = yield* effect.pipe(Effect.forkDetach({ startImmediately: true }));
    return yield* Effect.raceFirst(
      Fiber.join(task).pipe(Effect.asSome),
      Effect.raceFirst(Deferred.await(signal), Deferred.await(stopped)).pipe(
        Effect.as(Option.none<A>()),
      ),
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
      Effect.gen(function* () {
        if (!deps.supported()) return unavailable;
        if (!isOrigin(input.origin)) return invalidOrigin;
        const createdAt = yield* Clock.currentTimeMillis;
        const claimId = `browser-claim:${++sequence}`;
        const stopped = yield* Deferred.make<void>();
        pending.set(claimId, { ...input, claimId, createdAt, stopped, granted: false });
        yield* advance;
        return { status: "pending" as const, claimId };
      }),
    ),
  );
  const requestWindow = Effect.fn("BrowserOriginGrants.requestWindow")(function* (
    input: Omit<Request, "windowTitle">,
  ) {
    if (!deps.supported()) return unavailable;
    if (!isOrigin(input.origin)) return invalidOrigin;
    if (!deps.windowTitle) return yield* new BrowserManifestNotApplied();
    const windowTitle = yield* deps.windowTitle(input);
    return yield* request({ ...input, windowTitle });
  });
  const answer = Effect.fn("BrowserOriginGrants.answer")((claimId: string, approved: boolean) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const entry = pending.get(claimId);
        if (entry === undefined || !approved || !deps.supported()) {
          if (pending.delete(claimId)) yield* advance;
          return { agentResult: decline };
        }
        if (deps.bindAvailable?.() === false) {
          pending.delete(claimId);
          yield* advance;
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
          const applied = yield* untilRestart(publish(union()), signal, entry.stopped);
          if (Option.isNone(applied)) return { agentResult: decline };
          if (epoch !== driverEpoch) return { agentResult: decline };
          if (!deps.supported()) return yield* rollback.pipe(Effect.as({ agentResult: decline }));
          const bindingVersion = yield* SubscriptionRef.get(version);
          const bound = yield* untilRestart(
            deps.bind({ ...entry, bindingVersion }),
            signal,
            entry.stopped,
          );
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
          targets.set(claim, tab.targetId);
          claims.set(claimId, claim);
          pending.delete(claimId);
          yield* advance;
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
  const claim = Effect.fn("BrowserOriginGrants.claim")(function* (input: Request) {
    const result = yield* request(input);
    if (result.status !== "pending") return { agentResult: result };
    return yield* answer(result.claimId, true);
  });
  const claimWindow = Effect.fn("BrowserOriginGrants.claimWindow")(function* (
    input: Omit<Request, "windowTitle">,
  ) {
    const result = yield* requestWindow(input);
    if (result.status !== "pending") return { agentResult: result };
    return yield* answer(result.claimId, true);
  });
  const listAll = Effect.fn("BrowserOriginGrants.listAll")(() =>
    Effect.sync(() => ({
      claims: [...claims.values()],
      grants: [...grants.values()].filter(
        (grant) => !uncommittedGrants.has(key(grant.threadId, grant.origin)),
      ),
      pending: [...pending.values()].map(
        ({ claimId, threadId, pid, windowId, origin, windowTitle, createdAt }) => ({
          claimId,
          threadId,
          pid,
          windowId,
          origin,
          windowTitle,
          createdAt,
        }),
      ),
    })),
  );
  const endPerson = Effect.fn("BrowserOriginGrants.endPerson")((claimId: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const claim = claims.get(claimId);
        if (!claim) return false;
        claims.delete(claimId);
        yield* shrink(union());
        return true;
      }),
    ),
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
  const stop = Effect.fn("BrowserOriginGrants.stop")(function* (threadId?: ThreadId) {
    const stopped = yield* Effect.sync(() => {
      const signals: Array<Deferred.Deferred<void>> = [];
      for (const [id, entry] of pending)
        if (threadId === undefined || entry.threadId === threadId) {
          pending.delete(id);
          ended.set(id, { threadId: entry.threadId, reason: "stopped" });
          if (uncommittedGrants.delete(key(entry.threadId, entry.origin)))
            grants.delete(key(entry.threadId, entry.origin));
          signals.push(entry.stopped);
          sequence++;
        }
      for (const [id, claim] of claims)
        if (threadId === undefined || claim.threadId === threadId) {
          claims.delete(id);
          ended.set(id, { threadId: claim.threadId, reason: "stopped" });
          sequence++;
        }
      return signals;
    });
    for (const signal of stopped) yield* Deferred.succeed(signal, undefined);
    yield* shrink(union());
  });
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
  const bindingValues = (threadId: ThreadId) =>
    [...pending.values()]
      .filter((entry) => entry.threadId === threadId && entry.granted)
      .map(({ claimId, pid, windowId, origin }) => ({ claimId, pid, windowId, origin }));
  const claimValues = (threadId: ThreadId) => {
    const origins = [...grants.values()]
      .filter(
        (grant) =>
          grant.threadId === threadId && !uncommittedGrants.has(key(grant.threadId, grant.origin)),
      )
      .map((grant) => grant.origin);
    return [...claims.values()].flatMap((claim) => {
      const targetId = targets.get(claim);
      if (claim.threadId !== threadId || targetId === undefined) return [];
      return [
        {
          claimId: claim.claimId,
          claimGeneration: claim.claimGeneration,
          pid: claim.tab.pid,
          windowId: claim.tab.windowId,
          tabId: claim.tab.tabId,
          targetId,
          origins,
        },
      ];
    });
  };
  const pidValues = () => [...new Set([...claims.values()].map((claim) => claim.tab.pid))];
  const bindingsFor = Effect.fn("BrowserOriginGrants.bindingsFor")((threadId: ThreadId) =>
    Effect.sync(() => bindingValues(threadId)),
  );
  const claimsFor = Effect.fn("BrowserOriginGrants.claimsFor")((threadId: ThreadId) =>
    Effect.sync(() => claimValues(threadId)),
  );
  const claimedPids = Effect.fn("BrowserOriginGrants.claimedPids")(() => Effect.sync(pidValues));
  const snapshotFor = Effect.fn("BrowserOriginGrants.snapshotFor")((threadId: ThreadId) =>
    Effect.sync(() => ({
      revision: currentRevision,
      bindings: bindingValues(threadId),
      claims: claimValues(threadId),
      pids: pidValues(),
    })),
  );
  return {
    request,
    requestWindow,
    answer,
    claim,
    claimWindow,
    list,
    listAll,
    endPerson,
    revoke,
    stop,
    end,
    endReason,
    driverRestarted,
    bindingsFor,
    snapshotFor,
    claimsFor,
    claimedPids,
    settled,
    revision: SubscriptionRef.get(version),
    changes: SubscriptionRef.changes(version),
  };
});
