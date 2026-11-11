import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { LOGIN, RECEIPT, makeCliHarness } from "./testing.ts";

it.effect.each([{ signal: null }, { signal: 0 }] as const)(
  "returns identity before a normal native exit, preserving argv and zero trust input (%s)",
  ({ signal }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeCliHarness();
        const prompt = "Fix '$literal' and $(not-a-command)\nsecond line";
        const fiber = yield* h.service.start(LOGIN, "/fixture/repo", prompt).pipe(Effect.forkChild);
        yield* h.fake.ready;
        for (const character of RECEIPT) h.fake.emit(character);
        const handle = yield* Fiber.join(fiber);
        expect(handle.receipt.taskId).toBe("session_ABC123");
        expect(h.starts[0]).toEqual({
          shell: LOGIN.binary,
          args: [`--cloud=${prompt}`],
          cwd: "/fixture/repo",
          cols: 120,
          rows: 30,
          env: LOGIN.environment,
        });
        expect(h.fake.writes).toEqual([]);
        h.fake.finish(0, signal);
        yield* handle.exited;
      }),
    ),
);
