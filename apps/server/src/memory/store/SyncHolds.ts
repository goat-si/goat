import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { CoreReads } from "./CoreReads.ts";
import {
  decodeFailureCode,
  decodeHoldClass,
  holdRearmResult,
  pullRetryCodec,
  stored,
} from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import {
  HoldClass,
  MemoryStoreConflict,
  Transaction,
  emptyPullRetry,
  hashText,
  strict,
} from "./StoreModel.ts";
import type { MemoryHoldClass } from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";

export const makeSyncHolds = (
  kernel: Pick<StoreKernel, "sql">,
  coreReads: Pick<CoreReads, "readWorkOperation">,
) => {
  const { sql } = kernel;
  const { readWorkOperation } = coreReads;
  const acquireSyncWorkTx: MemoryStoreShape["acquireSyncWorkTx"] = Effect.fn(
    "MemoryStore.acquireSyncWorkTx",
  )(function* (input) {
    yield* Transaction;
    if (input.ownedUntil <= input.now) return null;
    const op = yield* readWorkOperation(input.workId);
    if (
      !op ||
      op.operationId !== input.operationId ||
      hashText(M.encodeMemoryOperation(op)) !== input.operationDigest
    )
      return null;
    const rows = yield* stored(
      "sync-acquire",
      sql`
      UPDATE memory_outbox SET status='running', claimed_by=${input.owner}, claimed_until=${input.ownedUntil},
        sync_version=sync_version+1, operation_digest=${input.operationDigest}, attempt=min(attempt+1,2147483647)
      WHERE id=${input.workId} AND kind IN ('sync','revert_intent') AND sync_version=${input.expectedVersion}
        AND (operation_digest IS NULL OR operation_digest=${input.operationDigest}) AND next_attempt_at<=${input.now}
        AND (status IN ('pending','retry') OR (status='running' AND claimed_until<=${input.now})) RETURNING id`,
    );
    return rows.length
      ? {
          workId: input.workId,
          operationId: input.operationId,
          operationDigest: input.operationDigest,
          owner: input.owner,
          version: input.expectedVersion + 1,
          ownedUntil: input.ownedUntil,
        }
      : null;
  });
  const retrySyncWorkTx: MemoryStoreShape["retrySyncWorkTx"] = Effect.fn(
    "MemoryStore.retrySyncWorkTx",
  )(function* (input) {
    yield* Transaction;
    const o = input.ownership;
    if ((input.nextAttemptAt === Number.MAX_SAFE_INTEGER) !== (input.holdClass !== undefined))
      return yield* new MemoryStoreConflict({ code: "invalid_output" });
    if (input.nextAttemptAt < input.now) return false;
    const rows = yield* stored(
      "sync-retry",
      sql`
      UPDATE memory_outbox SET status='retry', next_attempt_at=${input.nextAttemptAt}, failure_code=${input.failureCode},hold_class=${input.holdClass ?? null}, claimed_by=NULL, claimed_until=NULL, sync_version=sync_version+1
      WHERE id=${o.workId} AND kind IN ('sync','revert_intent') AND status='running' AND claimed_by=${o.owner}
        AND sync_version=${o.version} AND operation_digest=${o.operationDigest} AND claimed_until=${o.ownedUntil} AND claimed_until>${input.now} RETURNING id`,
    );
    return rows.length === 1;
  });
  const readPullRetry: MemoryStoreShape["readPullRetry"] = Effect.fn("MemoryStore.readPullRetry")(
    function* (input) {
      const rows = yield* stored(
        "pull-retry",
        sql<{
          pull_retry_json: string | null;
        }>`SELECT pull_retry_json FROM memory_sync_cursors WHERE space=${input.memorySpaceId} AND hub_environment_id=${input.hubEnvironmentId}`,
      );
      return rows[0]?.pull_retry_json
        ? yield* pullRetryCodec.decode(rows[0].pull_retry_json, strict)
        : emptyPullRetry;
    },
  );
  // Discovery observes presence, not rearm authority. Outbox work belongs to
  // the space; only pull retry is scoped to the current hub binding.
  const readPersistedHoldClasses: MemoryStoreShape["readPersistedHoldClasses"] = Effect.fn(
    "MemoryStore.readPersistedHoldClasses",
  )(function* (input) {
    // Observational probes need no write transaction or checkpoint accounting.
    // Rearm authority and mutations are checked separately inside transact.
    const pull = yield* readPullRetry(input);
    const classes: MemoryHoldClass[] = [];
    for (const holdClass of HoldClass.literals) {
      const held = yield* stored(
        "persisted-hold-discovery",
        sql`SELECT 1 FROM memory_outbox INDEXED BY memory_outbox_held_class
              WHERE space=${input.memorySpaceId} AND hold_class=${holdClass}
                AND hold_class IS NOT NULL AND next_attempt_at=9007199254740991
                AND kind IN ('sync','revert_intent','claim','resolve')
                AND status IN ('pending','retry','running') LIMIT 1`,
      );
      if (
        held.length ||
        (pull.nextAttemptAt === Number.MAX_SAFE_INTEGER && pull.holdClass === holdClass)
      )
        classes.push(holdClass);
    }
    return classes;
  });
  const writePullRetryTx: MemoryStoreShape["writePullRetryTx"] = Effect.fn(
    "MemoryStore.writePullRetryTx",
  )(function* (input) {
    yield* Transaction;
    const current = yield* readPullRetry(input);
    if (current.version !== input.expectedVersion) return null;
    if (
      (input.retry.nextAttemptAt === Number.MAX_SAFE_INTEGER) !==
      (input.retry.holdClass !== null)
    )
      return yield* new MemoryStoreConflict({ code: "invalid_output" });
    const next = { ...input.retry, version: current.version + 1 };
    const json = yield* pullRetryCodec.encode(next);
    const rows = yield* stored(
      "pull-retry-write",
      sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state,pull_retry_json)
      VALUES (${input.memorySpaceId},${input.hubEnvironmentId},0,'unbound',${json})
      ON CONFLICT(space,hub_environment_id) DO UPDATE SET pull_retry_json=excluded.pull_retry_json
      WHERE coalesce(json_extract(memory_sync_cursors.pull_retry_json,'$.version'),0)=${input.expectedVersion} RETURNING space`,
    );
    return rows.length === 1 ? next : null;
  });
  const readWorkHold: MemoryStoreShape["readWorkHold"] = Effect.fn("MemoryStore.readWorkHold")(
    function* (workId) {
      const rows = yield* stored(
        "work-hold",
        sql<{
          hold_class: string | null;
          failure_code: string | null;
        }>`SELECT hold_class,failure_code FROM memory_outbox WHERE id=${workId}`,
      );
      const row = rows[0];
      if (!row) return null;
      return {
        holdClass: row.hold_class
          ? yield* stored("hold-codec", decodeHoldClass(row.hold_class))
          : null,
        failureCode: row.failure_code
          ? yield* stored("failure-codec", decodeFailureCode(row.failure_code))
          : null,
      };
    },
  );
  // Page the existing ID primary key before applying class/space/state filters. Filtering in
  // SQL would make LIMIT bound matches rather than inspected history, and can force a sort.
  const readHoldRearmPage = (afterId: string, limit: number) =>
    stored(
      "hold-rearm-page",
      sql<{
        id: string;
        space: string;
        kind: string;
        status: string;
        next_attempt_at: number;
        hold_class: string | null;
      }>`SELECT id,space,kind,status,next_attempt_at,hold_class
      FROM memory_outbox WHERE id>${afterId} ORDER BY id LIMIT ${Math.max(0, Math.min(limit, M.MEMORY_PAGE_MAX_ITEMS))}`,
    );
  const rearmSyncHoldsTx: MemoryStoreShape["rearmSyncHoldsTx"] = Effect.fn(
    "MemoryStore.rearmSyncHoldsTx",
  )(function* (input) {
    yield* Transaction;
    const rows = yield* readHoldRearmPage(input.afterId, input.limit);
    const changed: string[] = [];
    for (const row of rows) {
      if (
        row.space !== input.memorySpaceId ||
        !["sync", "revert_intent"].includes(row.kind) ||
        row.status !== "retry" ||
        row.next_attempt_at !== Number.MAX_SAFE_INTEGER ||
        row.hold_class !== input.holdClass
      )
        continue;
      const updated = yield* stored(
        "sync-hold-rearm",
        sql`UPDATE memory_outbox SET hold_class=NULL,failure_code=NULL,next_attempt_at=${input.now},sync_version=sync_version+1 WHERE id=${row.id} RETURNING id`,
      );
      if (updated.length) changed.push(row.id);
    }
    return holdRearmResult(rows, changed, input.limit);
  });
  return {
    acquireSyncWorkTx,
    retrySyncWorkTx,
    readPullRetry,
    readPersistedHoldClasses,
    writePullRetryTx,
    readWorkHold,
    readHoldRearmPage,
    rearmSyncHoldsTx,
  };
};

export type SyncHolds = ReturnType<typeof makeSyncHolds>;
