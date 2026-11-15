import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { CLAUDE_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { type CapturedTurn, makeTestAdapter } from "./testing/providerSwitchAdapter.ts";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

const waitForIdle = Effect.fn("ProviderSwitchTest.waitForIdle")(function* (
  targetThreadId: ThreadId,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const isIdle = (projection: OrchestrationV2ThreadProjection) =>
    projection.runs.every(
      (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
    );
  const afterSequence = yield* eventSink.latestSequence();
  const current = yield* orchestrator.getThreadProjection(targetThreadId);
  if (isIdle(current)) {
    return current;
  }
  // Projections commit with their events, so each later event is the only time to re-read.
  const [idle] = yield* eventSink.stream({ afterSequence }).pipe(
    Stream.mapEffect(() => orchestrator.getThreadProjection(targetThreadId)),
    Stream.filter(isIdle),
    Stream.take(1),
    Stream.runCollect,
  );
  if (idle === undefined) {
    return yield* Effect.die(
      new Error("Provider switch test event stream ended before the thread went idle"),
    );
  }
  return idle;
});

describe("settings and background work", () => {
  // regression: #16000 thread setting changes must not end a Claude session's background work
  it.live.each([
    ["runtime mode", "runtime-mode"],
    ["worktree", "worktree"],
    ["provider instance", "instance"],
  ] as const)("keeps background work alive when the %s changes on an idle thread", ([, change]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`settings-background-${change}`);
        const nextCwd = yield* checkpointWorkspace(`settings-background-${change}-next`);
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const backgroundWork = yield* Ref.make(false);
        const closedSessions = yield* Ref.make<ReadonlyArray<string>>([]);
        const secondSelection: ModelSelection = {
          ...CLAUDE_MODEL_SELECTION,
          instanceId: ProviderInstanceId.make("claude-second-account"),
        };
        const threadId = ThreadId.make(`thread:settings-background-${change}`);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:settings-background-${change}:create`),
            threadId,
            projectId: ProjectId.make(`project:settings-background-${change}`),
            title: "Settings change with background work",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:settings-background-${change}:send`),
            threadId,
            messageId: MessageId.make(`message:settings-background-${change}:send`),
            text: "Start background work",
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          yield* worker.drain();
          const afterFirst = yield* waitForIdle(threadId);
          const session = afterFirst.providerSessions[0];
          assert.equal(session?.status, "ready");
          // The turn ended but a background subagent keeps running in the CLI process.
          yield* Ref.set(backgroundWork, true);

          const commandId = CommandId.make(`command:settings-background-${change}:change`);
          yield* orchestrator
            .dispatch(
              change === "runtime-mode"
                ? {
                    type: "thread.runtime-mode.set",
                    commandId,
                    threadId,
                    runtimeMode: "auto-accept-edits",
                  }
                : change === "worktree"
                  ? { type: "thread.metadata.update", commandId, threadId, worktreePath: nextCwd }
                  : {
                      type: "thread.model-selection.set",
                      commandId,
                      threadId,
                      modelSelection: secondSelection,
                    },
            )
            .pipe(Effect.ignore);
          yield* worker.drain();

          const projection = yield* orchestrator.getThreadProjection(threadId);
          // Refusing or deferring are both fine; closing the busy process is not.
          assert.deepEqual(yield* Ref.get(closedSessions), []);
          assert.deepEqual(
            projection.providerSessions.map((candidate) => [candidate.id, candidate.status]),
            [[session!.id, "ready"]],
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: `settings-background-${change}`,
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              ProviderAdapterRegistry.layerFromAdapters([
                makeTestAdapter({
                  instanceId: CLAUDE_MODEL_SELECTION.instanceId,
                  driver: CLAUDE_DRIVER,
                  capabilities: ClaudeProviderCapabilitiesV2,
                  modelSelection: CLAUDE_MODEL_SELECTION,
                  responseByRunOrdinal: { 1: "Background work started" },
                  capturedTurns,
                  backgroundWork,
                  closedSessions,
                }),
                makeTestAdapter({
                  instanceId: secondSelection.instanceId,
                  driver: CLAUDE_DRIVER,
                  capabilities: ClaudeProviderCapabilitiesV2,
                  modelSelection: secondSelection,
                  responseByRunOrdinal: {},
                  capturedTurns,
                }),
              ]),
            ),
          ),
        );
      }),
    ),
  );
});
