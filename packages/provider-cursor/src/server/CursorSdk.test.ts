import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as CursorSdk from "./CursorSdk.ts";

vi.mock("./sdk.ts", () => ({ Agent: {}, createAgentPlatform: {}, SqliteLocalAgentStore: {} }));

// Shaped like the SDK's minified class: the constructor is not named after the error.
class o extends Error {
  override name = "WriteIterableClosedError";
}

// Calls the process net's rejection listener directly, with Vitest's own listener detached so it does not defer.
const rejectThroughGuard = (reason: unknown) =>
  Effect.gen(function* () {
    const others = process.listeners("unhandledRejection");
    yield* Layer.build(CursorSdk.layer);
    const guard = process.listeners("unhandledRejection").find((l) => !others.includes(l));
    assert.isDefined(guard);
    using exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    for (const listener of others) process.off("unhandledRejection", listener);
    try {
      guard(reason, Promise.resolve());
    } finally {
      for (const listener of others) process.on("unhandledRejection", listener);
    }
    return exit.mock.calls;
  }).pipe(Effect.scoped);

describe("CursorSdk unhandled rejection guard", () => {
  it.effect("keeps the server running when the SDK writes to a closed stream", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* rejectThroughGuard(new o("WritableIterable is closed")), []);
    }),
  );

  it.effect("still exits on other rejections", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* rejectThroughGuard(new Error("WritableIterable is closed")), [
        [1],
      ]);
    }),
  );

  it.effect("exits on a Cursor shell spawn failure, which reaches GOAT's adapter too", () =>
    Effect.gen(function* () {
      const spawnFailure = Object.assign(new Error("spawn /bin/zsh ENOENT"), {
        code: "ENOENT",
        syscall: "spawn /bin/zsh",
        spawnargs: ["-c", "dump_zsh_state >&4"],
      });
      assert.deepStrictEqual(yield* rejectThroughGuard(spawnFailure), [[1]]);
    }),
  );

  it.effect("releases its rejection listener with the layer", () =>
    Effect.gen(function* () {
      const before = process.listenerCount("unhandledRejection");
      yield* Layer.build(CursorSdk.layer).pipe(Effect.scoped);
      assert.strictEqual(process.listenerCount("unhandledRejection"), before);
    }),
  );
});
