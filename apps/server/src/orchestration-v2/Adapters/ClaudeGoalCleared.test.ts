import { assert, it } from "@effect/vitest";
import { nextClaudeGoal } from "./ClaudeGoalProjection.ts";
import { claudeSdkFrame, WAKE_NATIVE_SESSION } from "./ClaudeWakeFrames.testkit.ts";

it("clears a Claude goal after the CLI reports an unrecoverable error", () => {
  const goal = { objective: "Build", status: "active" as const, checks: 0 };
  const frame = claudeSdkFrame({
    type: "system",
    subtype: "informational",
    content: "Goal cleared after an unrecoverable error (billing)",
    uuid: "00000000-0000-4000-8000-000000000901",
    session_id: WAKE_NATIVE_SESSION,
  });
  assert.isNull(nextClaudeGoal(goal, frame));
});
