import * as Effect from "effect/Effect";
import hubMigration from "../../persistence/Migrations/099_MemoryHubSync.ts";
import threadLineageMigration from "../../persistence/Migrations/158_MemoryThreadLineage.ts";

import floorMigration from "../../persistence/Migrations/159_MemoryHubFloor.ts";

export default hubMigration.pipe(
  Effect.andThen(threadLineageMigration),
  Effect.andThen(floorMigration),
);
