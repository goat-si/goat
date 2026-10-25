import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { driverExitReason } from "./ComputerUseDriverExit.ts";
import { markUnverified } from "./ComputerUseDriverOutcome.ts";

const reply = (structuredContent: unknown, isError = true) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    result: {
      isError,
      content: [
        {
          type: "text",
          text: "AX action failed: AXUIElementPerformAction(AXOpen) returned -25205",
        },
      ],
      structuredContent,
    },
  });
const parsed = (line: string) =>
  JSON.parse(line) as {
    result: { structuredContent: Record<string, unknown>; content: Array<{ text: string }> };
  };

describe("macOS input tool errors after dispatch reach the agent as may-have-acted", () => {
  it("a click whose AX action errored after it was sent is unverifiable, never a plain failure", () => {
    const out = parsed(markUnverified("click", reply({ code: "tool_invocation_failed" })));
    assert.equal(out.result.structuredContent.effect, "unverifiable");
    assert.equal(out.result.structuredContent.code, "tool_invocation_failed");
    assert.include(out.result.content.at(-1)?.text ?? "", "may have acted");
  });

  it("an error the driver raises before any input leaves stays a plain refusal", () => {
    const line = reply({ code: "stale_element_token" });
    assert.equal(markUnverified("click", line), line);
  });

  it("an explicit effect from the driver is kept as it said", () => {
    const line = reply({ code: "tool_invocation_failed", effect: "refused" });
    assert.equal(markUnverified("type_text", line), line);
  });

  it("read-only tools and successful replies pass unchanged", () => {
    const failedRead = reply({ code: "tool_invocation_failed" });
    assert.equal(markUnverified("get_window_state", failedRead), failedRead);
    const ok = reply({ effect: "confirmed" }, false);
    assert.equal(markUnverified("click", ok), ok);
  });

  it("an input error with no structured content at all is also unverifiable", () => {
    const out = parsed(markUnverified("press_key", reply(undefined)));
    assert.equal(out.result.structuredContent.effect, "unverifiable");
  });
});

describe("a helper that ends on its own is named by its exit code", () => {
  const exiting = (code: number | undefined) =>
    driverExitReason({
      send: () => Effect.void,
      lines: undefined as never,
      kill: Effect.void,
      exitCode: Effect.succeed(code),
    });
  it.effect("parent refusal (77) and the helper's other typed refusals do not say restart", () =>
    Effect.gen(function* () {
      assert.equal(yield* exiting(77), "helper_refused");
      for (const code of [64, 78, 79]) assert.equal(yield* exiting(code), "helper_unsupported");
      assert.equal(yield* exiting(0), "helper_restarted");
      assert.equal(yield* exiting(137), "helper_restarted");
      assert.equal(yield* exiting(undefined), "helper_restarted");
    }),
  );
});
