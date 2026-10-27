import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import { Devices } from "./Devices.ts";
import { LiveActivities } from "./LiveActivities.ts";
import { AccountLifecycle } from "../accounts/AccountLifecycle.ts";
import { layerFor, config, signingConfig, state, aggregate } from "./ApnsDeliveries.testkit.ts";
import { makeApnsDeliveryJobPayload, signApnsDeliveryJob } from "./apnsDeliveryJobs.ts";
import * as ApnsDeliveryQueueConsumer from "./ApnsDeliveryQueueConsumer.ts";
import { HttpClientResponse } from "effect/http";
import type * as Cloudflare from "alchemy/Cloudflare";
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

it.live(
  "an in-flight APNs result cannot overwrite same-token registration after suspend and allow",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('owner','allowed',1)",
      );
      yield* Effect.gen(function* () {
        const authorization = yield* DeliveryAuthorization;
        const devices = yield* Devices;
        const activities = yield* LiveActivities;
        const lifecycle = yield* AccountLifecycle;
        const registration = {
          deviceId: "phone",
          label: "Fixture",
          platform: "ios" as const,
          iosMajorVersion: 18,
          bundleId: config.apns!.bundleId,
          apsEnvironment: "sandbox" as const,
          pushToken: "push-token",
          preferences: {
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
            notifyOnApproval: true,
            notifyOnInput: true,
            notifyOnCompletion: true,
            notifyOnFailure: true,
          },
        };
        const register = devices
          .register({ userId: "owner", registration })
          .pipe(
            Effect.andThen(
              activities.register({
                userId: "owner",
                registration: { deviceId: "phone", activityPushToken: "same-token" },
              }),
            ),
          );
        yield* register;
        const now = yield* DateTime.now;
        const current = { ...state, updatedAt: DateTime.formatIso(now) };
        const payload = makeApnsDeliveryJobPayload({
          accountEpoch: 1,
          kind: "live_activity_update",
          userId: "owner",
          deviceId: "phone",
          token: "same-token",
          aggregate: {
            ...aggregate,
            updatedAt: current.updatedAt,
            activities: [{ ...aggregate.activities[0]!, updatedAt: current.updatedAt }],
          },
          createdAt: current.updatedAt,
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
          jobId: "in-flight-old",
        });
        const job = signApnsDeliveryJob({ secret: config.apnsDeliveryJobSigningSecret, payload });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let acked = false;
        const message: Cloudflare.Queues.Message<unknown> = {
          id: "fixture",
          body: job,
          timestamp: DateTime.toDateUtc(now),
          attempts: 1,
          ack: () => {
            acked = true;
          },
          retry: () => {
            throw new Error("A stale successful transport should not retry");
          },
        };
        const deliveries = layerFor({
          config: signingConfig,
          authorization,
          activities,
          attempts: [],
          activityStates: [current],
          execute: (request) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
            ),
        });
        const sending = yield* ApnsDeliveryQueueConsumer.processMessage(message).pipe(
          Effect.provide(deliveries),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        const suspend = yield* lifecycle.request({
          userId: "owner",
          kind: "suspend",
          idempotencyKey: "suspend",
        });
        yield* lifecycle.resume(suspend.id);
        yield* lifecycle.request({ userId: "owner", kind: "allow", idempotencyKey: "allow" });
        yield* register;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(sending);
        expect(acked).toBe(true);
        expect((yield* activities.listTargets({ userId: "owner" }))[0]).toMatchObject({
          account_epoch: 3,
          activity_push_token: "same-token",
          last_aggregate_json: null,
          last_live_activity_delivery_at: null,
        });
      }).pipe(Effect.provide(postgresPolicyLayer(pg)));
    }),
);
