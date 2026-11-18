import * as Effect from "effect/Effect";
import hubMigration from "../../persistence/Migrations/099_MemoryHubSync.ts";
import threadLineageMigration from "../../persistence/Migrations/158_MemoryThreadLineage.ts";
import suggestionsMigration from "../../persistence/Migrations/159_MemorySaveSuggestions.ts";
import floorMigration from "../../persistence/Migrations/160_MemoryHubFloor.ts";

import moveMigration from "../../persistence/Migrations/161_MemoryScopeVersion.ts";

export default hubMigration.pipe(
  Effect.andThen(threadLineageMigration),
  Effect.andThen(suggestionsMigration),
  Effect.andThen(floorMigration),
  Effect.andThen(moveMigration),
);
