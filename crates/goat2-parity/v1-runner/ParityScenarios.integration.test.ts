import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as CodexReplay from "effect-codex-app-server/replay";
import { ProviderDriverKind } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import { readProviderReplayTranscript, materializeReplayTranscriptWorkspace } from "@goat/provider-testing/replayTranscript";
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { CodexOrchestratorReplayHarness } from "../../Adapters/CodexAdapterV2.testkit.ts";
import * as CodexAdapterV2Testkit from "../../Adapters/CodexAdapterV2.testkit.ts";
import { withThreadNames, withThreadSetupReads } from "../../Adapters/CodexReplay.testkit.ts";
import { provideDeterministicTestRuntime } from "../DeterministicRuntime.ts";
import { CODEX_MODEL_SELECTION, materializeFixtureInput } from "../fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "../ProviderReplayHarness.ts";
import { traceFromV1 } from "./traceFromV1.ts";

it.effect("replays the parity scenario", () => Effect.scoped(Effect.gen(function* () {
  const dir = process.env.GOAT2_PARITY_SCENARIO!;
  const out = process.env.GOAT2_PARITY_OUT!;
  const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
  // Keep the fixture DSL's background-dispatch choice, then add the explicit
  // run-status barrier to its materialized steps below.
  const fixtureSteps = scenario.steps.flatMap((s: any, i: number) => {
    if (s.do === "send" && s.mode === "start") return [{type: "message", text: s.text}];
    if (s.do === "send" && s.mode === "queue") return [{type: "queue_message", text: s.text}];
    if (s.do === "await" && s.until === "run_status" && s.status === "running" && scenario.steps[i + 1]?.mode === "queue") return [];
    throw new Error(`unsupported scenario step: ${JSON.stringify(s)}`);
  });
  const workspace = yield* checkpointWorkspace(scenario.name);
  const raw = yield* readProviderReplayTranscript(pathToFileURL(join(dir, scenario.streams.codex.transcript)));
  const transcript = yield* Schema.decodeUnknownEffect(CodexReplay.CodexAppServerReplayTranscript)(materializeReplayTranscriptWorkspace(raw, workspace));
  const marked = {...transcript, entries: transcript.entries.map((entry) => ({...entry, parityOriginal: true}))};
  const augmented = withThreadSetupReads(withThreadNames(marked, [`Replay fixture: ${scenario.name}`]));
  const driver = yield* CodexReplay.makeReplayDriver(augmented);
  const materialized = yield* materializeFixtureInput({scenario: scenario.name, fixtureInput: {steps: fixtureSteps}, driver: ProviderDriverKind.make("codex"), modelSelection: CODEX_MODEL_SELECTION});
  const ids = yield* IdAllocator.IdAllocatorV2;
  const steps = [...materialized.steps];
  if (scenario.steps.some((s: any) => s.do === "await" && s.until === "run_status")) {
    const queueIndex = steps.findIndex((s: any) => s.type === "dispatch" && s.command.type === "message.dispatch" && s.command.dispatchMode?.type === "queue_after_active");
    if (queueIndex < 0) throw new Error("missing queue dispatch barrier");
    const threadId = materialized.projectionThreadIds[0];
    steps.splice(queueIndex, 0, {type: "await_run_status", threadId, runId: ids.derive.run({threadId, ordinal: 1}), status: "running"});
  }
  const harness = {...CodexOrchestratorReplayHarness, makeProviderAdapterRegistryLayer: () => CodexAdapterV2Testkit.layer({transcript, driver})};
  const exit = yield* Effect.exit(runOrchestratorV2ProviderReplayScenario({name: `${scenario.name}/codex`, transcript, commands: materialized.commands, steps, projectionThreadIds: materialized.projectionThreadIds, runtimePolicyOverride: {cwd: workspace}}, harness));
  const state = yield* Ref.get(driver.state);
  const trace = traceFromV1(scenario, Exit.isSuccess(exit) ? exit.value.storedEvents : [], driver.transcript, state, materialized.projectionThreadIds[0], Exit.isFailure(exit) ? Cause.pretty(exit.cause) : undefined);
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(trace, null, 2) + "\n");
  renameSync(tmp, out);
}).pipe(provideDeterministicTestRuntime, Effect.provide(Layer.merge(IdAllocator.layer, Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))))));
