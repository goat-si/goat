import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Tracer from "effect/Tracer";
import { makeAsyncRotatingFileSink } from "./logging.ts";
import type { TraceSink, TraceSinkOptions, TraceSinkFlushStats } from "./observability.ts";

import { redactUrlCredentials } from "./urlCredentialRedaction.ts";

const FLUSH_BUFFER_THRESHOLD = 256;

function* chunks(
  records: ReadonlyArray<{ readonly text: string; readonly bytes: number }>,
  maxBytes: number,
) {
  let texts: string[] = [];
  let bytes = 0;
  for (const record of records) {
    if (bytes + record.bytes > maxBytes && texts.length > 0) {
      yield { text: texts.join(""), bytes, count: texts.length };
      texts = [];
      bytes = 0;
    }
    texts.push(record.text);
    bytes += record.bytes;
  }
  if (texts.length > 0) yield { text: texts.join(""), bytes, count: texts.length };
}

export const makeTraceSink = Effect.fn("makeTraceSink")(function* (options: TraceSinkOptions) {
  const sink = yield* makeAsyncRotatingFileSink({
    filePath: options.filePath,
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
  }).pipe(Effect.orDie);

  let buffer: Array<{ readonly text: string; readonly bytes: number }> = [];
  let bufferBytes = 0;
  const maxBufferBytes = Math.max(options.maxBytes, 4 * 1024 * 1024);
  const flushRequests = yield* Queue.sliding<void>(1);
  const flushSemaphore = yield* Semaphore.make(1);
  const observed = options.onSnapshot
    ? { produced: 0, accepted: 0, written: 0, dropped: 0, logicalWriteBytes: 0 }
    : undefined;
  let flushingRecords = 0;
  let flushingBytes = 0;
  const snapshot = () => {
    if (observed)
      options.onSnapshot?.({
        ...observed,
        bufferedRecords: buffer.length,
        bufferedBytes: bufferBytes,
        flushingRecords,
        flushingBytes,
      });
  };
  let writeFailing = false;
  let droppedCount = 0;
  let failureReported = false;
  const reasons = ["overflow", "disk", "oversize", "serialization"] as const;
  const dropCounts = { overflow: 0, disk: 0, oversize: 0, serialization: 0 };
  const drop = (reason: (typeof reasons)[number], count: number) => {
    droppedCount += count;
    dropCounts[reason] += count;
    if (observed) observed.dropped += count;
  };
  let pendingFlushStats: TraceSinkFlushStats = {
    logicalWriteBytes: 0,
    count: 0,
    durationMs: 0,
  };

  const flushBuffered = Effect.gen(function* () {
    if (buffer.length === 0) {
      return;
    }

    const records = buffer;
    flushingRecords = records.length;
    flushingBytes = bufferBytes;
    buffer = [];
    bufferBytes = 0;
    snapshot();
    let persistedCount = 0;

    for (const chunk of chunks(records, options.maxBytes)) {
      const startedAt = performance.now();
      const written = yield* sink.write(chunk.text).pipe(Effect.result);
      if (Result.isFailure(written)) {
        // Drop the batch after disk failure to avoid an ever-growing retry backlog.
        writeFailing = true;
        drop("disk", records.length - persistedCount);
        flushingRecords = 0;
        flushingBytes = 0;
        snapshot();
        return;
      }
      writeFailing = false;
      pendingFlushStats = {
        logicalWriteBytes: pendingFlushStats.logicalWriteBytes + chunk.bytes,
        count: pendingFlushStats.count + chunk.count,
        durationMs: pendingFlushStats.durationMs + Math.max(0, performance.now() - startedAt),
      };
      persistedCount += chunk.count;
      flushingRecords -= chunk.count;
      flushingBytes -= chunk.bytes;
      if (observed) {
        observed.written += chunk.count;
        observed.logicalWriteBytes += chunk.bytes;
      }
      snapshot();
    }
  });

  const flush = flushSemaphore
    .withPermits(1)(
      Effect.gen(function* () {
        const droppedAtStart = droppedCount;
        yield* flushBuffered;
        for (const reason of reasons) {
          const count = dropCounts[reason];
          dropCounts[reason] = 0;
          if (count > 0 && options.onDrop) {
            yield* options.onDrop(reason, count).pipe(Effect.ignore);
          }
        }
        const stats = pendingFlushStats;
        pendingFlushStats = {
          logicalWriteBytes: 0,
          count: 0,
          durationMs: 0,
        };
        if (stats.count > 0 && options.onFlush) {
          yield* options.onFlush(stats).pipe(Effect.ignore);
        }
        if (droppedCount > 0 && !failureReported) {
          failureReported = true;
          yield* Effect.logWarning(
            "Trace writer could not keep up, dropping records until it recovers",
            {
              filePath: options.filePath,
            },
          );
        } else if (failureReported && !writeFailing && droppedCount === droppedAtStart) {
          yield* Effect.logInfo("Trace writes recovered", {
            filePath: options.filePath,
            droppedCount,
          });
          failureReported = false;
          droppedCount = 0;
        }
      }),
    )
    .pipe(
      // Cancelled OS writes still finish; await completion before rotation or finalizer drain.
      Effect.uninterruptible,
      Effect.withTracerEnabled(false),
      // Drop the ended makeTraceSink parent span so timed-fiber logs cannot accumulate on it.
      Effect.updateContext(Context.omit(Tracer.ParentSpan)<never>),
    );

  yield* Effect.addFinalizer(() => flush.pipe(Effect.ignore));
  yield* Effect.forkScoped(
    Queue.take(flushRequests).pipe(
      Effect.timeoutOption(`${options.batchWindowMs} millis`),
      Effect.andThen(flush),
      Effect.forever,
    ),
  );

  snapshot();
  return {
    filePath: options.filePath,
    push(record) {
      if (observed) observed.produced++;
      let text: string;
      try {
        text = `${redactUrlCredentials(JSON.stringify(record))}\n`;
      } catch {
        drop("serialization", 1);
        snapshot();
        return;
      }
      const bytes = Buffer.byteLength(text);
      if (bytes > options.maxBytes) {
        drop("oversize", 1);
      } else if (bufferBytes + bytes > maxBufferBytes) {
        drop("overflow", 1);
      } else {
        buffer.push({ text, bytes });
        bufferBytes += bytes;
        if (observed) observed.accepted++;
        if (buffer.length >= FLUSH_BUFFER_THRESHOLD) Queue.offerUnsafe(flushRequests, undefined);
      }
      snapshot();
    },
    flush,
    close: () => flush,
  } satisfies TraceSink;
});
