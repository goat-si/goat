import { assert, it } from "@effect/vitest";
import { RuntimeRequestId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { NOW, shell, THREAD_ID } from "./AgentAwarenessRelay.testkit.ts";
import { makeSubagentWaits } from "./SubagentWaits.ts";

it.effect("bounds tracked waits and accepts a new wait after one resolves", () =>
  Effect.gen(function* () {
    const waits = makeSubagentWaits({
      getAgentAwarenessSnapshot: () => Effect.succeed({ snapshotSequence: 0, threads: [shell()] }),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"]);
    const child = (index: number) =>
      shell({
        id: ThreadId.make(`child-${index}`),
        creationSource: "mcp",
        lineage: {
          rootThreadId: THREAD_ID,
          parentThreadId: THREAD_ID,
          relationshipToParent: "subagent",
        },
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make(`request-${index}`),
          kind: "command",
          createdAt: DateTime.makeUnsafe(NOW),
        },
      });
    for (let index = 0; index < 2048; index++) {
      const next = child(index);
      yield* waits.update(next.id, next);
    }
    const extra = child(2048);
    assert.isTrue(Exit.isFailure(yield* Effect.exit(waits.update(extra.id, extra))));
    const resolved = child(0);
    yield* waits.update(resolved.id, { ...resolved, pendingRuntimeRequest: null });
    assert.isTrue(Exit.isSuccess(yield* Effect.exit(waits.update(extra.id, extra))));
  }),
);
