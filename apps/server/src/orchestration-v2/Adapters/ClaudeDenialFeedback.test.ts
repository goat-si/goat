import { assert, it } from "@effect/vitest";
import { permissionResultFromDecision } from "./ClaudeApproval.ts";

it("attributes denial feedback to the user and preserves cancellation", () => {
  const result = permissionResultFromDecision({
    toolName: "Bash",
    decision: "cancel",
    toolInput: {},
    toolUseID: "tool",
    feedback: "try a safer command",
  });
  assert.equal(result.behavior, "deny");
  if (result.behavior === "deny") {
    assert.equal(result.message, "The user declined this tool call and said:\ntry a safer command");
    assert.isTrue(result.interrupt);
  }
});
