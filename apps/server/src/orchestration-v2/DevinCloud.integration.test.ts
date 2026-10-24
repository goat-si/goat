import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type Project,
} from "@goat/contracts";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import type * as Adapter from "@goat/provider-core/server/ProviderAdapter";
import * as Catalog from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import { makeAdapter } from "../../../../packages/provider-devin-cloud/src/server/adapter.ts";
import * as Cli from "../../../../packages/provider-devin-cloud/src/server/cli.ts";
import * as Relay from "../../../../packages/provider-devin-cloud/src/server/relay.ts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CloudSource from "./CloudTaskSourceService.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const INSTANCE = ProviderInstanceId.make("codex");
const SIBLING = ProviderInstanceId.make("devin-local");
const NATIVE_ID = "devin-integration-session";
const SOURCE = {
  repository: "https://github.com/example/project",
  branch: "main",
  sha: "a".repeat(40),
};
const decodeRpc = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);
const repos = (value: string, offered = "example/project") => [
  {
    id: "repos",
    name: "Repositories",
    type: "select",
    currentValue: value,
    options: [{ name: "Project", value: offered }],
  },
];
const metadata = (title: string) => ({
  "cognition.ai/session": {
    "cognition.ai/url": "https://app.devin.ai/sessions/integration-session",
    "cognition.ai/statusEnum": "blocked",
    "cognition.ai/currentActivity": title,
  },
});

/** The fake is the external CLI process; ACP encoding, relay and adapter remain real. */
const makePeer = Effect.fnUntraced(function* (initiallyOffered = "example/project") {
  // The Devin organization's repository list; a test can grant access mid-thread.
  let offered = initiallyOffered;
  let selected = offered === "example/project" ? "example/project" : "";
  const output = yield* Queue.unbounded<Uint8Array>();
  const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const prompted = yield* Deferred.make<void>();
  const loaded = yield* Deferred.make<void>();
  const methods: string[] = [];
  let promptId: string | number | undefined;
  let buffered = "";
  const send = (value: unknown) =>
    Queue.offer(output, new TextEncoder().encode(`${JSON.stringify(value)}\n`)).pipe(Effect.asVoid);
  const notify = (title: string) =>
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: NATIVE_ID,
        update: { sessionUpdate: "session_info_update", title, _meta: metadata(title) },
      },
    });
  const stdin = Sink.forEach((bytes: Uint8Array) =>
    Effect.gen(function* () {
      buffered += new TextDecoder().decode(bytes);
      const lines = buffered.split("\n");
      buffered = lines.pop()!;
      for (const line of lines.filter(Boolean)) {
        const rpc = decodeRpc(line);
        if (!rpc.method) continue;
        methods.push(rpc.method);
        const reply = (result: unknown) => send({ jsonrpc: "2.0", id: rpc.id, result });
        if (rpc.method === "initialize") {
          assert.deepEqual(rpc.params?.clientCapabilities, {});
          yield* reply({
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
            agentInfo: { name: "fixture", version: "1" },
          });
        } else if (rpc.method === "session/new") {
          assert.deepEqual(rpc.params?.mcpServers, []);
          yield* notify("Early session title");
          yield* reply({ sessionId: NATIVE_ID, configOptions: repos("", offered) });
        } else if (rpc.method === "session/set_config_option") {
          assert.equal(rpc.params?.value, "example/project");
          selected = "example/project";
          yield* reply({ configOptions: repos(selected, offered) });
        } else if (rpc.method === "session/prompt") {
          assert.equal(rpc.params?.sessionId, NATIVE_ID);
          promptId = rpc.id;
          yield* Deferred.succeed(prompted, undefined);
        } else if (rpc.method === "session/load") {
          assert.equal(rpc.params?.sessionId, NATIVE_ID);
          yield* send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: NATIVE_ID,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: "Historical replay must not replace the saved summary",
                },
              },
            },
          });
          yield* reply({
            configOptions: repos(selected, offered),
            _meta: metadata("Loaded session"),
          });
          yield* Deferred.succeed(loaded, undefined);
        }
      }
    }),
  );
  const handle = (
    stdout: Stream.Stream<Uint8Array>,
    input: ChildProcessSpawner.ChildProcessHandle["stdin"] = Sink.drain,
    code: Effect.Effect<ChildProcessSpawner.ExitCode> = Effect.succeed(
      ChildProcessSpawner.ExitCode(0),
    ),
  ) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(42),
      exitCode: code,
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      stdin: input,
      stdout,
      stderr: Stream.empty,
      all: stdout,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert.equal(command._tag, "StandardCommand");
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
      assert.equal(command.command, "/fixture/devin");
      assert.equal(command.options.shell, false);
      if (command.args[0] === "--version")
        return handle(Stream.make(new TextEncoder().encode("devin 3000.11.3 (fixture)\n")));
      if (command.args[0] === "auth")
        return handle(Stream.make(new TextEncoder().encode("Logged in (via Devin).\n")));
      if (command.args[1] === "--help")
        return handle(Stream.make(new TextEncoder().encode("--cloud\n")));
      assert.deepEqual(command.args, ["acp", "--cloud"]);
      return handle(Stream.fromQueue(output), stdin, Deferred.await(exit));
    }),
  );
  return {
    spawner,
    methods,
    prompted,
    loaded,
    notify,
    grant: () =>
      Effect.sync(() => {
        offered = "example/project";
      }),
    finish: () =>
      Effect.gen(function* () {
        assert.isDefined(promptId);
        yield* send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: NATIVE_ID,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Verified source. https://github.com/example/project/pull/12",
              },
            },
          },
        });
        yield* send({
          jsonrpc: "2.0",
          id: promptId,
          result: { stopReason: "end_turn", _meta: metadata("Response complete") },
        });
      }),
  };
});

const makeFixture = Effect.fnUntraced(function* (name: string, offered?: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-devin-relay-" });
  const peer = yield* makePeer(offered);
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
  const configured = {
    ...settings,
    providerInstances: {
      ...settings.providerInstances,
      [SIBLING]: {
        driver: ProviderDriverKind.make("acpRegistry"),
        enabled: true,
        config: { source: "local", commandPath: "/fixture/devin" },
      },
    },
  };
  const host = Layer.mock(ProviderHost.ProviderHost)({
    settings: {
      get: Effect.succeed(configured),
      withSnapshot: (use) => use(configured),
      changes: Stream.never,
      subscribe: Effect.succeed(Stream.never),
    },
    paths: {
      cwd,
      baseDir: "/fixture/home",
      stateDir: "/fixture/state",
      providerStatusCacheDir: "/fixture/cache",
      attachmentsDir: "/fixture/attachments",
    },
    resolveAttachmentPath: () => null,
  });
  const catalog = Layer.mock(Catalog.AcpRegistryCatalog)({
    inspect: () =>
      Effect.succeed({
        status: "ready",
        agentId: "devin",
        version: "3000.11.3",
        distribution: "local",
      }),
    resolve: (_settings, cwd, env) =>
      Effect.succeed({
        distribution: "local",
        spawn: {
          command: "/fixture/devin",
          args: ["acp", "--local-only"],
          cwd,
          ...(env ? { env } : {}),
        },
      }),
  });
  const dependencies = Layer.merge(Cli.layer, Relay.layer).pipe(
    Layer.provide(host),
    Layer.provide(catalog),
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, peer.spawner)),
  );
  const original = yield* makeAdapter(INSTANCE, SIBLING).pipe(Effect.provide(dependencies));
  const cli = yield* Cli.DevinCloudCli.pipe(Effect.provide(dependencies));
  const launch = yield* cli.resolve(SIBLING, cwd);
  const metadataCommitted = yield* Deferred.make<void>();
  const callbackCount = yield* Ref.make(0);
  const instrument = <
    T extends Pick<Adapter.ProviderAdapterV2TurnInput, "commitCloudTaskMetadata">,
  >(
    turn: T,
  ) => ({
    ...turn,
    commitCloudTaskMetadata: (id: string, patch: Adapter.ProviderAdapterV2CloudTaskMetadata) =>
      turn.commitCloudTaskMetadata!(id, patch).pipe(
        Effect.andThen(Ref.update(callbackCount, (count) => count + 1)),
        Effect.andThen(Deferred.succeed(metadataCommitted, undefined)),
      ),
  });
  const adapter: Adapter.ProviderAdapterV2["Service"] = {
    ...original,
    openSession: (input) =>
      original.openSession(input).pipe(
        Effect.map((session) => ({
          ...session,
          startTurn: (turn) => session.startTurn(instrument(turn)),
          ...(session.resumeTurn
            ? {
                resumeTurn: (turn: Parameters<NonNullable<typeof session.resumeTurn>>[0]) =>
                  Effect.gen(function* () {
                    assert.equal(
                      turn.providerThread.driver,
                      original.driver,
                      "restored thread driver",
                    );
                    assert.equal(
                      turn.providerThread.providerInstanceId,
                      INSTANCE,
                      "restored provider instance",
                    );
                    assert.equal(
                      turn.providerThread.nativeThreadRef?.driver,
                      original.driver,
                      "restored native driver",
                    );
                    assert.equal(
                      turn.providerThread.nativeThreadRef?.fingerprint,
                      launch.binding,
                      "restored sibling binding",
                    );
                    assert.equal(
                      turn.providerThread.cloudTask?.taskId,
                      NATIVE_ID,
                      "restored task identity",
                    );
                    yield* session.resumeTurn!(instrument(turn));
                  }),
              }
            : {}),
        })),
      ),
  };
  const projectId = ProjectId.make("project:devin-integration");
  const projects = Layer.mock(Projects.ProjectService)({
    getById: () =>
      Effect.succeed(
        Option.some({
          id: projectId,
          workspaceRoot: cwd,
          defaultModelSelection: { instanceId: INSTANCE, model: "default" },
        } as Project),
      ),
  });
  const runtime = layerWithRegistry(
    { name, runtimePolicyOverride: { cwd } },
    Registry.layerFromAdapters([adapter]),
    {
      runEffectWorker: false,
      projects,
      cloudSources: Layer.succeed(CloudSource.CloudTaskSourceService, {
        resolve: () =>
          Effect.succeed({
            source: SOURCE,
            launchSource: { cwd, restriction: "published-ref" },
            localChangesExcluded: true,
          }),
      }),
    },
  );
  return {
    peer,
    runtime,
    callbackCount,
    metadataCommitted,
    projectId,
    binding: launch.binding,
    adapter,
  };
});

it.effect("persists real Devin relay results and late metadata through manager and SQLite", () =>
  Effect.gen(function* () {
    const { peer, runtime, callbackCount, metadataCommitted, projectId } =
      yield* makeFixture("devin-relay-ingress");
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("thread:devin-integration");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:devin-create"),
        threadId,
        projectId,
        title: "Devin integration",
        modelSelection: { instanceId: INSTANCE, model: "default" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:devin-start"),
        threadId,
        messageId: MessageId.make("message:devin-start"),
        text: "Read the published source",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      yield* worker.drain();
      assert.notEqual(
        (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
        "failed",
      );
      yield* Deferred.await(peer.prompted);
      const accepted = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(accepted.providerThreads[0]?.nativeThreadRef?.ordinal, 0);
      assert.deepEqual(accepted.providerThreads[0]?.cloudTask?.source, SOURCE);
      assert.isTrue(accepted.providerThreads[0]?.cloudTask?.localChangesExcluded);
      const completed = yield* orchestrator
        .streamStoredEventsFrom({ threadId, eventType: "run.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" && stored.event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild,
        );
      yield* peer.finish();
      yield* Fiber.join(completed);
      yield* worker.drain();
      const settled = yield* orchestrator.getThreadProjection(threadId);
      const run = settled.runs[0]!;
      const providerThread = settled.providerThreads[0]!;
      const result = settled.messages.filter(
        (message) => message.id === `message:cloud-result:${run.id}`,
      );
      assert.equal(result.length, 1);
      assert.include(result[0]!.text, "Verified source.");
      assert.include(result[0]!.text, "https://github.com/example/project/pull/12");
      const resultItems = settled.turnItems.filter(
        (item) => item.runId === run.id && item.type === "assistant_message",
      );
      assert.equal(resultItems.length, 1);
      assert.equal(resultItems[0]!.id, `turn-item:cloud-result:${run.id}`);
      assert.deepEqual(
        resultItems.map((item) => (item.type === "assistant_message" ? item.text : null)),
        [result[0]!.text],
      );
      assert.equal(providerThread.nativeThreadRef?.ordinal, 1);
      assert.equal(providerThread.cloudTask?.status, "succeeded");
      assert.equal(providerThread.cloudTask?.prUrl, "https://github.com/example/project/pull/12");
      const late = yield* orchestrator
        .streamStoredEventsFrom({ threadId, eventType: "provider-thread.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-thread.updated" &&
              stored.event.payload.cloudTask?.title === "Late metadata",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild,
        );
      yield* peer.notify("Late metadata");
      yield* Fiber.join(late);
      yield* Deferred.await(metadataCommitted);
      const refreshed = yield* orchestrator.getThreadProjection(threadId);
      const task = refreshed.providerThreads[0]!.cloudTask!;
      assert.equal(task.title, "Late metadata");
      assert.deepEqual(task.source, providerThread.cloudTask!.source);
      assert.equal(task.status, providerThread.cloudTask!.status);
      assert.equal(task.summary, providerThread.cloudTask!.summary);
      assert.equal(task.taskId, providerThread.cloudTask!.taskId);
      assert.equal(task.prUrl, providerThread.cloudTask!.prUrl);
      assert.equal(refreshed.runs[0]!.status, "completed");
      assert.deepEqual(
        refreshed.messages.filter((message) => message.id === result[0]!.id),
        result,
      );
      assert.deepEqual(
        refreshed.turnItems.filter((item) => item.id === resultItems[0]!.id),
        resultItems,
      );
      assert.equal(peer.methods.filter((method) => method === "session/new").length, 1);
      assert.equal(peer.methods.filter((method) => method === "session/prompt").length, 1);
      assert.equal(peer.methods.filter((method) => method === "session/cancel").length, 0);
      assert.isAtLeast(yield* Ref.get(callbackCount), 1);
    }).pipe(Effect.provide(runtime));
  }).pipe(Effect.provide(Layer.merge(ServerSettings.layerTest(), NodeServices.layer))),
);

it.effect(
  "a repository Devin does not offer fails each run with its reason, and the thread works once access is granted",
  () =>
    Effect.gen(function* () {
      const { peer, runtime, projectId } = yield* makeFixture(
        "devin-relay-unoffered-repository",
        "other/project",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:devin-unoffered");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command:devin-unoffered-create"),
          threadId,
          projectId,
          title: "Devin unoffered repository",
          modelSelection: { instanceId: INSTANCE, model: "default" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const send = Effect.fnUntraced(function* (ordinal: number, status: "failed" | "completed") {
          const settled = yield* orchestrator
            .streamStoredEventsFrom({ threadId, eventType: "run.updated" })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.ordinal === ordinal &&
                  stored.event.payload.status === status,
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkChild,
            );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`command:devin-unoffered-${ordinal}`),
            threadId,
            messageId: MessageId.make(`message:devin-unoffered-${ordinal}`),
            text: "Read the published source",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
          yield* worker.drain();
          return settled;
        });
        const expectRefused = Effect.fnUntraced(function* (ordinal: number) {
          yield* Fiber.join(yield* send(ordinal, "failed"));
          yield* worker.drain();
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.find((candidate) => candidate.ordinal === ordinal)!;
          const task = projection.providerThreads[0]!.cloudTask!;
          // Nothing reached Devin, so the task is definitely failed: no "remote work may continue".
          assert.equal(run.status, "failed");
          assert.equal(task.status, "failed");
          assert.equal(task.taskId, NATIVE_ID);
          assert.include(task.error, "not offered by this Devin organization");
          const result = projection.messages.find(
            (message) => message.id === `message:cloud-result:${run.id}`,
          );
          assert.include(result?.text, "not offered by this Devin organization");
          assert.include(result?.text, "before any prompt was sent");
          assert.notInclude(result?.text, "Cloud task unknown");
        });
        yield* expectRefused(1);
        // A second message before access is granted is refused the same way, never "unknown".
        yield* expectRefused(2);
        assert.equal(peer.methods.filter((method) => method === "session/prompt").length, 0);
        yield* peer.grant();
        const completed = yield* send(3, "completed");
        yield* Deferred.await(peer.prompted);
        yield* peer.finish();
        yield* Fiber.join(completed);
        yield* worker.drain();
        const settled = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(settled.providerThreads[0]!.cloudTask?.status, "succeeded");
        assert.equal(settled.providerThreads[0]!.nativeThreadRef?.ordinal, 1);
        assert.equal(peer.methods.filter((method) => method === "session/new").length, 1);
        assert.equal(peer.methods.filter((method) => method === "session/prompt").length, 1);
      }).pipe(Effect.provide(runtime));
    }).pipe(Effect.provide(Layer.merge(ServerSettings.layerTest(), NodeServices.layer))),
);

it.effect(
  "reattaches the exact Devin session without importing replay or resubmitting and persists late unknown metadata",
  () =>
    Effect.gen(function* () {
      const { peer, runtime, metadataCommitted, projectId, binding, adapter } =
        yield* makeFixture("devin-relay-recovery");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:devin-recovery");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command:devin-recovery-create"),
          threadId,
          projectId,
          title: "Saved Devin task",
          modelSelection: { instanceId: INSTANCE, model: "default" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:devin-recovery-message"),
          threadId,
          messageId: MessageId.make("message:devin-recovery"),
          text: "Original prompt",
          attachments: [],
          dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
          createdBy: "user",
          creationSource: "web",
        });
        const initial = yield* orchestrator.getThreadProjection(threadId);
        const run = initial.runs[0]!;
        const attempt = initial.attempts[0]!;
        const root = initial.nodes.find((node) => node.id === run.rootNodeId)!;
        const providerThread = initial.providerThreads[0]!;
        const now = yield* DateTime.now;
        const savedSummary = "Saved progress before relay loss";
        const task = {
          taskId: NATIVE_ID,
          status: "running" as const,
          tracking: "live" as const,
          url: "https://app.devin.ai/sessions/integration-session",
          source: SOURCE,
          summary: savedSummary,
          localChangesExcluded: true,
          updatedAt: DateTime.formatIso(now),
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:devin-recovery-run"),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...run, status: "running", startedAt: now },
            },
            {
              id: EventId.make("event:devin-recovery-attempt"),
              type: "run-attempt.updated",
              threadId,
              occurredAt: now,
              payload: { ...attempt, status: "running", startedAt: now },
            },
            {
              id: EventId.make("event:devin-recovery-root"),
              type: "node.updated",
              threadId,
              occurredAt: now,
              payload: { ...root, status: "running", startedAt: now },
            },
            {
              id: EventId.make("event:devin-recovery-task"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...providerThread,
                driver: adapter.driver,
                cloudTask: task,
                nativeThreadRef: {
                  driver: adapter.driver,
                  nativeId: NATIVE_ID,
                  strength: "strong",
                  fingerprint: binding,
                  ordinal: 1,
                },
              },
            },
          ],
        });
        const terminal = yield* orchestrator
          .streamStoredEventsFrom({ threadId, eventType: "run.updated" })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" && stored.event.payload.status === "failed",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkChild,
          );
        yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
          threadId,
          runId: run.id,
          reattach: true,
        });
        yield* Deferred.await(peer.loaded);
        yield* Fiber.join(terminal);
        yield* worker.drain();
        const settled = yield* orchestrator.getThreadProjection(threadId);
        const saved = settled.providerThreads[0]!.cloudTask!;
        assert.equal(saved.status, "unknown");
        assert.equal(saved.summary, savedSummary);
        assert.deepEqual(saved.source, SOURCE);
        assert.equal(saved.taskId, NATIVE_ID);
        assert.isString(saved.error);
        assert.isFalse(
          settled.messages.some((message) => message.text.includes("Historical replay")),
        );
        const result = settled.messages.filter(
          (message) => message.id === `message:cloud-result:${run.id}`,
        );
        assert.equal(result.length, 1);
        assert.include(result[0]!.text, savedSummary);
        const resultItems = settled.turnItems.filter(
          (item) => item.runId === run.id && item.type === "assistant_message",
        );
        assert.equal(resultItems.length, 1);
        assert.equal(resultItems[0]!.id, `turn-item:cloud-result:${run.id}`);
        assert.deepEqual(
          resultItems.map((item) => (item.type === "assistant_message" ? item.text : null)),
          [result[0]!.text],
        );
        assert.isFalse(
          settled.turnItems.some(
            (item) => item.type === "assistant_message" && item.text.includes("Historical replay"),
          ),
        );
        const late = yield* orchestrator
          .streamStoredEventsFrom({ threadId, eventType: "provider-thread.updated" })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-thread.updated" &&
                stored.event.payload.cloudTask?.title === "Late recovered metadata",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkChild,
          );
        yield* peer.notify("Late recovered metadata");
        yield* Fiber.join(late);
        yield* Deferred.await(metadataCommitted);
        const refreshed = yield* orchestrator.getThreadProjection(threadId);
        const current = refreshed.providerThreads[0]!.cloudTask!;
        assert.equal(current.title, "Late recovered metadata");
        assert.equal(current.status, "unknown");
        assert.equal(current.summary, savedSummary);
        assert.equal(current.error, saved.error);
        assert.deepEqual(current.source, SOURCE);
        assert.deepEqual(
          refreshed.messages.filter((message) => message.id === result[0]!.id),
          result,
        );
        assert.deepEqual(
          refreshed.turnItems.filter((item) => item.id === resultItems[0]!.id),
          resultItems,
        );
        assert.equal(peer.methods.filter((method) => method === "session/load").length, 1);
        for (const method of [
          "session/new",
          "session/prompt",
          "session/set_config_option",
          "session/cancel",
        ]) {
          assert.equal(peer.methods.filter((seen) => seen === method).length, 0);
        }
      }).pipe(Effect.provide(runtime));
    }).pipe(Effect.provide(Layer.merge(ServerSettings.layerTest(), NodeServices.layer))),
);
