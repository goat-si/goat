import type { ServerSettings } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** SQL-free committed policy. An unready producer denies even the default-on setting. */
export interface MemoryProviderPolicy {
  readonly policyReady: boolean;
  readonly enableAgentMemoryAccess: boolean;
  /** Process-local; never a durable credential authority after a restart. */
  readonly epoch: number;
}

/** L2 subscribes before preparing credentials, and rotates on every published epoch. */
export class MemoryProviderCommittedPolicy extends Context.Service<
  MemoryProviderCommittedPolicy,
  {
    readonly read: Effect.Effect<MemoryProviderPolicy>;
    readonly subscribeRotations: Effect.Effect<
      Stream.Stream<MemoryProviderPolicy>,
      never,
      Scope.Scope
    >;
  }
  // @effect-diagnostics-next-line deterministicKeys:off -- Preserve the service key from serverSettings.ts.
>()("goat/serverSettings/MemoryProviderCommittedPolicy") {}

type ConversationControls = Pick<
  ServerSettings,
  "conversationMemoryEnabled" | "enableAgentMemoryAccess"
>;

export const makeMemoryProviderPolicy = Effect.gen(function* () {
  const current = yield* Ref.make<{
    configured: ConversationControls;
    policy: MemoryProviderPolicy;
  }>({
    configured: { conversationMemoryEnabled: false, enableAgentMemoryAccess: false },
    policy: Object.freeze({ policyReady: false, enableAgentMemoryAccess: false, epoch: 0 }),
  });
  const rotations = yield* PubSub.sliding<MemoryProviderPolicy>(1);
  const publish = ({ conversationMemoryEnabled, enableAgentMemoryAccess }: ConversationControls) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const configured = { conversationMemoryEnabled, enableAgentMemoryAccess };
        const allowed = conversationMemoryEnabled && enableAgentMemoryAccess;
        const changed = yield* Ref.modify(current, ({ policy }) => {
          if (policy.policyReady && policy.enableAgentMemoryAccess === allowed)
            return [null, { configured, policy }] as const;
          const next = Object.freeze({
            policyReady: true,
            enableAgentMemoryAccess: allowed,
            epoch: policy.epoch + 1,
          });
          return [next, { configured, policy: next }] as const;
        });
        if (changed !== null) yield* PubSub.publish(rotations, changed);
      }),
    );
  const read = Ref.get(current).pipe(Effect.map((state) => state.policy));
  const service = {
    read,
    subscribeRotations: Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(rotations);
      const snapshot = yield* read;
      return Stream.make(snapshot).pipe(Stream.concat(Stream.fromSubscription(subscription)));
    }),
  } satisfies MemoryProviderCommittedPolicy["Service"];
  return {
    publish,
    service,
    configured: Ref.get(current).pipe(Effect.map((state) => state.configured)),
  };
});
