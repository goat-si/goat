import type { ServerSettings } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as PubSub from "effect/PubSub";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";

export type CuaCommittedPolicy =
  | { readonly _tag: "unavailable" }
  | {
      readonly _tag: "committed";
      readonly enableCua: boolean;
      readonly blockedBrowserHosts: ReadonlyArray<string>;
    };

/** Zero-yield read of the committed policy, plus the publication feed beside it. */
export type CuaCommittedPolicyRead = Effect.Effect<CuaCommittedPolicy> & {
  readonly changes?: Stream.Stream<ReadonlyArray<string> | undefined>;
  readonly hostsNow?: () => ReadonlyArray<string> | undefined;
  readonly acknowledge?: () => void;
};

const HISTORY_LIMIT = 64;
const HOST_LIMIT = 4096;
const HOST_CHARS = 262_144;

const hostsOf = (policy: CuaCommittedPolicy): ReadonlyArray<string> | undefined => {
  if (policy._tag !== "committed") return undefined;
  if (policy.blockedBrowserHosts.length > HOST_LIMIT) return undefined;
  let size = 0;
  const hosts = [];
  for (const host of policy.blockedBrowserHosts) {
    size += host.length;
    if (size > HOST_CHARS) return undefined;
    hosts.push(host);
  }
  return hosts;
};

export const makeCuaCommittedPolicy = Effect.gen(function* () {
  const initial: CuaCommittedPolicy = { _tag: "unavailable" };
  const ref = yield* Ref.make<CuaCommittedPolicy>(initial);
  const signals = yield* PubSub.sliding<void>(1);
  const history: Array<{
    readonly sequence: number;
    readonly hosts: ReadonlyArray<string> | undefined;
  }> = [];
  let current: CuaCommittedPolicy = initial;
  let sequence = 0;
  let cursor = 0;
  let emittedThrough = 0;
  const pendingHosts = (): ReadonlyArray<string> | undefined => {
    const oldest = history[0];
    if (oldest !== undefined && cursor < oldest.sequence - 1) return undefined;
    const entries = history.filter((entry) => entry.sequence > cursor);
    if (entries.some((entry) => entry.hosts === undefined)) return undefined;
    const hosts = new Set<string>();
    for (const entry of entries)
      for (const host of entry.hosts ?? []) {
        hosts.add(host);
        if (hosts.size > HOST_LIMIT) return undefined;
      }
    return [...hosts];
  };
  const hostsNow = (): ReadonlyArray<string> | undefined => {
    const pending = pendingHosts();
    if (pending === undefined || current._tag !== "committed") return undefined;
    if (pending.length === 0) return current.blockedBrowserHosts;
    return [...new Set([...current.blockedBrowserHosts, ...pending])];
  };
  const acknowledge = () => {
    cursor = Math.max(cursor, emittedThrough);
  };
  // Subscribe before the first tick so no publication falls between it and the subscription.
  const changes = Stream.unwrap(
    Effect.map(PubSub.subscribe(signals), (subscription) =>
      Stream.concat(Stream.succeed(undefined), Stream.fromSubscription(subscription)),
    ),
  ).pipe(
    Stream.map(() => {
      emittedThrough = sequence;
      return hostsNow();
    }),
  );
  const setPolicy = (policy: CuaCommittedPolicy) =>
    Ref.set(ref, policy).pipe(
      Effect.andThen(
        Effect.sync(() => {
          current = policy;
          const hosts = hostsOf(policy);
          history.push({ sequence: ++sequence, hosts });
          // A dropped entry is a missed restriction, so the next read fails closed.
          if (history.length > HISTORY_LIMIT) history.shift();
        }),
      ),
      Effect.andThen(PubSub.publish(signals, undefined)),
      Effect.asVoid,
      Effect.provideService(Scheduler.PreventSchedulerYield, true),
      Effect.uninterruptible,
    );
  const publish = (settings: ServerSettings, parseFailure: Option.Option<unknown>) => {
    const policy: CuaCommittedPolicy = Option.isSome(parseFailure)
      ? { _tag: "unavailable" }
      : {
          _tag: "committed",
          enableCua: settings.enableCua,
          blockedBrowserHosts: settings.blockedBrowserHosts,
        };
    return setPolicy(policy);
  };
  const read: CuaCommittedPolicyRead = Object.assign(Ref.get(ref), {
    changes,
    hostsNow,
    acknowledge,
  });
  return {
    read,
    unavailable: setPolicy({ _tag: "unavailable" }),
    publish,
    commit: (settings: ServerSettings) => publish(settings, Option.none()),
    loaded: <E, R>(
      load: Effect.Effect<{ settings: ServerSettings; parseFailure: Option.Option<unknown> }, E, R>,
    ) =>
      load.pipe(
        Effect.tap(({ settings, parseFailure }) => publish(settings, parseFailure)),
        Effect.tapError(() => setPolicy({ _tag: "unavailable" })),
      ),
  };
});
