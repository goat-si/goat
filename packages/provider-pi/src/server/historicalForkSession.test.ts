import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { NodeId, ProviderDriverKind, ProviderThreadId, ProviderTurnId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { findHistoricalForkSession, makeHistoricalScanBudget } from "./historicalForkSession.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const driver = ProviderDriverKind.make("pi");
const turn = (startedAt: DateTime.Utc | null, completedAt: DateTime.Utc | null) => ({
  id: ProviderTurnId.make("legacy-turn"),
  providerThreadId: ProviderThreadId.make("legacy-thread"),
  nodeId: NodeId.make("legacy-node"),
  runAttemptId: null,
  nativeTurnRef: { driver, nativeId: "target", strength: "strong" as const },
  ordinal: 1,
  status: "completed" as const,
  startedAt,
  completedAt,
});
const content =
  [
    {
      type: "session",
      version: 3,
      id: "fake",
      timestamp: "1970-01-01T00:00:00.000Z",
      cwd: "/workspace",
    },
    {
      type: "message",
      id: "target",
      parentId: null,
      timestamp: "1970-01-01T00:00:10.000Z",
      message: { role: "user", content: [] },
    },
    {
      type: "message",
      id: "assistant",
      parentId: "target",
      timestamp: "1970-01-01T00:00:11.000Z",
      message: { role: "assistant", content: [] },
    },
  ]
    .map((row) => encode(row))
    .join("\n") + "\n";

it.effect("recovers beyond 256 sibling files and a very large unrelated line", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    for (let i = 0; i < 270; i++) yield* fs.writeFileString(`${dir}/other-${i}.jsonl`, "{}\n");
    yield* fs.writeFileString(`${dir}/large.jsonl`, "x".repeat(5 * 1024 * 1024) + "\n");
    yield* fs.writeFileString(`${dir}/target.jsonl`, content);
    const target = turn(DateTime.makeUnsafe(9000), DateTime.makeUnsafe(12000));
    const found = yield* findHistoricalForkSession(
      `${dir}/current.jsonl`,
      { type: "entry", entryId: "target", turn: target, target },
      driver,
      true,
      true,
      false,
    );
    assert.equal(found, `${dir}/target.jsonl`);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("recovers a unique legacy target without turn timestamps and rejects ambiguity", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${dir}/one.jsonl`, content);
    const target = turn(null, null);
    const boundary = { type: "entry" as const, entryId: "target", turn: target, target };
    assert.equal(
      yield* findHistoricalForkSession(`${dir}/current.jsonl`, boundary, driver, true, true, false),
      `${dir}/one.jsonl`,
    );
    yield* fs.writeFileString(`${dir}/two.jsonl`, content);
    const error = yield* Effect.flip(
      findHistoricalForkSession(`${dir}/current.jsonl`, boundary, driver, true, true, false),
    );
    assert.include(error.detail, "multiple matching sibling sessions");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("recovers from a session larger than four MiB while skipping an oversized line", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const padding = encode({ type: "metadata", note: "x".repeat(1024) }) + "\n";
    yield* fs.writeFileString(
      `${dir}/target.jsonl`,
      padding.repeat(4200) + "z".repeat(2 * 1024 * 1024) + "\n" + content,
    );
    const target = turn(DateTime.makeUnsafe(9000), DateTime.makeUnsafe(12000));
    const found = yield* findHistoricalForkSession(
      `${dir}/current.jsonl`,
      { type: "entry", entryId: "target", turn: target, target },
      driver,
      true,
      true,
      false,
    );
    assert.equal(found, `${dir}/target.jsonl`);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("follows ancestry after entries leave the bounded cache", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const rows = [
      encode({
        type: "message",
        id: "target",
        parentId: null,
        timestamp: "1970-01-01T00:00:10.000Z",
        message: { role: "user" },
      }),
    ];
    for (let i = 0; i < 4101; i++)
      rows.push(
        encode({
          type: "message",
          id: `entry-${i}`,
          parentId: i === 0 ? "target" : `entry-${i - 1}`,
          timestamp: "1970-01-01T00:00:11.000Z",
          message: { role: "assistant" },
        }),
      );
    yield* fs.writeFileString(`${dir}/target.jsonl`, rows.join("\n") + "\n");
    const target = turn(DateTime.makeUnsafe(9000), DateTime.makeUnsafe(12000));
    assert.equal(
      yield* findHistoricalForkSession(
        `${dir}/current.jsonl`,
        { type: "entry", entryId: "target", turn: target, target },
        driver,
        true,
        true,
        false,
      ),
      `${dir}/target.jsonl`,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed file-budget error even when a candidate matches", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${dir}/one.jsonl`, content);
    yield* fs.writeFileString(`${dir}/two.jsonl`, "{}\n");
    const target = turn(null, null);
    const error = yield* Effect.flip(
      findHistoricalForkSession(
        `${dir}/current.jsonl`,
        { type: "entry", entryId: "target", turn: target, target },
        driver,
        true,
        true,
        false,
        undefined,
        { maxFiles: 1, maxBytes: 100000, maxDurationMs: 10000 },
      ),
    );
    assert.include(error.detail, "scan limit");
    assert.include(error.detail, "files");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed byte-budget error instead of accepting a partial scan", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${dir}/one.jsonl`, content);
    const target = turn(null, null);
    const error = yield* Effect.flip(
      findHistoricalForkSession(
        `${dir}/current.jsonl`,
        { type: "entry", entryId: "target", turn: target, target },
        driver,
        true,
        true,
        false,
        undefined,
        { maxFiles: 10, maxBytes: 10, maxDurationMs: 10000 },
      ),
    );
    assert.include(error.detail, "scan limit");
    assert.include(error.detail, "bytes");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("ends a stalled recovery at the Effect clock time budget", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${dir}/one.jsonl`, content);
    const started = yield* Deferred.make<void>();
    const stalled = FileSystem.FileSystem.of({
      ...fs,
      stream: () =>
        Stream.unwrap(Deferred.succeed(started, undefined).pipe(Effect.as(Stream.never))),
    });
    const target = turn(null, null);
    const fiber = yield* findHistoricalForkSession(
      `${dir}/current.jsonl`,
      { type: "entry", entryId: "target", turn: target, target },
      driver,
      true,
      true,
      false,
      undefined,
      { maxFiles: 10, maxBytes: 100000, maxDurationMs: 1000 },
    ).pipe(Effect.provideService(FileSystem.FileSystem, stalled), Effect.result, Effect.forkScoped);
    yield* Deferred.await(started);
    yield* TestClock.adjust("1 second");
    const completed = fiber.pollUnsafe();
    assert.isDefined(completed, "the time budget must end the scan");
    if (completed !== undefined) {
      const result = yield* Fiber.join(fiber);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.include(result.failure.detail, "time");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("orders Pi filenames near the target and stops at the second match", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${dir}/1969-12-31T00-00-00-000Z_far.jsonl`, "x".repeat(5000));
    yield* fs.writeFileString(`${dir}/1970-01-01T00-00-11-000Z_second.jsonl`, content);
    yield* fs.writeFileString(`${dir}/1970-01-01T00-00-10-000Z_first.jsonl`, content);
    const target = turn(DateTime.makeUnsafe(9000), DateTime.makeUnsafe(12000));
    const error = yield* Effect.flip(
      findHistoricalForkSession(
        `${dir}/current.jsonl`,
        { type: "entry", entryId: "target", turn: target, target },
        driver,
        true,
        true,
        false,
        undefined,
        { maxFiles: 4, maxBytes: content.length * 3, maxDurationMs: 10000 },
      ),
    );
    assert.include(error.detail, "multiple matching sibling sessions");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("shares the byte budget across target and boundary scans", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${dir}/one.jsonl`, content);
    const target = turn(null, null);
    const boundary = { type: "entry" as const, entryId: "target", turn: target, target };
    const budget = makeHistoricalScanBudget({
      maxFiles: 10,
      maxBytes: content.length + 1,
      maxDurationMs: 10000,
    });
    yield* findHistoricalForkSession(
      `${dir}/current.jsonl`,
      boundary,
      driver,
      true,
      true,
      false,
      undefined,
      undefined,
      budget,
    );
    const error = yield* Effect.flip(
      findHistoricalForkSession(
        `${dir}/current.jsonl`,
        boundary,
        driver,
        true,
        true,
        false,
        undefined,
        undefined,
        budget,
      ),
    );
    assert.include(error.detail, "bytes scan limit");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("charges ancestry rescans against the same total byte budget", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const rows = [
      encode({
        type: "message",
        id: "target",
        parentId: null,
        timestamp: "1970-01-01T00:00:10.000Z",
        message: { role: "user" },
      }),
    ];
    for (let i = 0; i < 4101; i++)
      rows.push(
        encode({
          type: "message",
          id: `entry-${i}`,
          parentId: i === 0 ? "target" : `entry-${i - 1}`,
          timestamp: "1970-01-01T00:00:11.000Z",
          message: { role: "assistant" },
        }),
      );
    const text = rows.join("\n") + "\n";
    yield* fs.writeFileString(`${dir}/target.jsonl`, text);
    const target = turn(null, null);
    const error = yield* Effect.flip(
      findHistoricalForkSession(
        `${dir}/current.jsonl`,
        { type: "entry", entryId: "target", turn: target, target },
        driver,
        true,
        true,
        false,
        undefined,
        { maxFiles: 2, maxBytes: text.length + 1, maxDurationMs: 10000 },
      ),
    );
    assert.include(error.detail, "bytes scan limit");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not accept a candidate when the byte limit prevents checking later siblings", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${dir}/a.jsonl`, content);
    yield* fs.writeFileString(`${dir}/z.jsonl`, "x".repeat(4096));
    const target = turn(null, null);
    const error = yield* Effect.flip(
      findHistoricalForkSession(
        `${dir}/current.jsonl`,
        { type: "entry", entryId: "target", turn: target, target },
        driver,
        true,
        true,
        false,
        undefined,
        { maxFiles: 10, maxBytes: content.length + 100, maxDurationMs: 10000 },
      ),
    );
    assert.include(error.detail, "bytes scan limit");
    assert.include(error.detail, "2 files");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
