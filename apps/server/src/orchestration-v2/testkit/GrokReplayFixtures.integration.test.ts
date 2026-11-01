import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { makeProviderReplayGate } from "@goat/provider-testing/replayGate";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";

import { GrokOrchestratorReplayHarness } from "../Adapters/GrokAdapterV2.testkit.ts";
import * as Orchestrator from "../Orchestrator.ts";
import { materializeFixtureInput } from "./fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import { layerProviderReplay } from "./ProviderReplayHarness.ts";
import {
  findReplayFixture,
  itRunsReplayFixtures,
  readReplayFixtureTranscript,
  runReplayFixture,
} from "./ProviderReplayFixtures.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

describe("Grok replay fixtures", () => {
  itRunsReplayFixtures("grok", (input) =>
    runReplayFixture({ ...input, harness: GrokOrchestratorReplayHarness }),
  );

  it.effect("does not finish grok_background_bash while its wake response is still arriving", () =>
    Effect.gen(function* () {
      const fixture = findReplayFixture("grok_background_bash")!;
      const clock = yield* Clock.Clock;
      let wakeStartedAt = 0;
      let rootFinishReceipts = 0;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      const gate = makeProviderReplayGate([
        "notification:session/update:agent_thought_chunk:task-completed-00000000-0000-4000-8000-000000000002",
      ]);
      const replayGate = {
        ...gate,
        release: (label: string) => {
          wakeStartedAt = clock.currentTimeMillisUnsafe();
          rootFinishReceipts = gate.finishArmedCount();
          return gate.release(label);
        },
      };
      const harness = GrokOrchestratorReplayHarness;
      const provider = fixture.providers[0]!;
      const transcript = yield* harness.decodeTranscript(
        materializeReplayTranscriptRuntimeInstructions(
          yield* readReplayFixtureTranscript(provider.transcriptFile),
          {
            driver: provider.driver,
            model: provider.modelSelection.model,
          },
        ),
      );
      const materialized = yield* materializeFixtureInput({
        scenario: fixture.name,
        fixtureInput: fixture.buildInput(),
        driver: provider.driver,
        modelSelection: provider.modelSelection,
      }).pipe(Effect.provide(IdAllocator.layer));
      const scenario = {
        ...materialized,
        name: fixture.name,
        transcript,
        runtimePolicyOverride: { cwd: yield* checkpointWorkspace(fixture.name) },
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const replay = yield* runOrchestratorV2Scenario(scenario, {
          replayGate,
          awaitReplayTurnComplete: () => Deferred.await(completed),
        }).pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid));
        yield* Deferred.await(held);
        yield* orchestrator.streamStoredEvents.pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "run.updated" &&
              event.payload.ordinal === 2 &&
              event.payload.status === "running",
          ),
          Stream.runHead,
        );
        yield* Effect.promise(() => gate.waitForFinishArmed(rootFinishReceipts));
        yield* Effect.gen(function* () {
          yield* TestClock.adjust(0);
          assert.equal(
            yield* Clock.currentTimeMillis,
            wakeStartedAt,
            "the debounce must wait for the rest of the wake response",
          );
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        const result = yield* Fiber.join(replay);
        provider.assertOutput(result, transcript);
      }).pipe(
        Effect.provide(
          layerProviderReplay(scenario, harness, {
            runContinuationWorker: true,
            replayGate,
            onReplayTurnComplete: (nativeTurnId) =>
              nativeTurnId !== "task-completed-00000000-0000-4000-8000-000000000002"
                ? Effect.void
                : Effect.gen(function* () {
                    yield* Deferred.succeed(held, undefined);
                    yield* Deferred.await(release);
                    yield* Deferred.succeed(completed, undefined);
                  }),
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );
});
