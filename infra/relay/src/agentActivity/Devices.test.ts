import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createPostgresFixture } from "../accounts/test/PostgresFixture.ts";
import { postgresPolicyLayer } from "../accounts/test/PolicyPostgresLayers.ts";
import { AccountRequestAdmission } from "../accounts/AccountAccess.ts";
import { Devices } from "./Devices.ts";
import { LiveActivities } from "./LiveActivities.ts";

const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
it.live(
  "device admission is atomic before token claims, and unregister cannot leave an orphan Live Activity",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('owner-a','allowed',1),('owner-b','allowed',1)",
      );
      yield* Effect.gen(function* () {
        const devices = yield* Devices;
        const activities = yield* LiveActivities;
        const registration = (deviceId: string, pushToken?: string) => ({
          deviceId,
          label: "Fixture phone",
          platform: "ios" as const,
          iosMajorVersion: 18,
          preferences,
          ...(pushToken ? { pushToken } : {}),
        });
        for (let i = 0; i < 9; i++)
          yield* devices.register({ userId: "owner-a", registration: registration(`phone-${i}`) });
        yield* devices.register({
          userId: "owner-b",
          registration: registration("victim", "victim-token"),
        });
        const last = yield* Effect.forEach(
          ["phone-9", "phone-10"],
          (deviceId) =>
            devices
              .register({ userId: "owner-a", registration: registration(deviceId) })
              .pipe(Effect.result),
          { concurrency: 2 },
        );
        expect(last.filter((r) => r._tag === "Success")).toHaveLength(1);
        expect(
          (yield* Effect.flip(
            devices.register({
              userId: "owner-a",
              registration: registration("extra", "victim-token"),
            }),
          ))._tag,
        ).toBe("RelayAccountResourceLimitExceededError");
        expect(
          pg.query("SELECT push_token FROM relay_mobile_devices WHERE user_id='owner-b'").trim(),
        ).toBe("victim-token");
        yield* devices.register({
          userId: "owner-a",
          registration: registration("phone-0", "refresh-token"),
        });
        yield* Effect.all(
          [
            devices.unregister({ userId: "owner-a", deviceId: "phone-0" }).pipe(Effect.result),
            activities
              .register({
                userId: "owner-a",
                registration: { deviceId: "phone-0", activityPushToken: "activity-token" },
              })
              .pipe(Effect.result),
          ],
          { concurrency: 2 },
        );
        expect(
          pg
            .query(
              "SELECT count(*) FROM relay_live_activities WHERE user_id='owner-a' AND device_id='phone-0'",
            )
            .trim(),
        ).toBe("0");
        pg.query("UPDATE relay_account_access SET account_epoch=3 WHERE user_id='owner-a'");
        const stale = yield* devices
          .register({ userId: "owner-a", registration: registration("phone-stale") })
          .pipe(
            Effect.provideService(AccountRequestAdmission, { userId: "owner-a", accountEpoch: 1 }),
            Effect.result,
          );
        expect(stale._tag).toBe("Failure");
      }).pipe(Effect.provide(postgresPolicyLayer(pg)));
    }),
);
