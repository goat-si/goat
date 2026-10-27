import * as Cloudflare from "alchemy/Cloudflare";
import type * as Alchemy from "alchemy";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as AccountLimits from "./AccountLimits.ts";
import { consumeWindow } from "./AccountRateLimitStore.ts";

export class AccountRateLimitObject extends Cloudflare.DurableObject<
  AccountRateLimitObject,
  {
    readonly consume: (
      operation: AccountLimits.HourlyOperation,
    ) => Effect.Effect<
      { allowed: boolean; retryAfterSeconds: number },
      never,
      Alchemy.RuntimeContext
    >;
  }
>()("AccountRateLimitObject") {}
export const make = Effect.gen(function* () {
  const policy = yield* AccountLimits.config.pipe(Effect.orDie);
  const state = yield* Cloudflare.DurableObjectState;
  return Effect.succeed({
    consume: Effect.fn("AccountRateLimitObject.consume")(function* (
      operation: AccountLimits.HourlyOperation,
    ) {
      if (!AccountLimits.HOURLY_OPERATIONS.includes(operation))
        return yield* Effect.die(new Error("Unknown account rate operation"));
      const now = yield* Clock.currentTimeMillis;
      return consumeWindow(state.raw.storage, operation, policy[operation], now);
    }),
  });
});
export const layer = AccountRateLimitObject.make(make);
