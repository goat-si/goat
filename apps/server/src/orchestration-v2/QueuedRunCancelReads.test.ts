import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Statement from "effect/sql/Statement";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexCapabilities.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for queued cancels"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

it.effect("cancelling a queued message reads only that run's messages", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:queued-cancel-reads");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-queued-cancel-reads"),
      threadId,
      projectId: ProjectId.make("project:queued-cancel-reads"),
      title: "Queued cancel reads",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    for (const [name, mode] of [
      ["running", { type: "start_immediately" }],
      ["kept", { type: "queue_after_active" }],
      ["cancelled", { type: "queue_after_active" }],
    ] as const) {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`dispatch:${name}`),
        threadId,
        messageId: MessageId.make(`message:${name}`),
        text: `Request ${name}`,
        attachments: [],
        dispatchMode: mode,
        createdBy: "user",
        creationSource: "web",
      });
    }
    const cancelled = (yield* projections.getThreadProjection(threadId)).runs.at(-1)!;
    assert.equal(cancelled.status, "queued");

    const messageReads: Array<ReadonlyArray<unknown>> = [];
    const recordReads: Statement.Transformer = (statement) => {
      const [query, params] = statement.compile();
      // The cancel's user-message read; a lookup of one command's text is narrow already.
      if (
        /FROM orchestration_v2_projection_messages\b/.test(query) &&
        params.some((param) => param === JSON.stringify(["user"]))
      )
        messageReads.push(params);
      return Effect.succeed(statement);
    };
    yield* orchestrator
      .dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("cancel:queued-cancel-reads"),
        threadId,
        runId: cancelled.id,
      })
      .pipe(Effect.provideService(Statement.CurrentTransformer, recordReads));

    assert.equal(
      (yield* projections.getThreadProjection(threadId)).runs.find((run) => run.id === cancelled.id)
        ?.status,
      "cancelled",
    );
    assert.isNotEmpty(messageReads);
    // Every message read is bounded to the cancelled run, never the thread's whole history.
    for (const params of messageReads) {
      assert.isTrue(
        params.some((param) => typeof param === "string" && param.includes(cancelled.id)),
        JSON.stringify(params),
      );
    }
  }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        { name: "queued-cancel-reads" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { runEffectWorker: false },
      ),
    ),
  ),
);
