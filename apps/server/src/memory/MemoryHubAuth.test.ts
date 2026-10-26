import lineageMigration from "../persistence/Migrations/081_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/082_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/094_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/083_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/084_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/085_MemoryRevertResults.ts";
import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import migration from "../persistence/Migrations/077_Memory.ts";
import hubMigration from "../persistence/Migrations/078_MemoryHubSync.ts";
import * as Store from "./MemoryStore.ts";
import * as Auth from "./MemoryHubAuth.ts";

const space = M.MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
const member = M.EnvironmentId.make("synthetic-member");
const credential = "a".repeat(43);
const database = NodeSqliteClient.layer({ filename: ":memory:" });
const setup = Layer.effectDiscard(
  migration.pipe(
    Effect.andThen(hubMigration),
    Effect.andThen(lineageMigration),
    Effect.andThen(checkpointMigration),
    Effect.andThen(revisionSizeMigration),
    Effect.andThen(reportMigration),
    Effect.andThen(usageMigration),
    Effect.andThen(revertMigration),
  ),
).pipe(Layer.provideMerge(database));
const live = Auth.layer.pipe(
  Layer.provideMerge(Store.layer.pipe(Layer.provideMerge(setup))),
  Layer.provideMerge(NodeServices.layer),
);
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const digest = Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(credential)));
  yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${member},${digest},1,'active',NULL)`;
});

it.effect("only a dedicated bearer yields the member's sync-only principal", () =>
  Effect.gen(function* () {
    yield* seed;
    const auth = yield* Auth.MemoryHubAuth;
    for (const header of [
      undefined,
      "",
      "cookie=dev",
      "Basic abc",
      "Bearer dev-token",
      `Bearer ${credential},other`,
      `Bearer ${credential} extra`,
      `Bearer ${"b".repeat(43)}`,
    ]) {
      const result = yield* Effect.result(auth.authenticate(header));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.strictEqual(result.failure._tag, "MemoryHubUnauthorizedError");
    }
    assert.deepStrictEqual(yield* auth.authenticate(`Bearer ${credential}`), {
      environmentId: member,
      memorySpaceId: space,
      credentialVersion: 1,
      scopes: ["memory:sync"],
    });
  }).pipe(Effect.provide(live)),
);

it.effect("a principal captured before rotation or revoke fails transaction reauthorization", () =>
  Effect.gen(function* () {
    yield* seed;
    const auth = yield* Auth.MemoryHubAuth;
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const principal = yield* auth.authenticate(`Bearer ${credential}`);
    yield* store.transact(auth.reauthorize(principal));
    yield* sql`UPDATE memory_hub_members SET credential_version=2 WHERE space=${space}`;
    assert.strictEqual(
      (yield* Effect.result(store.transact(auth.reauthorize(principal))))._tag,
      "Failure",
    );
    yield* sql`UPDATE memory_hub_members SET status='revoked' WHERE space=${space}`;
    const result = yield* Effect.result(auth.authenticate(`Bearer ${credential}`));
    assert.strictEqual(result._tag, "Failure");
  }).pipe(Effect.provide(live)),
);
