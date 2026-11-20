import * as Settings from "../../serverSettings.ts";
import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../../persistence/Migrations/098_Memory.ts";
import hubMigration from "../testkit/MemoryHubTestMigration.ts";
import searchMigration from "../../persistence/Migrations/100_MemorySearchCounters.ts";
import checkpointMigration from "../../persistence/Migrations/103_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../../persistence/Migrations/115_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../../persistence/Migrations/104_MemoryReportLifecycle.ts";
import usageMigration from "../../persistence/Migrations/105_MemoryUsageCounters.ts";
import revertMigration from "../../persistence/Migrations/106_MemoryRevertResults.ts";
import lineageMigration from "../../persistence/Migrations/102_MemoryImportLineage.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as RepositoryResolver from "../../project/RepositoryIdentityResolver.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Quota from "../MemoryQuotaService.ts";
import * as Service from "../MemoryService.ts";
import * as Store from "../MemoryStore.ts";
import type { ImportSnapshot } from "./MemoryImportTypes.ts";
import { snapshotMemoryImportFiles } from "./MemoryImportFixtures.fixture.ts";
import { space, environmentId } from "./ProviderMemoryImport.testkit.ts";
const database = Layer.effectDiscard(
  migration.pipe(
    Effect.andThen(hubMigration),
    Effect.andThen(searchMigration),
    Effect.andThen(lineageMigration),
    Effect.andThen(checkpointMigration),
    Effect.andThen(revisionSizeMigration),
    Effect.andThen(reportMigration),
    Effect.andThen(usageMigration),
    Effect.andThen(revertMigration),
  ),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
export const serviceLive = (
  resolve: RepositoryResolver.RepositoryIdentityResolver["Service"]["resolve"],
) =>
  Service.layer.pipe(
    Layer.provide(
      Layer.succeed(Settings.MemoryHubCommittedSettings, {
        read: Effect.succeed({
          provenance: null,
          settings: { mode: "hub" as const, memorySpaceId: space },
          version: 1,
        }),
      }),
    ),
    Layer.provide(
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provide(
      Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
        resolve,
      }),
    ),
    Layer.provideMerge(
      Quota.layer.pipe(Layer.provideMerge(Store.layer.pipe(Layer.provideMerge(database)))),
    ),
  );
export const live = serviceLive(() => Effect.succeed(null));

export const setupProjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`;
  yield* sql`INSERT INTO projection_projects VALUES ('synthetic-a','/synthetic/a',NULL),('synthetic-z','/synthetic/z',NULL)`;
  yield* sql`INSERT INTO memory_compaction_state(space,published) VALUES (${space},1)`;
});

export const batchSnapshot = (s: ImportSnapshot) => {
  const sample = s.files[0];
  if (!sample) throw new Error("The import fixture needs a sample file");
  return snapshotMemoryImportFiles(
    s,
    ["a", "b", "z"].map((key) => ({
      ...sample,
      selector: `extensions/ad_hoc/notes/${key}.md`,
      text: `${key} guidance`,
      byteCount: 10,
    })),
  );
};
