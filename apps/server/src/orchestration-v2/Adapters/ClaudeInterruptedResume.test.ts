import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { interruptedResumeOptions } from "./ClaudeInterruptedResume.ts";

it.effect.each([true, false])(
  "does not request a second native resume after failed history=%s",
  (failed) =>
    Effect.gen(function* () {
      const messages = [
        { type: "user", uuid: "u", message: { content: "hello" } },
        {
          type: "assistant",
          uuid: "a",
          message: { content: "error", model: failed ? "<synthetic>" : "claude" },
        },
      ];
      const options = yield* interruptedResumeOptions(
        { resume: "session", model: "claude", tools: [], permissionMode: "default", env: {} },
        () => Effect.succeed(JSON.stringify(messages)),
      );
      assert.equal(options.env?.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, failed ? undefined : "1");
    }),
);
