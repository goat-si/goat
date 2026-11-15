import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { reportMetadataBytes } from "../../memory/MemoryReportAccounting.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE memory_report_outbox ADD COLUMN automatic_attempts INTEGER NOT NULL DEFAULT 0 CHECK(automatic_attempts BETWEEN 0 AND 10)`;
  yield* sql`ALTER TABLE memory_report_outbox ADD COLUMN report_kind TEXT NOT NULL DEFAULT 'unknown' CHECK(report_kind IN ('resolve','revert','conflict_failure','summary','consolidate','unknown'))`;
  yield* sql`ALTER TABLE memory_report_outbox ADD COLUMN report_approved INTEGER NOT NULL DEFAULT 0 CHECK(report_approved IN (0,1))`;
  yield* sql`ALTER TABLE memory_report_outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE memory_report_outbox ADD COLUMN attempts_known INTEGER NOT NULL DEFAULT 0 CHECK(attempts_known IN (0,1))`;
  // Only matching canonical, accepted receipts prove kind and approval. No body inspection
  // or guesses from outcome/nullable resolution IDs; pre-feature attempts remain unknown.
  yield* sql`UPDATE memory_report_outbox AS r SET
    report_kind=(SELECT json_extract(c.compact_json,'$.operationKind') FROM memory_compact_receipts c WHERE c.space=r.space AND c.operation_id=r.operation_id),
    report_approved=1
    WHERE EXISTS(SELECT 1 FROM memory_compact_receipts c WHERE c.space=r.space AND c.operation_id=r.operation_id
      AND json_extract(c.compact_json,'$.operationKind') IN ('resolve','revert')
      AND json_extract(c.compact_json,'$.receipt.hubSequence') IS NOT NULL
      AND json_extract(c.compact_json,'$.receipt.outcome') IN ('accepted','conflicted')
      AND json_extract(c.compact_json,'$.originEnvironmentId')=r.resolving_environment_id
      AND json_extract(c.compact_json,'$.receipt.operationId')=r.operation_id
      AND json_extract(c.compact_json,'$.resolutionId')=r.resolution_id
      AND json_extract(c.compact_json,'$.reportGuard.reportId')=r.report_id
      AND json_extract(c.compact_json,'$.reportGuard.resolvingEnvironmentId')=r.resolving_environment_id
      AND json_extract(c.compact_json,'$.reportGuard.outcome')=r.outcome
      AND json_extract(c.compact_json,'$.reportGuard.resolutionId')=r.resolution_id
      AND json_extract(c.compact_json,'$.receipt.memoryId')=r.memory_id
      AND ((r.outcome='resolved' AND json_extract(c.compact_json,'$.operationKind')='resolve' AND json_extract(c.compact_json,'$.receipt.resolutionApproval.resolutionId')=r.resolution_id)
        OR (r.outcome='reverted' AND json_extract(c.compact_json,'$.operationKind')='revert')))`;
  const oldBytes = (p = "") =>
    `length(CAST(${p}report_id AS BLOB))+length(CAST(${p}operation_id AS BLOB))+length(CAST(${p}resolving_environment_id AS BLOB))+coalesce(length(CAST(${p}resolution_id AS BLOB)),0)+coalesce(length(CAST(${p}report_thread_json AS BLOB)),0)+32`;
  for (const d of ["hub_metadata", "hub_private_metadata"])
    yield* sql.unsafe(
      `UPDATE memory_quota_counters SET value=value+(SELECT coalesce(sum((${reportMetadataBytes()})-(${oldBytes()})),0) FROM memory_report_outbox) WHERE space='_hub_global' AND dimension=? AND scope_key=''`,
      [d],
    );
  const counter = (space: string, d: string, expression: string) =>
    expression.startsWith("-")
      ? `UPDATE memory_quota_counters SET value=value+(${expression}) WHERE space=${space} AND dimension='${d}' AND scope_key='';`
      : `INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES (${space},'${d}','',${expression}) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value;`;
  for (const [d, expression] of [
    ["report_items", "1"],
    ["report_bytes", reportMetadataBytes()],
  ] as const)
    yield* sql.unsafe(
      `INSERT INTO memory_quota_counters(space,dimension,scope_key,value) SELECT space,?,'',sum(${expression}) FROM memory_report_outbox WHERE state!='delivered' GROUP BY space`,
      [d],
    );
  for (const [d, expression] of [
    ["report_all_rows", "1"],
    ["report_all_bytes", reportMetadataBytes()],
  ] as const)
    yield* sql.unsafe(
      `INSERT INTO memory_quota_counters(space,dimension,scope_key,value) SELECT space,?,'',sum(${expression}) FROM memory_report_outbox GROUP BY space`,
      [d],
    );
  for (const action of ["INSERT", "UPDATE", "DELETE"] as const) {
    yield* sql.unsafe(`DROP TRIGGER memory_report_outbox_hub_account_${action.toLowerCase()}`);
    const delta = (p: string, sign: number) =>
      ["hub_metadata", "hub_private_metadata"]
        .map((d) => counter("'_hub_global'", d, `${sign}*(${reportMetadataBytes(p + ".")})`))
        .join("") +
      counter(`${p}.space`, "report_all_rows", `${sign}`) +
      counter(`${p}.space`, "report_all_bytes", `${sign}*(${reportMetadataBytes(p + ".")})`) +
      counter(
        `${p}.space`,
        "report_items",
        `${sign}*CASE WHEN ${p}.state!='delivered' THEN 1 ELSE 0 END`,
      ) +
      counter(
        `${p}.space`,
        "report_bytes",
        `${sign}*CASE WHEN ${p}.state!='delivered' THEN ${reportMetadataBytes(p + ".")} ELSE 0 END`,
      );
    yield* sql.unsafe(
      `CREATE TRIGGER memory_report_outbox_hub_account_${action.toLowerCase()} AFTER ${action} ON memory_report_outbox BEGIN ${action !== "INSERT" ? delta("OLD", -1) : ""}${action !== "DELETE" ? delta("NEW", 1) : ""} END`,
    );
  }
  // Refusal is retained as a safe admission diagnostic; canonical approval is independent.
  // Unknown and exhausted rows still consume capacity. Replays of an existing ID are free.
  yield* sql.unsafe(`CREATE TRIGGER memory_report_capacity BEFORE INSERT ON memory_report_outbox
    WHEN NEW.state!='delivered' AND NOT EXISTS(SELECT 1 FROM memory_report_outbox WHERE report_id=NEW.report_id)
      AND (coalesce((SELECT value FROM memory_quota_counters WHERE space=NEW.space AND dimension='report_items' AND scope_key=''),0)+1>${M.MEMORY_REPORT_MAX_PENDING_ITEMS}
        OR coalesce((SELECT value FROM memory_quota_counters WHERE space=NEW.space AND dimension='report_bytes' AND scope_key=''),0)+(${reportMetadataBytes("NEW.")})>${M.MEMORY_REPORT_MAX_PENDING_BYTES})
    BEGIN ${counter("NEW.space", "processing_admission_failures", "1")} SELECT RAISE(IGNORE); END`);
  yield* sql`CREATE INDEX memory_report_delivery_due ON memory_report_outbox(resolving_environment_id,next_attempt_at,claimed_until,created_at,report_id) WHERE state!='delivered' AND report_approved=1 AND report_kind IN ('resolve','revert','conflict_failure')`;
  yield* sql`CREATE INDEX memory_report_local_retention ON memory_report_outbox(resolving_environment_id,delivered_at,report_id) WHERE state='delivered'`;
  yield* sql`CREATE INDEX memory_report_retention ON memory_report_outbox(space,delivered_at,report_id) WHERE state='delivered'`;
});
