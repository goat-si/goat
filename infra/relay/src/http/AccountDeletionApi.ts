import {
  RelayApi,
  RelayAccountDeletionConflictError,
  RelayAccountDeletionUnavailableError,
} from "@goat/contracts/relay";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { AccountLifecycle } from "../accounts/AccountLifecycle.ts";
import { AccountDeletionAuthentication } from "../auth/AccountDeletionAuthentication.ts";
import { HostRevocations } from "../accounts/HostRevocations.ts";
import { appendRelayCredentialResponseHeaders } from "./ApiErrors.ts";

const token = (header: string) => (/^Bearer [^\s]+$/u.test(header) ? header.slice(7) : "");
export const layerAccount = HttpApiBuilder.group(
  RelayApi,
  "account",
  Effect.fnUntraced(function* (handlers) {
    const lifecycle = yield* AccountLifecycle;
    const auth = yield* AccountDeletionAuthentication;
    return handlers
      .handle(
        "getAccountDeletion",
        Effect.fn("relay.account.status")(
          function* ({ headers }) {
            yield* appendRelayCredentialResponseHeaders;
            const userId = yield* auth.authenticate(token(headers.authorization), false);
            return yield* lifecycle.getDeletion(userId);
          },
          Effect.catchTags({
            RelayAuthorizationUnavailableError: () =>
              Effect.fail(
                new RelayAccountDeletionUnavailableError({
                  code: "account_deletion_unavailable",
                  traceId: "relay",
                }),
              ),
            AccountLifecycleConflict: () =>
              Effect.fail(
                new RelayAccountDeletionConflictError({
                  code: "account_deletion_conflict",
                  traceId: "relay",
                }),
              ),
          }),
        ),
      )
      .handle(
        "deleteAccount",
        Effect.fn("relay.account.delete")(
          function* ({ headers }) {
            yield* appendRelayCredentialResponseHeaders;
            const bearer = token(headers.authorization);
            const userId = yield* auth.authenticate(bearer, false);
            const status = yield* lifecycle.getDeletion(userId);
            if (status.status === "absent") yield* auth.authenticate(bearer, true);
            return yield* lifecycle.requestDelete({
              userId,
              idempotencyKey: headers["idempotency-key"],
            });
          },
          Effect.catchTags({
            RelayAuthorizationUnavailableError: () =>
              Effect.fail(
                new RelayAccountDeletionUnavailableError({
                  code: "account_deletion_unavailable",
                  traceId: "relay",
                }),
              ),
            AccountLifecycleConflict: () =>
              Effect.fail(
                new RelayAccountDeletionConflictError({
                  code: "account_deletion_conflict",
                  traceId: "relay",
                }),
              ),
          }),
        ),
      );
  }),
);
export const layerHost = HttpApiBuilder.group(
  RelayApi,
  "hostRevocation",
  Effect.fnUntraced(function* (handlers) {
    const revocations = yield* HostRevocations;
    return handlers
      .handle(
        "getHostRevocation",
        Effect.fn("relay.hostRevocation.check")(function* ({ headers, params, payload }) {
          yield* appendRelayCredentialResponseHeaders;
          return yield* revocations.check({
            ...params,
            ...payload,
            credential: token(headers.authorization),
          });
        }),
      )
      .handle(
        "ackHostRevocation",
        Effect.fn("relay.hostRevocation.ack")(function* ({ headers, params, payload }) {
          yield* appendRelayCredentialResponseHeaders;
          yield* revocations.acknowledge({
            ...params,
            ...payload,
            credential: token(headers.authorization),
          });
          return { ok: true as const };
        }),
      );
  }),
);
