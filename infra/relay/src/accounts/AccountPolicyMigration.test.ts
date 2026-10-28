// @effect-diagnostics nodeBuiltinImport:off -- Isolated persistence tests own synchronous fixture files.
import { describe, expect, it } from "@effect/vitest";
import { createPostgresFixture } from "./test/PostgresFixture.ts";

describe("account policy migration on isolated PostgreSQL", () => {
  it("fresh chain creates denied-by-default access and constrained lifecycle records", () => {
    using pg = createPostgresFixture();
    pg.migrate();
    expect(pg.query("SELECT count(*) FROM relay_account_access").trim()).toBe("0");
    expect(() =>
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('fixture','allowed',0)",
      ),
    ).toThrow();
    expect(() =>
      pg.query("INSERT INTO relay_managed_tunnel_limits VALUES ('fixture',-1,'now','now')"),
    ).toThrow();
  });
  it("upgrade retains legacy trust as unscoped and preserves labels and held capacity", () => {
    using pg = createPostgresFixture();
    pg.migrate("20261020013101_upstream_api_pauses");
    pg.query(
      "INSERT INTO relay_managed_endpoint_allocations(user_id,environment_id,hostname,tunnel_name,created_at,updated_at) VALUES ('fixture','env','prod-0123456789abcdef.example.test','goatrelay-managedendpoint-prod-0123456789abcdef','now','now')",
    );
    pg.migrate(undefined, "20261020013101_upstream_api_pauses");
    expect(pg.query("SELECT high_water_generation FROM relay_endpoint_identities").trim()).toBe(
      "0",
    );
    expect(
      pg
        .query(
          "SELECT count(*) FROM relay_managed_endpoint_allocations WHERE account_epoch IS NULL AND capacity_released_at IS NULL AND incarnation_id IS NOT NULL",
        )
        .trim(),
    ).toBe("1");
    expect(pg.query("SELECT count(*) FROM relay_account_access").trim()).toBe("0");
  });
  it("upgrade after the Connect auth migrations keeps allocation incarnations and retires relay_connect_accounts", () => {
    using pg = createPostgresFixture();
    pg.migrate("20261028010000_connect_link_recovery");
    pg.query(
      "INSERT INTO relay_managed_endpoint_allocations(user_id,environment_id,hostname,tunnel_name,created_at,updated_at) VALUES ('fixture','env','prod-0123456789abcdef.example.test','goatrelay-managedendpoint-prod-0123456789abcdef','now','now')",
    );
    pg.query(
      "INSERT INTO relay_connect_accounts(user_id,generation,status) VALUES ('fixture',1,'active')",
    );
    const incarnation = pg
      .query("SELECT incarnation_id FROM relay_managed_endpoint_allocations")
      .trim();
    pg.migrate(undefined, "20261028010000_connect_link_recovery");
    expect(pg.query("SELECT incarnation_id FROM relay_managed_endpoint_allocations").trim()).toBe(
      incarnation,
    );
    expect(
      pg
        .query(
          "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid='relay_managed_endpoint_allocations'::regclass AND i.indisprimary",
        )
        .trim(),
    ).toBe("incarnation_id");
    expect(pg.query("SELECT to_regclass('relay_connect_accounts') IS NULL").trim()).toBe("t");
    expect(pg.query("SELECT count(*) FROM relay_account_access").trim()).toBe("0");
  });
});
