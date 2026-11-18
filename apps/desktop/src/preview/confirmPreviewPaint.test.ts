import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { confirmPreviewPaint } from "./confirmPreviewPaint.ts";

it.effect.each(["Page.getFrameTree", "Page.createIsolatedWorld"] as const)(
  "issues no further paint commands when %s replies after the deadline",
  (lateCommand) =>
    Effect.gen(function* () {
      const issued = Promise.withResolvers<void>();
      const late = Promise.withResolvers<object>();
      const replies = {
        "Page.getFrameTree": { frameTree: { frame: { id: "main" } } },
        "Page.createIsolatedWorld": { executionContextId: 7 },
        "Runtime.evaluate": { result: { value: true } },
      };
      const methods: string[] = [];
      const sendCommand = (method: string) => {
        methods.push(method);
        if (method === lateCommand) {
          issued.resolve();
          return late.promise;
        }
        return Promise.resolve(replies[method as keyof typeof replies]);
      };
      const pending = yield* confirmPreviewPaint({ sendCommand }).pipe(Effect.forkChild);
      yield* Effect.promise(() => issued.promise);
      yield* TestClock.adjust(1_000);
      expect(yield* Fiber.join(pending)).toBe(false);
      const atDeadline = [...methods];
      late.resolve(replies[lateCommand]);
      // The waiting continuation runs before this promise's later subscriber.
      yield* Effect.promise(() => late.promise);
      expect(methods).toEqual(atDeadline);
    }),
);
