import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { MemoryRefusedSaveHook } from "./MemoryRemember.ts";
import { redactMemoryText, scanMemoryValue } from "./MemorySecretScanner.ts";
import type { MemoryAccessError } from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import type { makeUpsert } from "./MemoryUpsert.ts";
import { suggestionForgetGeneration } from "./store/SaveSuggestions.ts";
import { scopeCodec, stored, codec } from "./store/StoreCodecs.ts";

const revisionsCodec = codec(
  Schema.Array(M.MemoryRevisionId).check(Schema.isMaxLength(M.MEMORY_DERIVED_REVISIONS_MAX)),
);
const strict = { onExcessProperty: "error" } as const;

interface SuggestionRow {
  readonly id: string;
  readonly origin_environment_id: string;
  readonly origin_thread_id: string;
  readonly text: string;
  readonly scope_json: string;
  readonly derived_json: string;
  readonly lineage_complete: number;
  readonly reason: M.MemoryFailureCode;
  readonly forget_generation: number;
  readonly expires_at: number;
  readonly state: "pending" | "accepting";
  readonly attempt: number;
}

type Permit = Effect.Effect<void, MemoryAccessError>;

export const makeMemorySaveSuggestions = ({
  sql,
  store,
  requireSharing,
  stableUuid,
}: {
  readonly sql: SqlClient.SqlClient;
  readonly store: Store.MemoryStore["Service"];
  readonly requireSharing: (space: M.MemorySpaceId) => Permit;
  readonly stableUuid: (input: string) => string;
}) => {
  const readGeneration = (space: M.MemorySpaceId) =>
    suggestionForgetGeneration(space).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const dismissRow = (space: M.MemorySpaceId, id: M.MemoryId) =>
    stored(
      "suggestion-delete",
      sql`DELETE FROM memory_save_suggestions WHERE space=${space} AND id=${id}`,
    );
  const onRefusedSave: MemoryRefusedSaveHook["Service"]["onRefusedSave"] = Effect.fn(
    "MemorySuggestions.onRefusedSave",
  )(function* (candidate, permit) {
    const { input, thread, reason, knownRevisions, lineageComplete, forgetGeneration } = candidate;
    const {
      memorySpaceId: space,
      memoryId: id,
      scope,
      payload: { text },
    } = input;
    if (
      reason === "source_invalidated" ||
      knownRevisions.length > M.MEMORY_DERIVED_REVISIONS_MAX ||
      scanMemoryValue(text).kind !== "allowed" ||
      redactMemoryText({ text }).text !== text
    )
      return;
    const derived = yield* stored("suggestion-dependencies", revisionsCodec.encode(knownRevisions));
    const encodedScope = yield* stored("suggestion-scope", scopeCodec.encode(scope));
    yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        yield* requireSharing(space);
        if ((yield* readGeneration(space)) !== forgetGeneration) return;
        const current = yield* store.loadAggregate(space, id, {}, {});
        if (current.identity || current.tombstone) return;
        const now = yield* Clock.currentTimeMillis;
        yield* stored(
          "suggestion-expire-space",
          sql`DELETE FROM memory_save_suggestions WHERE space=${space} AND expires_at<=${now}`,
        );
        yield* stored(
          "suggestion-insert",
          sql`
          INSERT INTO memory_save_suggestions
            (id, space, origin_environment_id, origin_thread_id, text, scope_json, derived_json,
              lineage_complete, reason, forget_generation, created_at, expires_at)
          VALUES (${id},${space},${thread.environmentId},${thread.threadId},${text},${encodedScope},${derived},
            ${Number(lineageComplete)},${reason},${forgetGeneration},${now},${now + M.MEMORY_SAVE_SUGGESTION_TTL_MS})
          ON CONFLICT(id) DO NOTHING`,
        );
        yield* stored(
          "suggestion-evict",
          sql`DELETE FROM memory_save_suggestions WHERE id IN (
          SELECT id FROM memory_save_suggestions WHERE space=${space}
          ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ${M.MEMORY_SAVE_SUGGESTION_MAX_ITEMS}
        )`,
        );
      }),
    );
  });

  const project = Effect.fn("MemorySuggestions.project")(function* (row: SuggestionRow) {
    return {
      suggestionId: M.MemoryId.make(row.id),
      origin: {
        environmentId: M.EnvironmentId.make(row.origin_environment_id),
        threadId: M.ThreadId.make(row.origin_thread_id),
      },
      scope: yield* stored("suggestion-scope", scopeCodec.decode(row.scope_json, strict)),
      reason: row.reason,
      lineageComplete: row.lineage_complete === 1,
      expiresAt: row.expires_at,
      state: row.state,
    };
  });
  const list = Effect.fn("MemorySuggestions.list")(function* (
    input: M.MemorySuggestionsInput,
    permit: Permit,
  ) {
    const space = input.memorySpaceId;
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        yield* requireSharing(space);
        const now = yield* Clock.currentTimeMillis;
        const rows = yield* stored(
          "suggestion-list",
          sql<SuggestionRow>`
        SELECT * FROM memory_save_suggestions WHERE space=${space} AND expires_at>${now}
        ORDER BY created_at DESC, id DESC LIMIT ${M.MEMORY_SAVE_SUGGESTION_MAX_ITEMS}`,
        );
        const result = yield* Effect.forEach(rows, (row) =>
          project(row).pipe(Effect.map((metadata) => ({ ...metadata, text: row.text }))),
        );
        yield* permit;
        return result;
      }),
    );
  });
  const listMetadata = Effect.fn("MemorySuggestions.listMetadata")(function* (
    input: M.MemorySuggestionsInput,
    permit: Permit,
  ) {
    const rows = yield* list(input, permit);
    return rows.map(({ text: _text, ...metadata }) => metadata);
  });

  const accept = Effect.fn("MemorySuggestions.accept")(function* (
    input: M.MemorySuggestionActionInput,
    permit: Permit,
    writeAcceptedSuggestion: ReturnType<typeof makeUpsert>,
  ): Effect.fn.Return<
    M.MemorySuggestionAcceptResult,
    | Store.MemoryStorageError
    | Store.MemoryStoreConflict
    | MemoryAccessError
    | Store.MemoryCapacityError
  > {
    const { memorySpaceId: space, suggestionId: id } = input;
    const operationFor = (attempt: number) =>
      M.MemoryOperationId.make(stableUuid(`accept-suggestion:${space}:${id}:${attempt}`));
    return yield* store
      .transact(
        Effect.gen(function* () {
          yield* permit;
          yield* requireSharing(space);
          const now = yield* Clock.currentTimeMillis;
          const [row] = yield* stored(
            "suggestion-load",
            sql<SuggestionRow>`
        SELECT * FROM memory_save_suggestions WHERE space=${space} AND id=${id} AND expires_at>${now}`,
          );
          if (!row) {
            const current = yield* store.loadAggregate(space, id, {}, {});
            if (
              current.identity &&
              current.item?.status === "active" &&
              current.item.localAvailability.exposure === "visible" &&
              !current.tombstone
            ) {
              const prior = yield* store.receipt(space, current.identity.createOperationId);
              if (prior?.receipt.outcome === "accepted") {
                const pending = "pendingSync" in prior.receipt && prior.receipt.pendingSync;
                return { status: pending ? ("pending" as const) : ("accepted" as const) };
              }
            }
            return { status: "refused" as const, reason: "source_invalidated" as const };
          }
          if ((yield* readGeneration(space)) !== row.forget_generation)
            return { status: "refused" as const, reason: "source_invalidated" as const };
          if (row.state === "accepting") return { status: "pending" as const };
          const suggestion = yield* project(row);
          if (
            scanMemoryValue(row.text).kind !== "allowed" ||
            redactMemoryText({ text: row.text }).text !== row.text
          )
            return yield* new Store.MemoryStoreConflict({ code: "secret_detected" });
          const operationId = operationFor(row.attempt);
          const revisions = yield* stored(
            "suggestion-dependencies",
            revisionsCodec.decode(row.derived_json, strict),
          );
          const result = yield* writeAcceptedSuggestion(
            {
              memorySpaceId: space,
              memoryId: id,
              expectedHeads: [],
              operationId,
              scope: suggestion.scope,
              assertionKind: "inference",
              baseBoundary: null,
              payload: { text: row.text, evidence: [], derivedFromMemoryRevisions: revisions },
            },
            permit,
            suggestion.origin,
            {
              allowUnverified: false,
              acceptedSuggestion: { lineageComplete: suggestion.lineageComplete },
            },
          );
          if (result.receipt.outcome === "rejected")
            return yield* new Store.MemoryStoreConflict({
              code: result.receipt.failureCode ?? "invalid_output",
            });
          if (!("pendingSync" in result.receipt) || !result.receipt.pendingSync) {
            yield* dismissRow(space, id);
            return { status: "accepted" as const };
          }
          yield* stored(
            "suggestion-accepting",
            sql`UPDATE memory_save_suggestions
        SET state='accepting',accept_operation_id=${operationId} WHERE space=${space} AND id=${id}`,
          );
          return { status: "pending" as const };
        }),
      )
      .pipe(
        Effect.catchTags({
          MemoryCapacityError: () =>
            Effect.succeed({ status: "refused" as const, reason: "capacity_exceeded" as const }),
          MemoryStoreConflict: (error) =>
            Effect.succeed({ status: "refused" as const, reason: error.code }),
        }),
      );
  });
  const dismiss = Effect.fn("MemorySuggestions.dismiss")(function* (
    input: M.MemorySuggestionActionInput,
    permit: Permit,
  ) {
    return yield* store.transact(
      Effect.gen(function* () {
        yield* permit;
        yield* requireSharing(input.memorySpaceId);
        yield* dismissRow(input.memorySpaceId, input.suggestionId);
        return { ok: true as const };
      }),
    );
  });
  return { onRefusedSave, list, listMetadata, accept, dismiss };
};

export type MemorySuggestionService = Pick<
  ReturnType<typeof makeMemorySaveSuggestions>,
  "list" | "listMetadata" | "dismiss"
> & {
  readonly accept: (
    input: M.MemorySuggestionActionInput,
    permit: Permit,
  ) => ReturnType<ReturnType<typeof makeMemorySaveSuggestions>["accept"]>;
};

export const settleMemorySuggestion = Effect.fn("MemorySuggestions.settle")(function* (
  sql: SqlClient.SqlClient,
  space: M.MemorySpaceId,
  receipt: M.MemoryHubReceipt,
) {
  if (receipt.outcome !== "rejected" || receipt.failureCode === "source_invalidated") {
    yield* stored(
      "suggestion-settle",
      sql`DELETE FROM memory_save_suggestions
      WHERE space=${space} AND accept_operation_id=${receipt.operationId}`,
    );
  } else {
    yield* stored(
      "suggestion-reopen",
      sql`UPDATE memory_save_suggestions
      SET state='pending', attempt=attempt+1, accept_operation_id=NULL, reason=${receipt.failureCode ?? "invalid_output"}
      WHERE space=${space} AND accept_operation_id=${receipt.operationId}`,
    );
  }
});
