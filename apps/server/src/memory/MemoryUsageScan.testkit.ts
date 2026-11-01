import { assert } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Store from "./MemoryStore.ts";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
const scopeKey = (scope: M.MemoryScope) => {
  if (scope.kind === "user") return "user";
  if (scope.kind === "thread")
    return `thread:${scope.thread.environmentId.length}:${scope.thread.environmentId}:${scope.thread.threadId}`;
  return scope.projectKey.kind === "repository"
    ? `repository:${scope.projectKey.groupingKey}`
    : `explicit:${scope.projectKey.sharedProjectId}`;
};
export const scanUsage = Effect.fn("scanUsage")(function* (
  space: M.MemorySpaceId,
  scope: M.MemoryScope,
) {
  const sql = yield* SqlClient.SqlClient;
  const stored = <A>(_stage: string, effect: Effect.Effect<A, SqlError.SqlError>) => effect;
  const globalHubCounters = () =>
    sql<{
      dimension: string;
      value: number;
    }>`SELECT dimension,value FROM memory_quota_counters WHERE space='_hub_global' AND scope_key=''`;
  const scoped = yield* stored(
    "usage-scope",
    sql<{
      count: number;
    }>`SELECT count(*) AS count FROM memory_items WHERE space=${space} AND scope_key=${scopeKey(scope)} AND status!='forgotten'`,
  );
  const summaryCount = yield* stored(
    "usage-summaries",
    sql<{
      count: number;
    }>`SELECT count(*) AS count FROM memory_items i WHERE space=${space} AND scope_key=${scopeKey(scope)} AND status!='forgotten' AND EXISTS (SELECT 1 FROM memory_revisions r JOIN json_each(i.heads_json) h WHERE r.space=i.space AND r.revision_id=h.value AND json_extract(r.provenance_json,'$.sourceThread') IS NOT NULL)`,
  );
  const local = yield* stored(
    "usage-local",
    sql<{ count: number }>`SELECT count(*) AS count FROM memory_items WHERE status!='forgotten'`,
  );
  const live = yield* stored(
    "usage-live",
    sql<{
      count: number;
    }>`SELECT count(*) AS count FROM memory_items WHERE space=${space} AND status!='forgotten'`,
  );
  const identities = yield* stored(
    "usage-identities",
    sql<{
      count: number;
      bytes: number;
      reserved_receipts: number;
      reserved_keys: number;
    }>`SELECT count(*) AS count,coalesce(sum(reserve_bytes),0) AS bytes,coalesce(sum(CASE WHEN NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.space=memory_identity_ledger.space AND t.memory_id=memory_identity_ledger.memory_id) THEN 1 ELSE 0 END),0) AS reserved_receipts,coalesce(sum(reserve_keys),0) AS reserved_keys FROM memory_identity_ledger WHERE space=${space}`,
  );
  const payloads = yield* stored(
    "usage-payloads",
    sql<{
      live: number;
      history: number;
      all_bytes: number;
    }>`SELECT coalesce(sum(CASE WHEN EXISTS (SELECT 1 FROM memory_items i JOIN json_each(i.heads_json) h JOIN memory_revisions v ON v.space=i.space AND v.revision_id=h.value WHERE i.space=p.space AND i.memory_id=p.memory_id AND v.payload_ref=p.payload_ref) THEN length(CAST(p.body_json AS BLOB)) ELSE 0 END),0) AS live,coalesce(sum(CASE WHEN NOT EXISTS (SELECT 1 FROM memory_items i JOIN json_each(i.heads_json) h JOIN memory_revisions v ON v.space=i.space AND v.revision_id=h.value WHERE i.space=p.space AND i.memory_id=p.memory_id AND v.payload_ref=p.payload_ref) THEN length(CAST(p.body_json AS BLOB)) ELSE 0 END),0) AS history,coalesce(sum(length(CAST(p.body_json AS BLOB))),0) AS all_bytes FROM memory_payloads p WHERE p.space=${space}`,
  );
  const receipts = yield* stored(
    "usage-receipts",
    sql<{
      count: number;
      bytes: number;
    }>`SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM (
        SELECT operation_id,coalesce(length(compact_blob),length(CAST(compact_json AS BLOB))) AS bytes FROM memory_compact_receipts WHERE space=${space}
        UNION ALL SELECT operation_id,${M.MEMORY_COMPACT_RECEIPT_MAX_BYTES} AS bytes FROM memory_events e WHERE memory_space_id=${space}
          AND NOT EXISTS (SELECT 1 FROM memory_compact_receipts c WHERE c.space=e.memory_space_id AND c.operation_id=e.operation_id))`,
  );
  const keys = yield* stored(
    "usage-keys",
    sql<{
      count: number;
      bytes: number;
    }>`SELECT count(*) AS count,coalesce(sum(length(CAST(record_json AS BLOB))),0) AS bytes FROM memory_import_keys WHERE space=${space}`,
  );
  const work = yield* stored(
    "usage-work",
    sql<{
      count: number;
      bytes: number;
    }>`SELECT count(*) AS count,coalesce(sum(length(CAST(metadata_json AS BLOB))),0) AS bytes FROM memory_outbox WHERE space=${space} AND status IN ('pending','retry','running')`,
  );
  const reports = yield* stored(
    "usage-reports",
    sql<{
      count: number;
    }>`SELECT coalesce((SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='report_items' AND scope_key=''),0) AS count`,
  );
  const log = yield* stored(
    "usage-log",
    sql<{
      count: number;
      bytes: number;
    }>`SELECT count(*) AS count,coalesce(sum(length(CAST(metadata_json AS BLOB))+length(CAST(receipt_json AS BLOB))),0) AS bytes FROM memory_events WHERE memory_space_id=${space}`,
  );
  const environment = yield* stored(
    "usage-environment",
    sql<{
      live: number;
      history: number;
      ids: number;
      receipts: number;
      permanent: number;
      receipt_bytes: number;
    }>`SELECT
      (SELECT coalesce(sum(length(CAST(p.body_json AS BLOB))),0) FROM memory_payloads p WHERE EXISTS (SELECT 1 FROM memory_items i JOIN json_each(i.heads_json) h JOIN memory_revisions v ON v.space=i.space AND v.revision_id=h.value WHERE i.space=p.space AND i.memory_id=p.memory_id AND v.payload_ref=p.payload_ref)) AS live,
      (SELECT coalesce(sum(length(CAST(p.body_json AS BLOB))),0) FROM memory_payloads p WHERE NOT EXISTS (SELECT 1 FROM memory_items i JOIN json_each(i.heads_json) h JOIN memory_revisions v ON v.space=i.space AND v.revision_id=h.value WHERE i.space=p.space AND i.memory_id=p.memory_id AND v.payload_ref=p.payload_ref)) AS history,
      (SELECT count(*) FROM memory_identity_ledger) AS ids,
      (SELECT count(*) FROM (SELECT memory_space_id AS space,operation_id FROM memory_events UNION SELECT space,operation_id FROM memory_compact_receipts))+(SELECT count(*) FROM memory_identity_ledger l WHERE NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.space=l.space AND t.memory_id=l.memory_id)) AS receipts,
      (SELECT coalesce(sum(reserve_bytes),0) FROM memory_identity_ledger)+(SELECT coalesce(sum(length(CAST(record_json AS BLOB))),0) FROM memory_import_keys)+(SELECT coalesce(sum(length(CAST(record_json AS BLOB))),0) FROM memory_import_lineage) AS permanent,
      (SELECT coalesce(sum(coalesce(length(compact_blob),length(CAST(compact_json AS BLOB)))),0) FROM memory_compact_receipts)+
      (SELECT count(*)*${M.MEMORY_COMPACT_RECEIPT_MAX_BYTES} FROM memory_events e WHERE NOT EXISTS (SELECT 1 FROM memory_compact_receipts c WHERE c.space=e.memory_space_id AND c.operation_id=e.operation_id))+
      (SELECT count(*)*${M.MEMORY_COMPACT_RECEIPT_MAX_BYTES} FROM memory_identity_ledger l WHERE NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.space=l.space AND t.memory_id=l.memory_id)) AS receipt_bytes`,
  );
  const lineage = yield* stored(
    "usage-lineage",
    sql<{ bytes: number }>`
      SELECT coalesce(sum(length(CAST(record_json AS BLOB))),0) AS bytes FROM memory_import_lineage WHERE space=${space}`,
  );
  const importUsage = yield* stored(
    "usage-import",
    sql<{
      value: number;
    }>`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='import_metadata' AND scope_key=''`,
  );
  const importMetadata = importUsage[0]?.value ?? 0;
  return {
    scopeItems: scoped[0]!.count,
    scopeSummaries: summaryCount[0]!.count,
    scopeExplicit: scoped[0]!.count - summaryCount[0]!.count,
    environmentItems: local[0]!.count,
    environmentLiveBytes: environment[0]!.live,
    environmentHistoryBytes: environment[0]!.history,
    environmentLifetimeIds: environment[0]!.ids,
    environmentReceipts: environment[0]!.receipts,
    environmentPermanentBytes:
      environment[0]!.permanent +
      environment[0]!.receipt_bytes +
      ((yield* globalHubCounters()).find((row) => row.dimension === "hub_private_metadata")
        ?.value ?? 0),
    spaceItems: live[0]!.count,
    lifetimeIds: identities[0]!.count,
    permanentBytes:
      importMetadata +
      identities[0]!.bytes +
      lineage[0]!.bytes +
      keys[0]!.bytes +
      receipts[0]!.bytes +
      identities[0]!.reserved_receipts * M.MEMORY_COMPACT_RECEIPT_MAX_BYTES,
    receipts: receipts[0]!.count + identities[0]!.reserved_receipts,
    liveBytes: payloads[0]!.live,
    historyBytes: payloads[0]!.history,
    logicalBytes:
      importMetadata + payloads[0]!.all_bytes + log[0]!.bytes + keys[0]!.bytes + lineage[0]!.bytes,
    keys: keys[0]!.count + identities[0]!.reserved_keys,
    workItems: work[0]!.count,
    workBytes: work[0]!.bytes,
    reportItems: reports[0]!.count,
    reportBytes:
      (yield* stored(
        "usage-report-bytes",
        sql<{
          value: number;
        }>`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='report_bytes' AND scope_key=''`,
      ))[0]?.value ?? 0,
    logRows: log[0]!.count,
    logBytes: log[0]!.bytes,
  };
});

/** Full scan oracle is intentionally test-only; check every persisted space and scope. */
const decodeScopeKey = Schema.decodeUnknownEffect(M.MemoryScope);
const decodeScope = Schema.decodeEffect(Schema.fromJsonString(M.MemoryScope));
// Counter scope addresses survive the last item moving or being deleted.
const scopeFromKey = (key: string): unknown => {
  if (key === "user") return { kind: "user" };
  for (const kind of ["repository", "explicit"] as const) {
    const prefix = `${kind}:`;
    if (key.startsWith(prefix))
      return {
        kind: "project",
        projectKey: {
          kind,
          [kind === "repository" ? "groupingKey" : "sharedProjectId"]: key.slice(prefix.length),
        },
      };
  }
  const thread = /^thread:(\d+):/.exec(key);
  if (thread) {
    const start = thread[0].length;
    const end = start + Number(thread[1]);
    if (key[end] === ":")
      return {
        kind: "thread",
        thread: { environmentId: key.slice(start, end), threadId: key.slice(end + 1) },
      };
  }
  return null;
};
export const assertUsageCounters = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Store.MemoryStore;
  const spaces = yield* sql<{
    space: string;
  }>`SELECT space FROM memory_items
    UNION SELECT space FROM memory_identity_ledger
    UNION SELECT space FROM memory_payloads
    UNION SELECT memory_space_id AS space FROM memory_events
    UNION SELECT space FROM memory_compact_receipts
    UNION SELECT space FROM memory_import_keys
    UNION SELECT space FROM memory_import_lineage
    UNION SELECT space FROM memory_outbox
    UNION SELECT space FROM memory_import_receipts
    UNION SELECT space FROM memory_import_noop_results
    UNION SELECT space FROM memory_report_outbox
    UNION SELECT space FROM memory_quota_counters WHERE space NOT IN ('_usage_environment','_hub_global')`;
  for (const { space } of spaces) {
    // Internal unbound storage uses _local:<environment>, alongside UUID spaces.
    const id = space as M.MemorySpaceId;
    const scopes = yield* sql<{
      scope_json: string;
    }>`SELECT DISTINCT scope_json FROM memory_items WHERE space=${space}`;
    const candidates: M.MemoryScope[] = [{ kind: "user" }];
    for (const row of scopes) {
      // Some SQL-only tests intentionally store a placeholder scope_json; user is still checked.
      const scope = yield* decodeScope(row.scope_json).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (scope) candidates.push(scope);
    }
    const addresses = yield* sql<{
      scope_key: string;
    }>`SELECT DISTINCT scope_key FROM memory_quota_counters WHERE space=${space} AND dimension GLOB 'usage_*' AND scope_key!=''`;
    for (const { scope_key } of addresses) {
      const scope = yield* decodeScopeKey(scopeFromKey(scope_key));
      candidates.push(scope);
    }
    for (const scope of new Map(candidates.map((scope) => [scopeKey(scope), scope])).values())
      assert.deepStrictEqual(yield* store.usage(id, scope), yield* scanUsage(id, scope));
  }
});

export const checkUsage = Effect.tap(() => assertUsageCounters);

// The local input meter includes resolution metadata independently of 078 usage_*.
// Compare this scan with input-meter deltas in slot/migration transaction tests.
export const scanRevertResultBytes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ space: string; bytes: number }>`SELECT space,
    coalesce(sum(coalesce(length(CAST(revert_operation_id AS BLOB)),0)+coalesce(length(CAST(revert_result_json AS BLOB)),0)),0) AS bytes
    FROM memory_resolutions GROUP BY space`;
});
