import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createPostgresFixture } from "../accounts/test/PostgresFixture.ts";
import { postgresPolicyLayer } from "../accounts/test/PolicyPostgresLayers.ts";
import { DeliveryAuthorization, DeliveryContext } from "./DeliveryAuthorization.ts";

it.live(
  "old jobs and old transport results cannot act after same-token registration in a new epoch",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('owner','allowed',1)",
      );
      pg.query(
        "INSERT INTO relay_mobile_devices(user_id,device_id,platform,push_token,preferences_json,account_epoch,created_at,updated_at) VALUES ('owner','phone','ios','same-token','{}',1,'now','now')",
      );
      yield* Effect.gen(function* () {
        const authorization = yield* DeliveryAuthorization;
        const old = {
          userId: "owner",
          deviceId: "phone",
          accountEpoch: 1,
          token: "same-token",
          kind: "push_notification" as const,
        };
        expect(yield* authorization.eligible(old)).toBe(true);
        pg.query("UPDATE relay_account_access SET status='suspended',account_epoch=2");
        expect(yield* authorization.eligible(old)).toBe(false);
        pg.query("UPDATE relay_account_access SET status='allowed',account_epoch=3");
        pg.query("UPDATE relay_mobile_devices SET account_epoch=3");
        expect(yield* authorization.eligible(old)).toBe(false);
        expect(yield* authorization.eligible({ ...old, accountEpoch: 3 })).toBe(true);
        let changed = false;
        yield* authorization
          .result(
            Effect.sync(() => {
              changed = true;
            }),
          )
          .pipe(Effect.provideService(DeliveryContext, old));
        expect(changed).toBe(false);
      }).pipe(Effect.provide(postgresPolicyLayer(pg)));
    }),
);
