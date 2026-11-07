import { assert, it } from "@effect/vitest";
import { ChannelInputId, ChannelTaskId, RunId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { toolForwardKeyFor, toolSteerIdsFor, turnSteerIdsFor } from "./channelIds.ts";

it.effect(
  "tool follow-ups have stable per-request identities separate from legacy input identities",
  () =>
    Effect.sync(() => {
      const run = RunId.make("run:one");
      const task = ChannelTaskId.make("task:one");
      const first = toolForwardKeyFor(run, task, "request:one");
      const second = toolForwardKeyFor(run, task, "request:two");
      assert.strictEqual(first, toolForwardKeyFor(run, task, "request:one"));
      assert.notStrictEqual(first, second);
      assert.notStrictEqual(toolSteerIdsFor(first).messageId, toolSteerIdsFor(second).messageId);
      assert.notStrictEqual(
        toolSteerIdsFor(first).messageId,
        toolSteerIdsFor(first, "queued").messageId,
      );
      assert.notStrictEqual(
        toolSteerIdsFor(first).messageId,
        turnSteerIdsFor(ChannelInputId.make(first)).messageId,
      );
    }),
);
