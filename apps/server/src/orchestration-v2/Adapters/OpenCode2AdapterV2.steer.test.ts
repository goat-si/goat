import { assert, it } from "@effect/vitest";
import { MessageId } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  SESSION,
  WORK,
  event,
  out,
  promptAccepted,
  providerTurnId,
  reply,
  replyData,
  resumed,
  terminalOf,
  threadId,
  turnInput,
} from "./OpenCode2AdapterV2.fixtures.testkit.ts";

it.layer(McpProviderSessions.layer)("OpenCode2 steers", (it) => {
  it.effect("sends a $skill named in a message that steers the running turn", () =>
    Effect.gen(function* () {
      const prompts: Array<unknown> = [];
      const steerId = "msg_recorded_steer_skill";
      const greet = {
        id: "greet",
        name: "greet",
        path: `${WORK}/.opencode/skills/greet/SKILL.md`,
        content: "Say hello.",
      };
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.started", { sessionID: SESSION }),
          out("skill.list", { "location[directory]": WORK }),
          reply("skill.list", { location: { directory: WORK }, data: [greet] }),
          out("session.prompt", { sessionID: SESSION, id: steerId, delivery: "steer" }),
          replyData("session.prompt", {
            id: steerId,
            sessionID: SESSION,
            time: { created: 1790656601500 },
            type: "user",
            payload: { text: "$greet first" },
            delivery: "steer",
          }),
          event("session.inbox.delivered", { sessionID: SESSION, inboxID: steerId }),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { onPrompt: (input) => prompts.push(input) },
      );
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      const input = turnInput(thread);
      yield* runtime.startTurn(input);
      yield* runtime.steerTurn({
        threadId,
        runId: input.runId,
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
        message: {
          ...input.message,
          messageId: MessageId.make("message:opencode2-adapter:steer"),
          text: "$greet first",
        },
      });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
      assert.deepInclude(prompts[1], { delivery: "steer", skills: [{ id: "greet" }] });
    }).pipe(Effect.scoped),
  );
});
