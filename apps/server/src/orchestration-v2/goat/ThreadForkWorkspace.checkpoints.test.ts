// @effect-diagnostics nodeBuiltinImport:off -- real Git checkouts back the fork's checkpoints.
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

it.effect(
  "a fork into a new worktree runs its first turn and checkpoints in that checkout only",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* checkpointWorkspace("fork-worktree-checkpoints");
        // The worktree ThreadForkWorkspaceService would create; the orchestrator only binds the fork.
        const forkPath = `${source}-fork`;
        git(source, ["worktree", "add", "-q", "-b", "goat/fork-checkpoints", forkPath]);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(forkPath, { recursive: true, force: true })),
        );
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const started: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
        // Without forkHonorsTargetCwd the cross-checkout fork takes the portable path, so no native fork runs.
        const { forkHonorsTargetCwd: _native, ...threads } = CodexProviderCapabilitiesV2.threads;
        const capabilities = { ...CodexProviderCapabilitiesV2, threads };
        const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(capabilities),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              return {
                instanceId,
                driver,
                providerSessionId: input.providerSessionId,
                providerSession: {
                  id: input.providerSessionId,
                  driver,
                  providerInstanceId: instanceId,
                  status: "ready",
                  cwd: input.runtimePolicy.cwd,
                  model: modelSelection.model,
                  capabilities,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.fromQueue(events),
                ensureThread: ({ threadId }) =>
                  Effect.succeed({
                    id: ProviderThreadId.make(`provider-thread:${threadId}`),
                    driver,
                    providerInstanceId: instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: threadId,
                    ownerNodeId: null,
                    nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  }),
                resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                startTurn: (turn) =>
                  Effect.gen(function* () {
                    started.push(turn);
                    // The agent's edit lands wherever its turn runs.
                    const cwd = turn.runtimePolicy.cwd ?? "";
                    NodeFS.writeFileSync(
                      NodePath.join(cwd, `${turn.threadId}.txt`),
                      "agent edit\n",
                    );
                    yield* Queue.offer(events, {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: {
                        id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                        providerThreadId: turn.providerThread.id,
                        nodeId: turn.rootNodeId,
                        runAttemptId: turn.attemptId,
                        nativeTurnRef: {
                          driver,
                          nativeId: `native:${turn.attemptId}`,
                          strength: "strong",
                        },
                        ordinal: turn.providerTurnOrdinal,
                        status: "running",
                        startedAt: now,
                        completedAt: null,
                      },
                    });
                  }),
                steerTurn: () => Effect.die("unused"),
                interruptTurn: () => Effect.void,
                respondToRuntimeRequest: () => Effect.void,
                readThreadSnapshot: () => Effect.die("unused"),
                rollbackThread: () => Effect.die("unused"),
                forkThread: () =>
                  Effect.die("a cross-checkout fork without the flag must not fork natively"),
              };
            }),
        };

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const watch = (
            predicate: (event: Orchestrator.OrchestratorV2DomainEventLike) => boolean,
          ) =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(predicate),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          const runTurn = Effect.fn("test.runTurn")(function* (threadId: ThreadId, text: string) {
            const running = yield* watch(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.threadId === threadId &&
                event.payload.status === "running",
            );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`message:${threadId}`),
              threadId,
              messageId: MessageId.make(`message:${threadId}`),
              text,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain();
            yield* Fiber.join(running);
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const turn = projection.providerTurns.at(-1)!;
            const run = projection.runs.at(-1)!;
            // Subscribe before the provider finishes, so the event cannot pass unseen.
            const finished = yield* watch(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === run.id &&
                event.payload.status === "waiting",
            );
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
            });
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              runOrdinal: run.ordinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(finished);
            // The worker captures the turn's checkpoint, which completes the run.
            yield* worker.drain();
            const settled = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(
              settled.runs.find((candidate) => candidate.id === run.id)?.status,
              "completed",
            );
            return settled;
          });

          const sourceThreadId = ThreadId.make("thread:fork-checkpoints-source");
          const forkThreadId = ThreadId.make("thread:fork-checkpoints-target");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-source"),
            threadId: sourceThreadId,
            projectId: ProjectId.make("project:fork-checkpoints"),
            title: "Source",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: source,
            createdBy: "user",
            creationSource: "web",
          });
          const sourceAfterTurn = yield* runTurn(sourceThreadId, "source turn");
          const sourceFiles = git(source, ["status", "--porcelain", "--untracked-files=all"]);

          yield* orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("fork-into-worktree"),
            sourceThreadId,
            targetThreadId: forkThreadId,
            sourcePoint: { type: "latest_stable" },
            workspace: { branch: "goat/fork-checkpoints", worktreePath: forkPath },
            createdBy: "user",
            creationSource: "web",
          });
          const fork = yield* runTurn(forkThreadId, "fork turn");

          // The fork's turn ran in the new checkout. These capabilities share one provider session
          // between threads, so the cwd that matters is the one each turn starts with.
          const forkTurn = started.find((turn) => turn.threadId === forkThreadId);
          assert.equal(forkTurn?.runtimePolicy.cwd, forkPath);
          assert.equal(
            started.find((turn) => turn.threadId === sourceThreadId)?.runtimePolicy.cwd,
            source,
          );
          assert.equal(fork.thread.worktreePath, forkPath);
          assert.equal(fork.contextTransfers[0]?.resolution?.strategy, "portable_context");

          // Its checkpoints are scoped to the new checkout and record only its own edit.
          assert.isAbove(fork.checkpointScopes.length, 0);
          for (const scope of fork.checkpointScopes) assert.equal(scope.cwd, forkPath);
          const [baseline, ...turnCheckpoints] = [...fork.checkpoints].sort(
            (left, right) => left.ordinalWithinScope - right.ordinalWithinScope,
          );
          const latest = turnCheckpoints.at(-1);
          assert.isDefined(baseline);
          assert.isDefined(latest);
          assert.equal(
            git(forkPath, ["diff", "--name-only", baseline!.ref, latest!.ref]),
            `${forkThreadId}.txt`,
          );

          // The source checkout and its checkpoints are as the fork found them.
          assert.isTrue(NodeFS.existsSync(NodePath.join(forkPath, `${forkThreadId}.txt`)));
          assert.isFalse(NodeFS.existsSync(NodePath.join(source, `${forkThreadId}.txt`)));
          assert.equal(
            git(source, ["status", "--porcelain", "--untracked-files=all"]),
            sourceFiles,
          );
          const sourceAfterFork = yield* orchestrator.getThreadProjection(sourceThreadId);
          assert.deepEqual(
            sourceAfterFork.checkpoints.map((checkpoint) => checkpoint.id),
            sourceAfterTurn.checkpoints.map((checkpoint) => checkpoint.id),
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "fork-worktree-checkpoints" },
              ProviderAdapterRegistry.layerSingle(adapter),
              { runEffectWorker: false },
            ),
          ),
        );
      }),
    ),
);
