import * as Effect from "effect/Effect";
import hubMigration from "../../persistence/Migrations/099_MemoryHubSync.ts";
import threadLineageMigration from "../../persistence/Migrations/159_MemoryThreadLineage.ts";
import suggestionsMigration from "../../persistence/Migrations/160_MemorySaveSuggestions.ts";
import floorMigration from "../../persistence/Migrations/161_MemoryHubFloor.ts";

import moveMigration from "../../persistence/Migrations/162_MemoryScopeVersion.ts";
import originCatchupMigration from "../../persistence/Migrations/164_MemoryOriginCatchup.ts";
import suggestionQuotaMigration from "../../persistence/Migrations/165_MemorySuggestionQuota.ts";

export default hubMigration.pipe(
  Effect.andThen(threadLineageMigration),
  Effect.andThen(suggestionsMigration),
  Effect.andThen(floorMigration),
  Effect.andThen(moveMigration),
  Effect.andThen(originCatchupMigration),
  Effect.andThen(suggestionQuotaMigration),
);
