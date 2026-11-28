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
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexOrchestratorReplayHarness } from "../../Adapters/CodexAdapterV2.testkit.ts";
import * as CodexAdapterV2Testkit from "../../Adapters/CodexAdapterV2.testkit.ts";
import { withThreadNames, withThreadSetupReads } from "../../Adapters/CodexReplay.testkit.ts";
import { provideDeterministicTestRuntime } from "../DeterministicRuntime.ts";
import { CODEX_MODEL_SELECTION, materializeFixtureInput } from "../fixtures/shared.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../fixtures/index.ts";
import { runOrchestratorV2ProviderReplayScenario } from "../ProviderReplayHarness.ts";
import { traceFromV1 } from "./traceFromV1.ts";

it.effect("replays the parity scenario", () => Effect.scoped(Effect.gen(function* () {
  const dir = process.env.GOAT2_PARITY_SCENARIO!;
  const out = process.env.GOAT2_PARITY_OUT!;
  const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
  // Use the runtime policy v1 registers for the Codex fixture this scenario's transcript was
  // recorded from (fixtures/index.ts), rather than choosing one per scenario.
  // The runner is copied to apps/server/src/orchestration-v2/testkit/<dir>/, six levels below
  // the export root. Match the normalized repo-relative path. At least one fixture must match,
  // and every match must register the same policy (v1 reuses some transcripts across fixtures).
  const v1Root = join(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
  const source = scenario.streams.codex.provenance?.source as string | undefined;
  if (source === undefined) throw new Error("scenario has no codex provenance source");
  const wanted = posix.normalize(source);
  const fixtureProviders = ORCHESTRATOR_REPLAY_FIXTURES.flatMap((f) => f.providers).filter((p) =>
    p.driver === "codex" && relative(v1Root, fileURLToPath(p.transcriptFile)).split("\\").join("/") === wanted);
  if (fixtureProviders.length === 0) throw new Error(`no v1 codex fixture registers ${wanted}`);
  const policies = new Set(fixtureProviders.map((p) => JSON.stringify(p.runtimePolicyOverride ?? {})));
  if (policies.size !== 1) throw new Error(`v1 fixtures registering ${wanted} disagree on runtime policy`);
  const runtimePolicy = fixtureProviders[0].runtimePolicyOverride ?? {};
  const threadAliases = new Set(scenario.steps.map((s: any) => s.thread).filter(Boolean));
  if (threadAliases.size !== 1) throw new Error(`single-thread runner got threads ${[...threadAliases]}`);
  const sends = scenario.steps.filter((s: any) => s.do === "send");
  const editSteps = scenario.steps.filter((s: any) => s.do === "queue_edit" || s.do === "queue_cancel");
  if (editSteps.length > 1 || (editSteps.length === 1 && (sends.length !== 2 || editSteps[0].input !== sends[1].input || editSteps[0].thread !== sends[1].thread))) throw new Error("unsupported queue edit target");
  // v1's fixture DSL creates one run per start/queue send, numbered by send order
  // (shared.ts runIndex). Resolve a scenario run alias through the expected trace:
  // the run.started event names the input whose send created that run.
  const runOrdinal = (alias: string) => {
    // Same expectation the comparator selects for the v1 target.
    const expect = scenario.targets?.v1?.expect ?? scenario.expect;
    const events = Object.values(expect?.threads ?? {}).flat() as any[];
    const started = events.filter((e: any) => e.kind === "run.started" && e.run === alias);
    if (started.length !== 1 || started[0].inputs?.length !== 1) throw new Error(`cannot resolve run alias ${alias}`);
    const index = sends.findIndex((s: any) => s.input === started[0].inputs[0]);
    if (index < 0 || !["start", "queue"].includes(sends[index].mode)) throw new Error(`run alias ${alias} not created by a start/queue send`);
    return index + 1;
  };
  // Each await is re-inserted right after the dispatch of the send it directly follows, so it
  // keeps its position and its own run. An await after any other step kind (queue edit/cancel,
  // interrupt, ...) has no supported placement and is refused instead of being dropped.
  const awaitsAfterSend = new Map<number, any[]>();
  const fixtureSteps: any[] = [];
  let sendCount = 0;
  let previous: string | undefined;
  for (const s of scenario.steps) {
    if (s.do === "send" && s.mode === "start") { fixtureSteps.push({type: "message", text: s.text}); sendCount += 1; }
    else if (s.do === "send" && s.mode === "queue") { fixtureSteps.push({type: "queue_message", text: s.text}); sendCount += 1; }
    else if (s.do === "queue_edit" || s.do === "queue_cancel") fixtureSteps.push({type: "cancel_queued_run", targetRunIndex: 2});
    else if (s.do === "interrupt" && s.run === "r1") fixtureSteps.push({type: "interrupt", targetRunIndex: 1});
    else if (s.do === "await" && s.until === "run_status") {
      if (previous !== "send") throw new Error(`await ${s.id} after a ${previous ?? "start of scenario"} step is unsupported`);
      const list = awaitsAfterSend.get(sendCount - 1) ?? [];
      list.push(s);
      awaitsAfterSend.set(sendCount - 1, list);
      continue;
    } else throw new Error(`unsupported scenario step: ${JSON.stringify(s)}`);
    previous = s.do;
  }
  const workspace = yield* checkpointWorkspace(scenario.name);
  const raw = yield* readProviderReplayTranscript(pathToFileURL(join(dir, scenario.streams.codex.transcript)));
  const transcript = yield* Schema.decodeUnknownEffect(CodexReplay.CodexAppServerReplayTranscript)(materializeReplayTranscriptWorkspace(raw, workspace));
  const marked = {...transcript, entries: transcript.entries.map((entry) => ({...entry, parityOriginal: true}))};
  const augmented = withThreadSetupReads(withThreadNames(marked, [`Replay fixture: ${scenario.name}`]));
  const materialized = yield* materializeFixtureInput({scenario: scenario.name, fixtureInput: {steps: fixtureSteps}, driver: ProviderDriverKind.make("codex"), modelSelection: CODEX_MODEL_SELECTION});
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threadId = materialized.projectionThreadIds[0];
  const messageInputs = new Map<string, string>();
  const steps: any[] = [];
  let sendIndex = -1;
  for (const step of materialized.steps as any[]) {
    steps.push(step);
    if (step.type !== "dispatch" || step.command.type !== "message.dispatch") continue;
    sendIndex += 1;
    const send = sends[sendIndex];
    if (!send || messageInputs.has(step.command.messageId)) throw new Error(`unexpected message dispatch ${step.command.messageId}`);
    messageInputs.set(step.command.messageId, send.input);
    for (const a of awaitsAfterSend.get(sendIndex) ?? []) {
      // An awaited (foreground) dispatch has already gone idle, so a later status wait could
      // never be satisfied as intended; refuse rather than reorder.
      if (step.await !== false) throw new Error(`await ${a.id} follows a foreground send`);
      const ordinal = runOrdinal(a.run);
      if (ordinal > sendIndex + 1) throw new Error(`await ${a.id} waits for run ${a.run}, created by a later send`);
      steps.push({type: "await_run_status", threadId, runId: ids.derive.run({threadId, ordinal}), status: a.status});
    }
  }
  const edit = editSteps[0];
  if (edit) {
    const index = steps.findIndex((s: any) => s.type === "dispatch" && s.command.type === "queued-run.cancel");
    if (index < 0) throw new Error("missing queued edit placeholder");
    const command = steps[index].command;
    steps.splice(index, 1,
      {type: "await_run_status", threadId, runId: command.runId, status: "queued"},
      {type: "dispatch", command: edit.do === "queue_edit" ? {...command, type: "queued-run.edit", text: edit.text} : command},
      {type: "release_replay_gate", label: "turn/completed"},
      {type: "await", key: "run:1"},
      {type: "await_thread_idle", threadId});
  }
  if (sendIndex !== sends.length - 1) throw new Error(`materialized ${sendIndex + 1} sends, scenario has ${sends.length}`);
  let driver: any;
  const harness = {...CodexOrchestratorReplayHarness, makeProviderAdapterRegistryLayer: (_: any, options: any) => Layer.unwrap(Effect.gen(function* () {
    driver = yield* CodexReplay.makeReplayDriver(augmented, options?.replayGate ? {beforeEmitInbound: (entry) => Effect.promise((signal) => options.replayGate.beforeEmit(entry.label, signal))} : {});
    return CodexAdapterV2Testkit.layer({transcript, driver});
  }))};
  const exit = yield* Effect.exit(runOrchestratorV2ProviderReplayScenario({name: `${scenario.name}/codex`, transcript, commands: materialized.commands, steps, projectionThreadIds: materialized.projectionThreadIds, runtimePolicyOverride: {cwd: workspace, ...runtimePolicy}}, harness));
  const state = yield* Ref.get(driver.state);
  const trace = traceFromV1(scenario, Exit.isSuccess(exit) ? exit.value.storedEvents : [], driver.transcript, state, threadId, messageInputs, Exit.isFailure(exit) ? Cause.pretty(exit.cause) : undefined);
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(trace, null, 2) + "\n");
  renameSync(tmp, out);
}).pipe(provideDeterministicTestRuntime, Effect.provide(Layer.merge(IdAllocator.layer, Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))))));
