import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SecretRef,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeFakeCloudAdapter } from "../orchestration-v2/testkit/FakeCloudAdapter.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpThreadInvocationScope } from "./McpInvocationContext.ts";
import { makeRequestSecret } from "./SecretRequestTool.ts";

const threadId = ThreadId.make("thread:secret-tool");
const instanceId = ProviderInstanceId.make("codex");
const scope: McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("test"),
  requestNamespace: "secret-tool",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  client: undefined,
  thread: { threadId, providerSessionId: "session", providerInstanceId: instanceId },
};
const input = {
  label: "Webhook secret",
  reason: "Signs the posts.",
  clientRequestId: "ask",
  wait: false,
};

/** A thread with a running turn on the real orchestrator, and request_secret bound to it. */
const withRunningTurn = <A, E>(
  body: (input: {
    readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
    readonly worker: Worker.OrchestrationEffectWorkerV2["Service"];
    readonly handoffs: Handoffs.Handoffs["Service"];
    readonly requestSecret: ReturnType<typeof makeRequestSecret>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeCloudAdapter(true, instanceId);
    const adapter = {
      ...fake.adapter,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      openSession: (session: Parameters<typeof fake.adapter.openSession>[0]) =>
        fake.adapter
          .openSession(session)
          .pipe(Effect.map((opened) => ({ ...opened, startTurn: () => Effect.void }))),
    };
    const databaseLayer = Sqlite.layerMemory;
    return yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-thread"),
        threadId,
        projectId: ProjectId.make("project:secret-tool"),
        title: "Secret",
        modelSelection: { instanceId, model: "fake" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start-run"),
        threadId,
        messageId: MessageId.make("message:secret-tool"),
        text: "Set up the webhook",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: orchestrator.dispatch,
        getThreadRecords: orchestrator.getThreadRecords,
      });
      const secrets = Layer.mock(SecretRequests.SecretRequests)({
        savedRef: () => Effect.succeed(Option.some(SecretRef.make("secret-ref:saved"))),
      });
      const handoffs = yield* Handoffs.Handoffs.pipe(
        Effect.provide(
          Handoffs.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                threads,
                secrets,
                Layer.mock(SessionStore.SessionStore)({
                  cookieName: "test",
                  legacyCookieName: undefined,
                }),
                Layer.succeed(
                  SecretStore.ServerSecretStore,
                  SecretStore.ServerSecretStore.of({
                    get: () => Effect.succeed(Option.none()),
                    set: () => Effect.void,
                    create: () => Effect.void,
                    remove: () => Effect.void,
                    getOrCreateRandom: (_name, size) =>
                      Effect.succeed(new Uint8Array(size).fill(1)),
                  }),
                ),
              ),
            ),
          ),
        ),
      );
      const requestSecret = yield* Effect.gen(function* () {
        return makeRequestSecret({
          threadManagement: yield* ThreadManagement.ThreadManagementService,
          secretRequests: yield* SecretRequests.SecretRequests,
          loadThreadCaller: () =>
            orchestrator.getThreadProjection(threadId).pipe(
              Effect.map((parent) => ({ scope, parent })),
              Effect.orDie,
            ),
          requestKey: (key) => Effect.succeed(key ?? "random"),
        });
      }).pipe(Effect.provide(Layer.mergeAll(threads, secrets)));
      return yield* body({ orchestrator, worker, handoffs, requestSecret });
    }).pipe(
      Effect.provide(
        Harness.layerWithRegistry(
          { name: "secret-request-tool" },
          Registry.layerFromAdapters([adapter]),
          { runEffectWorker: false, databaseLayer },
        ).pipe(Layer.provideMerge(databaseLayer)),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

it.effect(
  "returns needs_human with the card's handoff at once, then the saved ref for the same request",
  () =>
    withRunningTurn(({ orchestrator, requestSecret }) =>
      Effect.gen(function* () {
        const pending = yield* requestSecret(scope, input);
        expect(pending).toMatchObject({
          status: "pending",
          kind: "needs_human",
          handoff: { kind: "secret", state: "pending", title: "Webhook secret" },
          next: { after: "input", call: "request_secret" },
        });
        // The card stays open for the person; asking again does not add a second one.
        expect(yield* requestSecret(scope, input)).toMatchObject({ status: "pending" });
        const cards = (yield* orchestrator.getThreadProjection(threadId)).turnItems.filter(
          (item) => item.type === "secret_request",
        );
        expect(cards).toMatchObject([{ secretStatus: "pending" }]);
        const card = cards[0]!;
        // What SecretRequests.answer records once the value is stored.
        yield* orchestrator.dispatch({
          type: "secret_request.record",
          commandId: CommandId.make("secret-saved"),
          threadId,
          runId: card.runId!,
          nodeId: card.nodeId!,
          turnItemId: card.id,
          label: input.label,
          reason: input.reason,
          secretStatus: "saved",
        });
        expect(yield* requestSecret(scope, input)).toEqual({
          status: "saved",
          secretRef: "secret-ref:saved",
        });
      }),
    ),
);

it.effect("refuses wait:false without a clientRequestId, which the next call would need", () =>
  withRunningTurn(({ orchestrator, requestSecret }) =>
    Effect.gen(function* () {
      const { clientRequestId: _omitted, ...withoutKey } = input;
      expect(yield* requestSecret(scope, withoutKey).pipe(Effect.flip)).toMatchObject({
        code: "invalid_request",
      });
      const cards = (yield* orchestrator.getThreadProjection(threadId)).turnItems.filter(
        (item) => item.type === "secret_request",
      );
      expect(cards).toEqual([]);
    }),
  ),
);

it.effect("closes a card nobody collects once its run ends", () =>
  withRunningTurn(({ orchestrator, worker, handoffs, requestSecret }) =>
    Effect.gen(function* () {
      yield* requestSecret(scope, input);
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop"),
        threadId,
      });
      yield* worker.drain();
      yield* handoffs.sweep;
      const cards = (yield* orchestrator.getThreadProjection(threadId)).turnItems.filter(
        (item) => item.type === "secret_request",
      );
      expect(cards).toMatchObject([{ secretStatus: "cancelled", handoff: { state: "expired" } }]);
    }),
  ),
);
