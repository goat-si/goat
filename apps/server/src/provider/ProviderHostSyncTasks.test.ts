import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { type HostTask, update } from "./ProviderHostSyncTasks.ts";

it.effect("regression S4-2: a host's final state is written once, whoever arrives later", () =>
  Effect.gen(function* () {
    let settled = 0;
    const task: HostTask = {
      state: { host: "box", phase: "installing", version: null },
      finished: false,
      onFinished: Effect.sync(() => {
        settled += 1;
      }),
    };
    yield* update(task, { phase: "cancelled" }, true);
    yield* update(task, { phase: "failed", message: "late" }, true);
    yield* update(task, { phase: "installing" });
    expect(task.state).toEqual({ host: "box", phase: "cancelled", version: null });
    expect(settled).toBe(1);
  }),
);
