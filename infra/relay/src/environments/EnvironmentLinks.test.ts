import { createPostgresFixture } from "../accounts/test/PostgresFixture.ts";
import { postgresPolicyLayer } from "../accounts/test/PolicyPostgresLayers.ts";
import { AccountTransactions } from "../accounts/AccountTransactions.ts";
import { EnvironmentId } from "@goat/contracts";
import { EnvironmentCredentials } from "./EnvironmentCredentials.ts";
import type { RelayEnvironmentLinkProofPayload } from "@goat/contracts/relay";
import { policyUnitLayer } from "../accounts/test/PolicyUnitLayers.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PgDialect } from "drizzle-orm/pg-core";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks } from "../persistence/schema.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";

describe("EnvironmentLinks", () => {
  it.effect("carries the webhook-hold opt-in over only from links with the same key", () => {
    const inserted: Array<Record<string, unknown>> = [];
    const fakeDb = {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          return { onConflictDoUpdate: () => Effect.void };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      yield* links.upsert({
        userId: "user-1",
        request: {
          notificationsEnabled: false,
          liveActivitiesEnabled: false,
          managedTunnelsEnabled: true,
        } as never,
        proof: {
          environmentId: "env-1",
          environmentPublicKey: "public-key-1",
          descriptor: { label: "Laptop" },
        } as never,
        endpoint: { httpBaseUrl: "https://a.example", wsBaseUrl: "wss://a.example" } as never,
      });
      const query = new PgDialect().sqlToQuery(inserted[0]?.holdWebhooksWhileOffline as never);
      expect(query.sql).toContain("environment_public_key");
      expect(query.params).toEqual(["env-1", "public-key-1"]);
    }).pipe(
      Effect.provide(
        EnvironmentLinks.layer.pipe(
          Layer.provide(policyUnitLayer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });

  it.effect("revokes only the active link owned by the requesting user", () => {
    const updateValues: Array<Record<string, unknown>> = [];
    const whereConditions: Array<unknown> = [];
    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(relayEnvironmentLinks);
        return {
          set: (values: Record<string, unknown>) => {
            updateValues.push(values);
            return {
              where: (condition: unknown) => {
                whereConditions.push(condition);
                return {
                  returning: (selection: unknown) => {
                    expect(selection).toBeDefined();
                    return Effect.succeed([{ environmentId: "env-1" }]);
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const revoked = yield* links.revokeForUser({
        userId: "user-1",
        environmentId: "env-1",
      });

      expect(revoked).toBe(true);
      expect(updateValues).toHaveLength(1);
      expect(updateValues[0]?.revokedAt).toEqual(updateValues[0]?.updatedAt);
      expect(typeof updateValues[0]?.revokedAt).toBe("string");
      expect(whereConditions).toHaveLength(1);

      const dialect = new PgDialect();
      const query = dialect.sqlToQuery(whereConditions[0] as never);
      expect(query.sql).toContain('"relay_environment_links"."user_id" = $1');
      expect(query.sql).toContain('"relay_environment_links"."environment_id" = $2');
      expect(query.sql).toContain('"relay_environment_links"."revoked_at" is null');
      expect(query.params).toEqual(["user-1", "env-1"]);
    }).pipe(
      Effect.provide(
        EnvironmentLinks.layer.pipe(
          Layer.provide(policyUnitLayer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });
});

it.live(
  "final link contention includes publish-only links, permits refresh at cap, and rolls credentials back atomically",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('owner','allowed',1),('rollback','allowed',1)",
      );
      yield* Effect.gen(function* () {
        const links = yield* EnvironmentLinks.EnvironmentLinks;
        const credentials = yield* EnvironmentCredentials;
        const tx = yield* AccountTransactions;
        const link = (userId: string, id: string) =>
          links.upsert({
            userId,
            request: {
              proof: "fixture-link-proof",
              notificationsEnabled: true,
              liveActivitiesEnabled: false,
              managedTunnelsEnabled: false,
            },
            proof: {
              environmentId: EnvironmentId.make(id),
              environmentPublicKey: id,
              descriptor: { label: id },
            } as RelayEnvironmentLinkProofPayload,
            endpoint: {
              httpBaseUrl: "https://publish.example.test/",
              wsBaseUrl: "wss://publish.example.test/ws",
              providerKind: "manual",
            },
          });
        const outcomes = yield* Effect.forEach(
          ["a", "b"],
          (id) => link("owner", id).pipe(Effect.as(id), Effect.result),
          { concurrency: 2 },
        );
        expect(outcomes.filter((r) => r._tag === "Success")).toHaveLength(1);
        expect(outcomes.filter((r) => r._tag === "Failure").map((r) => r.failure._tag)).toEqual([
          "RelayAccountResourceLimitExceededError",
        ]);
        const winner = outcomes.find((r) => r._tag === "Success");
        if (winner?._tag !== "Success") throw new Error("Expected admitted link");
        yield* link("owner", winner.success);
        expect(
          pg
            .query(
              "SELECT count(*) FROM relay_environment_links WHERE user_id='owner' AND revoked_at IS NULL",
            )
            .trim(),
        ).toBe("1");
        pg.query(
          "CREATE FUNCTION reject_fixture_credentials() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture credential outage'; END $$; CREATE TRIGGER reject_fixture_credentials BEFORE INSERT ON relay_environment_credentials FOR EACH ROW EXECUTE FUNCTION reject_fixture_credentials()",
        );
        const failed = yield* tx
          .run(
            { userIds: ["rollback"], environmentPublicKey: "rollback-env" },
            link("rollback", "rollback-env").pipe(
              Effect.andThen(
                credentials.create({
                  userId: "rollback",
                  accountEpoch: 1,
                  environmentId: "rollback-env",
                  environmentPublicKey: "rollback-env",
                }),
              ),
            ),
          )
          .pipe(Effect.result);
        expect(failed._tag).toBe("Failure");
        expect(
          pg.query("SELECT count(*) FROM relay_environment_links WHERE user_id='rollback'").trim(),
        ).toBe("0");
        expect(
          pg.query("SELECT count(*) FROM relay_environment_owners WHERE user_id='rollback'").trim(),
        ).toBe("0");
      }).pipe(Effect.provide(postgresPolicyLayer(pg, { limits: { environmentLinks: 1 } })));
    }),
);
