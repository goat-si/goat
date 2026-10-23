import * as M from "@goat/contracts";
import { reportMetadataBytes } from "../MemoryReportAccounting.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  codec,
  compactCodec,
  decodeFailureCode,
  decodeFailureEnvironment,
  decodeReport,
  metadataCodec,
  receiptCodec,
  stored,
  threadCodec,
  workMetadataCodec,
} from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import {
  MemoryStoreConflict,
  MemoryWork,
  Transaction,
  hashText,
  resolutionReportId,
  strict,
} from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";
import type { WorkQueue } from "./WorkQueue.ts";

export const makeReports = (
  kernel: Pick<StoreKernel, "markRunnable" | "sql" | "transact" | "withHubBudget">,
  workQueue: Pick<WorkQueue, "finishWork" | "readWork" | "retryWork">,
) => {
  const { markRunnable, sql, transact, withHubBudget } = kernel;
  const { finishWork, readWork, retryWork } = workQueue;
  const normalizeExpiredReports = Effect.fn("MemoryStore.normalizeExpiredReports")(function* (
    now: number,
    owner?: M.EnvironmentId,
  ) {
    yield* stored(
      "report-exhausted",
      sql`UPDATE memory_report_outbox SET state='failed',failure_code=coalesce(failure_code,'unavailable'),claimed_by=NULL,claimed_until=NULL
      WHERE state!='delivered' AND automatic_attempts=10 AND (state!='failed' OR claimed_by IS NOT NULL OR claimed_until IS NOT NULL) AND (claimed_until IS NULL OR claimed_until<=${now}) AND (${owner ?? null} IS NULL OR resolving_environment_id=${owner ?? null})`,
    );
  });
  const readReportTarget = Effect.fn("MemoryStore.readReportTarget")(function* (reportId: string) {
    const rows = yield* stored(
      "report-target",
      sql<{ space: string; memory_id: string; owner: string }>`
      SELECT space,memory_id,resolving_environment_id AS owner FROM memory_report_outbox WHERE report_id=${reportId}
      UNION SELECT space,memory_id,json_extract(record_json,'$.resolvingEnvironmentId') AS owner FROM memory_import_keys WHERE key_kind='report_delivered' AND key=${reportId}`,
    );
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    return yield* stored(
      "report-target-codec",
      Schema.decodeUnknownEffect(
        Schema.Struct({
          memorySpaceId: M.MemorySpaceId,
          memoryId: M.MemoryId,
          deliveryEnvironmentId: M.EnvironmentId,
        }),
      )(
        { memorySpaceId: row.space, memoryId: row.memory_id, deliveryEnvironmentId: row.owner },
        strict,
      ),
    );
  });
  const nextReportWakeAt = Effect.fn("MemoryStore.nextReportWakeAt")(function* (
    now: number,
    owner: M.EnvironmentId,
  ) {
    const rows = yield* stored(
      "report-wake",
      sql<{
        wake: number | null;
      }>`SELECT min(max(${now},next_attempt_at,coalesce(claimed_until,0))) AS wake FROM memory_report_outbox r
      WHERE resolving_environment_id=${owner} AND state!='delivered' AND report_approved=1 AND report_kind IN ('resolve','revert','conflict_failure') AND ((report_kind='resolve' AND outcome='resolved') OR (report_kind='revert' AND outcome='reverted') OR (report_kind='conflict_failure' AND outcome='failed')) AND (automatic_attempts<10 OR (automatic_attempts=10 AND claimed_until>${now}))
      AND NOT EXISTS(SELECT 1 FROM memory_import_keys g WHERE g.space=r.space AND g.key_kind='report_delivered' AND g.key=r.report_id)`,
    );
    return rows[0]?.wake ?? null;
  });
  const acquireReports: MemoryStoreShape["acquireReports"] = Effect.fn(
    "MemoryStore.acquireReports",
  )(function* (input) {
    if (input.until <= input.now) return [];
    return yield* transact(
      Effect.gen(function* () {
        yield* normalizeExpiredReports(input.now, input.owner);
        const rows = yield* stored(
          "report-acquire",
          sql<{
            report_id: string;
          }>`UPDATE memory_report_outbox SET claimed_by=${input.owner},claimed_until=${input.until},automatic_attempts=automatic_attempts+1,attempts_known=1
        WHERE report_id IN (SELECT report_id FROM memory_report_outbox r WHERE resolving_environment_id=${input.owner}
          AND state!='delivered' AND report_approved=1 AND report_kind IN ('resolve','revert','conflict_failure') AND ((report_kind='resolve' AND outcome='resolved') OR (report_kind='revert' AND outcome='reverted') OR (report_kind='conflict_failure' AND outcome='failed')) AND automatic_attempts<10
          AND next_attempt_at<=${input.now} AND (claimed_until IS NULL OR claimed_until<=${input.now})
          AND NOT EXISTS(SELECT 1 FROM memory_import_keys g WHERE g.space=r.space AND g.key_kind='report_delivered' AND g.key=r.report_id)
          ORDER BY next_attempt_at,created_at,report_id LIMIT ${Math.max(0, Math.min(32, Math.floor(input.limit)))}) RETURNING report_id`,
        );
        if (rows.length) yield* markRunnable;
        const claimed = new Set(rows.map((r) => r.report_id));
        // Read only the claimed rows, never materialize the backlog before applying LIMIT.
        return yield* Effect.forEach([...claimed], (reportId) => readReportDelivery(reportId));
      }),
    );
  });
  const readReportDelivery = Effect.fnUntraced(function* (reportId: string) {
    const rows = yield* stored(
      "report-delivery",
      sql<{
        report_id: string;
        operation_id: string;
        outcome: string;
        resolving_environment_id: string;
        resolution_id: string | null;
        state: string;
        failure_code: string | null;
        automatic_attempts: number;
        report_thread_json: string | null;
        delivered_sequence: number | null;
      }>`SELECT report_id,operation_id,outcome,resolving_environment_id,resolution_id,state,failure_code,automatic_attempts,report_thread_json,delivered_sequence FROM memory_report_outbox WHERE report_id=${reportId}`,
    );
    const r = rows[0]!;
    return yield* stored(
      "report-delivery-codec",
      decodeReport(
        {
          reportId: r.report_id,
          operationId: r.operation_id,
          outcome: r.outcome,
          resolvingEnvironmentId: r.resolving_environment_id,
          resolutionId: r.resolution_id,
          state: r.state,
          ...(r.failure_code ? { failureCode: r.failure_code } : {}),
          automaticAttempts: r.automatic_attempts,
          reportThread: r.report_thread_json
            ? yield* threadCodec.decode(r.report_thread_json, strict)
            : null,
          sequence: r.delivered_sequence,
        },
        strict,
      ),
    );
  });
  const acknowledgeClaimedReport: MemoryStoreShape["acknowledgeClaimedReport"] = Effect.fn(
    "MemoryStore.acknowledgeClaimedReport",
  )(function* (input) {
    return yield* transact(
      withHubBudget(
        Effect.gen(function* () {
          const d = yield* stored("report-ack-codec", decodeReport(input.delivery, strict));
          if (
            d.state !== "delivered" ||
            !d.reportThread ||
            d.sequence === null ||
            d.reportThread.environmentId !== input.owner
          )
            return false;
          const now = yield* Clock.currentTimeMillis;
          const rows = yield* stored(
            "report-ack-cas",
            sql`SELECT 1 FROM memory_report_outbox WHERE report_id=${d.reportId} AND claimed_by=${input.owner} AND claimed_until=${input.claimUntil} AND claimed_until>${now} AND resolving_environment_id=${input.owner} AND state!='delivered' AND report_approved=1 AND report_kind IN ('resolve','revert','conflict_failure') AND ((report_kind='resolve' AND outcome='resolved') OR (report_kind='revert' AND outcome='reverted') OR (report_kind='conflict_failure' AND outcome='failed'))`,
          );
          if (!rows.length) return false;
          yield* acknowledgeReport(d);
          yield* markRunnable;
          return true;
        }),
      ),
    );
  });
  const deferClaimedReport: MemoryStoreShape["deferClaimedReport"] = Effect.fn(
    "MemoryStore.deferClaimedReport",
  )(function* (input) {
    return yield* transact(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const code = yield* stored(
          "report-failure-codec",
          decodeFailureCode(input.failureCode, strict),
        );
        const rows = yield* stored(
          "report-defer-cas",
          sql`UPDATE memory_report_outbox SET state='failed',failure_code=${code},claimed_by=NULL,claimed_until=NULL,next_attempt_at=${Math.max(now + 30_000, Math.min(now + 600_000, input.nextAttemptAt))}
        WHERE report_id=${input.reportId} AND resolving_environment_id=${input.owner} AND claimed_by=${input.owner} AND claimed_until=${input.claimUntil} AND claimed_until>${now} AND state!='delivered'
        AND NOT EXISTS(SELECT 1 FROM memory_import_keys g WHERE g.space=memory_report_outbox.space AND g.key_kind='report_delivered' AND g.key=memory_report_outbox.report_id) RETURNING report_id`,
        );
        if (rows.length) yield* markRunnable;
        return rows.length === 1;
      }),
    );
  });
  const resetReportAttemptsTx: MemoryStoreShape["resetReportAttemptsTx"] = Effect.fn(
    "MemoryStore.resetReportAttemptsTx",
  )(function* (input, now) {
    yield* Transaction;
    yield* normalizeExpiredReports(now, input.environmentId);
    let resetCount = 0;
    for (const reportId of input.reportIds) {
      const rows = yield* stored(
        "report-reset",
        sql`UPDATE memory_report_outbox SET automatic_attempts=0 WHERE report_id=${reportId} AND space=${input.memorySpaceId} AND resolving_environment_id=${input.environmentId} AND state='failed' AND automatic_attempts=10 AND claimed_by IS NULL AND claimed_until IS NULL AND report_approved=1 AND report_kind IN ('resolve','revert','conflict_failure') AND ((report_kind='resolve' AND outcome='resolved') OR (report_kind='revert' AND outcome='reverted') OR (report_kind='conflict_failure' AND outcome='failed'))
        AND NOT EXISTS(SELECT 1 FROM memory_import_keys g WHERE g.space=memory_report_outbox.space AND g.key_kind='report_delivered' AND g.key=memory_report_outbox.report_id) RETURNING report_id`,
      );
      resetCount += rows.length;
    }
    if (resetCount) yield* markRunnable;
    return { resetCount, unchangedCount: input.reportIds.length - resetCount };
  });
  const purgeDeliveredReportDetailsTx: MemoryStoreShape["purgeDeliveredReportDetailsTx"] =
    Effect.fn("MemoryStore.purgeDeliveredReportDetailsTx")(function* (input) {
      yield* Transaction;
      const rows = yield* stored(
        "report-purge",
        sql.unsafe<{ report_id: string; bytes: number }>(
          `SELECT report_id,${reportMetadataBytes()} AS bytes FROM memory_report_outbox r WHERE ${input.memorySpaceId ? "space=?" : "1=1"} ${input.environmentId ? "AND resolving_environment_id=?" : ""} AND state='delivered' AND delivered_at<=? AND EXISTS(SELECT 1 FROM memory_import_keys g WHERE g.space=r.space AND g.key_kind='report_delivered' AND g.key=r.report_id) ORDER BY delivered_at,report_id LIMIT ?`,
          [
            ...(input.memorySpaceId ? [input.memorySpaceId] : []),
            ...(input.environmentId ? [input.environmentId] : []),
            input.now - M.MEMORY_REPORT_DETAIL_RETENTION_MS,
            Math.max(0, Math.min(256, input.limit)),
          ],
        ),
      );
      for (const r of rows)
        yield* stored(
          "report-purge-delete",
          sql`DELETE FROM memory_report_outbox WHERE report_id=${r.report_id}`,
        );
      return {
        removedRows: rows.length,
        reclaimedLogicalBytes: rows.reduce((n, r) => n + r.bytes, 0),
      };
    });
  const nextReportMaintenanceAt = Effect.fn("MemoryStore.nextReportMaintenanceAt")(function* (
    owner: M.EnvironmentId,
  ) {
    const rows = yield* stored(
      "report-maintenance",
      sql<{
        at: number | null;
      }>`SELECT min(delivered_at)+${M.MEMORY_REPORT_DETAIL_RETENTION_MS} AS at FROM memory_report_outbox r WHERE resolving_environment_id=${owner} AND state='delivered' AND EXISTS(SELECT 1 FROM memory_import_keys g WHERE g.space=r.space AND g.key_kind='report_delivered' AND g.key=r.report_id)`,
    );
    return rows[0]?.at ?? null;
  });
  const pendingReports = Effect.fn("MemoryStore.pendingReports")(function* (limit: number) {
    const rows = yield* stored(
      "reports",
      sql<{
        report_id: string;
        operation_id: string;
        outcome: string;
        resolving_environment_id: string;
        resolution_id: string | null;
        state: string;
        failure_code: string | null;
        report_thread_json: string | null;
        delivered_sequence: number | null;
      }>`SELECT * FROM memory_report_outbox WHERE state IN ('pending','failed') ORDER BY created_at,report_id LIMIT ${Math.min(limit, M.MEMORY_REPORT_MAX_PENDING_ITEMS)}`,
    );
    return yield* stored(
      "report-codec",
      Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          return yield* decodeReport(
            {
              reportId: row.report_id,
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
          );
        }),
      ),
    );
  });
  const claimReport = Effect.fn("MemoryStore.claimReport")(function* (
    id: string,
    owner: string,
    now: number,
    until: number,
  ) {
    const rows = yield* stored(
      "report-claim",
      sql`UPDATE memory_report_outbox SET claimed_by=${owner},claimed_until=${until} WHERE report_id=${id} AND state='pending' AND (claimed_until IS NULL OR claimed_until<=${now}) RETURNING report_id`,
    );
    return rows.length === 1;
  });
  const acknowledgeReport = Effect.fn("MemoryStore.acknowledgeReport")(function* (
    input: M.MemoryReportDelivery,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const report = yield* stored("report-codec", decodeReport(input, strict));
        if (report.state !== "delivered" || !report.reportThread || report.sequence === null)
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        const rows = yield* stored(
          "report-ack",
          sql`UPDATE memory_report_outbox SET state='delivered',report_thread_json=${yield* threadCodec.encode(report.reportThread)},delivered_sequence=${report.sequence},delivered_at=${yield* Clock.currentTimeMillis},claimed_by=NULL,claimed_until=NULL WHERE report_id=${report.reportId} AND operation_id=${report.operationId} AND resolving_environment_id=${report.resolvingEnvironmentId} AND outcome=${report.outcome} RETURNING report_id`,
        );
        if (!rows.length) return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        yield* stored(
          "report-delivery-guard",
          sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json)
      SELECT space,'report_delivered',report_id,memory_id,${yield* codec(Schema.Struct({ operationId: M.MemoryOperationId, outcome: Schema.Literals(["resolved", "reverted", "failed"]), resolvingEnvironmentId: M.EnvironmentId })).encode({ operationId: report.operationId, outcome: report.outcome, resolvingEnvironmentId: report.resolvingEnvironmentId })}
      FROM memory_report_outbox WHERE report_id=${report.reportId} ON CONFLICT(space,key_kind,key) DO NOTHING`,
        );
      }),
    );
  });
  const failGenerationAttempt = Effect.fn("MemoryStore.failGenerationAttempt")(function* (input: {
    work: MemoryWork;
    environmentId: M.EnvironmentId;
    failureCode: M.MemoryFailureCode;
    now: number;
    retryAt: number | null;
  }) {
    return yield* transact(
      Effect.gen(function* () {
        const work = input.work;
        const code = yield* stored("failure-code", decodeFailureCode(input.failureCode, strict));
        const environment = yield* stored(
          "failure-environment",
          decodeFailureEnvironment(input.environmentId, strict),
        );
        const current = yield* readWork(work.id);
        if (
          !current ||
          current.status !== "running" ||
          work.status !== "running" ||
          work.claimedBy === null ||
          work.claimedUntil === null ||
          current.claimedBy !== work.claimedBy ||
          current.claimedUntil !== work.claimedUntil ||
          current.attempt !== work.attempt ||
          current.claimedUntil <= input.now
        )
          return false;
        if (
          current.space !== work.space ||
          current.memoryId !== work.memoryId ||
          (yield* workMetadataCodec.encode(current.metadata)) !==
            (yield* workMetadataCodec.encode(work.metadata))
        )
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        const metadata = current.metadata;
        if (
          metadata.kind !== "summary" ||
          !current.memoryId ||
          metadata.sourceThread.environmentId !== environment ||
          !["summary", "consolidate"].includes(current.kind)
        )
          return yield* new MemoryStoreConflict({ code: "unsupported_operation" });
        const reportId = hashText(`${environment}:${work.id}:${work.attempt}:failed`);
        yield* stored(
          "generation-failure-intent",
          sql`INSERT INTO memory_report_outbox
        (report_id,space,memory_id,operation_id,resolution_id,attempt_id,resolving_environment_id,outcome,state,failure_code,created_at,report_kind,report_approved,attempts_known)
        VALUES (${reportId},${current.space},${current.memoryId},${metadata.operationId},NULL,${metadata.operationId},${environment},'failed','pending',${code},${input.now},${current.kind},1,1)
        ON CONFLICT(report_id) DO NOTHING`,
        );
        // Keep the safe failure on its existing work even if report admission refused it.
        yield* stored(
          "generation-failure-code",
          sql`UPDATE memory_outbox SET failure_code=${code} WHERE id=${current.id}`,
        );
        if (input.retryAt !== null) yield* retryWork(current, input.retryAt);
        else yield* finishWork(current.id, "failed");
        return true;
      }),
    );
  });
  const failReport = Effect.fn("MemoryStore.failReport")(function* (
    id: string,
    failure: M.MemoryFailureCode,
  ) {
    yield* stored(
      "report-fail",
      sql`UPDATE memory_report_outbox SET state='failed',failure_code=${failure},claimed_by=NULL,claimed_until=NULL WHERE report_id=${id} AND state!='delivered'`,
    );
  });
  // Canonical operation settlement retains shared evidence independently of local delivery.
  const reconcileOperationReportTx: MemoryStoreShape["reconcileOperationReportTx"] = Effect.fn(
    "MemoryStore.reconcileOperationReportTx",
  )(function* (input) {
    yield* Transaction;
    const { operation: op, receipt } = input;
    if (
      (op.kind !== "resolve" && op.kind !== "revert") ||
      receipt.hubSequence === null ||
      !["accepted", "conflicted"].includes(receipt.outcome)
    )
      return;
    if (
      receipt.operationId !== op.operationId ||
      receipt.memoryId !== op.memoryId ||
      receipt.operationDigest !== hashText(M.encodeMemoryOperation(op)) ||
      !M.validateMemoryResolutionApproval(
        op.kind,
        op.kind === "resolve" ? op.resolution.resolutionId : op.revertsResolutionId,
        receipt,
      )
    )
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    const existing = yield* stored(
      "operation-report-compact",
      sql<{
        compact_json: string;
      }>`SELECT compact_json FROM memory_compact_receipts WHERE space=${op.memorySpaceId} AND operation_id=${op.operationId}`,
    );
    const resolutionId =
      op.kind === "resolve" ? op.resolution.resolutionId : op.revertsResolutionId;
    const record: M.MemoryCompactReceipt = existing[0]
      ? yield* compactCodec.decode(existing[0].compact_json, strict)
      : {
          memorySpaceId: op.memorySpaceId,
          originEnvironmentId: op.originEnvironmentId,
          operationKind: op.kind,
          receipt,
          revisionId: op.revision.revisionId,
          resolutionId,
          revertsResolutionId: op.kind === "revert" ? resolutionId : null,
          attemptId: op.kind === "resolve" ? op.operationId : null,
          fencingToken: op.kind === "resolve" ? op.fencingToken : null,
          reportGuard: {
            reportId: resolutionReportId(op.memorySpaceId, op.operationId, resolutionId),
            resolvingEnvironmentId: op.originEnvironmentId,
            resolutionId,
            outcome: op.kind === "resolve" ? "resolved" : "reverted",
          },
        };
    if (
      record.operationKind !== op.kind ||
      record.originEnvironmentId !== op.originEnvironmentId ||
      record.resolutionId !== resolutionId ||
      record.revisionId !== op.revision.revisionId ||
      (yield* receiptCodec.encode(record.receipt)) !== (yield* receiptCodec.encode(receipt))
    )
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    // Operation envelopes do not carry the original claim attempt ID. Use this
    // validated projection for delivery, but let canonical checkpoint receipts own
    // permanent compact metadata (including their immutable attempt identity).
    yield* reconcileResolutionReportTx({ record, localEnvironmentId: input.localEnvironmentId });
  });
  // Page the PK before inspecting ownership/evidence: ambiguous rows cannot starve later spaces.
  const normalizeForeignReportIntentsTx: MemoryStoreShape["normalizeForeignReportIntentsTx"] =
    Effect.fn("MemoryStore.normalizeForeignReportIntentsTx")(function* (
      localEnvironmentId,
      after = null,
    ) {
      yield* Transaction;
      const page = yield* stored(
        "foreign-report-page",
        after === null
          ? sql<{
              report_id: string;
              resolving_environment_id: string;
              state: string;
            }>`SELECT report_id,resolving_environment_id,state FROM memory_report_outbox ORDER BY report_id LIMIT 256`
          : sql<{
              report_id: string;
              resolving_environment_id: string;
              state: string;
            }>`SELECT report_id,resolving_environment_id,state FROM memory_report_outbox WHERE report_id>${after} ORDER BY report_id LIMIT 256`,
      );
      for (const candidate of page) {
        if (
          candidate.resolving_environment_id === localEnvironmentId ||
          candidate.state === "delivered"
        )
          continue;
        const rows = yield* stored(
          "foreign-report-evidence",
          sql<{
            compact_json: string;
          }>`SELECT c.compact_json FROM memory_report_outbox r JOIN memory_compact_receipts c ON c.space=r.space AND c.operation_id=r.operation_id WHERE r.report_id=${candidate.report_id}`,
        );
        for (const row of rows) {
          const record = yield* compactCodec
            .decode(row.compact_json, strict)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (
            record?.reportGuard &&
            record.reportGuard.reportId === candidate.report_id &&
            record.reportGuard.reportId ===
              resolutionReportId(
                record.memorySpaceId,
                record.receipt.operationId,
                record.reportGuard.resolutionId,
              )
          )
            yield* reconcileResolutionReportTx({ record, localEnvironmentId });
        }
        // Older body-bearing receives may not have a compact checkpoint receipt yet.
        // Their canonical event metadata and approved receipt are sufficient without
        // loading payloads or inventing a missing claim attempt identity.
        const events = yield* stored(
          "foreign-report-events",
          sql<{
            report_id: string;
            metadata_json: string;
            receipt_json: string;
            operation_digest: string;
          }>`SELECT r.report_id,e.metadata_json,e.receipt_json,e.operation_digest FROM memory_report_outbox r JOIN memory_events e ON e.memory_space_id=r.space AND e.operation_id=r.operation_id WHERE r.report_id=${candidate.report_id}`,
        );
        for (const row of events) {
          const metadata = yield* metadataCodec
            .decode(row.metadata_json, strict)
            .pipe(Effect.orElseSucceed(() => undefined));
          const approval = yield* receiptCodec
            .decode(row.receipt_json, strict)
            .pipe(Effect.orElseSucceed(() => undefined));
          if (
            !metadata ||
            !approval ||
            !("hubSequence" in approval) ||
            approval.hubSequence === null ||
            !["accepted", "conflicted"].includes(approval.outcome) ||
            metadata.originEnvironmentId === localEnvironmentId ||
            approval.operationId !== metadata.operationId ||
            approval.memoryId !== metadata.memoryId ||
            approval.operationDigest !== row.operation_digest
          )
            continue;
          const resolutionId =
            metadata.kind === "resolve"
              ? metadata.resolution?.resolutionId
              : metadata.kind === "revert"
                ? metadata.revertsResolutionId
                : undefined;
          if (
            !resolutionId ||
            !M.validateMemoryResolutionApproval(metadata.kind, resolutionId, approval) ||
            (metadata.kind === "resolve" &&
              metadata.resolution?.resolvingEnvironmentId !== metadata.originEnvironmentId) ||
            row.report_id !==
              resolutionReportId(metadata.memorySpaceId, metadata.operationId, resolutionId)
          )
            continue;
          yield* stored(
            "foreign-report-event-intent",
            sql`DELETE FROM memory_report_outbox WHERE report_id=${row.report_id} AND space=${metadata.memorySpaceId} AND memory_id=${metadata.memoryId} AND operation_id=${metadata.operationId} AND resolution_id=${resolutionId} AND resolving_environment_id=${metadata.originEnvironmentId} AND outcome=${metadata.kind === "resolve" ? "resolved" : "reverted"} AND state!='delivered'`,
          );
        }
      }
      return {
        examined: page.length,
        nextCursor: page.length === 256 ? page[255]!.report_id : null,
      };
    });
  const reconcileResolutionReportTx: MemoryStoreShape["reconcileResolutionReportTx"] = Effect.fn(
    "MemoryStore.reconcileResolutionReportTx",
  )(function* (input) {
    yield* Transaction;
    const record = yield* stored(
      "report-compact",
      compactCodec.decode(yield* compactCodec.encode(input.record), strict),
    );
    const guard = record.reportGuard;
    if (!guard) return { reportId: null, deliverable: false };
    const reportId = resolutionReportId(
      record.memorySpaceId,
      record.receipt.operationId,
      guard.resolutionId,
    );
    if (guard.reportId !== reportId)
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    if (
      record.receipt.hubSequence === null ||
      !["accepted", "conflicted"].includes(record.receipt.outcome) ||
      !(
        (record.operationKind === "resolve" && guard.outcome === "resolved") ||
        (record.operationKind === "revert" && guard.outcome === "reverted")
      ) ||
      record.originEnvironmentId !== guard.resolvingEnvironmentId
    )
      return { reportId, deliverable: false };
    const deliverable = guard.resolvingEnvironmentId === input.localEnvironmentId;
    if (!deliverable) {
      // Only the exact canonical foreign delivery intent is disposable. Shared receipt
      // and delivered guards remain authoritative; unknown/contradictory rows stay put.
      yield* stored(
        "foreign-report-intent",
        sql`DELETE FROM memory_report_outbox WHERE report_id=${reportId} AND space=${record.memorySpaceId} AND memory_id=${record.receipt.memoryId} AND operation_id=${record.receipt.operationId} AND resolution_id=${guard.resolutionId} AND resolving_environment_id=${guard.resolvingEnvironmentId} AND outcome=${guard.outcome} AND state!='delivered'`,
      );
      return { reportId, deliverable };
    }
    const delivered = yield* stored(
      "report-delivered-guard",
      sql`SELECT 1 FROM memory_import_keys WHERE space=${record.memorySpaceId} AND key_kind='report_delivered' AND key=${reportId}`,
    );
    if (delivered.length) return { reportId, deliverable: false };
    yield* stored(
      "report-reconcile",
      sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolution_id,attempt_id,resolving_environment_id,outcome,state,created_at,report_kind,report_approved,attempts_known) VALUES (${reportId},${record.memorySpaceId},${record.receipt.memoryId},${record.receipt.operationId},${guard.resolutionId},${record.attemptId},${guard.resolvingEnvironmentId},${guard.outcome},'pending',${record.receipt.resolutionApproval ? Date.parse(record.receipt.resolutionApproval.appliedAtUtc) : 0},${record.operationKind === "resolve" ? "resolve" : "revert"},1,1) ON CONFLICT(report_id) DO UPDATE SET report_approved=1,report_kind=excluded.report_kind WHERE memory_report_outbox.space=excluded.space AND memory_report_outbox.memory_id=excluded.memory_id AND memory_report_outbox.operation_id=excluded.operation_id AND memory_report_outbox.resolving_environment_id=excluded.resolving_environment_id AND memory_report_outbox.resolution_id=excluded.resolution_id AND memory_report_outbox.outcome=excluded.outcome`,
    );
    const retained = yield* stored(
      "report-admission",
      sql`SELECT 1 FROM memory_report_outbox WHERE report_id=${reportId} AND report_approved=1`,
    );
    if (retained.length) yield* markRunnable;
    return { reportId, deliverable: retained.length === 1 };
  });
  return {
    normalizeExpiredReports,
    readReportTarget,
    nextReportWakeAt,
    acquireReports,
    acknowledgeClaimedReport,
    deferClaimedReport,
    resetReportAttemptsTx,
    purgeDeliveredReportDetailsTx,
    nextReportMaintenanceAt,
    pendingReports,
    claimReport,
    acknowledgeReport,
    failGenerationAttempt,
    failReport,
    reconcileOperationReportTx,
    normalizeForeignReportIntentsTx,
    reconcileResolutionReportTx,
  };
};

export type Reports = ReturnType<typeof makeReports>;
