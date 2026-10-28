import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";

export function keepLocalSqlSpan(span: Tracer.Span, eventCount: number): boolean {
  if (span.name !== "sqlite" && span.name !== "sql.transaction") return true;
  if (span.status._tag !== "Ended" || !Exit.isSuccess(span.status.exit)) return true;
  if (Option.isNone(span.parent) || eventCount > 0) return true;
  const wait = span.attributes.get("db.lock_wait_ms");
  if (typeof wait !== "number" || !Number.isFinite(wait) || wait < 0 || wait >= 1) return true;
  const duration = span.status.endTime - span.status.startTime;
  return duration < 0n || duration >= 10_000_000n;
}
