import { assert, it } from "@effect/vitest";
import { CommandId, MessageId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { threadId, withHarness } from "../handoffs/Handoffs.testkit.ts";
import { sessionId, supported, withRequests } from "./ComputerUseRequests.testkit.ts";

it.effect("without strict input guards a named protected app follows the person's approval", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("named-protected-off"),
        threadId,
        messageId: MessageId.make("message:named-protected-off"),
        text: "Use com.1password.safari",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* withRequests(orchestrator, supported, ({ request, handoffs }) =>
        Effect.gen(function* () {
          const first = yield* request({ apps: ["com.example.Other"] });
          if (first.kind !== "needs_human") return assert.fail("expected approval");
          yield* handoffs.respond(
            { threadId, handoffId: first.handoff.handoffId, action: "completed" },
            sessionId,
          );
          assert.equal((yield* request({ apps: ["com.1password.safari"] })).kind, "available");
        }),
      );
    }),
  ),
);
