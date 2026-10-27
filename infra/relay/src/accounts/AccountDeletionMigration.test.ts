// @effect-diagnostics nodeBuiltinImport:off -- Private PostgreSQL migration fixture only.
import { it, expect } from "@effect/vitest";
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
