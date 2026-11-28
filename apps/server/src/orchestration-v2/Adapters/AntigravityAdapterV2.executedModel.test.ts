import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";

import { openSessionWithRunningCommand } from "./AntigravityWake.testkit.ts";

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

describe("AntigravityAdapterV2 executed model", () => {
  // agy names the model that answered on each PLANNER_RESPONSE step of its native transcript;
  // delegated task results read executedModel from the completed provider turn.
  it.effect("records the model agy's transcript reports on the completed provider turn", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-agy-model-" });
      const logs = path.join(
        profile,
        "antigravity-acp",
        "brain",
        "mock-session-1",
        ".system_generated",
        "logs",
      );
      yield* fileSystem.makeDirectory(logs, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(logs, "transcript.jsonl"),
        [
          { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE" },
          {
            step_index: 1,
            source: "MODEL",
            type: "PLANNER_RESPONSE",
            status: "DONE",
            model: "gemini-test-high",
            content: "GOAT READY",
          },
        ]
          .map((line) => encodeUnknownJson(line))
          .join("\n") + "\n",
      );
      const { startTurn, throughTerminal } = yield* openSessionWithRunningCommand({}, undefined, {
        profileDirectory: profile,
        initialToolCalls: [],
      });
      yield* startTurn(1, false);
      const run = yield* throughTerminal;
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      const completed = run.findLast(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert.equal(
        completed?.type === "provider_turn.updated" && completed.providerTurn.model,
        "gemini-test-high",
      );
    }).pipe(Effect.provide(layerSession)),
  );
});
