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

/**
 * Reads on a reader. On reader admission overload it reruns once on the writer when `always` is set
 * or the caller opted in with `withWriterFallback`; other reads fail fast so a burst stays off the writer.
 */
export const readOnReader =
  <Args extends ReadonlyArray<unknown>, A, E, R>(
    method: (...args: Args) => Effect.Effect<A, E, R>,
    always = false,
  ) =>
  (...args: Args): Effect.Effect<A, E, R> =>
    method(...args).pipe(
      NodeSqliteClient.readOnly,
      Effect.catchIf(NodeSqliteClient.isReaderAdmissionOverload, (error) =>
        Effect.withFiber((fiber) =>
          always || fiber.getRef(WriterFallback)
            ? NodeSqliteClient.onWriter(method(...args))
            : Effect.fail(error),
        ),
      ),
    );
