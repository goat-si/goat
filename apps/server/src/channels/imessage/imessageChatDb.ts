import * as Effect from "effect/Effect";
import * as AuxiliarySqlite from "../../storage/AuxiliarySqlite.ts";

export interface ImessageRow {
  readonly rowid: number;
  readonly guid: string | null;
  readonly text: string | null;
  readonly attributedBody: Uint8Array | null;
  readonly handle_id: number | null;
  readonly is_from_me: number;
  readonly date: number;
  readonly date_read: number | null;
  readonly cache_roomnames: string | null;
  readonly associated_message_type: number | null;
  readonly item_type: number | null;
  readonly balloon_bundle_id: string | null;
  readonly sender_handle: string | null;
  readonly sender_service: string | null;
  readonly chat_rowid: number | null;
  readonly chat_guid: string | null;
  readonly chat_identifier: string | null;
  readonly style: number | null;
  readonly chat_join_count: number;
}

export interface ImessageChatDb {
  readonly maxRowId: () => Effect.Effect<number, ImessageDbError>;
  readonly rowsAfter: (
    cursor: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ImessageRow>, ImessageDbError>;
  readonly rowById: (rowId: number) => Effect.Effect<ImessageRow | undefined, ImessageDbError>;
  readonly close: () => Effect.Effect<void>;
}

export class ImessageDbError extends Error {
  readonly category: "database_unavailable" | "schema_unsupported" | "query_failed";
  constructor(category: "database_unavailable" | "schema_unsupported" | "query_failed") {
    super("iMessage database " + category);
    this.category = category;
  }
}

export function classifyImessageDbError(cause: unknown): ImessageDbError["category"] {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  const message = cause instanceof Error ? cause.message : "";
  if (
    /EACCES|EPERM|SQLITE_CANTOPEN/.test(code) ||
    /unable to open|authorization denied/i.test(message)
  )
    return "database_unavailable";
  if (/no such table|no such column/i.test(message)) return "schema_unsupported";
  return "query_failed";
}

export const openImessageChatDb = Effect.fn("ImessageChatDb.open")(function* (file: string) {
  const reader = yield* AuxiliarySqlite.AuxiliarySqlite;
  const read = Effect.fn("ImessageChatDb.read")(function* (input: AuxiliarySqlite.AuxiliaryRead) {
    return yield* reader
      .read(input)
      .pipe(Effect.mapError((cause) => new ImessageDbError(cause.category)));
  });
  yield* read({ kind: "imessage-max", file });
  return {
    maxRowId: () => read({ kind: "imessage-max", file }).pipe(Effect.map((result) => result.max)),
    rowsAfter: (cursor: number, limit: number) =>
      read({ kind: "imessage-rows", file, cursor, limit }).pipe(
        Effect.map((result) => result.rows),
      ),
    rowById: (rowId: number) =>
      read({ kind: "imessage-row", file, rowId }).pipe(Effect.map((result) => result.rows[0])),
    close: () => Effect.void,
  } satisfies ImessageChatDb;
});
