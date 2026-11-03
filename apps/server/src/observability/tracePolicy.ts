import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";
import type { LocalSpanEvents } from "@goat/shared/observability";

// Boundaries that run hundreds of times a minute and almost always finish in microseconds. A fast
// success says nothing the parent span does not; a slow or failed call is still written.
export const HOT_SPANS: ReadonlySet<string> = new Set([
  "CodexAdapterV2.appendReasoning",
  "CodexAssistantText.flushBeforeTool",
  "ChannelSessionFirst.observe",
  "GitConfigReadCache.read",
  "GitMetadataFingerprint.read",
  "OpenCodexQuotaPool.project",
  "OpenCodexQuotaPool.projectProvider",
  "OpenCodexQuotaPool.routeOf",
  "OrchestrationEventStore.rowToV2StoredEvent",
  "ProjectEnrichmentService.getAvailable",
  "ProjectEnrichmentService.peek",
  "ProjectEnrichmentService.request",
  "ProjectionMaintenance.threadEventPages",
  "ProjectionMaintenance.threadItemPages",
  "SessionReceiptHold.replay",
  "SqliteWriter.send",
  "ThreadLiveEventCoalescer.cancelWindow",
  "ThreadLiveEventCoalescer.flushPending",
  "ThreadLiveEventCoalescer.offerAll",
  "UsageLimitSources.projectProviders",
  "handleTraceLine",
  "resolveClaudeHomePath",
  "shell.resolveMacosGit",
]);
export const SQL_SPANS: ReadonlySet<string> = new Set(["sqlite", "sql.transaction"]);
// Every transaction records one of these; a rollback or any other event is still evidence.
const ROUTINE_SQL_EVENTS: ReadonlySet<string> = new Set([
  "effect.sql.transaction.commit",
  "effect.sql.transaction.savepoint",
]);
const FAST_SPAN_NANOS = 10_000_000n;

/**
 * Leaves a span out of the local trace file only when it is a hot boundary or uncontended SQL that
 * ended successfully under a parent within 10 ms, with nothing attached worth reading.
 */
function hasEvidence(span: Tracer.Span, events: LocalSpanEvents): boolean {
  const sql = SQL_SPANS.has(span.name);
  if (!sql && !HOT_SPANS.has(span.name)) return true;
  if (span.status._tag !== "Ended" || !Exit.isSuccess(span.status.exit)) return true;
  if (Option.isNone(span.parent) || span.attributes.has("memory.heap_growth_bytes")) return true;
  if (events.some(([name]) => !sql || !ROUTINE_SQL_EVENTS.has(name))) return true;
  if (sql) {
    // Statements on a transaction's connection carry no wait; unknown stays visible.
    const wait = span.attributes.get("db.lock_wait_ms");
    if (typeof wait !== "number" || !Number.isFinite(wait) || wait < 0 || wait >= 1) return true;
  }
  const duration = span.status.endTime - span.status.startTime;
  return duration < 0n || duration >= FAST_SPAN_NANOS;
}

export function makeLocalSpanPolicy() {
  const parents = new Set<string>();
  const dropped = new Set<string>();
  const limit = 10_000;
  const key = (span: Tracer.AnySpan) => `${span.traceId}:${span.spanId}`;
  const remember = (set: Set<string>, id: string) => {
    if (set.has(id)) return;
    // Evicting old ids can leave an orphan or an unmarked omitted parent.
    const oldest = set.values().next().value;
    if (set.size >= limit && oldest !== undefined) set.delete(oldest);
    set.add(id);
  };
  return (span: Tracer.Span, events: LocalSpanEvents): boolean => {
    const id = key(span);
    const needed = parents.delete(id);
    if (!needed && !hasEvidence(span, events)) {
      remember(dropped, id);
      return false;
    }
    if (Option.isSome(span.parent)) {
      const parentId = key(span.parent.value);
      if (dropped.has(parentId)) span.attribute("trace.parent_omitted", true);
      else remember(parents, parentId);
    }
    return true;
  };
}
