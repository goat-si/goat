import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CoreReads } from "./CoreReads.ts";
import {
  codec,
  contentCodec,
  decodeHistoryRevision,
  decodeReport,
  decodeRevertResult,
  decodeRevision,
  decodeTombstone,
  exclusionsCodec,
  headsCodec,
  identityCodec,
  importTime,
  payloadCodec,
  provenanceCodec,
  resolutionCodec,
  revertSlotCodec,
  scopeCodec,
  sourceKeysCodec,
  stored,
  threadCodec,
} from "./StoreCodecs.ts";
import type { HistoryRevisionRow } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { MemoryStorageError, MemoryStoreConflict, strict } from "./StoreModel.ts";
import type { MemoryAggregate } from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";

const historyPageCodec = codec(M.MemoryHistoryPage);
const decodeHistoryPage = Schema.decodeUnknownEffect(M.MemoryHistoryPage);
const historyRevisionCodec = codec(
  Schema.Struct({ revision: M.MemoryRevision, payload: Schema.NullOr(M.MemoryPayload) }),
);

export const makeHistory = (
  kernel: Pick<StoreKernel, "sql">,
  coreReads: Pick<CoreReads, "readItem" | "readOperation">,
) => {
  const { sql } = kernel;
  const { readItem, readOperation } = coreReads;
  const readResolutionInputsPage: MemoryStoreShape["readResolutionInputsPage"] = Effect.fn(
    "MemoryStore.readResolutionInputsPage",
  )(
    function* (input) {
      const offset = input.cursor ? Number(input.cursor) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0)
        return yield* new MemoryStoreConflict({ code: "invalid_cursor" });
      const current = yield* readItem(input.memorySpaceId, input.memoryId);
      if (!current) return yield* new MemoryStoreConflict({ code: "not_found" });
      const selected = yield* stored(
        "resolution-input-selection",
        sql<{ resolution_json: string; identity_json: string | null }>`
          SELECT r.resolution_json,l.identity_json FROM memory_resolutions r
          LEFT JOIN memory_identity_ledger l ON l.space=r.space AND l.memory_id=r.memory_id
          WHERE r.space=${input.memorySpaceId} AND r.resolution_id=${input.resolutionInputsFor} AND r.memory_id=${input.memoryId}`,
      );
      if (!selected[0]) return yield* new MemoryStoreConflict({ code: "not_found" });
      const resolution = yield* resolutionCodec.decode(selected[0].resolution_json, strict);
      const identity = selected[0].identity_json
        ? yield* identityCodec.decode(selected[0].identity_json, strict)
        : null;
      const ids = resolution.inputRevisionIds.slice(offset, offset + input.limit);
      const page: M.MemoryHistoryPage = {
        memoryId: input.memoryId,
        revisions: [],
        restorableRevisionIds: [],
        resolutions: [],
        tombstone: null,
        reports: [],
        revertResults: [],
        localAvailability: current.item.localAvailability,
        nextCursor: null,
      };
      const revisions: Array<M.MemoryHistoryPage["revisions"][number]> = [];
      const restorableRevisionIds: M.MemoryRevisionId[] = [];
      let bytes = new TextEncoder().encode(yield* historyPageCodec.encode(page)).length;
      let examined = offset;
      for (const id of ids) {
        // One PK lookup per selected input, never materialize the full revision history.
        const rows = yield* stored(
          "resolution-input-metadata",
          sql<{
            operation_id: string;
            parents_json: string;
            scope_json: string;
            assertion_kind: string;
            provenance_json: string;
            created_at: number;
            payload_bytes: number;
          }>`SELECT r.operation_id,r.parents_json,r.scope_json,r.assertion_kind,r.provenance_json,r.created_at,
            coalesce(length(CAST(p.body_json AS BLOB)),0) AS payload_bytes
            FROM memory_revisions r LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref
            WHERE r.space=${input.memorySpaceId} AND r.memory_id=${input.memoryId} AND r.revision_id=${id}`,
        );
        const row = rows[0];
        if (!row) {
          examined++;
          continue;
        }
        const revision = yield* decodeRevision(
          {
            memorySpaceId: input.memorySpaceId,
            memoryId: input.memoryId,
            revisionId: id,
            operationId: row.operation_id,
            parents: yield* headsCodec.decode(row.parents_json),
            scope: yield* scopeCodec.decode(row.scope_json),
            assertionKind: row.assertion_kind,
            provenance: yield* provenanceCodec.decode(row.provenance_json),
            payloadRef: id,
            createdAtUtc: yield* importTime(row.created_at),
          },
          strict,
        );
        // Include the UUID in retention metadata and array separators in the byte budget.
        const metadataBytes =
          new TextEncoder().encode(yield* historyRevisionCodec.encode({ revision, payload: null }))
            .length + 42;
        const visible =
          current.item.localAvailability.exposure === "visible" && current.item.status === "active";
        const bodyBytes = visible ? row.payload_bytes : 0;
        // Reserve cursor bytes before reading bodies. An oversized original remains restorable.
        if (
          bytes + metadataBytes + bodyBytes + 64 > M.MEMORY_PAGE_MAX_UTF8_BYTES &&
          revisions.length
        )
          break;
        let payload: M.MemoryPayload | null = null;
        if (
          visible &&
          bodyBytes &&
          bytes + metadataBytes + bodyBytes + 64 <= M.MEMORY_PAGE_MAX_UTF8_BYTES
        ) {
          const bodies = yield* stored(
            "resolution-input-body",
            sql<{ body_json: string }>`
              SELECT body_json FROM memory_payloads WHERE space=${input.memorySpaceId} AND memory_id=${input.memoryId} AND payload_ref=${id}`,
          );
          if (bodies[0]) payload = yield* payloadCodec.decode(bodies[0].body_json, strict);
        }
        revisions.push({ revision, payload });
        if (visible && row.payload_bytes > 0) restorableRevisionIds.push(id);
        bytes += metadataBytes + (payload ? bodyBytes : 0);
        examined++;
      }
      return {
        scope: identity?.scope ?? ("scope" in current.item ? current.item.scope : null),
        page: yield* decodeHistoryPage(
          {
            ...page,
            revisions,
            restorableRevisionIds,
            nextCursor: examined < resolution.inputRevisionIds.length ? String(examined) : null,
          },
          strict,
        ),
      };
    },
    Effect.mapError((cause) =>
      cause._tag === "MemoryStorageError" || cause._tag === "MemoryStoreConflict"
        ? cause
        : new MemoryStorageError({ stage: "resolution-input-codec", cause }),
    ),
  );
  const readAccess = Effect.fn("MemoryStore.readAccess")(function* (
    space: M.MemorySpaceId,
    id: M.MemoryId,
  ) {
    const current = yield* readItem(space, id);
    const rows = yield* stored(
      "read-identity",
      sql<{
        identity_json: string;
      }>`SELECT identity_json FROM memory_identity_ledger WHERE space=${space} AND memory_id=${id}`,
    );
    return {
      item: current?.item,
      identity: rows[0] ? yield* identityCodec.decode(rows[0].identity_json, strict) : undefined,
    };
  });
  const readHistoryRevision = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    id: M.MemoryId,
    revisionId: M.MemoryRevisionId,
    visible: boolean,
  ) {
    const rows = yield* stored(
      "history-revision-exact",
      sql<HistoryRevisionRow>`SELECT r.*,CASE WHEN ${visible ? 1 : 0} THEN p.body_json ELSE NULL END AS body_json
      FROM memory_revisions r LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref
      WHERE r.space=${space} AND r.revision_id=${revisionId} AND r.memory_id=${id} LIMIT 1`,
    );
    return rows[0] ? yield* decodeHistoryRevision(rows[0], space, id, visible) : undefined;
  });
  const historyPage: MemoryStoreShape["historyPage"] = Effect.fn("MemoryStore.historyPage")(
    function* (input, item, owner) {
      const space = input.memorySpaceId;
      const id = input.memoryId;
      const visible = item.localAvailability.exposure === "visible";
      const parsed = input.cursor ? /^h1:([0-4]):(0|[1-9][0-9]*)$/.exec(input.cursor) : undefined;
      if (input.cursor && (!parsed || !Number.isSafeInteger(Number(parsed[2]))))
        return yield* new MemoryStoreConflict({ code: "invalid_cursor" });
      let category = parsed ? Number(parsed[1]) : 0;
      let after = parsed ? Number(parsed[2]) : 0;
      let budget = input.limit;
      let bytes = 2048;
      let tombstoneResult: M.MemoryTombstone | null = null;
      const page: M.MemoryHistoryPage = {
        memoryId: id,
        revisions: [],
        resolutions: [],
        reports: [],
        revertResults: [],
        tombstone: null,
        localAvailability: item.localAvailability,
        nextCursor: null,
      };
      const revisions: M.MemoryHistoryPage["revisions"][number][] = [];
      const resolutions: M.MemoryHistoryPage["resolutions"][number][] = [];
      const reports: M.MemoryReportDelivery[] = [];
      const revertResults: M.MemoryRevertResult[] = [];
      const consumed: MemoryAggregate["revisions"][number][] = [];
      const fit = (value: unknown) => {
        const size = new TextEncoder().encode(JSON.stringify(value)).length + 1;
        if (bytes + size > M.MEMORY_PAGE_MAX_UTF8_BYTES) return false;
        bytes += size;
        return true;
      };
      // Select keys first, sharing one candidate budget even for null/hidden slots.
      // Existing equality indexes include rowid; no OFFSET, corpus scan or temp sort.
      while (budget > 0 && category < 5) {
        const keys = yield* stored(
          "history-keys",
          category === 0
            ? sql<{
                key: number;
              }>`SELECT rowid AS key FROM memory_revisions WHERE space=${space} AND memory_id=${id} AND rowid>${after} ORDER BY rowid LIMIT ${budget}`
            : category === 1 || category === 3
              ? sql<{
                  key: number;
                }>`SELECT rowid AS key FROM memory_resolutions WHERE space=${space} AND memory_id=${id} AND rowid>${after} ORDER BY rowid LIMIT ${budget}`
              : category === 2
                ? sql<{
                    key: number;
                  }>`SELECT rowid AS key FROM memory_report_outbox WHERE space=${space} AND memory_id=${id} AND rowid>${after} ORDER BY rowid LIMIT ${budget}`
                : sql<{
                    key: number;
                  }>`SELECT rowid AS key FROM memory_tombstones WHERE space=${space} AND memory_id=${id} AND rowid>${after} ORDER BY rowid LIMIT ${budget}`,
        );
        const requested = budget;
        for (const { key } of keys) {
          let output: unknown;
          let pair: M.MemoryHistoryPage["revisions"][number] | undefined;
          let resolutionPair: M.MemoryHistoryPage["resolutions"][number] | undefined;
          let report: M.MemoryReportDelivery | undefined;
          let result: M.MemoryRevertResult | undefined;
          let tombstone: M.MemoryTombstone | null = null;
          if (category === 0) {
            const rows = yield* stored(
              "history-revision",
              sql<HistoryRevisionRow>`SELECT r.*,CASE WHEN ${visible ? 1 : 0} THEN p.body_json ELSE NULL END AS body_json
            FROM memory_revisions r LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref
            WHERE r.rowid=${key} AND r.space=${space} AND r.memory_id=${id} LIMIT 1`,
            );
            if (rows[0]) output = pair = yield* decodeHistoryRevision(rows[0], space, id, visible);
          } else if (category === 1 || category === 3) {
            const rows = yield* stored(
              "history-resolution",
              sql<{
                resolution_json: string;
                revert_operation_id: string | null;
                revert_result_json: string | null;
              }>`
            SELECT resolution_json,revert_operation_id,revert_result_json FROM memory_resolutions WHERE rowid=${key} AND space=${space} AND memory_id=${id} LIMIT 1`,
            );
            const row = rows[0];
            if (row) {
              if (category === 1) {
                const resolution = yield* resolutionCodec.decode(row.resolution_json, strict);
                const revision = visible
                  ? yield* readHistoryRevision(space, id, resolution.resultRevisionId, false)
                  : undefined;
                const op = revision
                  ? yield* readOperation(space, revision.revision.operationId)
                  : undefined;
                output = resolutionPair = {
                  resolution,
                  payload: visible && op?.kind === "resolve" ? op.resolutionPayload : null,
                };
              } else if (row.revert_result_json && row.revert_operation_id) {
                const resolution = yield* resolutionCodec.decode(row.resolution_json, strict);
                const slot = yield* revertSlotCodec.decode(row.revert_result_json, strict);
                // Older clients cannot decode the refused arm. Only expose it on opt-in.
                if (slot.status !== "refused" || input.includeRefusedReverts === true) {
                  const common = {
                    operationId: row.revert_operation_id,
                    memoryId: id,
                    resolutionId: resolution.resolutionId,
                    revertDeadlineUtc: resolution.revertDeadlineUtc,
                  };
                  output = result = yield* stored(
                    "history-revert-codec",
                    decodeRevertResult(
                      slot.status === "accepted"
                        ? {
                            ...common,
                            status: slot.status,
                            receipt: {
                              operationId: row.revert_operation_id,
                              memoryId: id,
                              outcome: "accepted",
                              revisionId: slot.revisionId,
                              pendingSync: false,
                            },
                            localAvailability: item.localAvailability,
                          }
                        : slot.status === "refused"
                          ? { ...common, ...slot }
                          : { ...common, status: slot.status },
                      strict,
                    ),
                  );
                }
              }
            }
          } else if (category === 2) {
            yield* stored(
              "history-report-normalize",
              sql`UPDATE memory_report_outbox SET state='failed',failure_code=coalesce(failure_code,'unavailable'),claimed_by=NULL,claimed_until=NULL
            WHERE rowid=${key} AND space=${space} AND memory_id=${id} AND resolving_environment_id=${owner} AND state!='delivered' AND automatic_attempts=10
              AND (state!='failed' OR claimed_by IS NOT NULL OR claimed_until IS NOT NULL) AND (claimed_until IS NULL OR claimed_until<=${yield* Clock.currentTimeMillis})`,
            );
            const rows = yield* stored(
              "history-report",
              sql<{
                report_id: string;
                automatic_attempts: number;
                attempts_known: number;
                operation_id: string;
                outcome: string;
                resolving_environment_id: string;
                resolution_id: string | null;
                state: string;
                failure_code: string | null;
                report_thread_json: string | null;
                delivered_sequence: number | null;
              }>`
            SELECT report_id,automatic_attempts,attempts_known,operation_id,outcome,resolving_environment_id,resolution_id,state,failure_code,report_thread_json,delivered_sequence FROM memory_report_outbox WHERE rowid=${key} AND space=${space} AND memory_id=${id} LIMIT 1`,
            );
            const row = rows[0];
            if (row)
              output = report = yield* stored(
                "history-report-codec",
                decodeReport(
                  {
                    reportId: row.report_id,
                    ...(row.attempts_known === 1
                      ? { automaticAttempts: row.automatic_attempts }
                      : {}),
                    operationId: row.operation_id,
                    outcome: row.outcome,
                    resolvingEnvironmentId: row.resolving_environment_id,
                    resolutionId: row.resolution_id,
                    state: row.state,
                    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
                    reportThread: row.report_thread_json
                      ? yield* threadCodec.decode(row.report_thread_json, strict)
                      : null,
                    sequence: row.delivered_sequence,
                  },
                  strict,
                ),
              );
          } else {
            const rows = yield* stored(
              "history-tombstone",
              sql<{
                delete_operation_id: string;
                deleting_environment_id: string;
                deleted_at: number;
                suppressed_source_keys_json: string;
                suppressed_content_json: string;
                source_exclusions_json: string;
              }>`SELECT delete_operation_id,deleting_environment_id,deleted_at,suppressed_source_keys_json,suppressed_content_json,source_exclusions_json FROM memory_tombstones WHERE rowid=${key} AND space=${space} AND memory_id=${id} LIMIT 1`,
            );
            const t = rows[0];
            tombstone = yield* Effect.gen(function* () {
              return t
                ? yield* stored(
                    "tombstone-codec",
                    Effect.gen(function* () {
                      return yield* decodeTombstone(
                        {
                          memorySpaceId: space,
                          memoryId: id,
                          deleteOperationId: t.delete_operation_id,
                          deletingEnvironmentId: t.deleting_environment_id,
                          deletedAtUtc: yield* importTime(t.deleted_at),
                          suppressedSourceKeys: yield* sourceKeysCodec.decode(
                            t.suppressed_source_keys_json,
                          ),
                          suppressedContent: yield* contentCodec.decode(t.suppressed_content_json),
                          sourceExclusions: yield* exclusionsCodec.decode(t.source_exclusions_json),
                        },
                        strict,
                      );
                    }),
                  )
                : null;
            });
            output = tombstone;
          }
          if (output && !fit(output)) {
            if (bytes === 2048)
              return yield* new MemoryStoreConflict({ code: "payload_too_large" });
            return {
              page: {
                ...page,
                revisions,
                resolutions,
                reports,
                revertResults,
                tombstone: tombstoneResult,
                nextCursor: `h1:${category}:${after}`,
              },
              consumed,
            };
          }
          if (pair) {
            revisions.push(pair);
            if (pair.payload) consumed.push(pair);
          }
          if (resolutionPair) {
            resolutions.push(resolutionPair);
            if (resolutionPair.payload)
              for (const revisionId of new Set([
                resolutionPair.resolution.resultRevisionId,
                ...resolutionPair.resolution.inputRevisionIds,
              ])) {
                const inputPair = yield* readHistoryRevision(space, id, revisionId, true);
                if (inputPair) consumed.push(inputPair);
              }
          }
          if (report) reports.push(report);
          if (result) revertResults.push(result);
          if (tombstone) tombstoneResult = tombstone;
          after = key;
          budget--;
        }
        if (keys.length < requested) {
          category++;
          after = 0;
        }
      }
      return {
        page: {
          ...page,
          revisions,
          resolutions,
          reports,
          revertResults,
          tombstone: tombstoneResult,
          nextCursor: category < 5 ? `h1:${category}:${after}` : null,
        },
        consumed,
      };
    },
  );
  return {
    readResolutionInputsPage,
    readAccess,
    historyPage,
  };
};

export type History = ReturnType<typeof makeHistory>;
