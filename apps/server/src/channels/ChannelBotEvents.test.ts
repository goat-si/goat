import { assert, describe, it } from "@effect/vitest";
import { BotId, ChannelGatewayError, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { BOT_EVENT_LIMITS, makeWith } from "./ChannelBotEvents.ts";

interface Attempt {
  readonly botId: string;
  readonly recordKey: string;
  readonly text: string;
}

/** A fake timeline: every attempt is logged; `fails` bots always fail; `gate` holds attempts. */
const fakeTimeline = (options: {
  readonly fails?: ReadonlySet<string>;
  readonly gate?: Deferred.Deferred<void>;
  readonly onAttempt?: (attempts: ReadonlyArray<Attempt>) => Effect.Effect<void>;
}) => {
  const attempts: Array<Attempt> = [];
  const recorded: Array<Attempt> = [];
  return {
    attempts,
    recorded,
    deps: {
      threadOf: (_ownerId: string, botId: BotId) =>
        Effect.succeed(ThreadId.make("thread-" + botId)),
      record: (input: {
        readonly threadId: ThreadId;
        readonly record: { readonly recordKey: string; readonly entry: { readonly type: string } };
      }) =>
        Effect.gen(function* () {
          const botId = input.threadId.slice("thread-".length);
          const entry = input.record.entry as { readonly text: string };
          const attempt = { botId, recordKey: input.record.recordKey, text: entry.text };
          attempts.push(attempt);
          yield* options.onAttempt?.(attempts) ?? Effect.void;
          if (options.gate !== undefined) yield* Deferred.await(options.gate);
          if (options.fails?.has(botId) === true)
            return yield* new ChannelGatewayError({ reason: "persistence_failed" });
          recorded.push(attempt);
          return recorded.length;
        }),
    },
  };
};

const line = (botId: string, text: string, id = botId) => ({
  ownerId: "owner",
  botId: BotId.make(botId),
  kind: "profile-name",
  id,
  text,
});

describe("ChannelBotEvents", () => {
  it.effect("keeps a bot's lines in order and gives two same-moment changes two record keys", () =>
    Effect.gen(function* () {
      const timeline = fakeTimeline({});
      const events = yield* makeWith(timeline.deps);
      yield* events.emit(line("ada", "Renamed to Ada"));
      yield* events.emit(line("ada", "Renamed to Ada"));
      yield* events.emit(line("ada", "Purpose updated"));
      yield* events.flush;
      assert.deepStrictEqual(
        timeline.recorded.map((attempt) => attempt.text),
        ["Renamed to Ada", "Renamed to Ada", "Purpose updated"],
      );
      assert.strictEqual(new Set(timeline.recorded.map((attempt) => attempt.recordKey)).size, 3);
      assert.isTrue(timeline.recorded[0]?.recordKey.startsWith("event:profile-name:ada:"));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a bot whose timeline keeps failing does not delay another bot, and each line stops after five attempts",
    () =>
      Effect.gen(function* () {
        const otherRecorded = yield* Deferred.make<void>();
        const timeline = fakeTimeline({
          fails: new Set(["ada"]),
          onAttempt: (attempts) =>
            attempts.at(-1)?.botId === "bob"
              ? Deferred.succeed(otherRecorded, undefined)
              : Effect.void,
        });
        const events = yield* makeWith(timeline.deps);
        yield* events.emit(line("ada", "first"));
        yield* events.emit(line("ada", "second"));
        yield* events.emit(line("bob", "Renamed to Bob"));
        yield* Deferred.await(otherRecorded);
        // Bob's line was tried while Ada still waits for her first retry.
        assert.deepStrictEqual(
          timeline.attempts.map((attempt) => attempt.text),
          ["first", "Renamed to Bob"],
        );
        const flushed = yield* events.flush.pipe(Effect.forkChild);
        // Backoff is 1 + 2 + 4 + 8 seconds per line.
        for (let second = 0; second < 30; second++) yield* TestClock.adjust("1 second");
        yield* Fiber.join(flushed);
        assert.deepStrictEqual(
          timeline.recorded.map((attempt) => attempt.text),
          ["Renamed to Bob"],
        );
        const ada = timeline.attempts.filter((attempt) => attempt.botId === "ada");
        assert.deepStrictEqual(
          ada.map((attempt) => attempt.text),
          [
            ...Array.from({ length: BOT_EVENT_LIMITS.attempts }, () => "first"),
            ...Array.from({ length: BOT_EVENT_LIMITS.attempts }, () => "second"),
          ],
        );
      }).pipe(Effect.scoped),
  );

  it.effect("a full bot queue drops its oldest waiting line and keeps the newest", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const inFlight = yield* Deferred.make<void>();
      const timeline = fakeTimeline({
        gate,
        onAttempt: () => Deferred.succeed(inFlight, undefined).pipe(Effect.asVoid),
      });
      const events = yield* makeWith(timeline.deps);
      yield* events.emit(line("ada", "line 0"));
      yield* Deferred.await(inFlight);
      for (let index = 1; index <= BOT_EVENT_LIMITS.perBot + 1; index++)
        yield* events.emit(line("ada", "line " + index));
      yield* Deferred.succeed(gate, undefined);
      yield* events.flush;
      assert.deepStrictEqual(
        timeline.recorded.map((attempt) => attempt.text),
        [
          "line 0",
          ...Array.from({ length: BOT_EVENT_LIMITS.perBot }, (_, index) => "line " + (index + 2)),
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("lines beyond the bot limit and the total limit are dropped, the rest recorded", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const allInFlight = yield* Deferred.make<void>();
      const timeline = fakeTimeline({
        gate,
        onAttempt: (attempts) =>
          attempts.length === BOT_EVENT_LIMITS.bots
            ? Deferred.succeed(allInFlight, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });
      const events = yield* makeWith(timeline.deps);
      const bots = Array.from({ length: BOT_EVENT_LIMITS.bots }, (_, index) => "bot" + index);
      for (const bot of bots) yield* events.emit(line(bot, "first"));
      yield* events.emit(line("one-too-many", "dropped"));
      yield* Deferred.await(allInFlight);
      const filling = BOT_EVENT_LIMITS.total / BOT_EVENT_LIMITS.perBot;
      for (const bot of bots.slice(0, filling))
        for (let index = 0; index < BOT_EVENT_LIMITS.perBot; index++)
          yield* events.emit(line(bot, "queued"));
      yield* events.emit(line(bots[filling] ?? "", "over the total"));
      yield* Deferred.succeed(gate, undefined);
      yield* events.flush;
      assert.strictEqual(timeline.recorded.length, BOT_EVENT_LIMITS.bots + BOT_EVENT_LIMITS.total);
      assert.isFalse(timeline.recorded.some((attempt) => attempt.botId === "one-too-many"));
      assert.isFalse(timeline.recorded.some((attempt) => attempt.text === "over the total"));
    }).pipe(Effect.scoped),
  );
});
