import { assert, it } from "@effect/vitest";
import type { PreviewAutomationActionEvent } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as Clock from "effect/Clock";
import { awaitHistory } from "../cua/ComputerUseHistoryBackground.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { makeComputerUseHistory } from "../cua/ComputerUseHistory.ts";
import {
  browserHistoryPrefix,
  makeBrowserHistoryFork,
  makeBrowserHistoryRecordAction,
} from "./BrowserHistoryRecordAction.ts";

it.effect("returns a successful click when history fails or never completes", () =>
  Effect.gen(function* () {
    const history = yield* makeComputerUseHistory;
    const writes = yield* Queue.unbounded<void>();
    const gate = yield* Deferred.make<void>();
    const owner = yield* Scope.make();
    const queue = yield* Queue.unbounded<Effect.Effect<void>>();
    yield* Queue.take(queue).pipe(
      Effect.flatMap((effect) => effect),
      Effect.forever,
      Effect.forkScoped,
    );
    const fork = (effect: Effect.Effect<void>) => {
      Queue.offerUnsafe(queue, effect);
    };
    const tab = {
      threadId: "thread:test",
      page: { url: () => "https://example.test" },
      actionTimeline: [],
      diagnostics: { firstLine: (cause: unknown) => String(cause) },
    };
    const failed = makeBrowserHistoryRecordAction(history, fork, owner);
    const result = yield* Effect.tryPromise(() => failed(tab, "click", async () => "clicked")).pipe(
      Effect.result,
    );
    assert.equal(result._tag, "Success");
    const blockedHistory = {
      ...history,
      record: (_input: Parameters<typeof history.record>[0]) =>
        Queue.offer(writes, undefined).pipe(Effect.andThen(Deferred.await(gate)), Effect.asVoid),
    };
    const blocked = makeBrowserHistoryRecordAction(blockedHistory, fork, owner);
    const action = yield* Effect.promise(() => blocked(tab, "click", async () => "clicked")).pipe(
      Effect.timeoutOption("2 seconds"),
      Effect.forkChild,
    );
    yield* Queue.take(writes);
    yield* TestClock.adjust("3 seconds");
    const value = yield* Fiber.join(action);
    assert.isTrue(Option.isSome(value));
    if (Option.isSome(value)) assert.equal(value.value, "clicked");
    yield* Deferred.succeed(gate, undefined);
    yield* Scope.close(owner, Exit.void);
  }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each(["back", "forward"])(
  "records the %s destination at completion before later navigation",
  (method) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const history = yield* makeComputerUseHistory;
        const owner = yield* Effect.scope;
        const now = yield* Clock.currentTimeMillis;
        const fork = yield* makeBrowserHistoryFork();
        const launches: Array<Fiber.Fiber<void, never>> = [];
        const record = makeBrowserHistoryRecordAction(
          history,
          (effect) => {
            launches.push(fork(effect));
          },
          owner,
          () => now,
        );
        let url = "https://start.example/";
        const actionTimeline: Array<PreviewAutomationActionEvent> = [];
        const tab = {
          threadId: "thread:navigation",
          page: { url: () => url },
          actionTimeline,
          diagnostics: { firstLine: (cause: unknown) => String(cause) },
        };
        const retention = Promise.withResolvers<boolean>();
        const details = {
          targetLabel: "button",
          typedText: "hello",
          finishRetention: () => retention.promise,
        };
        yield* Effect.promise(() =>
          record(
            tab,
            method,
            async () => {
              url = "https://back-result.example/path";
              return "done";
            },
            details,
          ).then((result) => {
            url = "https://later-navigation.example/private";
            tab.threadId = "thread:other";
            details.targetLabel = "different";
            details.typedText = "changed";
            return result;
          }),
        );
        retention.resolve(false);
        yield* Effect.forEach(launches, Fiber.join, { discard: true });
        const event = tab.actionTimeline[0];
        if (event === undefined) return assert.fail("missing event");
        yield* awaitHistory(browserHistoryPrefix("thread:navigation") + event.id);
        const rows = yield* history.listForThread("thread:navigation");
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.method, method);
        assert.equal(rows[0]?.tabHost, "back-result.example");
        assert.equal(rows[0]?.targetLabel, "button");
        assert.equal(rows[0]?.typedLength, 5);
        assert.equal((yield* history.listForThread("thread:other")).length, 0);
      }),
    ).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("returns a completed navigation when its destination snapshot is unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const history = yield* makeComputerUseHistory;
      const owner = yield* Effect.scope;
      const fork = yield* makeBrowserHistoryFork();
      let reads = 0;
      const tab = {
        threadId: "thread:closed",
        page: {
          url: () => {
            if (++reads > 1) throw new Error("page unavailable");
            return "https://start.example/";
          },
        },
        actionTimeline: [],
        diagnostics: { firstLine: (cause: unknown) => String(cause) },
      };
      const record = makeBrowserHistoryRecordAction(history, fork, owner);
      const result = yield* Effect.tryPromise(() =>
        record(tab, "back", async () => "completed"),
      ).pipe(Effect.result);
      assert.equal(result._tag, "Success");
      if (result._tag === "Success") assert.equal(result.success, "completed");
    }),
  ).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("records a redacted entry when retention evidence fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* runMigrations();
      const history = yield* makeComputerUseHistory;
      const owner = yield* Effect.scope;
      const now = yield* Clock.currentTimeMillis;
      const fork = yield* makeBrowserHistoryFork();
      const launches: Array<Fiber.Fiber<void, never>> = [];
      const tab = {
        threadId: "thread:evidence-failure",
        page: { url: () => "https://example.test" },
        actionTimeline: new Array<PreviewAutomationActionEvent>(),
        diagnostics: { firstLine: (cause: unknown) => String(cause) },
      };
      const record = makeBrowserHistoryRecordAction(
        history,
        (effect) => {
          launches.push(fork(effect));
        },
        owner,
        () => now,
      );
      yield* Effect.promise(() =>
        record(tab, "type", async () => "done", {
          typedText: "hello",
          finishRetention: async () => {
            throw new Error("evidence unavailable");
          },
        }),
      );
      yield* Effect.forEach(launches, Fiber.join, { discard: true });
      const event = tab.actionTimeline[0];
      if (event === undefined) return assert.fail("missing event");
      yield* awaitHistory(browserHistoryPrefix(tab.threadId) + event.id);
      const rows = yield* history.listForThread(tab.threadId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.verdict, "sent");
      assert.equal(rows[0]?.typedLength, 5);
      assert.isNull(rows[0]?.typedText);
    }),
  ).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
