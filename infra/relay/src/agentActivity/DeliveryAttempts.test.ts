import { createPostgresFixture } from "../accounts/test/PostgresFixture.ts";
import { postgresPolicyLayer } from "../accounts/test/PolicyPostgresLayers.ts";
import { AccountLifecycle } from "../accounts/AccountLifecycle.ts";
import { policyUnitLayer } from "../accounts/test/PolicyUnitLayers.ts";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";

describe("DeliveryAttempts", () => {
  it.effect("reports completed source jobs when the durable claim already exists", () => {
    const fakeDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Effect.succeed([]),
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Effect.succeed([
                {
                  createdAt: "2026-05-26T00:00:00.000Z",
                  apnsStatus: 200,
                  apnsReason: null,
                  apnsId: null,
                  transportError: null,
                },
              ]),
          }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      const claimed = yield* attempts.claimSourceJob({
        accountEpoch: 1,
        userId: "user-1",
        environmentId: null,
        threadId: null,
        deviceId: "device-1",
        kind: "live_activity_update",
        sourceJobId: "job-1",
        token: "apns-token",
      });

      expect(claimed).toBe("completed");
    }).pipe(
      Effect.provide(
        DeliveryAttempts.layer.pipe(
          Layer.provide(policyUnitLayer),
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });

  it.effect("reports in-flight source jobs while an active claim lease exists", () => {
    const fakeDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Effect.succeed([]),
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Effect.succeed([
                {
                  createdAt: "2999-01-01T00:00:00.000Z",
                  apnsStatus: null,
                  apnsReason: null,
                  apnsId: null,
                  transportError: null,
                },
              ]),
          }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      const claimed = yield* attempts.claimSourceJob({
        accountEpoch: 1,
        userId: "user-1",
        environmentId: null,
        threadId: null,
        deviceId: "device-1",
        kind: "live_activity_update",
        sourceJobId: "job-1",
        token: "apns-token",
      });

      expect(claimed).toBe("in_flight");
    }).pipe(
      Effect.provide(
        DeliveryAttempts.layer.pipe(
          Layer.provide(policyUnitLayer),
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });

  it.effect("reclaims source jobs after the claim lease expires", () => {
    const updatedValues: Array<Record<string, unknown>> = [];
    const fakeDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Effect.succeed([]),
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Effect.succeed([
                {
                  createdAt: "1969-12-31T23:00:00.000Z",
                  apnsStatus: null,
                  apnsReason: null,
                  apnsId: null,
                  transportError: null,
                },
              ]),
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updatedValues.push(values);
          return {
            where: () => ({
              returning: () => Effect.succeed([{ id: "attempt-1" }]),
            }),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      const claimed = yield* attempts.claimSourceJob({
        accountEpoch: 1,
        userId: "user-1",
        environmentId: null,
        threadId: null,
        deviceId: "device-1",
        kind: "live_activity_update",
        sourceJobId: "job-1",
        token: "apns-token",
      });

      expect(claimed).toBe("claimed");
      expect(updatedValues[0]?.createdAt).toEqual(expect.any(String));
    }).pipe(
      Effect.provide(
        DeliveryAttempts.layer.pipe(
          Layer.provide(policyUnitLayer),
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });
});

it.live(
  "completion cannot update a stale epoch or erased owner and current-epoch completion persists",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      yield* Effect.gen(function* () {
        const lifecycle = yield* AccountLifecycle;
        const attempts = yield* DeliveryAttempts.DeliveryAttempts;
        for (const userId of ["completion-owner", "erased-owner"]) {
          yield* lifecycle.request({ userId, kind: "allow", idempotencyKey: "invite" });
          yield* attempts.claimSourceJob({
            userId,
            accountEpoch: 1,
            sourceJobId: userId,
            kind: "push",
            environmentId: null,
            threadId: null,
            deviceId: null,
            token: "fixture-token",
          });
        }
        pg.query(
          "UPDATE relay_account_access SET account_epoch=2 WHERE user_id='completion-owner'",
        );
        yield* attempts.completeSourceJob({ sourceJobId: "completion-owner", apnsStatus: 200 });
        expect(
          pg
            .query("SELECT count(*) FROM relay_delivery_attempts WHERE apns_status IS NOT NULL")
            .trim(),
        ).toBe("0");
        yield* attempts.claimSourceJob({
          userId: "completion-owner",
          accountEpoch: 2,
          sourceJobId: "current",
          kind: "push",
          environmentId: null,
          threadId: null,
          deviceId: null,
          token: "fixture-token",
        });
        yield* attempts.completeSourceJob({ sourceJobId: "current", apnsStatus: 200 });
        expect(
          pg
            .query("SELECT apns_status FROM relay_delivery_attempts WHERE source_job_id='current'")
            .trim(),
        ).toBe("200");
        const deletion = yield* lifecycle.requestDelete({
          userId: "erased-owner",
          idempotencyKey: "delete",
        });
        if (deletion.status !== "progress") throw new Error("Expected accepted deletion");
        expect((yield* lifecycle.resume(deletion.operationId)).state).toBe("completed");
        yield* attempts.completeSourceJob({ sourceJobId: "erased-owner", apnsStatus: 200 });
        expect(
          pg
            .query(
              "SELECT count(*) FROM relay_delivery_attempts WHERE source_job_id='erased-owner'",
            )
            .trim(),
        ).toBe("0");
      }).pipe(Effect.provide(postgresPolicyLayer(pg)));
    }),
);
