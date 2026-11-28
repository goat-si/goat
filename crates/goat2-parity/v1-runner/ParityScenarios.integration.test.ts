import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
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
import * as EffectWorker from "../../EffectWorker.ts";
import * as Orchestrator from "../../Orchestrator.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
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
  // Transcripts that a dedicated v1 integration test owns instead of the fixture registry, with the
  // runtime policy that test passes besides cwd.
  const testOwned: Record<string, {readonly runtimePolicyOverride: object; readonly ref: string}> = {
    "apps/server/src/orchestration-v2/testkit/fixtures/provider_thread_resume/codex_transcript.ndjson":
      {runtimePolicyOverride: {}, ref: "OrchestratorReplayRecovery.integration.test.ts:325"},
  };
  const owners = fixtureProviders.length > 0 ? fixtureProviders : testOwned[wanted] ? [testOwned[wanted]] : [];
  if (owners.length === 0) throw new Error(`no v1 codex fixture registers ${wanted}`);
  const policies = new Set(owners.map((p: any) => JSON.stringify(p.runtimePolicyOverride ?? {})));
  if (policies.size !== 1) throw new Error(`v1 fixtures registering ${wanted} disagree on runtime policy`);
  const runtimePolicy = (owners[0] as any).runtimePolicyOverride ?? {};
  const threadAliases = new Set(scenario.steps.map((s: any) => s.thread).filter(Boolean));
  if (threadAliases.size !== 1) throw new Error(`single-thread runner got threads ${[...threadAliases]}`);
  const sends = scenario.steps.filter((s: any) => s.do === "send");
  const editSteps = scenario.steps.filter((s: any) => s.do === "queue_edit" || s.do === "queue_cancel" || s.do === "queue_promote");
  if (editSteps.length > 1 || (editSteps.length === 1 && (sends.length !== 2 || editSteps[0].input !== sends[1].input || editSteps[0].thread !== sends[1].thread))) throw new Error("unsupported queue edit target");
  // Only start/queue sends create runs (fixture DSL runIndex); a steer joins an existing run.
  const createsRun = (s: any) => s.mode === "start" || s.mode === "queue";
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
    if (index < 0 || !createsRun(sends[index])) throw new Error(`run alias ${alias} not created by a start/queue send`);
    return sends.slice(0, index + 1).filter(createsRun).length;
  };
  // Each await is re-inserted right after the dispatch of the send it directly follows, so it
  // keeps its position and its own run. An await after any other step kind (queue edit/cancel,
  // interrupt, ...) has no supported placement and is refused instead of being dropped.
  const awaitsAfterSend = new Map<number, any[]>();
  // Sends followed by an idle wait, and the send after whose idle wait the host restarts.
  const idleAfterSend = new Set<number>();
  let restartAfterSend: number | undefined;
  // A restart directly after a run-status wait is a crash with that run still live.
  let crashAfterSend: number | undefined;
  const fixtureSteps: any[] = [];
  let sendCount = 0;
  let previous: string | undefined;
  for (const [i, s] of scenario.steps.entries()) {
    if (s.do === "send" && s.mode === "start") { fixtureSteps.push({type: "message", text: s.text}); sendCount += 1; }
    else if (s.do === "send" && s.mode === "queue") { fixtureSteps.push({type: "queue_message", text: s.text}); sendCount += 1; }
    else if (s.do === "send" && s.mode === "steer" && s.run !== undefined) { fixtureSteps.push({type: "steer", text: s.text, targetRunIndex: runOrdinal(s.run)}); sendCount += 1; }
    else if (s.do === "queue_edit" || s.do === "queue_cancel" || s.do === "queue_promote") fixtureSteps.push({type: "cancel_queued_run", targetRunIndex: 2});
    else if (s.do === "interrupt" && s.run === "r1") fixtureSteps.push({type: "interrupt", targetRunIndex: 1});
    else if (s.do === "await" && s.until === "steerable" && scenario.steps[i + 1]?.do === "send" && scenario.steps[i + 1].mode === "steer" && scenario.steps[i + 1].run === s.run && scenario.steps[i + 1].thread === s.thread) {
      // The fixture DSL's steer step itself awaits this run being steerable before dispatching.
      continue;
    } else if (s.do === "await" && s.until === "idle") {
      if (previous !== "send") throw new Error(`await ${s.id} after a ${previous ?? "start of scenario"} step is unsupported`);
      idleAfterSend.add(sendCount - 1);
      previous = "await_idle";
      continue;
    } else if (s.do === "restart_host") {
      // Idle restart (v1 OrchestratorReplayRecovery.integration.test.ts:294-369) or a crash with a
      // live run (snapshot before teardown, same test :547-600). Once per scenario.
      if (restartAfterSend !== undefined || crashAfterSend !== undefined) throw new Error(`restart ${s.id}: only one restart per scenario is supported`);
      if (previous === "await_idle") restartAfterSend = sendCount - 1;
      else if (previous === "await_run_status") crashAfterSend = sendCount - 1;
      else throw new Error(`restart ${s.id} must directly follow an idle or run-status wait`);
      previous = "restart_host";
      continue;
    } else if (s.do === "await" && (s.until === "run_status" || s.until === "steerable")) {
      if (previous !== "send" && previous !== "await_run_status") throw new Error(`await ${s.id} after a ${previous ?? "start of scenario"} step is unsupported`);
      const list = awaitsAfterSend.get(sendCount - 1) ?? [];
      list.push(s);
      awaitsAfterSend.set(sendCount - 1, list);
      previous = "await_run_status";
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
      // The crash send must stay live: run it in the background like the DSL does for sends
      // followed by another step (its own await_thread_idle is cut off with phase 2 below).
      if (sendIndex === crashAfterSend && step.await !== false) Object.assign(step, {await: false, key: `crash:${sendIndex}`});
      // An awaited (foreground) dispatch has already gone idle, so a later status wait could
      // never be satisfied as intended; refuse rather than reorder.
      if (step.await !== false) throw new Error(`await ${a.id} follows a foreground send`);
      const ordinal = runOrdinal(a.run);
      if (ordinal > sends.slice(0, sendIndex + 1).filter(createsRun).length) throw new Error(`await ${a.id} waits for run ${a.run}, created by a later send`);
      const runId = ids.derive.run({threadId, ordinal});
      steps.push(a.until === "steerable" ? {type: "await_run_steerable", threadId, runId} : {type: "await_run_status", threadId, runId, status: a.status});
    }
  }
  const edit = editSteps[0];
  if (edit) {
    const index = steps.findIndex((s: any) => s.type === "dispatch" && s.command.type === "queued-run.cancel");
    if (index < 0) throw new Error("missing queued edit placeholder");
    const command = steps[index].command;
    const mutation = edit.do === "queue_edit" ? {...command, type: "queued-run.edit", text: edit.text}
      : edit.do === "queue_promote" ? {type: "queued-message.promote-to-steer", commandId: command.commandId, threadId, queuedRunId: command.runId, targetRunId: ids.derive.run({threadId, ordinal: 1})}
      : command;
    steps.splice(index, 1,
      {type: "await_run_status", threadId, runId: command.runId, status: "queued"},
      ...(edit.do === "queue_promote" ? [{type: "await_run_steerable", threadId, runId: ids.derive.run({threadId, ordinal: 1})}] : []),
      {type: "dispatch", command: mutation},
      {type: "release_replay_gate", label: "turn/completed"},
      {type: "await", key: "run:1"},
      {type: "await_thread_idle", threadId});
  }
  if (sendIndex !== sends.length - 1) throw new Error(`materialized ${sendIndex + 1} sends, scenario has ${sends.length}`);
  // An idle wait must match the fixture DSL's own await_thread_idle after that send's dispatch
  // (a foreground send); otherwise it has no faithful placement.
  const idleIndexAfterSend = (n: number) => {
    const dispatches = steps.flatMap((step: any, index: number) => step.type === "dispatch" && step.command.type === "message.dispatch" ? [index] : []);
    const end = dispatches[n + 1] ?? steps.length;
    const idle = steps.findIndex((step: any, index: number) => index > dispatches[n] && index < end && step.type === "await_thread_idle");
    if (idle < 0) throw new Error(`idle wait after send ${sends[n].id} has no matching fixture idle wait`);
    return idle;
  };
  for (const n of idleAfterSend) idleIndexAfterSend(n);
  // Same split as v1's splitAfterFirstIdle (OrchestratorReplayRecovery.integration.test.ts:167-181).
  let phases: any[][];
  if (crashAfterSend !== undefined) {
    // Phase 1 ends at the crash send's last run-status wait; the DSL's idle wait for that send
    // (and anything before it) belongs to a runtime that never gets there. Phase 2 always runs:
    // recovery on startup is the behaviour under test.
    const dispatches = steps.flatMap((step: any, index: number) => step.type === "dispatch" && step.command.type === "message.dispatch" ? [index] : []);
    const lastAwait = dispatches[crashAfterSend] + (awaitsAfterSend.get(crashAfterSend)?.length ?? 0);
    const idle = idleIndexAfterSend(crashAfterSend);
    if (idle <= lastAwait) throw new Error("crash send: fixture idle wait precedes the run-status wait");
    phases = [steps.slice(0, lastAwait + 1), steps.slice(idle + 1)];
  } else {
    const splitIndex = restartAfterSend === undefined ? steps.length - 1 : idleIndexAfterSend(restartAfterSend);
    phases = [steps.slice(0, splitIndex + 1), steps.slice(splitIndex + 1)].filter((p) => p.length > 0);
  }
  const commandsOf = (phase: any[]) => phase.flatMap((step: any) => (step.type === "dispatch" ? [step.command] : []));
  let driver: any;
  let currentGate: any;
  // Replay-boundary observations: every inbound frame the driver delivers, with its transcript
  // position. A turn/steer response is only counted as applied when it is a result (not an error)
  // answering the outbound turn/steer request the adapter actually sent (the driver verified it).
  const replayObserved: Array<{readonly cursor: number; readonly label: string | undefined; readonly frame: any}> = [];
  const observe = (entry: any) => Effect.flatMap(Ref.get(driver.state), (s: any) => Effect.sync(() => { replayObserved.push({cursor: s.cursor, label: entry.label, frame: entry.frame}); }));
  const harness = {...CodexOrchestratorReplayHarness, makeProviderAdapterRegistryLayer: (_: any, options: any) => Layer.unwrap(Effect.gen(function* () {
    // One driver for the whole scenario: a host restart keeps the replay cursor, as v1's
    // recovery test does; each runtime only swaps in its own replay gate.
    currentGate = options?.replayGate;
    if (driver === undefined) driver = yield* CodexReplay.makeReplayDriver(augmented, {beforeEmitInbound: (entry) => Effect.andThen(
      currentGate ? Effect.promise((signal) => currentGate.beforeEmit(entry.label, signal)) : Effect.void,
      observe(entry))});
    return CodexAdapterV2Testkit.layer({transcript, driver});
  }))};
  let databaseOptions: any = {};
  let snapshotPath: string | undefined;
  if (restartAfterSend !== undefined || crashAfterSend !== undefined) {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* Effect.acquireRelease(fs.makeTempDirectory({prefix: "goat2-parity-restart-"}), (d) => fs.remove(d, {recursive: true, force: true}).pipe(Effect.orDie));
    databaseOptions = {databaseLayer: SqlitePersistence.layerFromPath(join(tempDir, "state.sqlite")).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))};
    if (crashAfterSend !== undefined) snapshotPath = join(tempDir, "crash-state.sqlite");
  }
  const stored = new Map<number, any>();
  let restartBoundary: number | undefined;
  // Crash: drain the worker, record the last event before the crash, and snapshot the database
  // before scoped teardown can settle the live run (OrchestratorReplayRecovery.integration.test.ts:556-564).
  const crashSnapshot = Effect.gen(function* () {
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* worker.drain();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    restartBoundary = yield* orchestrator.getThreadEventSequence(threadId);
    // The replay layer does not export SqlClient; v1's test merges the database layer for this
    // (:575-581). A second connection to the same file takes the same consistent snapshot.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${snapshotPath!}`;
    }).pipe(Effect.provide(databaseOptions.databaseLayer));
  });
  // Scenario results only carry events produced by dispatched commands; recovery runs while the
  // second runtime starts, so the crash phase reads the thread's stored events from the recovered
  // database itself (all of them, snapshot history included).
  let recoveredEvents: any[] | undefined;
  const readRecovered = Effect.gen(function* () {
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* worker.drain();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const last = yield* orchestrator.getThreadEventSequence(threadId);
    recoveredEvents = last <= 0 ? [] : [...(yield* orchestrator.streamStoredEventsFrom({threadId, afterSequence: 0}).pipe(
      Stream.takeUntil((stored: any) => stored.sequence >= last), Stream.runCollect))];
  });
  let exit: Exit.Exit<any, any> = Exit.void;
  for (const [index, phase] of phases.entries()) {
    const first = index === 0;
    const commands = phases.length === 1 ? materialized.commands : commandsOf(phase);
    const options = crashAfterSend === undefined
      ? (first ? databaseOptions : {...databaseOptions, recoverOnStartup: true})
      : first
        ? {...databaseOptions, afterSteps: crashSnapshot}
        : {databaseLayer: SqlitePersistence.layerFromPath(snapshotPath!).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))), recoverOnStartup: true, continueThreadsAfterServerUpdate: false, afterSteps: readRecovered};
    exit = yield* Effect.exit(Effect.scoped(runOrchestratorV2ProviderReplayScenario({name: `${scenario.name}/codex:runtime-${index + 1}`, transcript, commands, steps: phase, projectionThreadIds: materialized.projectionThreadIds, runtimePolicyOverride: {cwd: workspace, ...runtimePolicy}}, harness, options)));
    if (Exit.isFailure(exit)) break;
    // A crash's second runtime starts from the snapshot, so its events supersede the first
    // runtime's (which may include writes after the snapshot).
    if (crashAfterSend !== undefined && !first) stored.clear();
    for (const s of (crashAfterSend !== undefined && !first ? recoveredEvents ?? [] : exit.value.storedEvents)) stored.set(s.sequence, s);
    if (first && phases.length > 1 && crashAfterSend === undefined) restartBoundary = Math.max(...[...stored.keys()]);
  }
  const state = yield* Ref.get(driver.state);
  const trace = traceFromV1(scenario, Exit.isSuccess(exit) ? [...stored.values()] : [], driver.transcript, state, threadId, messageInputs, replayObserved, restartBoundary, Exit.isFailure(exit) ? Cause.pretty(exit.cause) : undefined);
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(trace, null, 2) + "\n");
  renameSync(tmp, out);
}).pipe(provideDeterministicTestRuntime, Effect.provide(Layer.merge(IdAllocator.layer, Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))))));
