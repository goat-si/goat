import { ServerSettingsError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import type * as SqlClient from "effect/sql/SqlClient";
import {
  readConversationMemoryEnabled,
  setConversationMemoryEnabled,
} from "./conversationMemoryPolicy.ts";

export function makeConversationMemorySettings(
  sql: SqlClient.SqlClient,
  fs: FileSystem.FileSystem,
  settingsPath: string,
) {
  // The settings writer serializes these calls, including file-watcher reloads.
  let recorded: boolean | undefined;
  const remember = (enabled: boolean) =>
    Effect.sync(() => {
      recorded = enabled;
    });
  const read = Effect.suspend(() =>
    recorded === undefined
      ? readConversationMemoryEnabled(sql).pipe(Effect.tap(remember))
      : Effect.succeed(recorded),
  ).pipe(
    Effect.mapError(
      (cause) => new ServerSettingsError({ settingsPath, operation: "read-file", cause }),
    ),
  );

  const reconcile = Effect.fn("ServerSettings.reconcileConversationMemory")(function* (
    enabled: boolean,
  ) {
    if ((yield* read) === enabled) return;
    yield* setConversationMemoryEnabled(sql, enabled).pipe(
      Effect.mapError(
        (cause) => new ServerSettingsError({ settingsPath, operation: "write-file", cause }),
      ),
    );
    yield* remember(enabled);
  });

  // Serialize the transcript boundary with event writers. A failed rename rolls the fence back.
  const rename = (from: string, to: string, enabled: boolean) =>
    Effect.suspend(() =>
      recorded === enabled
        ? fs.rename(from, to)
        : sql
            .withTransaction(
              setConversationMemoryEnabled(sql, enabled).pipe(Effect.andThen(fs.rename(from, to))),
            )
            .pipe(
              Effect.tap(() => remember(enabled)),
              Effect.catchTags({
                SqlError: (cause) =>
                  Effect.fail(
                    PlatformError.systemError({
                      _tag: "Unknown",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: to,
                      cause,
                    }),
                  ),
              }),
            ),
    );
  return { read, reconcile, rename };
}
