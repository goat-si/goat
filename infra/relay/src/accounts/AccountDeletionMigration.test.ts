// @effect-diagnostics nodeBuiltinImport:off -- Private PostgreSQL migration fixture only.
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AccountLifecycle } from "./AccountLifecycle.ts";
import { subjectDigest } from "./SubjectDigest.ts";
import { postgresPolicyLayer } from "./test/PolicyPostgresLayers.ts";
import { createPostgresFixture } from "./test/PostgresFixture.ts";

it("wp3 upgrade preserves active data and requires hash authority before raw identity can be erased", () => {
  using pg = createPostgresFixture();
  const base = "20261028110200_account_operation_idempotency";
  pg.migrate(base);
  pg.query(
    "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('legacy','allowed',1)",
  );
  pg.migrate(undefined, base);
  expect(pg.query("SELECT user_id||':'||status FROM relay_account_access").trim()).toBe(
    "legacy:allowed",
  );
  expect(() =>
    pg.query("UPDATE relay_account_access SET status='deleted',user_id=NULL,relay_erased_at=now()"),
  ).toThrow();
  expect(pg.query("SELECT user_id FROM relay_account_access").trim()).toBe("legacy");
  pg.query(
    "UPDATE relay_account_access SET subject_digest='fixture-digest',status='deleted',user_id=NULL,relay_erased_at=now()",
  );
  expect(pg.query("SELECT count(*) FROM relay_host_revocations").trim()).toBe("0");
  expect(pg.query("SELECT status FROM relay_account_access").trim()).toBe("deleted");
});

it.live(
  "operator readback sees untouched wp3 allowed, suspended and pending accounts after upgrade",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      const base = "20261028110200_account_operation_idempotency";
      pg.migrate(base);
      pg.query(`
      INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES
        ('legacy-allowed','allowed',1),('legacy-suspended','suspended',2),('legacy-pending','suspended',3);
      INSERT INTO relay_account_operations(id,user_id,kind,account_epoch,expected_epoch,idempotency_key,request_hash,state,step_state)
        VALUES ('10000000-0000-4000-8000-000000000001','legacy-pending','suspend',3,2,'fixture-key','fixture','pending','{}');
    `);
      pg.migrate(undefined, base);
      yield* Effect.gen(function* () {
        const lifecycle = yield* AccountLifecycle;
        expect(yield* lifecycle.getAccount("legacy-allowed")).toMatchObject({
          status: "allowed",
          accountEpoch: 1,
          operations: [],
        });
        expect(yield* lifecycle.getAccount("legacy-suspended")).toMatchObject({
          status: "suspended",
          accountEpoch: 2,
          operations: [],
        });
        const pending = yield* lifecycle.getAccount("legacy-pending");
        expect(pending).toMatchObject({ status: "suspended", accountEpoch: 3 });
        expect(pending.operations).toHaveLength(1);
        expect(pending.operations[0]).toMatchObject({ kind: "suspend", state: "pending" });
        expect(
          pg
            .query("SELECT count(*) FROM relay_account_access WHERE subject_digest IS NOT NULL")
            .trim(),
        ).toBe("0");
        const digest = yield* subjectDigest("legacy-allowed");
        pg.query(
          `UPDATE relay_account_access SET subject_digest='${digest}',status='deleted',user_id=NULL,relay_erased_at=now() WHERE user_id='legacy-allowed'`,
        );
        expect(yield* lifecycle.getAccount("legacy-allowed")).toMatchObject({
          status: "deleted",
          accountEpoch: 1,
        });
        expect(
          (yield* Effect.flip(
            lifecycle.request({
              userId: "legacy-allowed",
              kind: "allow",
              idempotencyKey: "cannot-reinvite",
            }),
          )).code,
        ).toBe("account_deleted");
      }).pipe(Effect.provide(postgresPolicyLayer(pg)));
    }),
);
