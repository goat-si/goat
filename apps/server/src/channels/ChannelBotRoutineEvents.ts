/**
 * ChannelBotRoutineEvents - routine set up / paused / resumed lines, from the task list feed.
 * Each subscription's first snapshot is a silent baseline; the feed keeps only the latest list.
 * @module ChannelBotRoutineEvents
 */
import type {
  BotId,
  ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskListResult,
  ThreadId,
} from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ChannelBotDirectory from "./ChannelBotDirectory.ts";
import * as ChannelBotEvents from "./ChannelBotEvents.ts";

/** Bot routines the watcher remembers between snapshots; above this it records no lines. */
export const MAX_TRACKED_ROUTINES = 500;

type RoutineChange = "set up" | "paused" | "resumed";

export interface RoutineWatchDeps {
  readonly subscribe: () => Stream.Stream<ScheduledTaskListResult, ScheduledTaskError>;
  readonly botForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<
    { readonly ownerId: string; readonly botId: BotId } | undefined,
    ChannelBotDirectory.ChannelBotDirectoryError
  >;
  readonly emit: ChannelBotEvents.ChannelBotEvents["Service"]["emit"];
}

const changeOf = (
  before: { readonly enabled: boolean } | undefined,
  task: ScheduledTask,
): RoutineChange | undefined =>
  before === undefined
    ? "set up"
    : before.enabled === task.enabled
      ? undefined
      : task.enabled
        ? "resumed"
        : "paused";

const announce = Effect.fn("ChannelBotRoutineEvents.announce")(function* (
  deps: RoutineWatchDeps,
  task: ScheduledTask & { readonly threadId: ThreadId },
  change: RoutineChange,
) {
  const bot = yield* deps.botForThread(task.threadId);
  if (bot === undefined) {
    yield* Effect.logDebug("GOAT Bot routine line skipped: its thread is not a bot's now", {
      taskId: task.id,
    });
    return;
  }
  yield* deps.emit({
    ownerId: bot.ownerId,
    botId: bot.botId,
    kind: "routine-" + change.replace(" ", "-"),
    id: task.id,
    text: "Routine " + task.title + " " + change,
  });
});

/** One subscription: a baseline, then a line for each routine set up, paused or resumed. */
const followOnce = Effect.fn("ChannelBotRoutineEvents.follow")(function* (deps: RoutineWatchDeps) {
  let known: Map<string, { readonly enabled: boolean }> | undefined;
  yield* Stream.runForEach(deps.subscribe(), (result) =>
    Effect.gen(function* () {
      const routines = result.tasks.flatMap((task) =>
        task.goatBotRoutine === true && task.threadId !== null
          ? [{ ...task, threadId: task.threadId }]
          : [],
      );
      if (routines.length > MAX_TRACKED_ROUTINES) {
        yield* Effect.logWarning("GOAT Bot routine lines paused: too many bot routines", {
          count: routines.length,
        });
        known = undefined;
        return;
      }
      const previous = known;
      known = new Map(routines.map((task) => [task.id, { enabled: task.enabled }]));
      if (previous === undefined) return;
      for (const task of routines) {
        const change = changeOf(previous.get(task.id), task);
        if (change !== undefined) yield* announce(deps, task, change);
      }
    }),
  );
});

/** Follows the feed for as long as the scope lives, resubscribing after any failure or end. */
export const watchRoutines = (deps: RoutineWatchDeps) =>
  followOnce(deps).pipe(
    Effect.sandbox,
    Effect.tapError((cause) => Effect.logWarning("GOAT Bot routine lines feed failed", { cause })),
    Effect.retry({
      schedule: Schedule.exponential("1 second").pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, Duration.seconds(60))),
        ),
      ),
    }),
    Effect.andThen(Effect.sleep("1 second")),
    Effect.forever,
  );

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService.ScheduledTaskService;
    const directory = yield* ChannelBotDirectory.ChannelBotDirectory;
    const events = yield* ChannelBotEvents.ChannelBotEvents;
    yield* watchRoutines({
      subscribe: tasks.subscribeList,
      botForThread: directory.botForThread,
      emit: events.emit,
    }).pipe(Effect.forkScoped);
  }),
);
