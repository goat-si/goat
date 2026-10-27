import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Stream from "effect/Stream";

import * as TraceDiagnostics from "./TraceDiagnostics.ts";

function ns(ms: number): string {
  return String(BigInt(ms) * 1_000_000n);
}

function record(input: {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly exit?: { readonly _tag: "Success" | "Failure" | "Interrupted"; readonly cause?: string };
  readonly events?: ReadonlyArray<unknown>;
}) {
  return JSON.stringify({
    type: "effect-span",
    name: input.name,
    traceId: input.traceId,
    spanId: input.spanId,
    sampled: true,
    kind: "internal",
    startTimeUnixNano: ns(input.startMs),
    endTimeUnixNano: ns(input.startMs + input.durationMs),
    durationMs: input.durationMs,
    attributes: {},
    events: input.events ?? [],
    links: [],
    exit: input.exit ?? { _tag: "Success" },
  });
}

const traceFilePath = "/tmp/server.trace.ndjson";
const readAt = DateTime.makeUnsafe("2026-05-05T10:00:00.000Z");

function aggregateLines(lines: ReadonlyArray<string>) {
  const aggregator = TraceDiagnostics.makeTraceDiagnosticsAggregator();
  lines.forEach(aggregator.addLine);
  return aggregator.finish({
    traceFilePath,
    scannedFilePaths: TraceDiagnostics.toRotatedTracePaths(traceFilePath, 1),
    readAt,
  });
}

function readTraces(fileSystem: Partial<FileSystem.FileSystem>) {
  return TraceDiagnostics.readTraceDiagnostics({ traceFilePath, maxFiles: 1, readAt }).pipe(
    Effect.provide(TraceDiagnostics.layer.pipe(Layer.provide(FileSystem.layerNoop(fileSystem)))),
  );
}

describe("TraceDiagnostics", () => {
  it.effect("shares overlapping trace scans and starts a fresh scan after completion", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let opens = 0;
      const diagnostics = yield* TraceDiagnostics.make.pipe(
        Effect.provide(
          FileSystem.layerNoop({
            stream: () =>
              Stream.fromEffect(
                Effect.gen(function* () {
                  opens++;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  return new TextEncoder().encode(
                    record({
                      name: "fixture",
                      traceId: "trace",
                      spanId: "span",
                      startMs: 1,
                      durationMs: 2,
                    }) + "\n",
                  );
                }),
              ),
          }),
        ),
      );
      const options = { traceFilePath, maxFiles: 0, readAt };
      const leader = yield* Effect.forkChild(diagnostics.read(options), { startImmediately: true });
      yield* Deferred.await(entered);
      const nextReadAt = DateTime.makeUnsafe("2026-05-05T11:00:00.000Z");
      const follower = yield* Effect.forkChild(
        diagnostics.read({ ...options, readAt: nextReadAt }),
        { startImmediately: true },
      );
      assert.equal(opens, 1);
      yield* Deferred.succeed(release, undefined);
      const first = yield* Fiber.join(leader);
      const second = yield* Fiber.join(follower);
      assert.equal(first.recordCount, 1);
      assert.deepStrictEqual(second, { ...first, readAt: nextReadAt });
      const fresh = yield* diagnostics.read(options);
      assert.equal(opens, 2);
      assert.equal(fresh.recordCount, 1);
    }),
  );

  it.effect("shares read failures only in flight and retries on the next explicit read", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let opens = 0;
      let failed = true;
      const problem = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "open",
        description: "fixture denial",
        pathOrDescriptor: traceFilePath,
      });
      const diagnostics = yield* TraceDiagnostics.make.pipe(
        Effect.provide(
          FileSystem.layerNoop({
            stream: () =>
              Stream.fromEffect(
                Effect.gen(function* () {
                  opens++;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  if (failed) return yield* problem;
                  return new TextEncoder().encode(
                    record({
                      name: "recovered",
                      traceId: "trace",
                      spanId: "span",
                      startMs: 1,
                      durationMs: 1,
                    }) + "\n",
                  );
                }),
              ),
          }),
        ),
      );
      const options = { traceFilePath, maxFiles: 0, readAt };
      const leader = yield* Effect.forkChild(diagnostics.read(options), { startImmediately: true });
      yield* Deferred.await(entered);
      const follower = yield* Effect.forkChild(diagnostics.read(options), {
        startImmediately: true,
      });
      assert.equal(opens, 1);
      yield* Deferred.succeed(release, undefined);
      const results = yield* Effect.all([Fiber.join(leader), Fiber.join(follower)]);
      assert.isTrue(results.every((result) => Option.isSome(result.error)));
      failed = false;
      const recovered = yield* diagnostics.read(options);
      assert.equal(recovered.recordCount, 1);
      assert.isTrue(Option.isNone(recovered.error));
      assert.equal(opens, 2);
    }),
  );

  it.effect("a cancelled diagnostics follower does not cancel its shared leader", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let opens = 0;
      const diagnostics = yield* TraceDiagnostics.make.pipe(
        Effect.provide(
          FileSystem.layerNoop({
            stream: () =>
              Stream.fromEffect(
                Effect.gen(function* () {
                  opens++;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  return new TextEncoder().encode(
                    record({
                      name: "fixture",
                      traceId: "trace",
                      spanId: "span",
                      startMs: 1,
                      durationMs: 1,
                    }) + "\n",
                  );
                }),
              ),
          }),
        ),
      );
      const options = { traceFilePath, maxFiles: 0, readAt };
      const leader = yield* Effect.forkChild(diagnostics.read(options), { startImmediately: true });
      yield* Deferred.await(entered);
      const follower = yield* Effect.forkChild(diagnostics.read(options), {
        startImmediately: true,
      });
      yield* Fiber.interrupt(follower);
      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* Fiber.join(leader)).recordCount, 1);
      assert.equal(opens, 1);
      yield* diagnostics.read(options);
      assert.equal(opens, 2);
    }),
  );

  it.effect("leader interruption releases diagnostics followers and clears the flight", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let opens = 0;
      const diagnostics = yield* TraceDiagnostics.make.pipe(
        Effect.provide(
          FileSystem.layerNoop({
            stream: () =>
              Stream.fromEffect(
                Effect.gen(function* () {
                  opens++;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  return new TextEncoder().encode(
                    record({
                      name: "fixture",
                      traceId: "trace",
                      spanId: "span",
                      startMs: 1,
                      durationMs: 1,
                    }) + "\n",
                  );
                }),
              ),
          }),
        ),
      );
      const options = { traceFilePath, maxFiles: 0, readAt };
      const leader = yield* Effect.forkChild(diagnostics.read(options), { startImmediately: true });
      yield* Deferred.await(entered);
      const follower = yield* Effect.forkChild(diagnostics.read(options), {
        startImmediately: true,
      });
      yield* Fiber.interrupt(leader);
      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* Fiber.join(follower).pipe(Effect.exit))._tag, "Failure");
      assert.equal((yield* diagnostics.read(options)).recordCount, 1);
      assert.equal(opens, 2);
    }),
  );

  it.effect("shares scan defects with followers and retries after the failed flight", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let opens = 0;
      let failed = true;
      const problem = new Error("fixture defect");
      const diagnostics = yield* TraceDiagnostics.make.pipe(
        Effect.provide(
          FileSystem.layerNoop({
            stream: () =>
              Stream.fromEffect(
                Effect.gen(function* () {
                  opens++;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  if (failed) return yield* Effect.die(problem);
                  return new TextEncoder().encode(
                    record({
                      name: "recovered",
                      traceId: "trace",
                      spanId: "span",
                      startMs: 1,
                      durationMs: 1,
                    }) + "\n",
                  );
                }),
              ),
          }),
        ),
      );
      const options = { traceFilePath, maxFiles: 0, readAt };
      const leader = yield* Effect.forkChild(diagnostics.read(options).pipe(Effect.exit), {
        startImmediately: true,
      });
      yield* Deferred.await(entered);
      const follower = yield* Effect.forkChild(diagnostics.read(options).pipe(Effect.exit), {
        startImmediately: true,
      });
      assert.equal(opens, 1);
      yield* Deferred.succeed(release, undefined);
      const first = yield* Fiber.join(leader);
      const second = yield* Fiber.join(follower);
      assert.equal(first._tag, "Failure");
      assert.deepStrictEqual(second, first);
      failed = false;
      assert.equal((yield* diagnostics.read(options)).recordCount, 1);
      assert.equal(opens, 2);
    }),
  );

  it.effect("shares equivalent scan options while isolating paths, rotations, and thresholds", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const opens: Array<string> = [];
      const diagnostics = yield* TraceDiagnostics.make.pipe(
        Effect.provide(
          FileSystem.layerNoop({
            stream: (path) =>
              Stream.fromEffect(
                Effect.gen(function* () {
                  opens.push(path);
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  return new TextEncoder().encode(
                    record({
                      name: "fixture",
                      traceId: "trace",
                      spanId: "span",
                      startMs: 1,
                      durationMs: 500,
                    }) + "\n",
                  );
                }),
              ),
          }),
        ),
      );
      const options = { traceFilePath, maxFiles: 0, readAt };
      const leader = yield* Effect.forkChild(diagnostics.read(options), { startImmediately: true });
      yield* Deferred.await(entered);
      const equivalent = yield* Effect.forkChild(
        diagnostics.read({ ...options, maxFiles: 0.9, slowSpanThresholdMs: 1_000 }),
        { startImmediately: true },
      );
      const otherPath = yield* Effect.forkChild(
        diagnostics.read({ ...options, traceFilePath: "/tmp/other.trace.ndjson" }),
        { startImmediately: true },
      );
      const rotated = yield* Effect.forkChild(diagnostics.read({ ...options, maxFiles: 1 }), {
        startImmediately: true,
      });
      const lowerThreshold = yield* Effect.forkChild(
        diagnostics.read({ ...options, slowSpanThresholdMs: 100 }),
        { startImmediately: true },
      );
      assert.deepStrictEqual(opens, [
        traceFilePath,
        "/tmp/other.trace.ndjson",
        `${traceFilePath}.1`,
        traceFilePath,
      ]);
      yield* Deferred.succeed(release, undefined);
      const first = yield* Fiber.join(leader);
      assert.deepStrictEqual(yield* Fiber.join(equivalent), first);
      assert.equal((yield* Fiber.join(otherPath)).traceFilePath, "/tmp/other.trace.ndjson");
      assert.equal((yield* Fiber.join(rotated)).recordCount, 2);
      assert.equal((yield* Fiber.join(lowerThreshold)).slowSpanCount, 1);
      assert.equal(first.slowSpanCount, 0);
      assert.equal(opens.length, 5);
    }),
  );

  it.effect("aggregates failures, slow spans, log levels, and parse errors", () =>
    Effect.sync(() => {
      const diagnostics = aggregateLines([
        record({
          name: "server.getConfig",
          traceId: "trace-a",
          spanId: "span-a",
          startMs: 1_000,
          durationMs: 50,
        }),
        "not-json",
        record({
          name: "orchestration.dispatch",
          traceId: "trace-b",
          spanId: "span-b",
          startMs: 2_000,
          durationMs: 1_500,
          exit: { _tag: "Failure", cause: "Provider crashed" },
          events: [
            {
              name: "provider failed",
              timeUnixNano: ns(3_400),
              attributes: { "effect.logLevel": "Error" },
            },
          ],
        }),
        record({
          name: "orchestration.dispatch",
          traceId: "trace-c",
          spanId: "span-c",
          startMs: 4_000,
          durationMs: 250,
          exit: { _tag: "Failure", cause: "Provider crashed" },
        }),
        record({
          name: "git.status",
          traceId: "trace-d",
          spanId: "span-d",
          startMs: 5_000,
          durationMs: 25,
          exit: { _tag: "Interrupted", cause: "Interrupted" },
          events: [
            {
              name: "status delayed",
              timeUnixNano: ns(5_010),
              attributes: { "effect.logLevel": "Warning" },
            },
          ],
        }),
      ]);

      assert.equal(diagnostics.recordCount, 4);
      assert.equal(DateTime.formatIso(diagnostics.readAt), "2026-05-05T10:00:00.000Z");
      assert.equal(
        Option.match(diagnostics.firstSpanAt, {
          onNone: () => null,
          onSome: DateTime.formatIso,
        }),
        "1970-01-01T00:00:01.000Z",
      );
      assert.equal(
        Option.match(diagnostics.lastSpanAt, {
          onNone: () => null,
          onSome: DateTime.formatIso,
        }),
        "1970-01-01T00:00:05.025Z",
      );
      assert.equal(diagnostics.parseErrorCount, 1);
      assert.equal(diagnostics.failureCount, 2);
      assert.equal(diagnostics.interruptionCount, 1);
      assert.equal(diagnostics.slowSpanCount, 1);
      assert.equal(diagnostics.logLevelCounts.Error, 1);
      assert.equal(diagnostics.logLevelCounts.Warning, 1);
      assert.equal(diagnostics.commonFailures[0]?.name, "orchestration.dispatch");
      assert.equal(diagnostics.commonFailures[0]?.count, 2);
      assert.equal(diagnostics.latestFailures[0]?.traceId, "trace-c");
      assert.equal(diagnostics.slowestSpans[0]?.traceId, "trace-b");
      assert.equal(diagnostics.latestWarningAndErrorLogs[0]?.message, "status delayed");
      assert.equal(diagnostics.topSpansByCount[0]?.name, "orchestration.dispatch");
    }),
  );

  it.effect("streams rotated files into the same result as reading them whole", () =>
    Effect.gen(function* () {
      const files = new Map([
        [
          `${traceFilePath}.1`,
          [
            record({
              name: "server.getConfig",
              traceId: "trace-a",
              spanId: "span-a",
              startMs: 1_000,
              durationMs: 50,
            }),
            "not-json",
            record({
              name: "orchestration.dispatch",
              traceId: "trace-b",
              spanId: "span-b",
              startMs: 2_000,
              durationMs: 1_500,
              exit: { _tag: "Failure", cause: "Provider crashed: café 🔥" },
            }),
            "",
          ].join("\r\n"),
        ],
        [
          traceFilePath,
          [
            record({
              name: "git.status",
              traceId: "trace-c",
              spanId: "span-c",
              startMs: 3_000,
              durationMs: 25,
              exit: { _tag: "Interrupted", cause: "Interrupted" },
              events: [
                {
                  name: "status delayed ⏳",
                  timeUnixNano: ns(3_010),
                  attributes: { "effect.logLevel": "Warning" },
                },
              ],
            }),
            "",
            record({
              name: "orchestration.dispatch",
              traceId: "trace-d",
              spanId: "span-d",
              startMs: 4_000,
              durationMs: 250,
              exit: { _tag: "Failure", cause: "Provider crashed: café 🔥" },
            }),
          ].join("\n"),
        ],
      ]);
      const encoder = new TextEncoder();

      const diagnostics = yield* readTraces({
        stream: (path) =>
          Stream.fromIterable(
            Array.from(encoder.encode(files.get(path)), (byte) => Uint8Array.of(byte)),
          ),
      });

      assert.equal(diagnostics.recordCount, 4);
      assert.deepStrictEqual(
        diagnostics,
        aggregateLines([...files.values()].flatMap((text) => text.split(/\r?\n/))),
      );
    }),
  );

  it.effect("keeps loaded trace data when one rotated trace file fails to read", () =>
    Effect.gen(function* () {
      const readFailure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "open",
        description: "permission denied",
        pathOrDescriptor: `${traceFilePath}.1`,
      });
      const logAnnotations: Array<Record<string, unknown>> = [];
      const logger = Logger.make<unknown, void>((options) => {
        logAnnotations.push({ ...options.fiber.getRef(References.CurrentLogAnnotations) });
      });

      const diagnostics = yield* readTraces({
        stream: (path) =>
          path === `${traceFilePath}.1`
            ? Stream.fail(readFailure)
            : Stream.make(
                new TextEncoder().encode(
                  record({
                    name: "server.getConfig",
                    traceId: "trace-a",
                    spanId: "span-a",
                    startMs: 1_000,
                    durationMs: 50,
                  }),
                ),
              ),
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));

      assert.equal(diagnostics.recordCount, 1);
      assert.equal(
        Option.getOrElse(diagnostics.partialFailure, () => false),
        true,
      );
      assert.deepStrictEqual(Option.getOrUndefined(diagnostics.error), {
        kind: "trace-file-read-failed",
        message: `Failed to read local trace file '${traceFilePath}.1'.`,
      });
      assert.deepStrictEqual(diagnostics.scannedFilePaths, [`${traceFilePath}.1`, traceFilePath]);

      const failureLog = logAnnotations.find(
        (annotations) => annotations.traceFilePath === `${traceFilePath}.1`,
      );
      assert.exists(failureLog);
      assert.deepStrictEqual(failureLog, {
        traceFilePath: `${traceFilePath}.1`,
        errorTag: "TraceFileReadError",
        causeTag: "PermissionDenied",
      });
    }),
  );
});
