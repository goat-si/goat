import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

import { CLOUD_WITHDRAWAL_FENCE } from "../cloud/config.ts";
export class CloudCredentialWithdrawalError extends Schema.TaggedError<CloudCredentialWithdrawalError>()(
  "CloudCredentialWithdrawalError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "GOAT Connect credential withdrawal is pending.";
  }
}
const Held = Context.Reference<boolean>("goat/auth/CloudCredentialWithdrawal/Held", {
  defaultValue: () => false,
});
export const make = Effect.gen(function* () {
  const grants = yield* PairingGrantStore.PairingGrantStore;
  const sessions = yield* SessionStore.SessionStore;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const pending = yield* Ref.make(
    Option.isSome(yield* secrets.get(CLOUD_WITHDRAWAL_FENCE).pipe(Effect.orDie)),
  );
  const permit = yield* Semaphore.make(1);
  const withPermit = Effect.fn("CloudCredentialWithdrawal.withPermit")(function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) {
    if (yield* Held) return yield* effect;
    return yield* effect.pipe(Effect.provideService(Held, true), permit.withPermits(1));
  });
  const guard = Effect.fn("CloudCredentialWithdrawal.guard")(function* (subject: string) {
    if (subject === "cloud-connect" && (yield* Ref.get(pending)))
      return yield* new CloudCredentialWithdrawalError({});
  });
  const withdraw = Effect.fn("CloudCredentialWithdrawal.withdraw")(function* () {
    yield* Ref.set(pending, true);
    yield* sessions.setCloudWithdrawalPending(true);
    return yield* withPermit(
      Effect.gen(function* () {
        const persisted = yield* secrets
          .set(CLOUD_WITHDRAWAL_FENCE, new TextEncoder().encode("pending"))
          .pipe(Effect.result);
        // Persistence failure keeps admission denied and still attempts every durable revocation.
        const revoked = yield* Effect.gen(function* () {
          const [grantResult, sessionResult] = yield* Effect.all([
            grants.listActive().pipe(Effect.result),
            sessions.listActive().pipe(Effect.result),
          ]);
          const activeGrants = grantResult._tag === "Success" ? grantResult.success : [];
          const activeSessions = sessionResult._tag === "Success" ? sessionResult.success : [];
          const results = yield* Effect.all([
            ...activeGrants
              .filter((grant) => grant.subject === "cloud-connect")
              .map((grant) => grants.revoke(grant.id).pipe(Effect.result)),
            ...activeSessions
              .filter((session) => session.subject === "cloud-connect")
              .map((session) => sessions.revoke(session.sessionId).pipe(Effect.result)),
          ]);
          if (grantResult._tag === "Failure")
            return yield* new CloudCredentialWithdrawalError({ cause: grantResult.failure });
          if (sessionResult._tag === "Failure")
            return yield* new CloudCredentialWithdrawalError({ cause: sessionResult.failure });
          const failed = results.find((result) => result._tag === "Failure");
          if (failed?._tag === "Failure")
            return yield* new CloudCredentialWithdrawalError({ cause: failed.failure });
        }).pipe(Effect.result);
        if (persisted._tag === "Failure")
          return yield* new CloudCredentialWithdrawalError({ cause: persisted.failure });
        if (revoked._tag === "Failure")
          return yield* new CloudCredentialWithdrawalError({ cause: revoked.failure });
      }),
    ).pipe(Effect.mapError((cause) => new CloudCredentialWithdrawalError({ cause })));
  });
  const complete = Effect.fn("CloudCredentialWithdrawal.complete")(function* () {
    yield* secrets
      .remove(CLOUD_WITHDRAWAL_FENCE)
      .pipe(Effect.mapError((cause) => new CloudCredentialWithdrawalError({ cause })));
    yield* sessions.setCloudWithdrawalPending(false);
    yield* Ref.set(pending, false);
  });
  return { withPermit, guard, withdraw, complete };
});
