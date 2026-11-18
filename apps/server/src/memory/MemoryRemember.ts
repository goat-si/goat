import { floorWriteId } from "./store/FloorWrites.ts";
import * as M from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./MemoryStore.ts";
import { resolveThreadProject } from "./MemorySummaryCommit.ts";
import type { MemoryAccessError, MemoryServiceError } from "./MemoryService.ts";

/** The requested scope does not exist for this caller: no conversation, or no project memory. */
export class MemoryRememberScopeUnavailable extends Schema.TaggedError<MemoryRememberScopeUnavailable>()(
  "MemoryRememberScopeUnavailable",
  { scope: Schema.Literals(["project", "thread"]) },
) {}

export class MemoryRememberMoveRequiresNoText extends Schema.TaggedError<MemoryRememberMoveRequiresNoText>()(
  "MemoryRememberMoveRequiresNoText",
  {},
) {}

export class MemoryRefusedSaveHook extends Context.Service<
  MemoryRefusedSaveHook,
  {
    readonly onRefusedSave: (
      candidate: {
        readonly input: M.MemoryUpsertInput;
        readonly thread: M.ScopedThreadRef;
        readonly reason:
          | "thread_lineage_incomplete"
          | "hub_upgrade_required"
          | "hub_unavailable"
          | "capacity_exceeded"
          | "source_invalidated";
        readonly knownRevisions: ReadonlyArray<M.MemoryRevisionId>;
        readonly lineageComplete: boolean;
        readonly forgetGeneration: number;
        readonly stagedOperationId?: M.MemoryOperationId;
      },
      permit: Effect.Effect<void, MemoryAccessError>,
    ) => Effect.Effect<void, MemoryServiceError>;
  }
>()("goat/memory/MemoryRemember/MemoryRefusedSaveHook") {}

const encodeProjectKey = Schema.encodeSync(Schema.fromJsonString(M.MemoryProjectKey));
const scopeKey = (scope: M.MemoryScope) =>
  scope.kind === "user"
    ? "user"
    : scope.kind === "thread"
      ? `thread:${scope.thread.environmentId}:${scope.thread.threadId}`
      : `project:${encodeProjectKey(scope.projectKey)}`;

/**
 * The agent write path: the caller names only the text and a scope. The space, ids, current
 * heads, project key and conversation evidence come from server state, and the strict upsert
 * still validates everything.
 */
export const makeRemember = (deps: {
  readonly sql: SqlClient.SqlClient;
  readonly environmentId: M.EnvironmentId;
  readonly store: Store.MemoryStore["Service"];
  readonly resolveProjectKey: (
    space: M.MemorySpaceId,
    project: M.ScopedProjectRef,
  ) => Effect.Effect<M.MemoryProjectKey | null, MemoryServiceError>;
  readonly upsert: (
    input: M.MemoryUpsertInput,
    permit: Effect.Effect<void, MemoryAccessError>,
    sourceThread?: M.ScopedThreadRef,
    remember?: { readonly allowUnverified: boolean },
  ) => Effect.Effect<Store.StoredReceipt, MemoryServiceError>;
  readonly move: (
    input: M.MemoryMoveInput,
    permit: Effect.Effect<void, MemoryAccessError>,
  ) => Effect.Effect<Store.StoredReceipt, MemoryServiceError>;
  readonly stableUuid: (text: string) => string;
}) =>
  Effect.fn("MemoryService.remember")(function* (
    input: M.MemoryRememberInput & { readonly memorySpaceId: M.MemorySpaceId },
    permit: Effect.Effect<void, MemoryAccessError>,
    sourceThread?: M.ScopedThreadRef,
  ) {
    const { sql, store } = deps;
    const space = input.memorySpaceId;
    yield* permit;
    const storageFailure = (cause: unknown) =>
      Effect.fail(new Store.MemoryStorageError({ stage: "remember-read", cause }));
    const scopeFor = Effect.fnUntraced(function* (kind: "user" | "project" | "thread") {
      if (kind === "user") return { kind: "user" } satisfies M.MemoryScope;
      if (!sourceThread) return yield* new MemoryRememberScopeUnavailable({ scope: kind });
      if (kind === "thread")
        return { kind: "thread", thread: sourceThread } satisfies M.MemoryScope;
      const project = yield* resolveThreadProject(
        { sql, environmentId: deps.environmentId, resolveProjectKey: deps.resolveProjectKey },
        sourceThread,
        space,
      ).pipe(Effect.catchTags({ SqlError: storageFailure }));
      if (!project) return yield* new MemoryRememberScopeUnavailable({ scope: "project" });
      return { kind: "project", projectKey: project.projectKey } satisfies M.MemoryScope;
    });
    const requested = input.scope === undefined ? undefined : yield* scopeFor(input.scope);
    const caller = sourceThread ? `${sourceThread.environmentId}:${sourceThread.threadId}` : "none";
    // Same text, scope and conversation lands on one memory, so a retry cannot add a duplicate.
    const memoryId =
      input.memoryId ??
      M.MemoryId.make(
        deps.stableUuid(
          `remember:${space}:${caller}:${requested ? scopeKey(requested) : ""}:${input.text}`,
        ),
      );
    const current = yield* store.loadAggregate(space, memoryId);
    const scope = current.identity?.scope ?? requested;
    if (
      input.memoryId &&
      current.identity &&
      requested &&
      scopeKey(current.identity.scope) !== scopeKey(requested)
    ) {
      if (input.text !== undefined) return yield* new MemoryRememberMoveRequiresNoText({});
      const fromScope = current.identity.scope;
      if (fromScope.kind !== "user") {
        const authorized = yield* scopeFor(fromScope.kind);
        if (scopeKey(authorized) !== scopeKey(fromScope))
          return yield* new Store.MemoryStoreConflict({ code: "not_found" });
      }
      let operationId = M.MemoryOperationId.make(
        deps.stableUuid(
          `remember-move:${space}:${memoryId}:${current.identity.scopeVersion ?? 0}:${current.heads.join(",")}:${scopeKey(requested)}`,
        ),
      );
      for (let attempts = 0; attempts < M.MEMORY_WORK_MAX_PENDING_ITEMS; attempts++) {
        const prior = yield* store.readWork(floorWriteId(space, operationId));
        if (prior?.status !== "failed") break;
        operationId = M.MemoryOperationId.make(
          deps.stableUuid(`remember-move-retry:${operationId}`),
        );
      }
      return yield* deps.move(
        {
          memorySpaceId: space,
          memoryId,
          operationId,
          expectedHeads: current.heads,
          expectedScopeVersion: current.identity.scopeVersion ?? 0,
          fromScope,
          toScope: requested,
        },
        permit,
      );
    }
    if (input.text === undefined)
      return yield* new Store.MemoryStoreConflict({ code: "unsupported_operation" });
    if (!scope || (input.memoryId !== undefined && !current.identity))
      return yield* new Store.MemoryStoreConflict({ code: "not_found" });
    const rows = sourceThread
      ? yield* sql<{ first: string | null; last: string | null; through: number | null }>`
          SELECT
            (SELECT event_id FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${sourceThread.threadId} ORDER BY sequence LIMIT 1) AS first,
            (SELECT event_id FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${sourceThread.threadId} ORDER BY sequence DESC LIMIT 1) AS last,
            (SELECT max(sequence) FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${sourceThread.threadId}) AS through`.pipe(
          Effect.catchTags({ SqlError: storageFailure }),
        )
      : [];
    const row = rows[0];
    // The conversation is the evidence; with no conversation to cite, the memory is an inference.
    const watermark =
      sourceThread && row?.first && row.last && row.through !== null
        ? {
            fromEventId: M.EventId.make(row.first),
            toEventId: M.EventId.make(row.last),
            throughSequence: row.through,
          }
        : undefined;
    const evidence: M.MemoryEvidence[] =
      sourceThread && watermark
        ? [{ origin: "thread", sourceThread, watermark, messageIds: [] }]
        : [];
    let operationId = M.MemoryOperationId.make(
      deps.stableUuid(
        `remember-op:${space}:${memoryId}:${current.heads.join(",")}:${scopeKey(scope)}:${watermark?.throughSequence ?? ""}:${input.text}`,
      ),
    );
    // Failed attempts are terminal. Pending attempts retain their first operation bytes.
    for (let attempts = 0; attempts < M.MEMORY_WORK_MAX_PENDING_ITEMS; attempts++) {
      const prior = yield* store.readWork(floorWriteId(space, operationId));
      if (
        prior?.status !== "failed" ||
        !("authorityFirst" in prior.metadata) ||
        !prior.metadata.authorityFirst
      )
        break;
      operationId = M.MemoryOperationId.make(deps.stableUuid(`remember-retry:${operationId}`));
    }
    const candidate: M.MemoryUpsertInput = {
      memorySpaceId: space,
      operationId,
      memoryId,
      expectedHeads: current.heads,
      scope,
      assertionKind: evidence.length > 0 ? "fact" : "inference",
      payload: { text: input.text, evidence, derivedFromMemoryRevisions: [] },
      baseBoundary: null,
    };
    return yield* deps.upsert(candidate, permit, sourceThread, {
      allowUnverified: input.memoryId === undefined,
    });
  });
