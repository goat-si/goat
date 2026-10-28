import { expect, it } from "@effect/vitest";
import { EnvironmentId, OrchestratorMcpFailure, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadDiffMcpService from "./ThreadDiffMcpService.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Agent", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const hidden = ThreadId.make("thread:hidden");
const shown = ThreadId.make("thread:shown");

it.effect(
  "checks the caller may read the thread before any diff, and cuts a long diff so its JSON fits the budget",
  () =>
    Effect.gen(function* () {
      const queried = yield* Ref.make(0);
      const diff = (threadId: ThreadId, toTurnCount: number) =>
        Ref.update(queried, (count) => count + 1).pipe(
          // Tabs double when JSON-escaped, so raw bytes alone would overrun the budget.
          Effect.as({ threadId, fromTurnCount: 0, toTurnCount, diff: "\t".repeat(300 * 1024) }),
        );
      const service = yield* ThreadDiffMcpService.ThreadDiffMcpService.pipe(
        Effect.provide(
          ThreadDiffMcpService.layer.pipe(
            Layer.provide(
              Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
                assertReadableThread: (_scope, threadId) =>
                  threadId === hidden
                    ? Effect.fail(
                        new OrchestratorMcpFailure({ code: "thread_not_found", message: "hidden" }),
                      )
                    : Effect.void,
              }),
            ),
            Layer.provide(
              Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({
                getTurnDiff: (input) => diff(input.threadId, input.toTurnCount),
                getFullThreadDiff: (input) => diff(input.threadId, input.toTurnCount),
              }),
            ),
          ),
        ),
      );

      // An empty range still checks the thread first.
      for (const read of [
        service.turnDiff(scope, { threadId: hidden, fromTurnCount: 0, toTurnCount: 0 }),
        service.fullDiff(scope, { threadId: hidden, toTurnCount: 0 }),
      ])
        expect(yield* read.pipe(Effect.flip)).toMatchObject({ code: "thread_not_found" });
      expect(
        yield* service
          .turnDiff(scope, { threadId: shown, fromTurnCount: 3, toTurnCount: 2 })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "invalid_request" });
      expect(yield* Ref.get(queried)).toBe(0);

      const read = yield* service.fullDiff(scope, { threadId: shown, toTurnCount: 4 });
      expect(read.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(read), "utf8")).toBeLessThanOrEqual(256 * 1024);
      expect(read.diff.length).toBeGreaterThan(100 * 1024);
    }),
);
