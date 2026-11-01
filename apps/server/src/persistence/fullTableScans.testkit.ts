import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

/**
 * Runs `effect` and explains every statement it ran against `table`. A read that scans a large
 * projection table blocks the server for as long as the scan takes, so reads that run per call
 * or on a timer must reach their rows through an index. `scans` lists the statements whose plan
 * reads the whole table; `reads` counts the statements explained, so a test can tell it saw them.
 */
export const fullTableScans = Effect.fn("fullTableScans")(function* <A, E, R>(
  table: string,
  effect: Effect.Effect<A, E, R>,
) {
  const sql = yield* SqlClient.SqlClient;
  const statements: Array<string> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string" && query.includes(table)) statements.push(query);
      };
      return span;
    },
  });
  const result = yield* effect.pipe(Effect.withTracer(tracer));
  const scans: Array<string> = [];
  for (const statement of statements) {
    const plan = yield* sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${statement}`);
    if (plan.some((row) => row.detail.startsWith(`SCAN ${table}`))) scans.push(statement);
  }
  return { result, reads: statements.length, scans };
});
