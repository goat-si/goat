import { RelayApi, type RelayProtectedError } from "@goat/contracts/relay";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { withRelayClientTracing } from "@goat/shared/relayTracing";
import type { ManagedRelayClientError } from "./managedRelay.ts";

type RequestError = RelayProtectedError | HttpClientError.HttpClientError | Schema.SchemaError;
export const make = Effect.fn("clientRuntime.managedRelayAccount.make")(function* (
  baseUrl: string,
  options: {
    readonly error: (
      action: "delete relay account" | "read relay account deletion",
    ) => (cause: RequestError) => ManagedRelayClientError;
    readonly timeout: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ManagedRelayClientError, R>;
  },
) {
  const client = yield* HttpApiClient.make(RelayApi, { baseUrl });
  return {
    deleteAccount: Effect.fn("clientRuntime.managedRelay.deleteAccount")(function* (input: {
      clerkToken: string;
      idempotencyKey: string;
    }) {
      return yield* client.account
        .deleteAccount({
          headers: {
            authorization: `Bearer ${input.clerkToken}`,
            "idempotency-key": input.idempotencyKey,
          },
        })
        .pipe(Effect.mapError(options.error("delete relay account")), options.timeout);
    }, withRelayClientTracing),
    getAccountDeletion: Effect.fn("clientRuntime.managedRelay.getAccountDeletion")(
      function* (input: { clerkToken: string }) {
        return yield* client.account
          .getAccountDeletion({ headers: { authorization: `Bearer ${input.clerkToken}` } })
          .pipe(Effect.mapError(options.error("read relay account deletion")), options.timeout);
      },
      withRelayClientTracing,
    ),
  };
});
