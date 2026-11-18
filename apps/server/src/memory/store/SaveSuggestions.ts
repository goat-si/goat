import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { stored } from "./StoreCodecs.ts";

export const suggestionForgetGeneration = Effect.fn("MemorySuggestions.forgetGeneration")(
  function* (space: M.MemorySpaceId) {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* stored(
      "suggestion-generation",
      sql<{
        forget_generation: number;
      }>`SELECT forget_generation FROM memory_space_counters WHERE space=${space}`,
    );
    return row?.forget_generation ?? 0;
  },
);

export const purgeSpaceSuggestions = Effect.fn("MemorySuggestions.purgeOnForget")(function* (
  sql: SqlClient.SqlClient,
  space: M.MemorySpaceId,
) {
  yield* stored(
    "suggestion-forget-fence",
    sql`INSERT INTO memory_space_counters (space, forget_generation) VALUES (${space}, 1)
      ON CONFLICT(space) DO UPDATE SET forget_generation=forget_generation+1`,
  );
  yield* stored(
    "suggestion-forget-purge",
    sql`DELETE FROM memory_save_suggestions WHERE space=${space}`,
  );
});

export const expireMemorySuggestions = Effect.fn("MemorySuggestions.expire")(function* (
  sql: SqlClient.SqlClient,
) {
  const now = yield* Clock.currentTimeMillis;
  yield* stored(
    "suggestions-expire",
    sql`DELETE FROM memory_save_suggestions WHERE expires_at<=${now}`,
  );
});
