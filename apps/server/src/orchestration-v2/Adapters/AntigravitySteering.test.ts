import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import * as FileSystem from "effect/FileSystem";
import * as EffectAcpErrors from "effect-acp/errors";
import type { AcpAdapterV2RuntimeInput as AntigravityAdapterV2RuntimeInput } from "@goat/provider-acp/server/adapter";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import type * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import { normalizeAntigravitySessionUpdate } from "../../provider/acp/AntigravityProtocol.ts";
import {
  makeAntigravityAdapterV2,
  makeAntigravityAcpAdapterFlavor,
  type AntigravityAdapterV2Options,
} from "./AntigravityAdapterV2.ts";
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const openSessionWithRunningCommand = Effect.fn("openSessionWithRunningCommand")(function* (
  commandInput: Record<string, unknown>,
  /** The prompt launches one agy 1.5 subagent instead; its records live below this profile. */
  detachedChildProfile?: string,
  options?: {
    readonly profileDirectory?: string;
    readonly holdsFirstPrompt?: boolean;
    readonly initialToolCalls?: ReadonlyArray<EffectAcpSchema.SessionUpdate>;
  },
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const crypto = yield* SecureRandom.SecureRandom;
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
  let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
  let requestPermission: Parameters<RuntimeService["handleRequestPermission"]>[0] | undefined;
  const send = (update: EffectAcpSchema.SessionUpdate) =>
    sessionUpdate === undefined
      ? Effect.die("the adapter must handle session updates")
      : sessionUpdate(normalizeAntigravitySessionUpdate({ sessionId: "mock-session-1", update }));
  const command = {
    toolCallId: "call_fetch",
    kind: "execute",
    title: "node fetch_throughput.mjs",
    rawInput: { CommandLine: "node fetch_throughput.mjs", ...commandInput },
  } as const;
  let cancels = 0;
  const prompts: Array<ReadonlyArray<EffectAcpSchema.ContentBlock>> = [];
  const firstPrompt = yield* Deferred.make<void>();
  const steered = yield* Deferred.make<void>();
  const releaseSteer = yield* Deferred.make<void>();
  let terminate: AntigravityAdapterV2RuntimeInput["onTermination"] | undefined;
  const usage = { sessionUpdate: "usage_update", used: 9000, size: 1048576 } as const;
  const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
  const scheduledFinalizes = yield* Queue.unbounded<Duration.Input>();
  const instanceId = ProviderInstanceId.make("antigravity-wake-test");
  const threadId = ThreadId.make("thread-antigravity-wake");
  const selfInvocation = yield* resolveSelfInvocation();
  const profileDirectory = options?.profileDirectory ?? detachedChildProfile;
  const adapterOptions: AntigravityAdapterV2Options = {
    instanceId,
    selfInvocation,
    continuationRequests: { offer: (request) => Effect.sync(() => void offers.push(request)) },
    makeRuntime: (input) => {
      terminate = input.onTermination;
      return makeAntigravityAcpRuntime({
        ...input,
        childProcessSpawner,
        spawn: {
          command: process.execPath,
          args: [mockAgentPath],
          cwd: input.cwd,
          env: { GOAT_ACP_ANTIGRAVITY: "1", GOAT_ACP_AGENT_VERSION: "1.5.11" },
        },
      }).pipe(
        Effect.provideService(SecureRandom.SecureRandom, crypto),
        Effect.map((runtime): RuntimeService => ({
          ...runtime,
          cancel: Effect.sync(() => {
            cancels += 1;
          }),
          handleSessionUpdate: (handler) =>
            Effect.sync(() => {
              sessionUpdate = handler;
            }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
          handleRequestPermission: (handler) =>
            Effect.sync(() => {
              requestPermission = handler;
            }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
          prompt: (payload, promptOptions) =>
            Effect.gen(function* () {
              prompts.push(payload.prompt);
              if (promptOptions?.dispatched)
                yield* Deferred.succeed(promptOptions.dispatched, undefined);
              if (prompts.length > 1) {
                yield* Deferred.succeed(steered, undefined);
                yield* Deferred.await(releaseSteer);
                return { stopReason: "end_turn" as const };
              }
              yield* Deferred.succeed(firstPrompt, undefined);
              if (options?.initialToolCalls !== undefined) {
                for (const toolUpdate of options.initialToolCalls) yield* send(toolUpdate);
              } else {
                yield* send(
                  detachedChildProfile === undefined
                    ? { sessionUpdate: "tool_call", ...command, status: "in_progress" }
                    : {
                        sessionUpdate: "tool_call",
                        toolCallId: "call_research",
                        kind: "other",
                        title: "Run invoke_subagent",
                        status: "completed",
                        rawInput: { TypeName: "research", Role: "Researcher", Prompt: "Read it" },
                      },
                );
              }
              yield* send({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "I'll render once the fetch finishes." },
              });
              yield* send(usage);
              if (options?.holdsFirstPrompt !== false) yield* Deferred.await(steered);
              return { stopReason: "end_turn" as const };
            }),
        })),
      );
    },
    withProcess: (_stop, task) => task,
    defaultModel: Effect.undefined,
    ...(profileDirectory === undefined ? {} : { profileDirectory }),
  };
  const adapter =
    options === undefined
      ? yield* makeAntigravityAdapterV2(adapterOptions)
      : yield* makeAcpAdapterV2({
          instanceId,
          selfInvocation,
          flavor: makeAntigravityAcpAdapterFlavor({
            ...adapterOptions,
            random: crypto,
            fileSystem: yield* FileSystem.FileSystem,
            path,
            host: yield* ProviderHost.ProviderHost,
          }),
          ...(adapterOptions.continuationRequests === undefined
            ? {}
            : { continuationRequests: adapterOptions.continuationRequests }),
          testHooks: {
            onDeferredFinalizeScheduled: (debounce) =>
              Queue.offer(scheduledFinalizes, debounce).pipe(Effect.asVoid),
          },
        });
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: process.cwd(),
  });
  const modelSelection = { instanceId, model: "gemini-test-low" } as const;
  const session = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-antigravity-wake"),
    modelSelection,
    runtimePolicy,
  });
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* session.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const until = (done: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      while (true) {
        const event = yield* Queue.take(events);
        seen.push(event);
        if (done(event)) return seen;
      }
    });
  const providerThread = yield* session.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy,
  });
  const now = yield* DateTime.now;
  const startTurn = (ordinal: number, continuation: boolean) =>
    session.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-antigravity-wake"),
        title: "Antigravity wake",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`run-antigravity-wake-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`attempt-antigravity-wake-${ordinal}`),
      rootNodeId: NodeId.make(`node-antigravity-wake-${ordinal}`),
      providerThread,
      message: {
        ...(continuation
          ? { createdBy: "agent" as const, creationSource: "provider" as const }
          : { createdBy: "user" as const, creationSource: "web" as const }),
        messageId: MessageId.make(`message-antigravity-wake-${ordinal}`),
        text: "chart the throughput",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });

  return {
    session,
    providerThread,
    command,
    usage,
    offers,
    scheduledFinalizes,
    send,
    startTurn,
    until,
    throughTerminal: until((event) => event.type === "turn.terminal"),
    // The reply before end_turn closes when the prompt settles, held open or not.
    throughPromptSettled: until(
      (event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "assistant_message" &&
        event.turnItem.status === "completed",
    ),
    requestPermission: (...args: Parameters<NonNullable<typeof requestPermission>>) =>
      requestPermission === undefined
        ? Effect.die("the adapter must handle permission requests")
        : requestPermission(...args),
    cancels: () => cancels,
    prompts,
    firstPrompt,
    releaseSteer,
    runtimeDies: Effect.suspend(
      () =>
        terminate?.(
          new EffectAcpErrors.AcpTransportError({ detail: "agent exited", cause: "exit" }),
        ) ?? Effect.die("the adapter must watch its runtime"),
    ),
  };
});

describe("Antigravity steering", () => {
  it.effect(
    "steers a running prompt without cancelling the running command or ending the turn",
    () =>
      Effect.gen(function* () {
        const opened = yield* openSessionWithRunningCommand({});
        yield* opened.startTurn(1, false);
        const started = yield* opened.until(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === opened.command.toolCallId,
        );
        const providerTurnId = started.flatMap((event) =>
          event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
        )[0]!;
        assert.isTrue(opened.session.providerSession.capabilities.turns.supportsActiveSteering);
        yield* opened.session.steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId: RunId.make("run-antigravity-wake-1"),
          providerThread: opened.providerThread,
          providerTurnId,
          message: {
            messageId: MessageId.make("message-antigravity-steer"),
            text: "Use opus subagents",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        });
        assert.equal(opened.cancels(), 0);
        assert.lengthOf(opened.prompts, 2);
        yield* opened.send({
          sessionUpdate: "tool_call_update",
          ...opened.command,
          status: "completed",
          rawOutput: { output: "done", exit_code: 0 },
        });
        yield* Deferred.succeed(opened.releaseSteer, undefined);
        const run = [
          ...started,
          ...(yield* opened.until((event) => event.type === "turn.terminal")),
        ];
        assert.lengthOf(opened.prompts, 2);
        assert.deepEqual(opened.prompts[1], [{ type: "text", text: "Use opus subagents" }]);
        const terminal = run.at(-1);
        assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      }).pipe(Effect.provide(layerSession)),
  );
  it.effect("a steer carries the MCP app context the session has not seen yet", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand({});
      yield* opened.startTurn(1, false);
      const started = yield* opened.until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === opened.command.toolCallId,
      );
      const providerTurnId = started.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;
      yield* opened.session.steerTurn({
        threadId: ThreadId.make("thread-antigravity-wake"),
        runId: RunId.make("run-antigravity-wake-1"),
        providerThread: opened.providerThread,
        providerTurnId,
        message: {
          messageId: MessageId.make("message-antigravity-steer-app"),
          text: "What does the board show now?",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        appContext: [{ key: "mcp_app_board", text: "Column Done holds 3 cards" }],
      });
      assert.equal(opened.cancels(), 0);
      assert.lengthOf(opened.prompts, 2);
      const steerText = opened.prompts[1]!.flatMap((block) =>
        block.type === "text" ? [block.text] : [],
      );
      assert.isTrue(steerText.some((text) => text.includes("Column Done holds 3 cards")));
      assert.equal(steerText.at(-1), "What does the board show now?");
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("steers a run held open by a detached subagent without stopping it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-kids-" });
      const records = (conversationId: string, kind: string) =>
        path.join(profile, "antigravity-acp", "brain", conversationId, ".system_generated", kind);
      const write = (directory: string, name: string, value: unknown) =>
        fileSystem
          .makeDirectory(directory, { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.writeFileString(path.join(directory, name), JSON.stringify(value)),
            ),
          );
      yield* write(records("mock-session-1", "subagents"), "child-1.json", {});
      yield* write(records("child-1", "messages"), "launch.json", {
        sender: "mock-session-1",
        sourceMetadata: { tool: { toolCall: { id: "call_research", name: "invoke_subagent" } } },
      });
      const opened = yield* openSessionWithRunningCommand({}, profile, {
        holdsFirstPrompt: false,
      });
      const { session, providerThread, usage, send, startTurn, until, throughPromptSettled } =
        opened;
      yield* startTurn(1, false);
      const prompt = yield* throughPromptSettled;
      const providerTurnId = prompt.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;
      yield* TestClock.adjust("10 minutes");

      yield* session.steerTurn({
        threadId: ThreadId.make("thread-antigravity-wake"),
        runId: RunId.make("run-antigravity-wake-1"),
        providerThread,
        providerTurnId,
        message: {
          messageId: MessageId.make("message-antigravity-steer"),
          text: "Also check the footnotes",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      assert.equal(opened.cancels(), 0, "a steer must not cancel the agent's subagents");
      assert.lengthOf(opened.prompts, 2);
      yield* write(records("mock-session-1", "messages"), "report.json", { sender: "child-1" });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I'll have the footnotes checked too." },
      });
      yield* send(usage);
      yield* Deferred.succeed(opened.releaseSteer, undefined);
      const run = [...prompt, ...(yield* until((event) => event.type === "turn.terminal"))];
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.include(JSON.stringify(run), "I'll have the footnotes checked too.");
      const subagentStatuses = run.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent.status] : [],
      );
      assert.notInclude(subagentStatuses, "interrupted");
      assert.equal(subagentStatuses.at(-1), "idle");
    }).pipe(Effect.provide(layerSession)),
  );
  // A wake run has no prompt of its own, yet agy can keep working in it for minutes.
  it.effect("steers a continuation run that keeps working after its wake", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand(
        { IsDaemon: true, WaitMsBeforeAsync: 500 },
        undefined,
        { holdsFirstPrompt: false },
      );
      const { session, providerThread, command, offers, send, startTurn, until, throughTerminal } =
        opened;
      yield* startTurn(1, false);
      yield* throughTerminal;
      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      assert.lengthOf(offers, 1, "the finished daemon must wake the thread");
      yield* offers[0]!.dispatchIfCurrent!(Effect.void);
      yield* startTurn(2, true);
      const followUp = {
        toolCallId: "call_build",
        kind: "execute",
        title: "vp run build",
      } as const;
      yield* send({ sessionUpdate: "tool_call", ...followUp, status: "in_progress" });
      const continued = yield* until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === followUp.toolCallId,
      );
      const providerTurnId = continued.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;

      const steer = yield* session
        .steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId: RunId.make("run-antigravity-wake-2"),
          providerThread,
          providerTurnId,
          message: {
            messageId: MessageId.make("message-antigravity-steer"),
            text: "Skip the build",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.exit);
      assert.isTrue(
        Exit.isSuccess(steer),
        `a working wake run must accept a steer: ${String(Exit.isFailure(steer) && steer.cause)}`,
      );
      assert.equal(opened.cancels(), 0, "a steer must not cancel the agent's work");
      assert.lengthOf(opened.prompts, 2);
      assert.deepEqual(opened.prompts[1], [{ type: "text", text: "Skip the build" }]);

      yield* send({ sessionUpdate: "tool_call_update", ...followUp, status: "completed" });
      yield* TestClock.adjust("16 minutes");
      const silent = yield* until((event) => event.type === "turn.terminal");
      const terminal = silent.at(-1);
      assert.equal(
        terminal?.type === "turn.terminal" && terminal.status,
        "failed",
        "a silent steer prompt must still hit the inactivity timeout",
      );
    }).pipe(Effect.provide(layerSession)),
  );

  // agy answers a steered prompt only when the next one arrives, so a steered turn can stay open
  // for hours; a child that reported meanwhile must not keep showing as running.
  it.effect("idles a detached subagent that reports while a steered prompt is still open", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-antigravity-kids-",
      });
      const records = (conversationId: string, kind: string) =>
        path.join(profile, "antigravity-acp", "brain", conversationId, ".system_generated", kind);
      const write = (directory: string, name: string, value: unknown) =>
        fileSystem
          .makeDirectory(directory, { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.writeFileString(path.join(directory, name), encodeUnknownJson(value)),
            ),
          );
      yield* write(records("mock-session-1", "subagents"), "child-1.json", {});
      yield* write(records("child-1", "messages"), "launch.json", {
        sender: "mock-session-1",
        sourceMetadata: { tool: { toolCall: { id: "call_research", name: "invoke_subagent" } } },
      });
      const opened = yield* openSessionWithRunningCommand({}, profile, {
        holdsFirstPrompt: false,
      });
      const { session, providerThread, usage, send, startTurn, until, throughPromptSettled } =
        opened;
      yield* startTurn(1, false);
      const prompt = yield* throughPromptSettled;
      const providerTurnId = prompt.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0];
      assert.isDefined(providerTurnId);
      const launched = prompt.findLast((event) => event.type === "subagent.updated");
      assert.equal(launched?.type === "subagent.updated" && launched.subagent.status, "running");
      yield* TestClock.adjust("10 minutes");

      yield* session.steerTurn({
        threadId: ThreadId.make("thread-antigravity-wake"),
        runId: RunId.make("run-antigravity-wake-1"),
        providerThread,
        providerTurnId,
        message: {
          messageId: MessageId.make("message-antigravity-steer"),
          text: "Also check the footnotes",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      assert.lengthOf(opened.prompts, 2);
      yield* write(records("mock-session-1", "messages"), "report.json", { sender: "child-1" });
      yield* write(records("mock-session-1", "subagents"), "child-1.json", {
        state: "SUBAGENT_STATE_KILLED",
      });
      yield* send(usage);
      // Events stay ordered, so an idle the usage update caused arrives before this reply.
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Checking the footnotes now." },
      });
      const midTurn = yield* until((event) =>
        encodeUnknownJson(event).includes("Checking the footnotes now."),
      );
      assert.include(
        midTurn.flatMap((event) =>
          event.type === "subagent.updated" ? [event.subagent.status] : [],
        ),
        "idle",
        "a reported, killed subagent must leave running before the steered prompt settles",
      );
      yield* Deferred.succeed(opened.releaseSteer, undefined);
    }).pipe(Effect.provide(layerSession)),
  );
});
