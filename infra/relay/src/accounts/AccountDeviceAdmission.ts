import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import {
  RelayAccountResourceLimitExceededError,
  RelayMobileDeviceNotRegisteredError,
  RelayAuthorizationUnavailableError,
} from "@goat/contracts/relayErrors";
import * as SqlError from "effect/sql/SqlError";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RelayDb } from "../db.ts";
import { AccountAccess, type AccountAccessError } from "./AccountAccess.ts";
import { AccountLimits } from "./AccountLimits.ts";
import { AccountTransactions } from "./AccountTransactions.ts";
export type DeviceAdmissionError =
  | AccountAccessError
  | RelayAccountResourceLimitExceededError
  | RelayMobileDeviceNotRegisteredError;
export class AccountDeviceAdmission extends Context.Service<
  AccountDeviceAdmission,
  {
    readonly write: <A, E, R>(
      input: {
        readonly userId: string;
        readonly deviceId: string;
        readonly liveActivity?: boolean;
        readonly tokens?: ReadonlyArray<string>;
      },
      body: (epoch: number) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | DeviceAdmissionError, R>;
    readonly unregister: <A, E, R>(
      userId: string,
      body: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | RelayAuthorizationUnavailableError, R>;
  }
>()("goat-relay/accounts/AccountDeviceAdmission") {}
const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const db = yield* RelayDb;
  const sql = db.$client;
  const access = yield* AccountAccess;
  const tx = yield* AccountTransactions;
  const limits = yield* AccountLimits;
  return AccountDeviceAdmission.of({
    write: Effect.fn("AccountDeviceAdmission.write")(function* (input, body) {
      const admission = yield* access.admit(input.userId);
      return yield* tx
        .run(
          { userIds: [input.userId] },
          Effect.gen(function* () {
            yield* access.requireAllowed(admission);
            const devices = yield* sql<{
              device_id: string;
              account_epoch: number | null;
              delivery_disabled_at: string | null;
            }>`SELECT device_id,account_epoch,delivery_disabled_at FROM relay_mobile_devices WHERE user_id=${input.userId}`;
            const target = devices.find((d) => d.device_id === input.deviceId);
            if (
              input.liveActivity &&
              (!target ||
                target.account_epoch !== admission.accountEpoch ||
                target.delivery_disabled_at !== null)
            )
              return yield* new RelayMobileDeviceNotRegisteredError({
                code: "mobile_device_not_registered",
                traceId: "relay",
              });
            if (!input.liveActivity && !target && devices.length >= limits.mobileDevices)
              return yield* new RelayAccountResourceLimitExceededError({
                code: "account_resource_limit_exceeded",
                resource: "mobile_devices",
                limit: limits.mobileDevices,
                traceId: "relay",
              });
            for (const token of (yield* Effect.forEach([...new Set(input.tokens ?? [])], (token) =>
              crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(
                Effect.map(Hex.encode),
                Effect.mapError(
                  () =>
                    new RelayAuthorizationUnavailableError({
                      code: "authorization_unavailable",
                      traceId: "unavailable",
                    }),
                ),
              ),
            )).sort())
              yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`relay:token:${token}`},0))`;
            return yield* body(admission.accountEpoch);
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            SqlError.isSqlError(error)
              ? new RelayAuthorizationUnavailableError({
                  code: "authorization_unavailable",
                  traceId: "relay",
                })
              : error,
          ),
        );
    }),
    unregister: Effect.fn("AccountDeviceAdmission.unregister")(function* (userId, body) {
      return yield* tx.run({ userIds: [userId] }, body).pipe(
        Effect.mapError((error) =>
          SqlError.isSqlError(error)
            ? new RelayAuthorizationUnavailableError({
                code: "authorization_unavailable",
                traceId: "relay",
              })
            : error,
        ),
      );
    }),
  });
});
export const layer = Layer.effect(AccountDeviceAdmission, make);
