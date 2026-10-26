import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeTabClaims } from "./TabClaims.ts";

const identity = { environmentId: "env", threadId: "thread", runId: "run-a", turnId: "turn-a",
  browserInstanceId: "browser", connectionId: "connection", tabId: "tab", controlGeneration: 1 };

it.effect("only one turn atomically claims a user tab", () => Effect.gen(function* () {
  const claims = yield* makeTabClaims(() => Effect.void);
  const [first, second] = yield* Effect.all([
    claims.claimUserTab({ ...identity, owner: "unclaimed", ownedByCaller: false }).pipe(Effect.result),
    claims.claimUserTab({ ...identity, runId: "run-b", turnId: "turn-b", owner: "unclaimed", ownedByCaller: false }).pipe(Effect.result),
  ], { concurrency: "unbounded" });
  expect([first._tag, second._tag].sort()).toEqual(["Failure", "Success"]);
}));

it.effect("releases a user tab without closing it at turn end", () => Effect.gen(function* () {
  const closed: string[] = [];
  const claims = yield* makeTabClaims((tab) => Effect.sync(() => { closed.push(tab.tabId); }));
  yield* claims.claimUserTab({ ...identity, owner: "unclaimed", ownedByCaller: false });
  const authority = yield* claims.captureCleanup(identity);
  expect(yield* claims.releaseTurn(identity, authority)).toEqual([{ tabId: "tab", status: "released" }]);
  expect(closed).toEqual([]);
}));

it.effect("closes only an unkept tab created by this run", () => Effect.gen(function* () {
  const closed: string[] = [];
  const claims = yield* makeTabClaims((tab) => Effect.sync(() => { closed.push(tab.tabId); }));
  yield* claims.recordOpened(identity);
  const authority = yield* claims.captureCleanup(identity);
  expect(yield* claims.releaseTurn(identity, authority)).toEqual([{ tabId: "tab", status: "closed" }]);
  expect(yield* claims.releaseTurn(identity, authority)).toEqual([]);
  expect(closed).toEqual(["tab"]);
}));

it.effect("keeps an explicitly handed-off tab open", () => Effect.gen(function* () {
  const closed: string[] = [];
  const claims = yield* makeTabClaims((tab) => Effect.sync(() => { closed.push(tab.tabId); }));
  yield* claims.recordOpened(identity);
  yield* claims.keep(identity, "handoff");
  const authority = yield* claims.captureCleanup(identity);
  expect(yield* claims.releaseTurn(identity, authority)).toEqual([{ tabId: "tab", status: "kept" }]);
  expect(closed).toEqual([]);
}));

it.effect("rejects claim after a control generation change", () => Effect.gen(function* () {
  const claims = yield* makeTabClaims(() => Effect.void);
  yield* claims.claimUserTab({ ...identity, owner: "unclaimed", ownedByCaller: false });
  const result = yield* claims.assertCurrent({ ...identity, controlGeneration: 2 }).pipe(Effect.result);
  expect(result._tag).toBe("Failure");
}));
