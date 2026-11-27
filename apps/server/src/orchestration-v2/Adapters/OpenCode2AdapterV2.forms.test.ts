import { assert, it } from "@effect/vitest";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import {
  SESSION,
  event,
  out,
  promptAccepted,
  reply,
  resumed,
  terminalOf,
  turnInput,
} from "./OpenCode2AdapterV2.fixtures.testkit.ts";

it.layer(McpProviderSessions.layer)("OpenCode2 forms", (it) => {
  it.effect("answers an optional multiselect with none and keeps a minimum choice required", () =>
    Effect.gen(function* () {
      const formID = "frm_0eb79ab35001fkvFECSh3wYNVE";
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        event("form.created", {
          form: {
            id: formID,
            sessionID: SESSION,
            title: "Setup",
            fields: [
              {
                key: "extras",
                type: "multiselect",
                title: "Extras",
                options: [
                  { value: "lint", label: "Lint" },
                  { value: "tests", label: "Tests" },
                ],
              },
              {
                key: "targets",
                type: "multiselect",
                title: "Targets",
                minItems: 1,
                options: [{ value: "web", label: "Web" }],
              },
            ],
          },
        }),
        out("session.form.reply", {
          sessionID: SESSION,
          formID,
          answer: { extras: [], targets: ["web"] },
        }),
        reply("session.form.reply", null),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const shown = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "runtime_request.updated"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const events = yield* Fiber.join(shown);
      const questions = events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "user_input_request"
          ? event.turnItem.questions
          : [],
      );
      assert.deepEqual(
        questions.map((question) => [question.id, question.required]),
        [
          ["extras", undefined],
          ["targets", true],
        ],
      );
      const request = events.find((event) => event.type === "runtime_request.updated");
      assert.isDefined(request);
      if (request?.type !== "runtime_request.updated") return;
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.respondToRuntimeRequest({
        requestId: request.runtimeRequest.id,
        answers: { extras: [], targets: ["web"] },
      });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }).pipe(Effect.scoped),
  );
});
