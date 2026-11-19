import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { NodeId, ProviderDriverKind, ProviderThreadId, ProviderTurnId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { findHistoricalForkSession } from "./historicalForkSession.ts";

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
