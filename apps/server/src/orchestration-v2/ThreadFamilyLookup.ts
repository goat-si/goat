import {
  OrchestrationV2GetShellSnapshotError,
  type OrchestrationV2GetThreadFamilyInput,
  type OrchestrationV2ThreadShell,
  type ProjectId,
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
  // The titles and projects of the threads a lookup found; a deleted project names none.
  const lookupAnswer = Effect.fn("ThreadFamilyLookup.lookupAnswer")(function* (
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) {
    const projectIds = [...new Set(threads.map((thread) => thread.projectId))];
    const liveRows =
      projectIds.length === 0
        ? []
        : yield* input.sql<{ readonly project_id: ProjectId }>`
            SELECT project_id FROM projection_projects
            WHERE deleted_at IS NULL AND project_id IN ${input.sql.in(projectIds)}`.pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetShellSnapshotError({
                  message: "Failed to resolve thread projects",
                  cause,
                }),
            ),
          );
    const live = new Set(liveRows.map((row) => row.project_id));
    return {
      lookupTitles: Object.fromEntries(threads.map((thread) => [thread.id, thread.title])),
      lookupProjectIds: Object.fromEntries(
        threads.map((thread) => [thread.id, live.has(thread.projectId) ? thread.projectId : null]),
      ),
    };
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
        ...(yield* lookupAnswer([...threads.threads, ...threads.archivedThreads])),
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
      ...(yield* lookupAnswer([...snapshot.threads, ...snapshot.archivedThreads])),
    };
  });
  return { readOmittableShellRows, readThreadFamily };
}
