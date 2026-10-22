import { expect, it } from "@effect/vitest";
import { NoteError } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { document } from "../test-fixtures";
import { followNotesSessions, type NotesSession } from "./subscription";

it.effect("resets snapshots on reconnect and closes the previous subscription", () =>
  Effect.gen(function* () {
    const firstSeen = yield* Deferred.make<void>();
    const secondSeen = yield* Deferred.make<void>();
    const sessions = yield* SubscriptionRef.make(Option.none<NotesSession>());
    const seen: string[] = [];
    let closed = 0;
    const session = (title: string): NotesSession => ({
      subscribe: () =>
        Stream.succeed({
          type: "snapshot" as const,
          notes: [{ ...document(), title }],
          folders: [],
          truncated: false,
        }).pipe(
          Stream.concat(Stream.never),
          Stream.ensuring(
            Effect.sync(() => {
              closed++;
            }),
          ),
        ),
    });
    const fiber = yield* followNotesSessions(SubscriptionRef.changes(sessions)).pipe(
      Stream.runForEach((feed) => {
        if (feed.notes.length === 0) return Effect.void;
        const title = feed.notes[0]!.title;
        seen.push(title);
        return Deferred.succeed(title === "first" ? firstSeen : secondSeen, undefined);
      }),
      Effect.forkChild,
    );
    yield* SubscriptionRef.set(sessions, Option.some(session("first")));
    yield* Deferred.await(firstSeen);
    yield* SubscriptionRef.set(sessions, Option.some(session("second")));
    yield* Deferred.await(secondSeen);
    expect(seen).toEqual(["first", "second"]);
    expect(closed).toBe(1);
    yield* Fiber.interrupt(fiber);
    expect(closed).toBe(2);
  }),
);
it.effect("surfaces a subscription error and still follows a replacement session", () =>
  Effect.gen(function* () {
    const failed = yield* Deferred.make<void>();
    const recovered = yield* Deferred.make<void>();
    const sessions = yield* SubscriptionRef.make(
      Option.some<NotesSession>({
        subscribe: () =>
          Stream.fail(new NoteError({ reason: "storage", message: "disk unavailable" })),
      }),
    );
    const fiber = yield* followNotesSessions(SubscriptionRef.changes(sessions)).pipe(
      Stream.runForEach((feed) =>
        feed.error
          ? Deferred.succeed(failed, undefined)
          : feed.event?.type === "snapshot"
            ? Deferred.succeed(recovered, undefined)
            : Effect.void,
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(failed);
    yield* SubscriptionRef.set(
      sessions,
      Option.some({
        subscribe: () =>
          Stream.succeed({ type: "snapshot", notes: [document()], folders: [], truncated: false }),
      }),
    );
    yield* Deferred.await(recovered);
    yield* Fiber.interrupt(fiber);
  }),
);
