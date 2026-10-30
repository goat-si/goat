import { assert, it } from "@effect/vitest";
import { CommandId, MessageId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { threadId, withHarness } from "../handoffs/Handoffs.testkit.ts";
import { sessionId, supported, withRequests } from "./ComputerUseRequests.testkit.ts";

it.effect("expiry between a response's check and commit retires the earlier mention", () =>
  withHarness(({ orchestrator }) => {
    let advance = false;
    const delayed = {
      ...orchestrator,
      dispatch: (command: Parameters<typeof orchestrator.dispatch>[0]) =>
        advance && command.type === "handoff.transition" && command.state === "completed"
          ? TestClock.adjust("5 minutes").pipe(Effect.andThen(orchestrator.dispatch(command)))
          : orchestrator.dispatch(command),
    };
    return withRequests(delayed, supported, ({ request, handoffs }) =>
      Effect.gen(function* () {
        const prior = yield* request({ apps: ["com.example.Other"] });
        if (prior.kind !== "needs_human") return assert.fail("expected prior approval");
        yield* handoffs.respond(
          { threadId, handoffId: prior.handoff.handoffId, action: "completed" },
          sessionId,
        );
        const pending = yield* request({ apps: ["com.example.Editor"], minutes: 5 });
        if (pending.kind !== "needs_human") return assert.fail("expected pending card");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cross-expiry-name"),
          threadId,
          messageId: MessageId.make("message:cross-expiry-name"),
          text: "Use com.example.Editor",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        advance = true;
        const result = yield* handoffs
          .respond(
            { threadId, handoffId: pending.handoff.handoffId, action: "completed" },
            sessionId,
          )
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    );
  }),
);
