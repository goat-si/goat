import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { createPostgresFixture } from "../accounts/test/PostgresFixture.ts";
import { postgresPolicyLayer } from "../accounts/test/PolicyPostgresLayers.ts";
import { EnvironmentOwnership } from "./EnvironmentOwnership.ts";
import { EnvironmentCredentials } from "./EnvironmentCredentials.ts";
import { RelayDb } from "../db.ts";

it.live(
  "one account wins a public key and only its current epoch can rotate or authenticate credentials",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('owner-a','allowed',1),('owner-b','allowed',1)",
      );
      yield* Effect.gen(function* () {
        const owners = yield* EnvironmentOwnership;
        const credentials = yield* EnvironmentCredentials;
        const db = yield* RelayDb;
        const sql = db.$client;
        const outcomes = yield* Effect.all(
          ["owner-a", "owner-b"].map((userId) =>
            owners
              .claim({
                userId,
                accountEpoch: 1,
                environmentId: "env-shared",
                environmentPublicKey: "fixture-key",
              })
              .pipe(Effect.as(userId), Effect.result),
          ),
          { concurrency: 2 },
        );
        const success = outcomes.find((r) => r._tag === "Success");
        if (success?._tag !== "Success") throw new Error("Expected one owner");
        expect(outcomes.filter((r) => r._tag === "Success")).toHaveLength(1);
        expect(outcomes.filter((r) => r._tag === "Failure").map((r) => r.failure)).toEqual([
          expect.objectContaining({
            _tag: "RelayEnvironmentOwnerConflictError",
            code: "environment_owner_conflict",
          }),
        ]);
        const userId = success.success;
        const other = userId === "owner-a" ? "owner-b" : "owner-a";
        yield* sql`UPDATE relay_environment_owners SET state='active' WHERE user_id=${userId}`;
        yield* sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,account_epoch,created_at,updated_at) VALUES (${userId},'env-shared','fixture-key','https://env.example.test','wss://env.example.test/ws','manual',1,'now','now')`;
        const input = {
          userId,
          accountEpoch: 1,
          environmentId: "env-shared",
          environmentPublicKey: "fixture-key",
        };
        const token = yield* credentials.create(input);
        expect(Option.isSome(yield* credentials.authenticate(token))).toBe(true);
        expect((yield* Effect.flip(credentials.create({ ...input, userId: other })))._tag).toBe(
          "RelayEnvironmentOwnerMismatchError",
        );
        yield* credentials.revokeForEnvironmentPublicKey({ ...input, userId: other });
        expect(Option.isSome(yield* credentials.authenticate(token))).toBe(true);
        yield* sql`UPDATE relay_account_access SET account_epoch=3 WHERE user_id=${userId}`;
        expect((yield* Effect.flip(credentials.authenticate(token)))._tag).toBe(
          "RelayAccountEpochStaleError",
        );
      }).pipe(Effect.provide(postgresPolicyLayer(pg)));
    }),
);
