import { assert, describe, it } from "@effect/vitest";
import {
  BotId,
  ProjectId,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
  type ScheduledTaskListResult,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { scheduledTaskFixture } from "../scheduledTasks/ScheduledTaskFixture.testkit.ts";
import type { BotEvent } from "./ChannelBotEvents.ts";
import { MAX_TRACKED_ROUTINES, watchRoutines } from "./ChannelBotRoutineEvents.ts";

const botThread = ThreadId.make("thread:bot");
const routine = (id: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask =>
  scheduledTaskFixture(ProjectId.make("project"), {
    id: ScheduledTaskId.make(id),
    title: "Check in",
    threadId: botThread,
    goatBotRoutine: true,
    enabled: true,
    ...overrides,
  });
const list = (...tasks: ReadonlyArray<ScheduledTask>): ScheduledTaskListResult => ({ tasks });
/** An ordinary task on the same thread, without the GOAT Bot routine marker. */
const plain = (id: string): ScheduledTask =>
  scheduledTaskFixture(ProjectId.make("project"), {
    id: ScheduledTaskId.make(id),
    threadId: botThread,
  });

/** A watcher over feeds the test pushes snapshots into, one feed per subscription. */
const start = (options: { readonly failFirst?: boolean } = {}) =>
  Effect.gen(function* () {
    const lines = yield* Queue.unbounded<BotEvent>();
    const feeds: Array<Queue.Queue<ScheduledTaskListResult>> = [];
    const subscriptions = yield* Queue.unbounded<Queue.Queue<ScheduledTaskListResult>>();
    yield* watchRoutines({
      subscribe: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            if (options.failFirst === true && feeds.length === 0) {
              feeds.push(yield* Queue.unbounded<ScheduledTaskListResult>());
              return Stream.fail(new ScheduledTaskError({ message: "feed down" }));
            }
            const feed = yield* Queue.unbounded<ScheduledTaskListResult>();
            feeds.push(feed);
            yield* Queue.offer(subscriptions, feed);
            return Stream.fromQueue(feed);
          }),
        ),
      botForThread: (threadId) =>
        Effect.succeed(
          threadId === botThread ? { ownerId: "owner", botId: BotId.make("main") } : undefined,
        ),
      emit: (event) => Queue.offer(lines, event).pipe(Effect.asVoid),
    }).pipe(Effect.forkScoped);
    return { lines, subscriptions };
  });

describe("ChannelBotRoutineEvents", () => {
  it.effect(
    "after a silent baseline, a new bot routine, a pause and a resume each leave a line",
    () =>
      Effect.gen(function* () {
        const { lines, subscriptions } = yield* start();
        const feed = yield* Queue.take(subscriptions);
        yield* Queue.offer(feed, list(routine("old"), plain("plain")));
        yield* Queue.offer(feed, list(routine("old"), routine("new", { title: "Standup" })));
        const setUp = yield* Queue.take(lines);
        assert.deepStrictEqual(
          [setUp.text, setUp.kind, setUp.id, setUp.botId],
          ["Routine Standup set up", "routine-set-up", "new", "main"],
        );
        // The line names its routine, so a client can open it from the line.
        assert.deepStrictEqual(setUp.subject, { kind: "routine", id: "new", name: "Standup" });
        yield* Queue.offer(
          feed,
          list(routine("old", { enabled: false }), routine("new", { title: "Standup" })),
        );
        assert.strictEqual((yield* Queue.take(lines)).text, "Routine Check in paused");
        yield* Queue.offer(feed, list(routine("old"), routine("new", { title: "Standup" })));
        assert.strictEqual((yield* Queue.take(lines)).text, "Routine Check in resumed");
        assert.strictEqual(yield* Queue.size(lines), 0);
      }).pipe(Effect.scoped),
  );

  it.effect("ordinary tasks and routines whose thread is no longer a bot's leave no line", () =>
    Effect.gen(function* () {
      const { lines, subscriptions } = yield* start();
      const feed = yield* Queue.take(subscriptions);
      yield* Queue.offer(feed, list());
      yield* Queue.offer(
        feed,
        list(plain("plain"), routine("replaced", { threadId: ThreadId.make("thread:old-bot") })),
      );
      yield* Queue.offer(feed, list(routine("marker")));
      assert.strictEqual((yield* Queue.take(lines)).id, "marker");
    }).pipe(Effect.scoped),
  );

  it.effect("a failed feed is subscribed again after its backoff, with a fresh baseline", () =>
    Effect.gen(function* () {
      const { lines, subscriptions } = yield* start({ failFirst: true });
      yield* TestClock.adjust("1 second");
      const feed = yield* Queue.take(subscriptions);
      yield* Queue.offer(feed, list(routine("during-outage")));
      yield* Queue.offer(feed, list(routine("during-outage"), routine("after")));
      assert.strictEqual((yield* Queue.take(lines)).id, "after");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "over the routine limit no lines are recorded, and the first snapshot back is a baseline",
    () =>
      Effect.gen(function* () {
        const { lines, subscriptions } = yield* start();
        const feed = yield* Queue.take(subscriptions);
        const many = Array.from({ length: MAX_TRACKED_ROUTINES + 1 }, (_, index) =>
          routine("many-" + index),
        );
        yield* Queue.offer(feed, list(...many.slice(0, 2)));
        yield* Queue.offer(feed, list(...many));
        yield* Queue.offer(feed, list(...many.slice(0, 2), routine("back")));
        yield* Queue.offer(feed, list(...many.slice(0, 2), routine("back"), routine("last")));
        assert.strictEqual((yield* Queue.take(lines)).id, "last");
      }).pipe(Effect.scoped),
  );

  describe("a long title is shortened so the whole line fits 200 characters", () => {
    /** The line a new routine with this title leaves. */
    const setUpLine = (title: string) =>
      Effect.gen(function* () {
        const { lines, subscriptions } = yield* start();
        const feed = yield* Queue.take(subscriptions);
        yield* Queue.offer(feed, list());
        yield* Queue.offer(feed, list(routine("long", { title })));
        const line = yield* Queue.take(lines);
        const name = line.subject?.name ?? "";
        // The chip finds its name in the text, and the subject keeps its 200 cap.
        assert.strictEqual(line.text, "Routine " + name + " set up");
        assert.isAtMost(line.text.length, 200);
        assert.strictEqual(line.subject?.id, "long");
        return name;
      }).pipe(Effect.scoped);

    it.effect("a title that fits is kept whole", () =>
      Effect.gen(function* () {
        const title = "a".repeat(185);
        assert.strictEqual(yield* setUpLine(title), title);
      }),
    );

    it.effect("one character over, the name ends in an ellipsis and the change word stays", () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* setUpLine("b".repeat(186)), "b".repeat(184) + "…");
      }),
    );

    it.effect("a title over 192 characters, whose chip the cut used to lose, keeps a name", () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* setUpLine("c".repeat(195)), "c".repeat(184) + "…");
      }),
    );

    it.effect("a title over 200 characters fits the subject's cap", () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* setUpLine("d".repeat(250)), "d".repeat(184) + "…");
      }),
    );

    it.effect("the cut never splits an emoji or a letter from its accent", () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* setUpLine("a" + "😀".repeat(100)), "a" + "😀".repeat(91) + "…");
        assert.strictEqual(
          yield* setUpLine("a" + "e\u0301".repeat(100)),
          "a" + "e\u0301".repeat(91) + "…",
        );
      }),
    );
  });
});
