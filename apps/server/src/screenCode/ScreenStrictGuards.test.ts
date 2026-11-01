import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { ServerSettings } from "@goat/contracts";
import type { ServerSettingsService } from "../serverSettings.ts";
import {
  followStrictInputGuards,
  makeStrictInputGuards,
  refreshStrictInputGuards,
} from "./ScreenStrictGuards.ts";

const settingsOf = (strict: boolean) => ({ cuaStrictInputGuards: strict }) as ServerSettings;

it.effect("an older settings read that finishes last does not overwrite a newer one", () =>
  Effect.gen(function* () {
    const holder = makeStrictInputGuards();
    const reads = yield* Queue.unbounded<Deferred.Deferred<ServerSettings>>();
    const service = {
      getSettings: Effect.gen(function* () {
        const read = yield* Deferred.make<ServerSettings>();
        yield* Queue.offer(reads, read);
        return yield* Deferred.await(read);
      }),
      streamChanges: Stream.empty,
    } as unknown as ServerSettingsService["Service"];
    const older = yield* Effect.forkChild(refreshStrictInputGuards(holder, service));
    const olderRead = yield* Queue.take(reads);
    const newer = yield* Effect.forkChild(refreshStrictInputGuards(holder, service));
    const newerRead = yield* Queue.take(reads);
    yield* Deferred.succeed(newerRead, settingsOf(true));
    yield* Fiber.join(newer);
    yield* Deferred.succeed(olderRead, settingsOf(false));
    yield* Fiber.join(older);
    assert.equal(holder.value, true);
  }),
);

it.effect("turning strict guards on reaches the holder without a new cell", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const holder = { ...makeStrictInputGuards(), value: false };
      const service = {
        getSettings: Effect.succeed(settingsOf(false)),
        streamChanges: Stream.make(settingsOf(true)),
      } as unknown as ServerSettingsService["Service"];
      // The follower ends with its finite change stream, after applying every change.
      yield* Fiber.join(yield* followStrictInputGuards(holder, service));
      assert.equal(holder.value, true);
    }),
  ),
);
