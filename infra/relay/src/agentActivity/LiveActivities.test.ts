import { DeliveryContext } from "./DeliveryAuthorization.ts";
import { createPostgresFixture } from "../accounts/test/PostgresFixture.ts";
import { postgresPolicyLayer } from "../accounts/test/PolicyPostgresLayers.ts";
import { policyUnitLayer } from "../accounts/test/PolicyUnitLayers.ts";
import type {
  RelayAgentActivityAggregateState,
  RelayLiveActivityRegistrationRequest,
} from "@goat/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import * as LiveActivities from "./LiveActivities.ts";

const aggregate: RelayAgentActivityAggregateState = {
  title: "GOAT",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: "2026-05-25T00:00:00.000Z",
  activities: [
    {
      environmentId:
        "env" as RelayAgentActivityAggregateState["activities"][number]["environmentId"],
      threadId: "thread" as RelayAgentActivityAggregateState["activities"][number]["threadId"],
      projectTitle: "Project",
      threadTitle: "Thread",
      modelTitle: "gpt-5.4",
      phase: "running",
      status: "Working",
      updatedAt: "2026-05-25T00:00:00.000Z",
      deepLink: "/threads/env/thread",
    },
  ],
};

describe("LiveActivities", () => {
  it.effect("keeps the arming time when the current card re-registers its token", () => {
    const armedAt = "2026-05-25T00:00:00.000Z";
    const insertedValues: Array<Record<string, unknown>> = [];
    const conflictSets: Array<Record<string, unknown> | undefined> = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Effect.succeed([
              { accountEpoch: 1, activityPushToken: "current-token", remoteStartedAt: armedAt },
            ]),
        }),
      }),
      update: () => ({ set: () => ({ where: () => Effect.void }) }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          insertedValues.push(values);
          return {
            onConflictDoUpdate: (config: { readonly set?: Record<string, unknown> }) => {
              conflictSets.push(config.set);
              return Effect.void;
            },
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];
    const register = (activityPushToken: string) =>
      Effect.flatMap(LiveActivities.LiveActivities, (liveActivities) =>
        liveActivities.register({
          userId: "user-1",
          registration: {
            deviceId: "device-1" as RelayLiveActivityRegistrationRequest["deviceId"],
            activityPushToken:
              activityPushToken as RelayLiveActivityRegistrationRequest["activityPushToken"],
          },
        }),
      );

    return Effect.gen(function* () {
      yield* register("current-token");
      yield* register("new-card-token");

      expect(insertedValues[0]).toMatchObject({ remoteStartedAt: armedAt });
      expect(conflictSets[0]).toMatchObject({ remoteStartedAt: armedAt, lastAggregateJson: null });
      expect(insertedValues[1]?.remoteStartedAt).not.toBe(armedAt);
      expect(conflictSets[1]?.remoteStartedAt).not.toBe(armedAt);
    }).pipe(
      Effect.provide(
        LiveActivities.layer.pipe(
          Layer.provide(policyUnitLayer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });

  it.live("preserves ended state when a delayed current-epoch update delivery is marked", () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('owner','allowed',1)",
      );
      pg.query(
        "INSERT INTO relay_mobile_devices(user_id,device_id,platform,preferences_json,account_epoch,created_at,updated_at) VALUES ('owner','phone','ios','{}',1,'now','now')",
      );
      pg.query(
        "INSERT INTO relay_live_activities(user_id,device_id,account_epoch,activity_push_token,ended_at,created_at,updated_at) VALUES ('owner','phone',1,'current-token','ended-before-update','now','now')",
      );
      yield* Effect.gen(function* () {
        const activities = yield* LiveActivities.LiveActivities;
        yield* activities
          .markDelivery({
            userId: "owner",
            deviceId: "phone",
            kind: "live_activity_update",
            aggregate,
            deliveredAt: aggregate.updatedAt,
          })
          .pipe(
            Effect.provideService(DeliveryContext, {
              userId: "owner",
              deviceId: "phone",
              accountEpoch: 1,
              token: "current-token",
              kind: "live_activity_update",
            }),
          );
        expect((yield* activities.listTargets({ userId: "owner" }))[0]).toMatchObject({
          ended_at: "ended-before-update",
          activity_push_token: "current-token",
          last_live_activity_delivery_at: aggregate.updatedAt,
        });
      }).pipe(Effect.provide(postgresPolicyLayer(pg)));
    }),
  );
});

it.live(
  "Android acknowledgements are visible to the next grouped job and obsolete epoch state is reset",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('owner','allowed',1)",
      );
      pg.query(
        "INSERT INTO relay_mobile_devices(user_id,device_id,platform,push_token,preferences_json,account_epoch,created_at,updated_at) VALUES ('owner','phone','android','same-token','{}',1,'now','now')",
      );
      yield* Effect.gen(function* () {
        const activities = yield* LiveActivities.LiveActivities;
        const target = {
          userId: "owner",
          deviceId: "phone",
          accountEpoch: 1,
          token: "same-token",
          kind: "push_notification" as const,
        };
        const mark = (epoch: number, state: RelayAgentActivityAggregateState) =>
          activities
            .markDelivery({
              userId: "owner",
              deviceId: "phone",
              kind: "push_notification",
              aggregate: state,
              deliveredAt: state.updatedAt,
            })
            .pipe(Effect.provideService(DeliveryContext, { ...target, accountEpoch: epoch }));
        const grouped = {
          ...aggregate,
          activeCount: 2,
          activities: [
            ...aggregate.activities,
            {
              ...aggregate.activities[0]!,
              threadId:
                "second" as RelayAgentActivityAggregateState["activities"][number]["threadId"],
            },
          ],
        };
        yield* mark(1, grouped);
        const [next] = yield* activities.listTargets({ userId: "owner" });
        expect(JSON.parse(next?.last_aggregate_json ?? "null")).toEqual(grouped);
        expect(next?.last_live_activity_delivery_at).toBe(grouped.updatedAt);
        yield* mark(1, aggregate);
        expect(
          JSON.parse(
            (yield* activities.listTargets({ userId: "owner" }))[0]?.last_aggregate_json ?? "null",
          ),
        ).toEqual(aggregate);
        pg.query(
          "UPDATE relay_account_access SET account_epoch=3; UPDATE relay_mobile_devices SET account_epoch=3; UPDATE relay_live_activities SET delivery_disabled_at=now(),activity_push_token='obsolete',remote_started_at='old',ended_at='old'",
        );
        yield* mark(3, grouped);
        const [fresh] = yield* activities.listTargets({ userId: "owner" });
        expect(JSON.parse(fresh?.last_aggregate_json ?? "null")).toEqual(grouped);
        expect(fresh?.activity_push_token).toBeNull();
        expect(fresh?.remote_started_at).toBeNull();
        expect(fresh?.ended_at).toBeNull();
        yield* mark(1, aggregate);
        expect(
          JSON.parse(
            (yield* activities.listTargets({ userId: "owner" }))[0]?.last_aggregate_json ?? "null",
          ),
        ).toEqual(grouped);
      }).pipe(Effect.provide(postgresPolicyLayer(pg)));
    }),
);

it.live(
  "a queued start replaces disabled bookkeeping without reviving the old activity token",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('owner','allowed',3)",
      );
      pg.query(
        "INSERT INTO relay_mobile_devices(user_id,device_id,platform,push_to_start_token,preferences_json,account_epoch,created_at,updated_at) VALUES ('owner','phone','ios','same-token','{}',3,'now','now')",
      );
      pg.query(
        "INSERT INTO relay_live_activities(user_id,device_id,account_epoch,activity_push_token,remote_start_queued_at,remote_started_at,delivery_disabled_at,created_at,updated_at) VALUES ('owner','phone',1,'obsolete','old','old',now(),'now','now')",
      );
      yield* Effect.gen(function* () {
        const activities = yield* LiveActivities.LiveActivities;
        yield* activities
          .markStartQueued({ userId: "owner", deviceId: "phone", queuedAt: aggregate.updatedAt })
          .pipe(
            Effect.provideService(DeliveryContext, {
              userId: "owner",
              deviceId: "phone",
              accountEpoch: 3,
              token: "same-token",
              kind: "live_activity_start",
            }),
          );
        expect((yield* activities.listTargets({ userId: "owner" }))[0]).toMatchObject({
          remote_start_queued_at: aggregate.updatedAt,
          remote_started_at: null,
          activity_push_token: null,
          last_aggregate_json: null,
        });
      }).pipe(Effect.provide(postgresPolicyLayer(pg)));
    }),
);
