import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeCliHarness, LOGIN, RECEIPT, SYNTHETIC_FOLDER_TRUST_REFUSALS } from "./testing.ts";

it.effect("after a refusal, a caller's accept answers in place of interactive Claude", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      let answers = 0;
      let accepted = 0;
      const trust = {
        accept: Effect.sync(() => {
          answers += 1;
        }),
        onAccepted: () => {
          accepted += 1;
        },
      };
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task", trust)
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      h.fake.emit(SYNTHETIC_FOLDER_TRUST_REFUSALS[0]);
      h.fake.finish(1);
      // The retry is the next process: no interactive Claude was opened in between.
      const retried = h.fakes[1]!;
      yield* retried.ready;
      retried.emit(RECEIPT);
      const handle = yield* Fiber.join(fiber);
      expect(handle.receipt.taskId).toBe("session_ABC123");
      expect([answers, accepted]).toEqual([1, 1]);
      expect(h.starts.map((start) => start.args)).toEqual([["--cloud=task"], ["--cloud=task"]]);
      retried.finish(0);
      yield* handle.exited;
    }),
  ),
);
