import { assert, describe, it } from "@effect/vitest";
import { MessageId, RunId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  ComputerUseOriginError,
  computerUseOrigin,
  type OriginMessage,
  type OriginReads,
  type OriginRun,
  type OriginThread,
} from "./ComputerUseOrigin.ts";

const at = (minute: number) => DateTime.makeUnsafe(minute * 60_000);

interface World {
  readonly bot?: ReadonlyArray<string>;
  readonly workers?: ReadonlyArray<string>;
  readonly threads: Record<string, Partial<OriginThread>>;
  readonly runs?: Record<string, ReadonlyArray<OriginRun>>;
  readonly messages?: Record<string, OriginMessage>;
  readonly failing?: ReadonlyArray<string>;
}

const reads = (world: World): OriginReads => ({
  channelOrigin: (id) =>
    Effect.succeed(
      world.bot?.includes(id)
        ? ("goat_bot" as const)
        : world.workers?.includes(id)
          ? ("channel_task" as const)
          : undefined,
    ),
  thread: (id) =>
    world.failing?.includes(id)
      ? Effect.fail(new ComputerUseOriginError({ cause: "projection unavailable" }))
      : Effect.succeed(
          world.threads[id] === undefined
            ? undefined
            : {
                createdAt: at(0),
                lineage: { parentThreadId: null, relationshipToParent: null },
                ...world.threads[id],
              },
        ),
  runs: (id) => Effect.succeed(world.runs?.[id] ?? []),
  message: (_id, messageId) => Effect.succeed(world.messages?.[messageId]),
});

const run = (id: string, message: string, from: number, to: number | null = null): OriginRun => ({
  id: RunId.make(id),
  userMessageId: MessageId.make(message),
  requestedAt: at(from),
  completedAt: to === null ? null : at(to),
});
const typed = (createdAt = 0): OriginMessage => ({ createdAt: at(createdAt) });

const classify = (world: World, thread: string, runId?: string) =>
  computerUseOrigin(reads(world), {
    threadId: ThreadId.make(thread),
    ...(runId === undefined ? {} : { runId: RunId.make(runId) }),
  });

describe("computerUseOrigin", () => {
  it.effect("treats a person's own turn as interactive", () =>
    Effect.gen(function* () {
      const world: World = {
        threads: { mine: {} },
        runs: { mine: [run("r1", "m1", 1)] },
        messages: { m1: typed(1) },
      };
      assert.deepEqual(yield* classify(world, "mine", "r1"), { _tag: "interactive" });
    }),
  );

  it.effect("marks the GOAT Bot thread, channel workers, scheduled and channel messages", () =>
    Effect.gen(function* () {
      const world: World = {
        bot: ["bot"],
        workers: ["worker"],
        threads: { bot: {}, worker: {}, mine: {} },
        runs: { mine: [run("typed", "m1", 1, 2), run("cron", "m2", 3, 4), run("slack", "m3", 5)] },
        messages: {
          m1: typed(1),
          m2: { createdAt: at(3), scheduledTaskId: "task-1" },
          m3: { createdAt: at(5), channel: { originKind: "slack" } },
        },
      };
      assert.deepEqual(yield* classify(world, "bot"), { _tag: "unattended", reason: "goat_bot" });
      assert.deepEqual(yield* classify(world, "worker"), {
        _tag: "unattended",
        reason: "channel_task",
      });
      // A scheduled task bound to a person's thread makes only that run unattended.
      assert.deepEqual(yield* classify(world, "mine", "typed"), { _tag: "interactive" });
      assert.deepEqual(yield* classify(world, "mine", "cron"), {
        _tag: "unattended",
        reason: "scheduled_task",
      });
      assert.deepEqual(yield* classify(world, "mine", "slack"), {
        _tag: "unattended",
        reason: "channel_message",
      });
    }),
  );

  it.effect("follows delegate and launch lineage to the turn that started the thread", () =>
    Effect.gen(function* () {
      const world: World = {
        bot: ["bot"],
        threads: {
          bot: {},
          mine: {},
          botChild: {
            createdAt: at(2),
            lineage: { parentThreadId: ThreadId.make("bot"), relationshipToParent: "subagent" },
          },
          grandchild: {
            createdAt: at(3),
            launchedBy: {
              kind: "launch",
              threadId: ThreadId.make("botChild"),
              environmentId: null,
            },
          },
          fromCron: {
            createdAt: at(11),
            launchedBy: { kind: "launch", threadId: ThreadId.make("mine"), environmentId: null },
          },
          fromTyped: {
            createdAt: at(2),
            launchedBy: { kind: "launch", threadId: ThreadId.make("mine"), environmentId: null },
          },
          promoted: {
            createdAt: at(2),
            launchedBy: { kind: "promotion", threadId: ThreadId.make("bot"), environmentId: null },
          },
          remote: {
            launchedBy: {
              kind: "launch",
              threadId: ThreadId.make("elsewhere"),
              environmentId: "other-host",
            },
          },
        },
        runs: { mine: [run("typed", "m1", 1, 5), run("cron", "m2", 10)] },
        messages: { m1: typed(1), m2: { createdAt: at(10), scheduledTaskId: "task-1" } },
      };
      const launched = { _tag: "unattended", reason: "launched_by_unattended" } as const;
      assert.deepEqual(yield* classify(world, "botChild"), launched);
      assert.deepEqual(yield* classify(world, "grandchild"), launched);
      // Launched while the person's thread ran a scheduled turn, not while they typed.
      assert.deepEqual(yield* classify(world, "fromCron"), launched);
      assert.deepEqual(yield* classify(world, "fromTyped"), { _tag: "interactive" });
      // A person promoting a delegated task takes it over.
      assert.deepEqual(yield* classify(world, "promoted"), { _tag: "interactive" });
      assert.deepEqual(yield* classify(world, "remote"), {
        _tag: "unattended",
        reason: "launched_remotely",
      });
    }),
  );

  it.effect("inherits from the thread that sent the turn's message", () =>
    Effect.gen(function* () {
      const world: World = {
        bot: ["bot"],
        threads: { bot: {}, mine: {}, peer: {} },
        runs: {
          mine: [run("fromBot", "m1", 1), run("fromPeer", "m2", 2)],
          peer: [run("p1", "pm", 0)],
        },
        messages: {
          m1: { createdAt: at(1), senderThreadId: ThreadId.make("bot") },
          m2: { createdAt: at(2), senderThreadId: ThreadId.make("peer") },
          pm: typed(0),
        },
      };
      assert.deepEqual(yield* classify(world, "mine", "fromBot"), {
        _tag: "unattended",
        reason: "sent_by_unattended",
      });
      assert.deepEqual(yield* classify(world, "mine", "fromPeer"), { _tag: "interactive" });
    }),
  );

  it.effect("fails closed on missing records, read errors and runaway lineage", () =>
    Effect.gen(function* () {
      const unknown = { _tag: "unattended", reason: "unknown" } as const;
      const loop: World = {
        threads: {
          a: { launchedBy: { kind: "launch", threadId: ThreadId.make("b"), environmentId: null } },
          b: { launchedBy: { kind: "launch", threadId: ThreadId.make("a"), environmentId: null } },
        },
      };
      assert.deepEqual(yield* classify(loop, "a"), {
        _tag: "unattended",
        reason: "launched_by_unattended",
      });
      assert.deepEqual(yield* classify({ threads: {} }, "gone"), unknown);
      assert.deepEqual(yield* classify({ threads: { x: {} }, failing: ["x"] }, "x"), unknown);
      assert.deepEqual(
        yield* classify({ threads: { x: {} }, runs: { x: [run("r1", "m1", 0)] } }, "x", "r9"),
        unknown,
      );
      assert.deepEqual(
        yield* classify({ threads: { x: {} }, runs: { x: [run("r1", "m1", 0)] } }, "x", "r1"),
        unknown,
      );
    }),
  );
});
