import { layerNoFleetSync } from "../../../goatclaw/FleetSync.testkit.ts";
import * as ThreadReplicaService from "../../../mcp/ThreadReplicaService.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CommandId, EnvironmentId, MessageId, ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { decodeProviderReplayNdjson, materializeReplayTranscriptWorkspace } from "@goat/provider-testing/replayTranscript";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";
import * as CodexReplay from "effect-codex-app-server/replay";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { layerMemorySecretStore } from "../../../mcp/OrchestratorMcpToolkit.integration.testkit.ts";
import * as CodexAdapterV2Testkit from "../../../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../../../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { withThreadNames, withThreadSetupReads } from "../../../orchestration-v2/Adapters/CodexReplay.testkit.ts";
import * as CommandReceiptStore from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { layerThreadStartMocks } from "../../../mcp/threadStartMocks.testkit.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistryMock from "../../../provider/testUtils/providerRegistryMock.ts";
import * as RemoteDispatchCoordinator from "../../../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SshRemoteDispatch from "../../../sshRemote/SshRemoteDispatch.ts";
import * as ThreadResultService from "../../../threadResults/ThreadResultService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as LaunchWatchService from "../../../mcp/LaunchWatchService.ts";
import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { layerPermissionProfilesOff } from "../../../mcp/McpToolAccess.testkit.ts";
import { makeProviderSnapshot } from "../../../mcp/OrchestratorMcpToolkit.adapter.testkit.ts";
import { traceFromV1Mcp } from "./traceFromV1Mcp.ts";

// Lifted from v1 apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts:77-157 (layers,
// ids, MCP client) and :166-252 (layer composition, including its two Codex replay registry layers:
// one inside the orchestrator replay layer, one provided to the toolkit). The runner keeps every
// replay driver those layers create and reports the one that advanced. The thread-record read
// instrumentation is dropped.
const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(layerPermissionProfilesOff),
  Layer.provide(layerNoFleetSync),
  Layer.provide(layerThreadStartMocks),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);
const rootThreadId = ThreadId.make("thread:mcp-orchestrator-parent");
const projectId = ProjectId.make("project:mcp-orchestrator");
const codexInstanceId = ProviderInstanceId.make("codex");
const codexModel = "gpt-5.4";
// The recorded session names the parent thread this (v1 test :129-133 goatReplayTitles).
const rootTitle = "MCP replay parent";
const codexSelection = { instanceId: codexInstanceId, model: codexModel };
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  initializePayload: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" } },
  getClient: Effect.die("unused"),
});
const unused = (name: string) => () => Effect.die(name + " is unused in parity scenarios");
const layerUnusedScheduledTaskStub = Layer.succeed(
  ScheduledTaskService.ScheduledTaskService,
  ScheduledTaskService.ScheduledTaskService.of({
    list: () => Effect.succeed({ tasks: [] }),
    subscribeList: () => Stream.succeed({ tasks: [] }),
    upsert: unused("upsert"), setEnabled: unused("setEnabled"), delete: unused("delete"),
    deleteForThread: unused("deleteForThread"), moveThreadTasks: unused("moveThreadTasks"),
    runNow: unused("runNow"), rotateWebhookToken: unused("rotateWebhookToken"),
    listWebhookDeliveries: unused("listWebhookDeliveries"), getWebhookDelivery: unused("getWebhookDelivery"),
    triggerWebhook: unused("triggerWebhook"),
  } as any),
);
const TERMINAL = new Set(["completed", "interrupted", "failed", "cancelled"]);

it.live("replays the parity MCP scenario", () => Effect.scoped(Effect.gen(function* () {
  const dir = process.env.GOAT2_PARITY_SCENARIO!;
  const out = process.env.GOAT2_PARITY_OUT!;
  const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
  const decls = Object.entries(scenario.threads) as Array<[string, any]>;
  const roots = decls.filter(([, t]) => t.parent === undefined).map(([alias]) => alias);
  if (roots.length !== 1) throw new Error("MCP runner needs exactly one root thread, got " + roots.join(","));
  const root = roots[0]!;
  const streams = Object.keys(scenario.streams);
  if (streams.length !== 1 || scenario.streams[streams[0]!].engine !== "codex") throw new Error("MCP runner needs one codex stream");
  const stream = scenario.streams[streams[0]!];
  const cwd = yield* checkpointWorkspace("delegated-task-status");
  // Same reading path as v1's test (:111-127, :170-172).
  const raw = yield* decodeProviderReplayNdjson(readFileSync(join(dir, stream.transcript), "utf8"));
  const transcript: any = yield* CodexOrchestratorReplayHarness.decodeTranscript(materializeReplayTranscriptWorkspace(raw as any, cwd) as any);
  const marked = { ...transcript, entries: transcript.entries.map((entry) => ({ ...entry, parityOriginal: true })) };
  // Thread names the shared harness adds: the root title, then each delegated task's prompt.
  const titles = [rootTitle, ...scenario.steps.filter((s: any) => s.do === "mcp" && s.path === "task.create").map((s: any) => String(s.args.task))];
  const augmented = withThreadSetupReads(withThreadNames(marked, titles));
  const drivers: Array<{ driver: any; observed: Array<{ readonly cursor: number; readonly label: string | undefined; readonly frame: any }> }> = [];
  // Same construction as CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer
  // (CodexAdapterV2.testkit.ts:297-319), keeping each driver for the stream report.
  const makeRegistryLayer = () => Layer.unwrap(Effect.gen(function* () {
    const record = { driver: undefined as any, observed: [] as Array<{ readonly cursor: number; readonly label: string | undefined; readonly frame: any }> };
    record.driver = yield* CodexReplay.makeReplayDriver(augmented, {
      beforeEmitInbound: (entry) => Effect.flatMap(Ref.get(record.driver.state), (s: any) => Effect.sync(() => { record.observed.push({ cursor: s.cursor, label: entry.label, frame: entry.frame }); })),
    });
    drivers.push(record);
    return CodexAdapterV2Testkit.layer({ transcript, driver: record.driver });
  }));
  const harness = { ...CodexOrchestratorReplayHarness, makeProviderAdapterRegistryLayer: makeRegistryLayer };
  const layerOrchestrator = ProviderReplayHarness.layerProviderReplay(
    { name: scenario.name + "/codex", transcript, commands: [], runtimePolicyOverride: { cwd } }, harness as any);
  const layerOrchestration = Layer.merge(
    layerOrchestrator,
    ThreadManagementService.layer.pipe(
      Layer.provide(layerOrchestrator),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    ),
  );
  const layerTest = layerOrchestratorToolkit.pipe(
    Layer.provide(ThreadResultService.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
    Layer.provide(
      Layer.mock(LaunchWatchService.LaunchWatchService)({ find: () => Effect.succeed(null), rearm: () => Effect.void })
        .pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
    ),
    Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(layerOrchestration),
    Layer.provide((makeRegistryLayer() as any).pipe(Layer.provide(McpProviderSessions.layer))),
    Layer.provide(ProviderRegistryMock.layer([makeProviderSnapshot({ instanceId: codexInstanceId, driver: ProviderDriverKind.make("codex"), model: codexModel })])),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerUnusedScheduledTaskStub),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(SecretRequests.layer.pipe(Layer.provide(ServerSettings.layerTest()), Layer.provide(layerMemorySecretStore), Layer.provide(layerOrchestration))),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

  const threadIds = new Map<string, ThreadId>();
  const messageInputs = new Map<string, string>();
  const callMessages = new Map<string, string>();
  const callRuns = new Map<string, string>();
  const callResults = new Map<string, any>();
  const toolResults: Array<{ watermark: number; event: any }> = [];
  let events: any[] = [];

  const run = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const server = yield* McpServer.McpServer;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const watermark = Effect.gen(function* () {
      let max = 0;
      for (const id of threadIds.values()) max = Math.max(max, yield* orchestrator.getThreadEventSequence(id));
      return max;
    });
    // Child threads bind to the declared children of their parent in creation order.
    const bindChildren = Effect.gen(function* () {
      for (const [parentAlias, parentId] of [...threadIds]) {
        const projection = yield* orchestrator.getThreadProjection(parentId);
        for (const task of projection.subagents) {
          if (task.childThreadId === null || [...threadIds.values()].includes(task.childThreadId)) continue;
          const next = decls.find(([alias, t]) => t.parent === parentAlias && !threadIds.has(alias));
          if (next === undefined) throw new Error("undeclared child thread " + task.childThreadId + " of " + parentAlias);
          threadIds.set(next[0], task.childThreadId);
        }
      }
    });
    const threadOf = (alias: string) => Effect.gen(function* () {
      if (!threadIds.has(alias)) yield* bindChildren;
      const id = threadIds.get(alias);
      if (id === undefined) throw new Error("thread " + alias + " has not been created");
      return id;
    });
    const resolve = (value: any): Effect.Effect<any, any, any> => Effect.gen(function* () {
      if (typeof value === "string" && value.startsWith("$thread:")) return yield* threadOf(value.slice(8));
      if (typeof value === "string" && value.startsWith("$result:")) {
        const [call, field] = value.slice(8).split(".");
        const result = callResults.get(call!);
        if (result === undefined || result[field!] === undefined) throw new Error("no result field " + value);
        return result[field!];
      }
      if (Array.isArray(value)) { const outArr: any[] = []; for (const v of value) outArr.push(yield* resolve(v)); return outArr; }
      if (value !== null && typeof value === "object") { const o: any = {}; for (const [k, v] of Object.entries(value)) o[k] = yield* resolve(v); return o; }
      return value;
    });
    // Waits read only the thread's stored-event stream, like v1's test
    // (OrchestratorMcpToolkit.integration.test.ts:263-283). Reading the projection while a turn
    // starts changes what the turn-start input sees (the first turn then skips thread/name/set).
    // A run counts as running once its own provider turn runs (provider-turn.updated, linked through
    // its run attempt), as v1's test waits (:263-283); GOAT marks the run running earlier, before
    // the engine turn exists, and the recording orders later calls after the engine turn.
    const waitFor = (what: string, threadId: ThreadId, done: (runs: ReadonlyArray<{ id: string; status: string; engineRunning: boolean }>) => boolean) => Effect.gen(function* () {
      const started: Array<{ id: string; status: string }> = [];
      const status = new Map<string, string>();
      const attemptRun = new Map<string, string>();
      const engineRunning = new Set<string>();
      const seen = yield* orchestrator.streamStoredEventsFrom({ threadId, afterSequence: 0 }).pipe(
        Stream.map((stored: any) => {
          const e = stored.event;
          if (e.type === "run.created" || e.type === "run.updated") {
            status.set(e.payload.id, e.payload.status);
            if (e.payload.startedAt !== null && e.payload.startedAt !== undefined && !started.some((r) => r.id === e.payload.id)) started.push({ id: e.payload.id, status: e.payload.status });
          }
          if (e.type === "run-attempt.created" || e.type === "run-attempt.updated") attemptRun.set(e.payload.id, e.payload.runId);
          if (e.type === "provider-turn.updated" && e.payload.status === "running" && e.payload.runAttemptId) {
            const runId = attemptRun.get(e.payload.runAttemptId);
            if (runId !== undefined) engineRunning.add(runId);
          }
          return done(started.map((r) => ({ id: r.id, status: status.get(r.id)!, engineRunning: engineRunning.has(r.id) })));
        }),
        Stream.filter((ok) => ok),
        Stream.runHead,
        Effect.timeout("120 seconds"),
      );
      if (seen === undefined || (seen as any)._tag === "None") throw new Error("timed out waiting for " + what);
    });
    const startedRuns = (projection: any) => projection.runs.filter((r: any) => r.startedAt !== null).sort((a: any, b: any) => a.ordinal - b.ordinal);
    const pending = new Map<string, any>();
    const invoke = (step: any) => Effect.gen(function* () {
      const args = yield* resolve(step.args);
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-replay"),
        requestNamespace: "mcp-provider-session-replay-" + step.caller,
        thread: { threadId: yield* threadOf(step.caller), providerSessionId: "mcp-provider-session-replay-" + step.caller, providerInstanceId: codexInstanceId },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      } as any;
      const result: any = yield* server.callTool({ name: "goat_" + step.path.replaceAll(".", "_"), arguments: args }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client));
      const ok = result.isError !== true;
      let code: string | undefined;
      if (!ok) {
        const text = result.content?.find((c: any) => c.type === "text")?.text;
        try { const parsed = JSON.parse(text); code = parsed.reason ?? parsed.code ?? parsed._tag; } catch { code = "unparsed_error"; }
      } else {
        callResults.set(step.call, result.structuredContent);
        if (step.path === "thread.send" && result.structuredContent?.messageId) callMessages.set(result.structuredContent.messageId, step.call);
        if (step.path === "task.create" && result.structuredContent?.childRunId) callRuns.set(result.structuredContent.childRunId, step.call);
      }
      yield* bindChildren;
      toolResults.push({ watermark: yield* watermark, event: { kind: "tool.result", thread: step.caller, call: step.call, path: step.path, status: ok ? "ok" : "error", ...(code === undefined ? {} : { code }) } });
    });

    if (process.env.GOAT2_PARITY_PROLOGUE === "1") {
      yield* orchestrator.dispatch({ type: "thread.create", createdBy: "user", creationSource: "web", commandId: CommandId.make("command:mcp-replay-parent:create"), threadId: rootThreadId, projectId, title: rootTitle, modelSelection: codexSelection, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: cwd } as any);
      threadIds.set(root, rootThreadId);
      yield* orchestrator.dispatch({ type: "message.dispatch", createdBy: "user", creationSource: "web", commandId: CommandId.make("command:mcp-replay-parent:start"), threadId: rootThreadId, messageId: MessageId.make("message:mcp-replay-parent:start"), text: scenario.steps[0].text, attachments: [], modelSelection: codexSelection, dispatchMode: { type: "start_immediately" } } as any);
      yield* orchestrator.streamStoredEventsFrom({ threadId: rootThreadId, afterSequence: 0 }).pipe(Stream.filter((s: any) => s.event.type === "provider-turn.updated" && s.event.payload.status === "running"), Stream.runHead, Effect.timeout("30 seconds"));
      return;
    }
    for (const step of scenario.steps) {
      if (step.do === "send") {
        if (step.thread !== root || !["start", "queue"].includes(step.mode)) throw new Error("MCP runner: unsupported send " + step.id);
        if (!threadIds.has(root)) {
          yield* orchestrator.dispatch({ type: "thread.create", createdBy: "user", creationSource: "web", commandId: CommandId.make("command:mcp-replay-parent:create"), threadId: rootThreadId, projectId, title: rootTitle, modelSelection: codexSelection, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: cwd } as any);
          threadIds.set(root, rootThreadId);
        }
        const first = messageInputs.size === 0;
        const messageId = MessageId.make(first ? "message:mcp-replay-parent:start" : "message:parity:" + step.input);
        messageInputs.set(messageId, step.input);
        yield* orchestrator.dispatch({ type: "message.dispatch", createdBy: "user", creationSource: "web", commandId: CommandId.make(first ? "command:mcp-replay-parent:start" : "command:parity:" + step.id), threadId: rootThreadId, messageId, text: step.text, attachments: [], modelSelection: codexSelection, dispatchMode: { type: step.mode === "start" ? "start_immediately" : "queue_after_active" } } as any);
      } else if (step.do === "await" && step.until === "run_status") {
        const threadId = yield* threadOf(step.thread);
        const index = Number(String(step.run).replace(/^r/, "")) - 1;
        yield* waitFor(step.id, threadId, (runs) => runs[index]?.status === step.status && (step.status !== "running" || runs[index]!.engineRunning));
      } else if (step.do === "await" && step.until === "idle") {
        const threadId = yield* threadOf(step.thread);
        yield* waitFor(step.id, threadId, (runs) => runs.length > 0 && runs.every((r) => TERMINAL.has(r.status)));
      } else if (step.do === "mcp") {
        if (step.wait) yield* invoke(step);
        else pending.set(step.call, yield* Effect.forkScoped(invoke(step)));
      } else if (step.do === "await_call") {
        const fiber = pending.get(step.call);
        if (fiber === undefined) throw new Error("unknown call " + step.call);
        yield* fiber.await.pipe(Effect.timeout(step.timeoutMs + " millis" as any), Effect.flatMap((exit: any) => exit === undefined ? Effect.die(new Error("call " + step.call + " timed out")) : exit));
      } else throw new Error("MCP runner: unsupported step " + JSON.stringify(step));
    }
    yield* worker.drain();
    yield* bindChildren;
    const all = new Map<number, any>();
    for (const id of threadIds.values()) {
      const last = yield* orchestrator.getThreadEventSequence(id);
      if (last <= 0) continue;
      const collected = yield* orchestrator.streamStoredEventsFrom({ threadId: id, afterSequence: 0 }).pipe(Stream.takeUntil((s: any) => s.sequence >= last), Stream.runCollect);
      for (const s of collected) all.set(s.sequence, s);
    }
    events = [...all.values()];
  }).pipe(Effect.provide(layerTest as any));

  const exit = yield* Effect.exit(run);
  const states = [];
  for (const d of drivers) states.push({ d, state: yield* Ref.get(d.driver.state) });
  const advanced = states.filter((s) => s.state.cursor > 0 || s.state.failure !== null);
  if (advanced.length > 1) throw new Error("more than one replay driver advanced");
  const used = advanced[0] ?? states[0];
  if (used === undefined) throw new Error("no replay driver was built");
  const driver = used.d.driver;
  const state = used.state;
  const replayObserved = used.d.observed;
  const aliasOf = new Map([...threadIds].map(([alias, id]) => [id as string, alias]));
  const trace = traceFromV1Mcp({ scenario, stored: events, augmented: driver.transcript, state, threadAliases: aliasOf, messageInputs, callMessages, callRuns, toolResults, replayObserved, failure: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : undefined });
  const tmp = out + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(trace, null, 2) + "\n");
  renameSync(tmp, out);
}).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))), 300_000);
