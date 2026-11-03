import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

const WriterFallback = Context.Reference<boolean>(
  "@goat/server/orchestration-v2/ReaderOverloadWriterFallback",
  { defaultValue: () => false },
);

/** Provider ingestion must not fail a running turn because every reader is saturated. */
export const withWriterFallback = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, WriterFallback, true);

/** Reads wait for admission unless writer fallback is enabled, in which case overload retries on the writer. */
export const readOnReader =
  <Args extends ReadonlyArray<unknown>, A, E, R>(
    method: (...args: Args) => Effect.Effect<A, E, R>,
    always = false,
  ) =>
  (...args: Args): Effect.Effect<A, E, R> =>
    Effect.withFiber((fiber) => {
      const read = NodeSqliteClient.readOnly(method(...args));
      if (!always && !fiber.getRef(WriterFallback)) return read;
      return NodeSqliteClient.failFastReaderAdmission(read).pipe(
        Effect.catchIf(NodeSqliteClient.isReaderAdmissionOverload, () =>
          NodeSqliteClient.onWriter(method(...args)),
        ),
      );
    });
