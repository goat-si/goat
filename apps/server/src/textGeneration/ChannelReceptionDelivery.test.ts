import * as M from "@goat/contracts";
import { it } from "@effect/vitest";
import { EMPTY_CHANNEL_RECEPTION_MODEL_OUTPUT } from "@goat/provider-core/server/channelReceptionPrompt";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";
import { MemoryAccessError } from "../memory/MemoryService.ts";
import { channelMemoryReadBatch } from "../channels/channelConversationMemory.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as SourceControl from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  DEFAULT_TEST_MODEL_SELECTION,
  layerCodexTextGenerationTest,
  withFakeCodexEnv,
} from "./codexTextGenerationFake.testkit.ts";
import { withFakeClaudeEnv } from "./ClaudeTextGeneration.testkit.ts";

const output = {
  ...EMPTY_CHANNEL_RECEPTION_MODEL_OUTPUT,
  replyText: "Done.",
  action: "report_only",
};
const memory = "Saved preference from GOAT";
const fallback = "Nothing in memory matches.";

it.layer(layerCodexTextGenerationTest)("channel reception at provider delivery", (it) => {
  it.effect.each(["codex allowed", "codex paused", "claude retry"] as const)(
    "sends only the authorized recall text on stdin (%s)",
    (scenario) =>
      Effect.gen(function* () {
        const native = yield* ChildProcessSpawner.ChildProcessSpawner;
        let paused = false;
        const spawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command)) {
            const args = command.args;
            if (scenario === "codex paused" && args.includes("mcp") && args.includes("list"))
              paused = true;
            if (
              scenario === "claude retry" &&
              args.includes("--json-schema") &&
              !args.includes("--no-session-persistence")
            )
              paused = true;
          }
          return native.spawn(command);
        });
        const batch = channelMemoryReadBatch(
          Effect.suspend(() =>
            paused ? Effect.fail(new MemoryAccessError({ code: "unavailable" })) : Effect.void,
          ),
        );
        const send = (textGeneration: ProviderInstance["textGeneration"]) =>
          Effect.gen(function* () {
            const service = yield* TextGeneration.make.pipe(
              Effect.provide(
                Layer.mergeAll(
                  Settings.layerTest(),
                  Layer.mock(Registry.ProviderInstanceRegistry)({
                    getInstance: () => Effect.succeed({ textGeneration } as ProviderInstance),
                  }),
                  Layer.mock(SourceControl.SourceControlProviderRegistry)({
                    resolveLink: () =>
                      Effect.die("channel reception never resolves source control links"),
                  }),
                ),
              ),
            );
            if (!service.generateChannelReception)
              return yield* Effect.die("missing channel reception");
            const result = yield* service.generateChannelReception({
              cwd: process.cwd(),
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              input: {
                mode: "input",
                originKind: "slack",
                conversationId: M.ChannelConversationId.make("conversation"),
                inputText: "Which preference did I save?",
                tail: [],
                tasks: [],
                allowedTargets: [],
                requester: {
                  ownerId: "owner",
                  principalId: "owner",
                  displayName: "Owner",
                  originKind: "slack",
                  runtimeModeCeiling: "full-access",
                  grantedScopes: ["memory:read"],
                },
                readResults: [
                  { kind: "memory", query: "preference", text: batch.format(0, [], [memory]) },
                ],
              },
              recheckInput: batch.recheck,
            });
            expect(result.replyText).toBe(output.replyText);
          });
        yield* (
          scenario === "claude retry"
            ? withFakeClaudeEnv(
                {
                  output: JSON.stringify({ structured_output: output }),
                  rejectsNoSessionPersistence: true,
                  expectSpawnCount: 2,
                  stdinMustContain: fallback,
                },
                send,
              )
            : withFakeCodexEnv(
                {
                  output: JSON.stringify(output),
                  stdinMustContain: scenario === "codex allowed" ? memory : fallback,
                  stdinMustNotContain: scenario === "codex allowed" ? fallback : memory,
                },
                send,
              )
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      }),
  );
});
