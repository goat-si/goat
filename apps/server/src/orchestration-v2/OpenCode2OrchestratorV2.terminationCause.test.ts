import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type OrchestrationV2Command } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { OPENCODE_PROVIDER } from "@goat/provider-opencode/testing";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import {
  OPENCODE2_HTTP_PROTOCOL,
  OpenCode2OrchestratorReplayHarness,
  layerRegistry,
} from "./Adapters/OpenCode2AdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "./testkit/DeterministicRuntime.ts";
import type { OrchestratorV2ScenarioStep } from "./testkit/OrchestratorScenario.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./testkit/ProviderReplayHarness.ts";
import {
  SESSION,
  out,
  reply,
  instructionsWritten,
  createdSession,
  threadCommands,
} from "./OpenCode2OrchestratorV2.testkit.ts";

it.effect("records queued replacement when a waiting message becomes Steer", () =>
  Effect.gen(function* () {
    const name = "opencode2-queued-replaced";
    const steerSent = Promise.withResolvers<void>();
    const cwd = yield* checkpointWorkspace(name);
    const thread = threadCommands({ name, worktreePath: cwd });
    const ids = yield* IdAllocator.IdAllocatorV2;
    const run = (ordinal: number) => ids.derive.run({ threadId: thread.threadId, ordinal });
    const first = thread.message("first");
    const second: OrchestrationV2Command = {
      ...thread.message("second"),
      dispatchMode: { type: "queue_after_active" },
    };
    const promote: OrchestrationV2Command = {
      type: "queued-message.promote-to-steer",
      commandId: thread.command("promote"),
      threadId: thread.threadId,
      queuedRunId: run(2),
      targetRunId: run(1),
    };
    const transcript = yield* OpenCode2OrchestratorReplayHarness.decodeTranscript({
      provider: OPENCODE_PROVIDER,
      protocol: OPENCODE2_HTTP_PROTOCOL,
      version: "2.0.18",
      scenario: name,
      entries: [
        ...createdSession(cwd, name),
        ...instructionsWritten,
        out("session.prompt", { sessionID: SESSION, id: "<any>", text: "<any>" }),
        reply("session.prompt", {
          data: {
            id: "msg_user_FIRST",
            sessionID: SESSION,
            time: { created: 1 },
            type: "user",
            payload: { text: "<prompt>" },
            delivery: "steer",
          },
        }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        reply("session.prompt", "<hang>"),
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: true }),
      ],
    });
    const steps: Array<OrchestratorV2ScenarioStep> = [
      { type: "dispatch", command: thread.create },
      { type: "advance_clock", duration: "1 millis" },
      { type: "dispatch", command: first, await: false, key: "first" },
      { type: "await_run_steerable", threadId: thread.threadId, runId: run(1) },
      { type: "dispatch", command: second },
      { type: "dispatch", command: promote },
      { type: "await_run_status", threadId: thread.threadId, runId: run(2), status: "cancelled" },
    ];
    const result = yield* runOrchestratorV2ProviderReplayScenario(
      { name, transcript, commands: [thread.create, first, second, promote], steps },
      {
        ...OpenCode2OrchestratorReplayHarness,
        makeProviderAdapterRegistryLayer: (transcript, options) =>
          layerRegistry(transcript, {
            ...options,
            onHang: () => steerSent.resolve(),
          }),
      },
      // Shutdown interrupts the active session; wait until the steer has reached OpenCode.
      { afterSteps: Effect.promise(() => steerSent.promise) },
    ).pipe(provideDeterministicTestRuntime);
    const projection = result.projections.get(thread.threadId);
    assert.isDefined(projection);
    assert.equal(projection.runs[1]?.terminationCause?.kind, "queued_replaced");
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, IdAllocator.layer))),
);

it.effect("fails fast when a promotion has no steer effect (#2473)", () =>
  Effect.gen(function* () {
    const name = "opencode2-missing-steer-effect";
    const thread = threadCommands({ name, worktreePath: yield* checkpointWorkspace(name) });
    const transcript = yield* OpenCode2OrchestratorReplayHarness.decodeTranscript({
      provider: OPENCODE_PROVIDER,
      protocol: OPENCODE2_HTTP_PROTOCOL,
      version: "2.0.18",
      scenario: name,
      entries: [],
    });
    const options = {
      steerGuard: { commandId: thread.command("promote"), arrival: Effect.never },
    };
    const outcome = yield* runOrchestratorV2ProviderReplayScenario(
      { name, transcript, commands: [], steps: [] },
      OpenCode2OrchestratorReplayHarness,
      options,
    ).pipe(provideDeterministicTestRuntime, Effect.exit);
    assert.equal(outcome._tag, "Failure", "a missing steer effect must fail the scenario");
    if (outcome._tag === "Failure") {
      assert.include(String(outcome.cause), "no steer effect");
    }
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, IdAllocator.layer))),
);
