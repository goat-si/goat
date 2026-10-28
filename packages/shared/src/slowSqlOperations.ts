import * as NodePerfHooks from "node:perf_hooks";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

export interface SlowSqlOperation {
  readonly connection: "reader" | "writer" | "checkpoint";
  readonly operation: "prepare" | "execute";
  readonly owner: string;
  readonly nativeMs: number;
  readonly completedAtMs: number;
}

const CAPACITY = 64;
const MIN_NATIVE_MS = 50;
const MAX_AGE_MS = 60_000;
const recent: Array<SlowSqlOperation> = [];

export const recordSlowSql = (operation: SlowSqlOperation) => {
  if (!Number.isFinite(operation.nativeMs) || operation.nativeMs < MIN_NATIVE_MS) return;
  recent.push({
    connection: operation.connection,
    operation: operation.operation,
    owner: operation.owner.slice(0, 160),
    nativeMs: operation.nativeMs,
    completedAtMs: operation.completedAtMs,
  });
  if (recent.length > CAPACITY) recent.shift();
};

export const recentSlowSql = (nowMs: number) =>
  recent.filter(
    (operation) =>
      operation.completedAtMs <= nowMs && nowMs - operation.completedAtMs <= MAX_AGE_MS,
  );

export const measureNativeSql = <A>(
  operation: Pick<SlowSqlOperation, "connection" | "operation" | "owner">,
  execute: () => A,
): A => {
  const started = NodePerfHooks.performance.now();
  try {
    return execute();
  } finally {
    recordSlowSql({
      ...operation,
      nativeMs: NodePerfHooks.performance.now() - started,
      completedAtMs: Date.now(),
    });
  }
};

export const connectionOwner = (fiber: Fiber.Fiber<unknown, unknown>) => {
  const current = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
  if (current?._tag !== "Span") return { fiberId: fiber.id, name: "untraced" };
  let span: Tracer.Span = current;
  while (span.name === "sqlite" || span.name === "sql.transaction") {
    const parent: Tracer.AnySpan | undefined = Option.getOrUndefined(span.parent);
    if (parent?._tag !== "Span") return { fiberId: fiber.id, name: "untraced" };
    span = parent;
  }
  return { fiberId: fiber.id, name: span.name, traceId: span.traceId, spanId: span.spanId };
};

export const measureWriterSql = <A>(
  operation: SlowSqlOperation["operation"],
  execute: () => A,
): A => {
  const fiber = Fiber.getCurrent();
  return measureNativeSql(
    {
      connection: "writer",
      operation,
      owner: fiber === undefined ? "untraced" : connectionOwner(fiber).name,
    },
    execute,
  );
};

export const recordReaderSql = (
  owner: string,
  reply: { readonly prepareMs?: number; readonly nativeMs?: number },
) => {
  for (const [operation, nativeMs] of [
    ["prepare", reply.prepareMs],
    ["execute", reply.nativeMs],
  ] as const) {
    if (nativeMs !== undefined)
      recordSlowSql({
        connection: "reader",
        operation,
        owner,
        nativeMs,
        completedAtMs: Date.now(),
      });
  }
};
