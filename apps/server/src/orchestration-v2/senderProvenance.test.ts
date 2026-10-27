import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2Run,
  type OrchestrationV2ThreadLauncher,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import { withLauncherRun, withSenderRun } from "./senderProvenance.ts";

const sender = ThreadId.make("thread:sender");
const store = (runs: ReadonlyArray<readonly [string, OrchestrationV2Run["status"]]>) => ({
  getThreadRecords: () =>
    Effect.succeed({ runs: runs.map(([id, status]) => ({ id: RunId.make(id), status })) }),
});
const recorded = (runs: ReadonlyArray<readonly [string, OrchestrationV2Run["status"]]>) =>
  Effect.gen(function* () {
    const command: { readonly senderThreadId: ThreadId; readonly senderRunId?: RunId } = {
      senderThreadId: sender,
    };
    const message = yield* withSenderRun(store(runs), command);
    const launch: OrchestrationV2ThreadLauncher = yield* withLauncherRun(store(runs), {
      kind: "launch",
      threadId: sender,
      environmentId: null,
      environmentLabel: null,
      threadTitle: null,
    });
    return { message: message.senderRunId, launch: launch.runId };
  });

it.effect.each([
  // Projection order is by ordinal: an earlier run can wait while a later one executes.
  {
    label: "a person's waiting run before a running schedule",
    runs: [
      ["person", "waiting"],
      ["cron", "running"],
    ],
    expected: "cron",
  },
  {
    label: "a waiting schedule before a person's running run",
    runs: [
      ["cron", "waiting"],
      ["person", "running"],
    ],
    expected: "person",
  },
  {
    label: "a starting run",
    runs: [
      ["cron", "completed"],
      ["person", "starting"],
    ],
    expected: "person",
  },
] as const)(
  "records the one executing run for a message and a launch: $label",
  ({ runs, expected }) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* recorded(runs), {
        message: RunId.make(expected),
        launch: RunId.make(expected),
      });
    }),
);

it.effect.each([
  { label: "only a waiting run", runs: [["person", "waiting"]] },
  {
    label: "two executing runs",
    runs: [
      ["person", "running"],
      ["cron", "starting"],
    ],
  },
] as const)("records no run when the sender is ambiguous: $label", ({ runs }) =>
  Effect.gen(function* () {
    assert.deepEqual(yield* recorded(runs), { message: undefined, launch: undefined });
  }),
);
