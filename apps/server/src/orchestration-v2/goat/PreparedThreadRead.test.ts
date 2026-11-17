import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";

import {
  ProjectionStoreReadError,
  ProjectionStoreThreadNotFoundError,
} from "../ProjectionStore.ts";
import { readPreparedThread } from "./PreparedThreadRead.ts";

const threadId = ThreadId.make("thread:prepare");

const read = (failure: ProjectionStoreReadError | ProjectionStoreThreadNotFoundError) =>
  Effect.gen(function* () {
    const warnings: Array<unknown> = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(message);
    });
    const thread = yield* readPreparedThread(
      { getThread: () => Effect.fail(failure) },
      threadId,
    ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    return { thread, warnings };
  });

it.effect(
  "regression goat#3639: a failed thread read logs its category before the prepare denies grants",
  () =>
    Effect.gen(function* () {
      const { thread, warnings } = yield* read(
        new ProjectionStoreReadError({ threadId, cause: new Error("SQLITE_BUSY: private detail") }),
      );
      assert.isTrue(Option.isNone(thread));
      assert.lengthOf(warnings, 1);
      const logged = JSON.stringify(warnings[0]);
      assert.include(logged, "ProjectionStoreReadError");
      assert.notInclude(logged, "private detail");
    }),
);

it.effect("a missing thread denies grants without a warning", () =>
  Effect.gen(function* () {
    const { thread, warnings } = yield* read(new ProjectionStoreThreadNotFoundError({ threadId }));
    assert.isTrue(Option.isNone(thread));
    assert.deepEqual(warnings, []);
  }),
);
