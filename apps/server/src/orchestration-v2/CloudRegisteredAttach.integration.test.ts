import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2CloudTask,
  type Project,
  ProjectId,
  ThreadId,
} from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { ProviderAdapterTurnStartError } from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Projects from "../project/ProjectService.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import { fakeCloudDriver, makeFakeCloudAdapter } from "./testkit/FakeCloudAdapter.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:cloud-registered");
const projectionThreadId = "pt:fake-cloud" as import("@goat/contracts").ProviderThreadId;

const registeredTask: OrchestrationV2CloudTask = {
  taskId: "bc-registered-1",
  url: "https://cursor.com/agents/bc-registered-1",
  status: "running",
  tracking: "polled",
  source: { repository: "https://github.com/acme/repo", branch: "dev" },
  localChangesExcluded: true,
  updatedAt: "2026-10-20T00:00:00.000Z",
  attach: "registered",
};

const registerAndStart = Effect.fn(function* (
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  name: string,
) {
  const runtime = layerWithRegistry({ name }, Registry.layerFromAdapters([adapter]), {
    runEffectWorker: false,
    projects: Layer.mock(Projects.ProjectService)({
      getById: () =>
        Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/repo" } as Project)),
    }),
  });
  return yield* Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`command:${name}:create`),
      threadId,
      projectId,
      title: "Registered run",
      modelSelection: { instanceId: adapter.instanceId, model: "fake" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      importedNativeThread: {
        ref: { driver: fakeCloudDriver, nativeId: "bc-registered-1", strength: "strong" },
        cloudTask: registeredTask,
      },
      externalLauncher: "Grok Bot",
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:${name}:follow`),
      threadId,
      messageId: MessageId.make(`message:${name}`),
      text: "Follow Cursor Cloud run https://cursor.com/agents/bc-registered-1.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* worker.drain();
    return yield* orchestrator.getThreadProjection(threadId);
  }).pipe(Effect.provide(runtime));
});

it.effect("a registered cloud run's first run attaches to the task and never submits", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeCloudAdapter();
    const projection = yield* registerAndStart(fake.adapter, "cloud-registered-attach");
    assert.equal(yield* Ref.get(fake.submissions), 0);
    assert.equal(yield* Ref.get(fake.creations), 0);
    assert.equal(yield* Ref.get(fake.attachments), 1);
    const run = projection.runs[0]!;
    assert.equal(run.status, "running");
    const task = projection.providerThreads[0]?.cloudTask;
    assert.equal(task?.taskId, "bc-registered-1");
    assert.equal(task?.acceptedAppRunId, run.id);
    assert.equal(task?.tracking, "polled");
    assert.equal(projection.thread.externalLauncher, "Grok Bot");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a registered run its holder cannot see stays link-only without a result", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeCloudAdapter();
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      ...fake.adapter,
      openSession: (open) =>
        fake.adapter.openSession(open).pipe(
          Effect.map((session) => ({
            ...session,
            resumeTurn: (input: { readonly runId: import("@goat/contracts").RunId }) =>
              Effect.fail(
                new ProviderAdapterTurnStartError({
                  driver: fakeCloudDriver,
                  threadId: open.threadId,
                  providerThreadId: projectionThreadId,
                  runId: input.runId,
                  cause: "Cursor Cloud get-run failed.",
                }),
              ),
          })),
        ),
    };
    const projection = yield* registerAndStart(adapter, "cloud-registered-hidden");
    assert.equal(yield* Ref.get(fake.submissions), 0);
    const run = projection.runs[0]!;
    assert.equal(run.status, "completed");
    const task = projection.providerThreads[0]?.cloudTask;
    assert.equal(task?.tracking, "link-only");
    assert.equal(task?.status, "running");
    assert.match(task?.error ?? "", /keeps only its link/u);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
