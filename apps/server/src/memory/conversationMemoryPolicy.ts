import { TextGenerationError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import * as Generation from "../textGeneration/TextGeneration.ts";
import { MemoryWorkerError, safeCode } from "./MemoryWorkerError.ts";

export const setConversationMemoryEnabled = Effect.fn("ConversationMemoryPolicy.set")(function* (
  sql: SqlClient.SqlClient,
  enabled: boolean,
) {
  const value = enabled ? 1 : 0;
  yield* sql`INSERT INTO conversation_memory_policy (after_sequence, enabled)
    SELECT max(coalesce((SELECT max(sequence) FROM orchestration_events),0),
               coalesce((SELECT after_sequence FROM conversation_memory_policy ORDER BY generation DESC LIMIT 1),0)), ${value}
    WHERE ${value} != coalesce((SELECT enabled FROM conversation_memory_policy ORDER BY generation DESC LIMIT 1),1)`;
});

const readConversationMemoryPolicy = (sql: SqlClient.SqlClient) =>
  sql<{ generation: number; enabled: number }>`SELECT generation,enabled
    FROM conversation_memory_policy ORDER BY generation DESC LIMIT 1`.pipe(
    Effect.map((rows) => rows[0]),
  );

export const readConversationMemoryEnabled = (sql: SqlClient.SqlClient) =>
  readConversationMemoryPolicy(sql).pipe(Effect.map((row) => row?.enabled !== 0));

/** Generates a summary that rechecks the admitted policy after any wait for a provider update. */
export const admittedSummary =
  <E>(generation: Generation.TextGeneration["Service"], check: Effect.Effect<void, E>) =>
  (input: Generation.GenerateMemorySummaryInput) =>
    generation.generateMemorySummary(input).pipe(
      Effect.provideService(
        Generation.MemorySummaryDispatchCheck,
        check.pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: "generateMemorySummary",
                detail: safeCode(cause),
              }),
          ),
        ),
      ),
    );

// An off/on cycle must revoke a model call already in flight, even without intervening messages.
export const admitConversationSummary = Effect.fn("ConversationMemoryPolicy.admitSummary")(
  function* (sql: SqlClient.SqlClient) {
    const admitted = yield* readConversationMemoryPolicy(sql);
    if (admitted?.enabled === 0)
      return yield* new MemoryWorkerError({ code: "source_invalidated" });
    return readConversationMemoryPolicy(sql).pipe(
      Effect.flatMap((current) =>
        current?.generation === admitted?.generation
          ? Effect.void
          : Effect.fail(new MemoryWorkerError({ code: "source_invalidated" })),
      ),
    );
  },
);

// Channel requests can carry a paused origin from another environment, even before the first local pause.
export const readThreadConversationMemoryPolicy = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<{ generation: number; enabled: number }>`WITH latest AS (
    SELECT generation, enabled FROM conversation_memory_policy ORDER BY generation DESC LIMIT 1
  ) SELECT generation, enabled FROM latest
    UNION ALL SELECT 0, 1 WHERE NOT EXISTS (SELECT 1 FROM latest)
      AND EXISTS (SELECT 1 FROM conversation_memory_excluded_messages WHERE thread_id=${threadId})`.pipe(
    Effect.map((rows) => rows[0]),
  );
