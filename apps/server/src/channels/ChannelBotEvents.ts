/**
 * ChannelBotEvents - best-effort event lines ("Renamed to Ada") after the change commits. One
 * bounded queue and worker per bot, five tries each; lines queued at shutdown are lost.
 * @module ChannelBotEvents
 */
import * as NodeCrypto from "node:crypto";

import type { BotId, ChannelGatewayError, ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as ChannelBotTimeline from "./ChannelBotTimeline.ts";
import * as ChannelLedger from "./ChannelLedger.ts";

export const BOT_EVENT_LIMITS = { perBot: 32, bots: 64, total: 256, attempts: 5 } as const;
const MAX_TEXT = 200;

export interface BotEvent {
  readonly ownerId: string;
  readonly botId: BotId;
  /** What changed, such as "profile-name" or "routine-paused"; part of the record key. */
  readonly kind: string;
  /** The bot or routine the line is about; part of the record key. */
  readonly id: string;
  readonly text: string;
}

interface QueuedEvent extends BotEvent {
  /** Fresh per change, so two changes in one millisecond stay two lines and a retry stays one. */
  readonly changeId: string;
}

export class ChannelBotEvents extends Context.Service<
  ChannelBotEvents,
  {
    /** Queues one line; never fails, and drops the line with a warning when a limit is reached. */
    readonly emit: (event: BotEvent) => Effect.Effect<void>;
    /** Resolves once every queued line has been recorded or given up on. */
    readonly flush: Effect.Effect<void>;
  }
>()("goat/channels/ChannelBotEvents") {}

export interface BotEventsDeps {
  /** The bot's current conversation thread, or undefined when the bot is gone. */
  readonly threadOf: (
    ownerId: string,
    botId: BotId,
  ) => Effect.Effect<ThreadId | undefined, unknown>;
  readonly record: ChannelBotTimeline.ChannelBotTimeline["Service"]["record"];
}

export const recordKeyFor = (event: QueuedEvent) =>
  "event:" + event.kind + ":" + event.id + ":" + event.changeId;

export const makeWith = Effect.fn("ChannelBotEvents.make")(function* (deps: BotEventsDeps) {
  const scope: Scope.Scope = yield* Effect.scope;
  const queues = new Map<string, Array<QueuedEvent>>();
  let total = 0;
  let idle: Array<Deferred.Deferred<void>> = [];

  const deliver = Effect.fn("ChannelBotEvents.deliver")(
    function* (event: QueuedEvent) {
      const threadId = yield* deps.threadOf(event.ownerId, event.botId);
      if (threadId === undefined) {
        yield* Effect.logWarning("GOAT Bot event line dropped: the bot is gone", {
          botId: event.botId,
          kind: event.kind,
        });
        return;
      }
      yield* deps.record({
        threadId,
        record: { recordKey: recordKeyFor(event), entry: { type: "event", text: event.text } },
        revision: "v1",
      });
    },
    Effect.retry({
      schedule: Schedule.exponential("1 second"),
      times: BOT_EVENT_LIMITS.attempts - 1,
    }),
    Effect.catchCause((cause) => Effect.logWarning("GOAT Bot event line not recorded", { cause })),
  );

  /** Takes the bot's next line, or retires its queue when empty, in one step. */
  const takeNext = (key: string) =>
    Effect.sync(() => {
      const queue = queues.get(key);
      const next = queue?.shift();
      if (next !== undefined) {
        total -= 1;
        return next;
      }
      queues.delete(key);
      if (queues.size === 0) {
        const waiting = idle;
        idle = [];
        return waiting;
      }
      return undefined;
    });

  const work = Effect.fn("ChannelBotEvents.work")(function* (key: string) {
    while (true) {
      const next = yield* takeNext(key);
      if (next === undefined) return;
      if (Array.isArray(next)) {
        for (const waiter of next) yield* Deferred.succeed(waiter, undefined);
        return;
      }
      yield* deliver(next);
    }
  });

  const emit = Effect.fn("ChannelBotEvents.emit")(function* (event: BotEvent) {
    const key = event.ownerId + "\u0000" + event.botId;
    const queued: QueuedEvent = {
      ...event,
      text: event.text.trim().slice(0, MAX_TEXT),
      changeId: NodeCrypto.randomUUID(),
    };
    const outcome = yield* Effect.sync(() => {
      const queue = queues.get(key);
      if (queue === undefined) {
        if (queues.size >= BOT_EVENT_LIMITS.bots) return "too_many_bots" as const;
        if (total >= BOT_EVENT_LIMITS.total) return "full" as const;
        queues.set(key, [queued]);
        total += 1;
        return "started" as const;
      }
      if (queue.length >= BOT_EVENT_LIMITS.perBot) {
        queue.shift();
        queue.push(queued);
        return "dropped_oldest" as const;
      }
      if (total >= BOT_EVENT_LIMITS.total) return "full" as const;
      queue.push(queued);
      total += 1;
      return "queued" as const;
    });
    if (outcome === "started") yield* work(key).pipe(Effect.forkIn(scope));
    else if (outcome !== "queued")
      yield* Effect.logWarning("GOAT Bot event line dropped: queue full", {
        botId: event.botId,
        kind: event.kind,
        outcome,
      });
  });

  const flush = Effect.gen(function* () {
    const waiter = yield* Deferred.make<void>();
    const ready = yield* Effect.sync(() => {
      if (queues.size === 0) return true;
      idle.push(waiter);
      return false;
    });
    if (!ready) yield* Deferred.await(waiter);
  });

  return ChannelBotEvents.of({ emit, flush });
});

export const layer = Layer.effect(
  ChannelBotEvents,
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const timeline = yield* ChannelBotTimeline.ChannelBotTimeline;
    return yield* makeWith({
      threadOf: (ownerId, botId) =>
        ledger.getBotById(ownerId, botId).pipe(Effect.map((found) => found?.bot.threadId)),
      record: (input): Effect.Effect<number, ChannelGatewayError> => timeline.record(input),
    });
  }),
);
