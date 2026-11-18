import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ThreadPullRequestLink, ThreadPullRequestWatch } from "./threadPullRequest.ts";

const decodeLinks = Schema.decodeUnknownEffect(Schema.Array(ThreadPullRequestLink));

const decodeWatch = Schema.decodeEffect(ThreadPullRequestWatch);

const savedWatch = {
  startedAt: "2026-01-01T00:00:00.000Z",
  headSha: "abc123",
  failedChecks: [],
  passed: true,
  remarksThrough: "2026-01-01T00:00:00.000Z",
  remarkIds: [],
  conflicting: false,
  wakes: 0,
};
// A peer built from dev before merge queue removals: the same watch minus that one field.
const { mergeQueueRemovalId: _addedField, ...watchFieldsBeforeRemovals } =
  ThreadPullRequestWatch.fields;
const decodeWatchWithPeerBeforeRemovals = Schema.decodeUnknownEffect(
  Schema.Struct(watchFieldsBeforeRemovals),
);

it.effect("decodes a watch saved before merge queue removals as having read none yet", () =>
  Effect.gen(function* () {
    const watch = yield* decodeWatch(savedWatch);
    assert.isFalse(Object.hasOwn(watch, "mergeQueueRemovalId"));
  }),
);

it.effect("an older peer accepts a watch that recorded a removal id or an empty read", () =>
  Effect.gen(function* () {
    for (const mergeQueueRemovalId of ["RMQE_1", null]) {
      const saved = { ...savedWatch, mergeQueueRemovalId };
      const current = yield* decodeWatch(saved);
      assert.strictEqual(current.mergeQueueRemovalId, mergeQueueRemovalId);
      const older = yield* decodeWatchWithPeerBeforeRemovals(saved);
      assert.isFalse(Object.hasOwn(older, "mergeQueueRemovalId"));
    }
  }),
);

it.effect("rejects a watch whose recorded removal id is blank", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      decodeWatch({
        ...savedWatch,
        mergeQueueRemovalId: " ",
      }),
    );
    assert.isTrue(exit._tag === "Failure");
  }),
);

it.effect("decodes a watch saved before passed checks were recorded", () =>
  Effect.gen(function* () {
    const [link] = yield* decodeLinks([
      {
        host: "github.com",
        repository: "goat-si/goat",
        number: 42,
        url: "https://github.com/goat-si/goat/pull/42",
        source: "agent",
        linkedAt: "2026-01-01T00:00:00.000Z",
        snapshot: null,
        stack: null,
        watch: {
          startedAt: "2026-01-01T00:00:00.000Z",
          headSha: "abc123",
          failedChecks: [],
          passed: true,
          remarksThrough: "2026-01-01T00:00:00.000Z",
          remarkIds: [],
          conflicting: false,
          wakes: 0,
        },
      },
    ]);

    assert.deepStrictEqual(link?.watch?.passedChecks, []);
  }),
);
