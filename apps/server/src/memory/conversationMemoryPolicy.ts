import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import { MemoryWorkerError } from "./MemoryWorkerError.ts";

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

export const readConversationMemoryPolicy = (sql: SqlClient.SqlClient) =>
  sql<{ generation: number; enabled: number }>`SELECT generation,enabled
    FROM conversation_memory_policy ORDER BY generation DESC LIMIT 1`.pipe(
    Effect.map((rows) => rows[0]),
  );

export const readConversationMemoryEnabled = (sql: SqlClient.SqlClient) =>
  readConversationMemoryPolicy(sql).pipe(Effect.map((row) => row?.enabled !== 0));

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

export const hasConversationMemoryPauses = (sql: SqlClient.SqlClient) =>
  readConversationMemoryPolicy(sql).pipe(Effect.map((row) => row !== undefined));
