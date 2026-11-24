import { assert, it } from "@effect/vitest";
import type { OpenCodeClient } from "@opencode/client/effect";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { ActiveTurn, ThreadState } from "./adapterState.ts";
import { finishIdleCommand } from "./commandCompletion.ts";

it.effect(
  "settles an idle command only when no execution appeared after its history boundary",
  () =>
    Effect.gen(function* () {
      for (const scenario of ["noop", "active", "history", "busy"] as const) {
        const turn = { interrupted: false } as ActiveTurn;
        const state = { active: turn } as ThreadState;
        let ended = 0;
        const client = {
          session: { active: () => Effect.succeed(scenario === "active" ? { session: {} } : {}) },
          message: {
            list: () =>
              Effect.succeed({
                data:
                  scenario === "history"
                    ? [
                        { id: "new", type: "idle" },
                        { id: "old", type: "idle" },
                      ]
                    : [{ id: "old", type: "idle" }],
                cursor: {},
              }),
          },
        } as unknown as OpenCodeClient;
        yield* finishIdleCommand({
          client,
          sessionId: "session",
          before: "old",
          state,
          turn,
          busy: new Set(scenario === "busy" ? ["session"] : []),
          lock: yield* Semaphore.make(1),
          end: () =>
            Effect.sync(() => {
              ended++;
            }),
        });
        assert.equal(ended, scenario === "noop" ? 1 : 0);
      }
    }),
);
