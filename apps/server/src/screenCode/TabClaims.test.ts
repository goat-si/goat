import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeTabClaims } from "./TabClaims.ts";

const identity = {
  environmentId: "env",
  threadId: "thread",
  runId: "run-a",
  turnId: "turn-a",
  browserInstanceId: "browser",
  connectionId: "connection",
  tabId: "tab",
  controlGeneration: 1,
};

it.effect("only one turn atomically claims a user tab", () =>
  Effect.gen(function* () {
    const claims = yield* makeTabClaims(() => Effect.void);
    const [first, second] = yield* Effect.all(
      [
        claims
          .acquireTab({ ...identity, owner: "unclaimed", ownedByCaller: false })
          .pipe(Effect.result),
        claims
          .acquireTab({
            ...identity,
            runId: "run-b",
            turnId: "turn-b",
            owner: "unclaimed",
            ownedByCaller: false,
          })
          .pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    );
    expect([first._tag, second._tag].sort()).toEqual(["Failure", "Success"]);
  }),
);

it.effect("releases a user tab without closing it at turn end", () =>
  Effect.gen(function* () {
    const closed: string[] = [];
    const claims = yield* makeTabClaims((tab) =>
      Effect.sync(() => {
        closed.push(tab.tabId);
      }),
    );
    yield* claims.acquireTab({ ...identity, owner: "unclaimed", ownedByCaller: false });
    const authority = yield* claims.captureCleanup(identity);
    expect(yield* claims.releaseTurn(identity, authority)).toEqual([
      { tabId: "tab", status: "released" },
    ]);
    expect(closed).toEqual([]);
  }),
);

it.effect("closes only an unkept tab created by this run", () =>
  Effect.gen(function* () {
    const closed: string[] = [];
    const claims = yield* makeTabClaims((tab) =>
      Effect.sync(() => {
        closed.push(tab.tabId);
      }),
    );
    yield* claims.recordOpened(identity);
    const authority = yield* claims.captureCleanup(identity);
    expect(yield* claims.releaseTurn(identity, authority)).toEqual([
      { tabId: "tab", status: "closed" },
    ]);
    expect(yield* claims.releaseTurn(identity, authority)).toEqual([]);
    expect(closed).toEqual(["tab"]);
  }),
);

it.effect("keeps an explicitly handed-off tab open", () =>
  Effect.gen(function* () {
    const closed: string[] = [];
    const claims = yield* makeTabClaims((tab) =>
      Effect.sync(() => {
        closed.push(tab.tabId);
      }),
    );
    yield* claims.recordOpened(identity);
    yield* claims.keep(identity, "handoff");
    const authority = yield* claims.captureCleanup(identity);
    expect(yield* claims.releaseTurn(identity, authority)).toEqual([
      { tabId: "tab", status: "kept" },
    ]);
    expect(closed).toEqual([]);
  }),
);

it.effect("rejects claim after a control generation change", () =>
  Effect.gen(function* () {
    const claims = yield* makeTabClaims(() => Effect.void);
    yield* claims.acquireTab({ ...identity, owner: "unclaimed", ownedByCaller: false });
    const result = yield* claims
      .assertCurrent({ ...identity, controlGeneration: 2 })
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
  }),
);

it.effect("Stop relaxation stays on its own cleanup authority", () =>
  Effect.gen(function* () {
    const modes: boolean[] = [];
    const claims = yield* makeTabClaims((_tab, afterStop) =>
      Effect.sync(() => {
        modes.push(afterStop);
      }),
    );
    yield* claims.recordOpened(identity);
    yield* claims.recordOpened({ ...identity, tabId: "other" });
    const stopped = yield* claims.captureCleanup(identity, {
      fence: false,
      tabId: "tab",
      afterStop: true,
    });
    const finished = yield* claims.captureCleanup(identity, { tabId: "other" });
    yield* claims.releaseTurn(identity, stopped);
    yield* claims.releaseTurn(identity, finished);
    expect(modes).toEqual([true, false]);
  }),
);

it.effect("turn memory stays bounded over many turns while recent turns stay fenced", () =>
  Effect.gen(function* () {
    const claims = yield* makeTabClaims(() => Effect.void);
    const turn = (index: number) => ({
      ...identity,
      runId: `run-${index}`,
      turnId: `turn-${index}`,
      tabId: `tab-${index}`,
    });
    for (let index = 0; index < 5000; index++) {
      const authority = yield* claims.captureCleanup(turn(index));
      yield* claims.releaseTurn(turn(index), authority);
    }
    const recent = yield* claims.recordOpened(turn(4999)).pipe(Effect.result);
    expect(recent._tag).toBe("Failure");
    // The first turn ended thousands of turns ago; forgetting it is what bounds the memory.
    const oldest = yield* claims.recordOpened(turn(0)).pipe(Effect.result);
    expect(oldest._tag).toBe("Success");
  }),
);
