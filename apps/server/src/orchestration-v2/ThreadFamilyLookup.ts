import {
  OrchestrationV2GetShellSnapshotError,
  type OrchestrationV2GetThreadFamilyInput,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { loadShellSnapshotParts } from "./ShellStream.ts";
import type * as ThreadManagementService from "./ThreadManagementService.ts";

type ThreadReader = Pick<
  ThreadManagementService.ThreadManagementService["Service"],
  "readShellSnapshot" | "getShellSnapshot"
>;

export function makeOmittableShellReaders<E>(input: {
  readonly sql: SqlClient.SqlClient;
  readonly threadManagement: ThreadReader;
  readonly latestSequence: Effect.Effect<number, E>;
}) {
  const readOmittableShellRows = Effect.fn("ws.orchestrationV2.readOmittableShellRows")(function* (
    options: { readonly familyOf: ThreadId } | { readonly worktreePath: string },
    message: string,
  ) {
    const { threads, snapshotSequence } = yield* loadShellSnapshotParts({
      sql: input.sql,
      readThreads: input.threadManagement.readShellSnapshot({ location: "active", ...options }),
      listProjects: Effect.succeed([]),
      latestSequence: input.latestSequence,
    }).pipe(
      Effect.mapError((cause) => new OrchestrationV2GetShellSnapshotError({ message, cause })),
    );
    return { snapshotSequence, threads: threads.threads };
  });
  const readThreadFamily = Effect.fn("ThreadFamilyLookup.read")(function* (
    request: OrchestrationV2GetThreadFamilyInput,
  ) {
    if (request.lookupOnly === true && request.lookupThreadIds !== undefined) {
      const { threads, snapshotSequence } = yield* loadShellSnapshotParts({
        sql: input.sql,
        readThreads: input.threadManagement.readShellSnapshot({
          threadIds: request.lookupThreadIds,
        }),
        listProjects: Effect.succeed([]),
        latestSequence: input.latestSequence,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetShellSnapshotError({
              message: "Failed to resolve thread titles",
              cause,
            }),
        ),
      );
      return {
        snapshotSequence,
        threads: [],
        lookupTitles: Object.fromEntries(
          [...threads.threads, ...threads.archivedThreads].map((thread) => [
            thread.id,
            thread.title,
          ]),
        ),
      };
    }
    const family = yield* readOmittableShellRows(
      { familyOf: request.threadId },
      "Failed to load the thread family",
    );
    if (request.lookupThreadIds === undefined) return family;
    const snapshot = yield* input.threadManagement
      .getShellSnapshot({ threadIds: request.lookupThreadIds })
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetShellSnapshotError({
              message: "Failed to resolve thread titles",
              cause,
            }),
        ),
      );
    return {
      ...family,
      lookupTitles: Object.fromEntries(
        [...snapshot.threads, ...snapshot.archivedThreads].map((thread) => [
          thread.id,
          thread.title,
        ]),
      ),
    };
  });
  return { readOmittableShellRows, readThreadFamily };
}
