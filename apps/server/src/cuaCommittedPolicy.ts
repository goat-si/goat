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

export const makeCuaCommittedPolicy = Effect.gen(function* () {
  const ref = yield* Ref.make<CuaCommittedPolicy>({ _tag: "unavailable" });
  const signals = yield* PubSub.sliding<void>(1);
  const history: Array<{
    readonly sequence: number;
    readonly hosts: ReadonlyArray<string> | undefined;
  }> = [];
  let sequence = 0;
  const setPolicy = (policy: CuaCommittedPolicy) =>
    Ref.set(ref, policy).pipe(
      Effect.andThen(
        Effect.sync(() => {
          const hosts =
            policy._tag === "committed" && policy.blockedBrowserHosts.length <= 4096
              ? [...policy.blockedBrowserHosts]
              : undefined;
          history.push({ sequence: ++sequence, hosts });
          if (history.length > 64) history.shift();
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
  const unavailable = setPolicy({ _tag: "unavailable" });
  const subscribeRestrictions = Effect.gen(function* () {
    let cursor = sequence;
    const subscription = yield* PubSub.subscribe(signals);
    return Stream.concat(Stream.succeed(undefined), Stream.fromSubscription(subscription)).pipe(
      Stream.map(() => {
        const oldest = history[0];
        const missed = oldest !== undefined && cursor < oldest.sequence - 1;
        const pending = history.filter((entry) => entry.sequence > cursor);
        cursor = sequence;
        if (missed || pending.some((entry) => entry.hosts === undefined)) return undefined;
        const hosts = new Set<string>();
        for (const entry of pending)
          for (const host of entry.hosts ?? []) {
            hosts.add(host);
            if (hosts.size > 4096) return undefined;
          }
        return [...hosts];
      }),
    );
  });
  return {
    read: Ref.get(ref),
    subscribeRestrictions,
    unavailable,
    publish,
    commit: (settings: ServerSettings) => publish(settings, Option.none()),
    loaded: <E, R>(
      load: Effect.Effect<{ settings: ServerSettings; parseFailure: Option.Option<unknown> }, E, R>,
    ) =>
      load.pipe(
        Effect.tap(({ settings, parseFailure }) => publish(settings, parseFailure)),
        Effect.tapError(() => unavailable),
      ),
  };
});
