import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../config.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { AuthSessionId, type AuthClientSession } from "@goat/contracts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { transitionHandoff } from "../orchestration-v2/handoffState.ts";
import * as Handoffs from "./Handoffs.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  CommandId,
  EnvironmentId,
  Handoff,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeFakeCloudAdapter } from "../orchestration-v2/testkit/FakeCloudAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";

const encodeHandoff = Schema.encodeEffect(Schema.toCodecJson(Handoff));
const threadId = ThreadId.make("thread:handoff-tests");
const instanceId = ProviderInstanceId.make("codex");
const withHarness = <A, E, R>(
  body: (input: {
    orchestrator: Orchestrator.OrchestratorV2["Service"];
    worker: Worker.OrchestrationEffectWorkerV2["Service"];
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeCloudAdapter(true, instanceId);
    const adapter = {
      ...fake.adapter,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      openSession: (input: Parameters<typeof fake.adapter.openSession>[0]) =>
        fake.adapter
          .openSession(input)
          .pipe(Effect.map((session) => ({ ...session, startTurn: () => Effect.void }))),
    };
    const databaseLayer = Sqlite.layerMemory;
    return yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-thread"),
        threadId,
        projectId: ProjectId.make("project:handoff-tests"),
        title: "Human handoff",
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
        messageId: MessageId.make("message:handoff"),
        text: "Set up the provider",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      return yield* body({ orchestrator, worker });
    }).pipe(
      Effect.provide(
        Harness.layerWithRegistry(
          { name: "human-handoff" },
          Registry.layerFromAdapters([adapter]),
          { runEffectWorker: false, databaseLayer },
        ).pipe(Layer.provideMerge(databaseLayer)),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const create = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  id: string,
  kind: Handoff["kind"] = "device_code",
) =>
  Effect.gen(function* () {
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    const now = yield* DateTime.now;
    const handoff: Handoff = {
      handoffId: TurnItemId.make(id),
      kind,
      title: "Sign in to the provider",
      reason: "The provider requires your consent.",
      requestedBy: { threadId, providerInstanceId: instanceId, path: "provider.login_start" },
      target: { environmentId: EnvironmentId.make("test-environment"), path: "provider.verify" },
      dedupeKey: id,
      state: "pending",
      expiresAt: kind === "approval" ? null : DateTime.add(now, { minutes: 15 }),
      createdAt: now,
      actor: { type: "agent", threadId },
    };
    yield* orchestrator.dispatch({
      type: "handoff.create",
      commandId: CommandId.make(`create:${id}`),
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId!,
      handoff,
    });
    return handoff;
  });
const transition = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  id: string,
  state: Handoff["state"],
  actor: Handoff["actor"] = { type: "client", label: "Test phone" },
) =>
  orchestrator.dispatch({
    type: "handoff.transition",
    commandId: CommandId.make(`${id}:${state}`),
    threadId,
    handoffId: TurnItemId.make(id),
    state,
    actor,
  });
const read = (orchestrator: Orchestrator.OrchestratorV2["Service"], id: string) =>
  orchestrator.getThreadProjection(threadId).pipe(
    Effect.map((projection) => {
      const item = projection.turnItems.find((item) => item.id === id);
      assert.isTrue(item?.type === "human_handoff" || item?.type === "secret_request");
      return item?.type === "human_handoff" || item?.type === "secret_request"
        ? item.handoff!
        : undefined!;
    }),
  );

it.effect(
  "persists actor-labelled transitions, rejects agent completion and terminal rewrites",
  () =>
    withHarness(({ orchestrator, worker }) =>
      Effect.gen(function* () {
        yield* create(orchestrator, "h:one");
        yield* transition(orchestrator, "h:one", "opened");
        yield* worker.drain();
        assert.equal((yield* read(orchestrator, "h:one")).state, "opened");
        const denied = yield* orchestrator
          .dispatch({
            type: "handoff.transition",
            commandId: CommandId.make("agent-complete"),
            threadId,
            handoffId: TurnItemId.make("h:one"),
            state: "completed",
            actor: { type: "agent", threadId },
          })
          .pipe(Effect.result);
        assert.equal(denied._tag, "Failure");
        const result = yield* transition(orchestrator, "h:one", "completed");
        yield* worker.drain();
        assert.equal(result.storedEvents.length, 1);
        const record = yield* read(orchestrator, "h:one");
        assert.equal(record.state, "completed");
        assert.equal(record.resolvedBy, "Test phone");
        assert.deepEqual(record.actor, { type: "client", label: "Test phone" });
        assert.equal(
          (yield* transition(orchestrator, "h:one", "declined").pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* transition(orchestrator, "h:one", "completed")).storedEvents.length,
          1,
        ); // receipt replay, not a new event
      }),
    ),
);

it.effect("expiry wins over a late answer even before the scheduler runs", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      yield* create(orchestrator, "h:expires");
      yield* transition(orchestrator, "h:expires", "opened");
      yield* TestClock.adjust("15 minutes");
      yield* transition(orchestrator, "h:expires", "completed");
      yield* worker.drain();
      const record = yield* read(orchestrator, "h:expires");
      assert.equal(record.state, "expired");
      assert.deepEqual(record.actor, { type: "server" });
      assert.isUndefined(record.resolvedBy);
    }),
  ),
);

it.effect("opened requests count toward the three-request cap and cancellation frees a slot", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      for (const id of ["h:1", "h:2", "h:3"]) {
        yield* create(orchestrator, id);
        yield* transition(orchestrator, id, "opened");
      }
      assert.equal((yield* create(orchestrator, "h:4").pipe(Effect.result))._tag, "Failure");
      yield* transition(orchestrator, "h:1", "cancelled");
      yield* create(orchestrator, "h:5");
      yield* worker.drain();
      assert.equal((yield* read(orchestrator, "h:5")).state, "pending");
    }),
  ),
);

it.effect("approval expires at run end and cannot be approved afterwards", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      yield* create(orchestrator, "h:approval", "approval");
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop"),
        threadId,
      });
      yield* worker.drain();
      yield* transition(orchestrator, "h:approval", "completed");
      assert.equal((yield* read(orchestrator, "h:approval")).state, "expired");
    }),
  ),
);

it.effect(
  "legacy secrets carry handoff metadata and cannot complete through the generic verb",
  () =>
    withHarness(({ orchestrator, worker }) =>
      Effect.gen(function* () {
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        const command = {
          type: "secret_request.record" as const,
          commandId: CommandId.make("secret-create"),
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId!,
          turnItemId: TurnItemId.make("secret:one"),
          environmentId: EnvironmentId.make("test-environment"),
          label: "Webhook signing secret",
          reason: "Sign outgoing requests",
          secretStatus: "pending" as const,
        };
        yield* orchestrator.dispatch(command);
        yield* worker.drain();
        const record = yield* read(orchestrator, "secret:one");
        assert.equal(record.kind, "secret");
        assert.equal(
          DateTime.toEpochMillis(record.expiresAt!) - DateTime.toEpochMillis(record.createdAt),
          3_600_000,
        );
        assert.equal(
          (yield* transition(orchestrator, "secret:one", "completed").pipe(Effect.result))._tag,
          "Failure",
        );
        yield* orchestrator.dispatch({
          ...command,
          commandId: CommandId.make("secret-save"),
          secretStatus: "saved",
          actor: { type: "client", label: "Test desktop" },
        });
        const saved = yield* read(orchestrator, "secret:one");
        assert.equal(saved.state, "completed");
        assert.equal(saved.resolvedBy, "Test desktop");
        const json = yield* encodeHandoff(saved);
        assert.notProperty(json, "human");
      }),
    ),
);

it.effect(
  "domain API deduplicates targets, keeps instructions encrypted, authorizes the human and expires opened records",
  () =>
    withHarness(({ orchestrator, worker }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const plan = yield* sql<{
          detail: string;
        }>`EXPLAIN QUERY PLAN SELECT thread_id, turn_item_id FROM orchestration_v2_projection_turn_items WHERE type IN ('human_handoff', 'secret_request') AND status = 'waiting'`;
        assert.isTrue(
          plan.some((row) =>
            row.detail.includes("orchestration_v2_projection_turn_items_handoff_idx"),
          ),
        );
        const stored = new Map<string, Uint8Array>();
        const now = yield* DateTime.now;
        const sessionId = AuthSessionId.make("client:handoff-test");
        let sessions: AuthClientSession[] = [
          {
            sessionId,
            subject: "test",
            method: "browser-session-cookie",
            scopes: ["orchestration:operate"],
            permissions: ["orchestration:operate", "providers:manage"],
            client: { label: "Test tablet", deviceType: "unknown" },
            issuedAt: now,
            expiresAt: DateTime.add(now, { days: 1 }),
            lastConnectedAt: now,
            connected: true,
            current: true,
          },
        ];
        const dependencies = Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: orchestrator.dispatch,
            getThreadRecords: orchestrator.getThreadRecords,
          }),
          Layer.mock(SessionStore.SessionStore)({
            cookieName: "test",
            legacyCookieName: undefined,
            listActive: () => Effect.sync(() => sessions),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.succeed(
            SecretStore.ServerSecretStore,
            SecretStore.ServerSecretStore.of({
              get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
              set: (name, value) =>
                Effect.sync(() => {
                  stored.set(name, value);
                }),
              create: (name, value) =>
                Effect.sync(() => {
                  assert.isFalse(stored.has(name));
                  stored.set(name, value);
                }),
              remove: (name) =>
                Effect.sync(() => {
                  stored.delete(name);
                }),
              getOrCreateRandom: (name, size) =>
                Effect.sync(() => {
                  const bytes = stored.get(name) ?? new Uint8Array(size).fill(5);
                  stored.set(name, bytes);
                  return bytes;
                }),
            }),
          ),
        );
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        const input = {
          kind: "device_code" as const,
          title: "Sign in",
          reason: "Finish provider setup",
          requestedBy: { threadId, providerInstanceId: instanceId, path: "provider.login_start" },
          target: { environmentId: EnvironmentId.make("test"), path: "provider.verify" },
          runId: run.id,
          nodeId: run.rootNodeId!,
          args: { instance: "codex", options: { a: 1, b: 2 } },
          human: {
            location: "Your browser",
            url: "https://example.com/device?private=test-code",
            userCode: "TEST-CODE",
          },
        };
        yield* Effect.gen(function* () {
          const service = yield* Handoffs.Handoffs;
          const [first, second] = yield* Effect.all(
            [
              service.create(input),
              service.create({ ...input, args: { options: { b: 2, a: 1 }, instance: "codex" } }),
            ],
            { concurrency: "unbounded" },
          );
          assert.equal(first.handoffId, second.handoffId);
          yield* worker.drain();
          assert.notProperty(first, "human");
          for (const value of stored.values()) {
            assert.notInclude(new TextDecoder().decode(value), "TEST-CODE");
            assert.notInclude(new TextDecoder().decode(value), "example.com");
          }
          const address = { threadId, handoffId: first.handoffId };
          assert.equal(
            (yield* service.open(address, AuthSessionId.make("thread-token")).pipe(Effect.result))
              ._tag,
            "Failure",
          );
          const full = sessions;
          sessions = sessions.map((session) => ({
            ...session,
            permissions: ["orchestration:operate"],
          }));
          assert.equal(
            (yield* service.open(address, sessionId).pipe(Effect.result))._tag,
            "Failure",
          );
          sessions = full;
          const opened = yield* service.open(address, sessionId);
          assert.equal(opened.human?.userCode, "TEST-CODE");
          assert.equal(opened.handoff.state, "opened");
          const transcript = JSON.stringify(yield* orchestrator.getThreadProjection(threadId));
          assert.notInclude(transcript, "TEST-CODE");
          assert.notInclude(transcript, "example.com");
          // Rebuilding the domain service preserves the durable record and decrypts
          // with the existing key, without copying instructions into the event log.
          const reopened = yield* Effect.gen(function* () {
            const restarted = yield* Handoffs.Handoffs;
            return yield* restarted.open(address, sessionId);
          }).pipe(Effect.provide(Handoffs.layer.pipe(Layer.provide(dependencies))));
          assert.equal(reopened.human?.userCode, "TEST-CODE");
          sessions = [];
          assert.equal(
            (yield* service
              .respond({ ...address, action: "completed" }, sessionId)
              .pipe(Effect.result))._tag,
            "Failure",
          );
          sessions = full;

          assert.deepEqual(opened.handoff.actor, { type: "client", label: "Test tablet" });
          const scheduled = yield* service.create({ ...input, args: { scheduled: true } });
          const scheduledAddress = { threadId, handoffId: scheduled.handoffId };
          // Expiry must not decode resolved history, even during its authoritative transition.
          for (let index = 0; index < 12; index++) {
            const id = `h:resolved:${index}`;
            yield* create(orchestrator, id);
            yield* transition(orchestrator, id, "completed");
          }
          yield* worker.drain();
          const history = yield* sql<{ turn_item_id: string; payload_json: string }>`
            SELECT turn_item_id, payload_json FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${threadId} AND type IN ('human_handoff', 'secret_request') AND status = 'completed'
          `;
          assert.equal(history.length, 12);
          yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = '{}'
            WHERE thread_id = ${threadId} AND type IN ('human_handoff', 'secret_request') AND status = 'completed'`;
          yield* TestClock.adjust("15 minutes");
          const lateOpen = yield* service.open(address, sessionId).pipe(Effect.result);
          assert.equal(lateOpen._tag, "Failure");
          if (lateOpen._tag === "Failure")
            assert.equal(
              lateOpen.failure._tag === "HandoffError" ? lateOpen.failure.reason : null,
              "expired",
            );
          yield* service.sweep;
          assert.equal((yield* service.read(scheduledAddress)).state, "expired");
          // A second sweep also ignores the resolved history and is idempotent.
          yield* service.sweep;
          for (const row of history)
            yield* sql`UPDATE orchestration_v2_projection_turn_items
              SET payload_json = ${row.payload_json} WHERE turn_item_id = ${row.turn_item_id}`;
          yield* worker.drain();
          assert.equal((yield* service.read(address)).state, "expired");
          assert.isNull((yield* service.open(address, sessionId)).human);
          assert.equal(stored.size, 1); // only the durable encryption key remains
          const approval = yield* service.create({
            ...input,
            kind: "approval",
            args: { approval: true },
          });
          const approvalAddress = { threadId, handoffId: approval.handoffId };
          yield* service.open(approvalAddress, sessionId);
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("end-approval-run"),
            threadId,
          });
          yield* worker.drain();
          assert.equal(
            (yield* service.open(approvalAddress, sessionId).pipe(Effect.result))._tag,
            "Failure",
          );
          assert.equal((yield* service.read(approvalAddress)).state, "expired");
        }).pipe(Effect.provide(Handoffs.layer.pipe(Layer.provide(dependencies))));
      }),
    ),
);

it.effect("declined and failed outcomes are durable and terminal", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      yield* create(orchestrator, "h:decline", "oauth");
      yield* transition(orchestrator, "h:decline", "declined");
      yield* create(orchestrator, "h:failure", "mfa");
      yield* transition(orchestrator, "h:failure", "failed", { type: "server" });
      yield* worker.drain();
      assert.equal((yield* read(orchestrator, "h:decline")).state, "declined");
      assert.equal((yield* read(orchestrator, "h:failure")).state, "failed");
      assert.equal(
        (yield* transition(orchestrator, "h:failure", "completed").pipe(Effect.result))._tag,
        "Failure",
      );
    }),
  ),
);

it.effect.each([
  undefined,
  {
    result: {
      kind: "ok" as const,
      status: {
        host: "box",
        state: "stopped" as const,
        runtimeVersion: null,
        requestedVersion: "1.0",
      },
    },
    aliasRevision: "pinned-revision",
  },
  {
    result: {
      kind: "error" as const,
      code: "operation_failed" as const,
      message: "The SSH host key changed.",
    },
  },
])(
  "SSH approvals retain encrypted completion %s across ack and restart",
  (completion: Handoffs.SshProgressBinding["completion"]) =>
    withHarness(({ orchestrator, worker }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-handoff-store-" });
        const store = Context.get(
          yield* Layer.build(
            SecretStore.layer.pipe(
              Layer.provide(ServerConfig.layerTest(home, { prefix: "ssh-handoff-store-" })),
            ),
          ),
          SecretStore.ServerSecretStore,
        );
        const now = yield* DateTime.now;
        const sessionId = AuthSessionId.make("ssh-reviewer");
        let permissions: AuthClientSession["scopes"] = [
          "orchestration:operate",
          "orchestration:read",
          "environment:maintain",
        ];
        const domainDependencies = Layer.mergeAll(
          Layer.mock(Environment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("ssh-origin")),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: orchestrator.dispatch,
            getThreadRecords: orchestrator.getThreadRecords,
          }),
          Layer.mock(SessionStore.SessionStore)({
            cookieName: "test",
            legacyCookieName: undefined,
            listActive: () =>
              Effect.succeed([
                {
                  sessionId,
                  subject: "test",
                  method: "browser-session-cookie",
                  scopes: permissions,
                  permissions,
                  client: { label: "Review tablet", deviceType: "unknown" },
                  issuedAt: now,
                  expiresAt: DateTime.add(now, { days: 2 }),
                  lastConnectedAt: now,
                  connected: true,
                  current: true,
                },
              ]),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.succeed(SecretStore.ServerSecretStore, store),
        );
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        const environmentId = EnvironmentId.make("ssh-origin");
        const binding = {
          host: "box",
          aliasGeneration: 3,
          operationId: "setup-3",
          environmentId,
          threadId,
        };
        yield* Effect.gen(function* () {
          const service = yield* Handoffs.Handoffs;
          const summary = yield* service.create({
            kind: "approval",
            title: "Update box?",
            reason: "Replaces the runtime",
            requestedBy: { threadId, providerInstanceId: instanceId, path: "ssh.runtime_update" },
            target: { environmentId, path: "ssh.runtime_update" },
            runId: run.id,
            nodeId: run.rootNodeId!,
            human: { location: "box", fingerprint: "SHA256:private-review" },
            args: { version: 1, host: "box", secretArgument: "private-args" },
            expiresAt: DateTime.add(now, { hours: 24 }),
            sshProgress: binding,
          });
          yield* worker.drain();
          const input = { threadId, handoffId: summary.handoffId };
          assert.isNotNull((yield* service.read(input)).expiresAt);
          permissions = ["orchestration:operate"];
          assert.equal((yield* service.open(input, sessionId).pipe(Effect.result))._tag, "Failure");
          permissions = ["environment:maintain"];
          assert.equal((yield* service.open(input, sessionId).pipe(Effect.result))._tag, "Failure");
          permissions = ["orchestration:operate", "orchestration:read", "environment:maintain"];
          assert.equal(
            (yield* service.open(input, sessionId)).human?.fingerprint,
            "SHA256:private-review",
          );
          yield* service.respond({ ...input, action: "completed" }, sessionId);
          const continuations = yield* service.completedSshContinuations;
          assert.lengthOf(continuations, 1);
          assert.equal(continuations[0]?.approvedBySessionId, sessionId);
          assert.deepEqual(continuations[0]?.sshProgress, binding);
          assert.deepEqual(yield* service.readSshProgressBinding(input, sessionId), binding);
          yield* service.finishSshContinuation(input, completion);
          const retainedBinding = { ...binding, ...(completion ? { completion } : {}) };
          assert.lengthOf(yield* service.completedSshContinuations, 0);
          assert.deepEqual(
            yield* service.readSshProgressBinding(input, sessionId),
            retainedBinding,
          );
          assert.isNull((yield* service.open(input, sessionId)).human);
          assert.isDefined(store.directory);
          for (const file of yield* fs.readDirectory(store.directory!)) {
            const value = yield* fs.readFile(`${store.directory!}/${file}`);
            assert.notInclude(new TextDecoder().decode(value), "private-review");
            assert.notInclude(new TextDecoder().decode(value), "private-args");
          }
          yield* Effect.gen(function* () {
            const restarted = yield* Handoffs.Handoffs;
            assert.deepEqual(
              yield* restarted.readSshProgressBinding(input, sessionId),
              retainedBinding,
            );
            assert.lengthOf(yield* restarted.completedSshContinuations, 0);
          }).pipe(Effect.provide(Handoffs.layer.pipe(Layer.provide(domainDependencies))));
          const expired = yield* service.create({
            kind: "approval",
            title: "Update box?",
            reason: "Update",
            requestedBy: { threadId, providerInstanceId: instanceId, path: "ssh.runtime_update" },
            target: { environmentId, path: "ssh.runtime_update" },
            runId: run.id,
            nodeId: run.rootNodeId!,
            human: { location: "box" },
            args: { version: 1, request: "expires" },
            expiresAt: DateTime.add(now, { minutes: 1 }),
            sshProgress: binding,
          });
          yield* TestClock.adjust("1 minute");
          yield* service.sweep;
          const outcomes = yield* service.resolvedSshOutcomes;
          assert.lengthOf(outcomes, 1);
          assert.equal(outcomes[0]?.handoff.state, "expired");
          assert.deepEqual(outcomes[0]?.sshProgress, binding);
          assert.notProperty(outcomes[0], "args");
          yield* service.finishSshContinuation({ threadId, handoffId: expired.handoffId });
          assert.lengthOf(yield* service.resolvedSshOutcomes, 0);
          assert.lengthOf(yield* service.completedSshContinuations, 0);
          yield* TestClock.adjust("24 hours");
          assert.isNull(yield* service.readSshProgressBinding(input, sessionId));
        }).pipe(Effect.provide(Handoffs.layer.pipe(Layer.provide(domainDependencies))));
      }),
    ),
);

it.effect(
  "an SSH approval can complete after its requesting run ends, while ordinary approvals expire",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const record: Handoff = {
        handoffId: TurnItemId.make("ssh:after-run"),
        kind: "approval",
        title: "Update box?",
        reason: "Replace the runtime",
        requestedBy: { threadId, providerInstanceId: instanceId, path: "ssh.runtime_update" },
        target: { environmentId: EnvironmentId.make("origin"), path: "ssh.runtime_update" },
        dedupeKey: "ssh",
        state: "pending",
        expiresAt: DateTime.add(now, { hours: 24 }),
        createdAt: now,
        actor: { type: "agent", threadId },
      };
      const actor = { type: "client" as const, label: "Reviewer" };
      const ssh = yield* transitionHandoff(record, "completed", actor, now, true);
      assert.equal(ssh.state, "completed");
      const ordinary = yield* transitionHandoff(
        { ...record, target: { ...record.target, path: "provider.verify" } },
        "completed",
        actor,
        now,
        true,
      );
      assert.equal(ordinary.state, "expired");
    }),
);

it.effect(
  "provider Home approvals retain private intent and approver across restart without entering SSH continuations",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-provider-handoff-" });
        const store = Context.get(
          yield* Layer.build(
            SecretStore.layer.pipe(
              Layer.provide(ServerConfig.layerTest(home, { prefix: "provider-home-private-" })),
            ),
          ),
          SecretStore.ServerSecretStore,
        );
        const reviewer = AuthSessionId.make("provider-home-reviewer");
        const now = yield* DateTime.now;
        const dependencies = Layer.mergeAll(
          Layer.succeed(SecretStore.ServerSecretStore, store),
          Layer.mock(Environment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("provider-home-host")),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: orchestrator.dispatch,
            getThreadRecords: orchestrator.getThreadRecords,
          }),
          Layer.mock(SessionStore.SessionStore)({
            cookieName: "test",
            legacyCookieName: undefined,
            listActive: () =>
              Effect.succeed([
                {
                  sessionId: reviewer,
                  subject: "test",
                  method: "browser-session-cookie",
                  scopes: ["orchestration:operate", "providers:manage"],
                  client: { label: "Human reviewer", deviceType: "unknown" },
                  issuedAt: now,
                  expiresAt: DateTime.add(now, { days: 2 }),
                  lastConnectedAt: now,
                  connected: true,
                  current: true,
                },
              ]),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
        );
        const service = Context.get(
          yield* Layer.build(Handoffs.layer.pipe(Layer.provide(dependencies))),
          Handoffs.Handoffs,
        );
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        const args = {
          version: 1,
          expectedFingerprint: "private-fingerprint",
          expectedRevision: { epoch: "private-epoch", sequence: 2 },
          originalConfig: "human-only",
        };
        const summary = yield* service.create({
          kind: "approval",
          title: "Use Home",
          reason: "Review the instance route",
          requestedBy: { threadId, providerInstanceId: instanceId, path: "provider.home_request" },
          target: {
            environmentId: EnvironmentId.make("provider-home-host"),
            path: "provider.home_request",
          },
          runId: run.id,
          nodeId: run.rootNodeId!,
          human: { location: "Connect OpenCodex on this host first." },
          args,
        });
        assert.isNotNull(summary.expiresAt);
        const address = { threadId, handoffId: summary.handoffId };
        yield* service.respond({ ...address, action: "completed" }, reviewer);
        const restarted = Context.get(
          yield* Layer.build(Layer.fresh(Handoffs.layer).pipe(Layer.provide(dependencies))),
          Handoffs.Handoffs,
        );
        const continuations = yield* restarted.completedProviderHomeContinuations;
        assert.equal(continuations.length, 1);
        assert.deepStrictEqual(continuations[0]?.args, args);
        assert.equal(continuations[0]?.approvedBySessionId, reviewer);
        assert.deepStrictEqual(yield* restarted.completedSshContinuations, []);
        const publicRecord = yield* encodeHandoff(yield* restarted.read(address));
        assert.notInclude(JSON.stringify(publicRecord), "private-fingerprint");
        assert.notInclude(JSON.stringify(publicRecord), reviewer);
        yield* restarted.finishProviderHomeContinuation(address);
        assert.deepStrictEqual(yield* restarted.completedProviderHomeContinuations, []);
      }),
    ),
);
it.effect(
  "provider settings progress survives restart and its outcome stays readable for a day",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-provider-progress-" });
        const store = Context.get(
          yield* Layer.build(
            SecretStore.layer.pipe(
              Layer.provide(ServerConfig.layerTest(home, { prefix: "provider-progress-" })),
            ),
          ),
          SecretStore.ServerSecretStore,
        );
        const reviewer = AuthSessionId.make("provider-settings-reviewer");
        const now = yield* DateTime.now;
        const dependencies = Layer.mergeAll(
          Layer.succeed(SecretStore.ServerSecretStore, store),
          Layer.mock(Environment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("provider-settings-host")),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: orchestrator.dispatch,
            getThreadRecords: orchestrator.getThreadRecords,
          }),
          Layer.mock(SessionStore.SessionStore)({
            cookieName: "test",
            legacyCookieName: undefined,
            listActive: () =>
              Effect.succeed([
                {
                  sessionId: reviewer,
                  subject: "test",
                  method: "browser-session-cookie",
                  scopes: ["orchestration:operate", "providers:manage"],
                  client: { label: "Human reviewer", deviceType: "unknown" },
                  issuedAt: now,
                  expiresAt: DateTime.add(now, { days: 2 }),
                  lastConnectedAt: now,
                  connected: true,
                  current: true,
                },
              ]),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
        );
        const start = Layer.build(
          Layer.fresh(Handoffs.layer).pipe(Layer.provide(dependencies)),
        ).pipe(Effect.map((context) => Context.get(context, Handoffs.Handoffs)));
        const service = yield* start;
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        const summary = yield* service.create({
          kind: "approval",
          title: "Change provider settings?",
          reason: "An agent asked",
          requestedBy: { threadId, providerInstanceId: instanceId, path: "provider.settings" },
          target: {
            environmentId: EnvironmentId.make("provider-settings-host"),
            path: "provider.settings",
          },
          runId: run.id,
          nodeId: run.rootNodeId!,
          human: { location: "Add Devin." },
          args: { version: 1 },
        });
        const address = { threadId, handoffId: summary.handoffId };
        const recordBeforeApproval = yield* Effect.flip(
          service.recordProviderProgress(address, { step: "early" }),
        );
        assert.equal(recordBeforeApproval.reason, "invalid_request");
        yield* service.respond({ ...address, action: "completed" }, reviewer);
        yield* service.recordProviderProgress(address, { effects: { install: "done" } });

        const restarted = yield* start;
        const [continuation] = yield* restarted.completedProviderContinuations("provider.settings");
        assert.deepStrictEqual(continuation?.progress, { effects: { install: "done" } });
        assert.deepStrictEqual(continuation?.args, { version: 1 });

        const settled = {
          effects: { install: "done", save: "done" },
          outcome: { state: "applied" },
        };
        yield* restarted.finishProviderContinuation(address, settled);
        assert.deepStrictEqual(
          yield* restarted.completedProviderContinuations("provider.settings"),
          [],
        );
        assert.deepStrictEqual(yield* restarted.readProviderProgress(address), settled);
        yield* TestClock.adjust("25 hours");
        assert.isUndefined(yield* restarted.readProviderProgress(address));
      }),
    ),
);

it.effect(
  "provider Home approval survives its requesting run and expires after fifteen minutes",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const record: Handoff = {
        handoffId: TurnItemId.make("provider-home-ttl"),
        kind: "approval",
        title: "Use Home",
        reason: "Review",
        requestedBy: { threadId, providerInstanceId: instanceId, path: "provider.home_request" },
        target: { environmentId: EnvironmentId.make("host"), path: "provider.home_request" },
        dedupeKey: "private-hash",
        state: "pending",
        createdAt: now,
        expiresAt: DateTime.add(now, { minutes: 15 }),
        actor: { type: "agent", threadId },
      };
      assert.equal(
        (yield* transitionHandoff(
          record,
          "opened",
          { type: "client", label: "Human" },
          DateTime.add(now, { minutes: 1 }),
          true,
        )).state,
        "opened",
      );
      assert.equal(
        (yield* transitionHandoff(
          record,
          "completed",
          { type: "client", label: "Human" },
          DateTime.add(now, { minutes: 16 }),
          false,
        )).state,
        "expired",
      );
    }),
);

it.effect(
  "computer use grants: settings:write approves, one thread per host, ending early and expiry end the lease",
  () =>
    withHarness(({ orchestrator, worker }) =>
      Effect.gen(function* () {
        const otherThread = ThreadId.make("thread:handoff-tests-other");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-other-thread"),
          threadId: otherThread,
          projectId: ProjectId.make("project:handoff-tests"),
          title: "Scheduled check",
          modelSelection: { instanceId, model: "fake" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "system",
          creationSource: "server",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-other-run"),
          threadId: otherThread,
          messageId: MessageId.make("message:other"),
          text: "Look at the screen",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "system",
          creationSource: "server",
        });
        yield* worker.drain();
        const stored = new Map<string, Uint8Array>();
        const now = yield* DateTime.now;
        const session = (id: string, permissions: NonNullable<AuthClientSession["permissions"]>) =>
          ({
            sessionId: AuthSessionId.make(id),
            subject: "test",
            method: "browser-session-cookie",
            scopes: ["orchestration:operate"],
            permissions,
            client: { label: id, deviceType: "unknown" },
            issuedAt: now,
            expiresAt: DateTime.add(now, { days: 1 }),
            lastConnectedAt: now,
            connected: true,
            current: true,
          }) satisfies AuthClientSession;
        const owner = session("owner", ["orchestration:operate", "settings:write"]);
        const operator = session("operator", ["orchestration:operate"]);
        const environmentId = EnvironmentId.make("test-environment");
        const dependencies = Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: orchestrator.dispatch,
            getThreadRecords: orchestrator.getThreadRecords,
          }),
          Layer.mock(SessionStore.SessionStore)({
            cookieName: "test",
            legacyCookieName: undefined,
            listActive: () => Effect.succeed([owner, operator]),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(Environment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(environmentId),
          }),
          Layer.succeed(
            SecretStore.ServerSecretStore,
            SecretStore.ServerSecretStore.of({
              get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
              set: (name, value) => Effect.sync(() => void stored.set(name, value)),
              create: (name, value) => Effect.sync(() => void stored.set(name, value)),
              remove: (name) => Effect.sync(() => void stored.delete(name)),
              getOrCreateRandom: (name, size) =>
                Effect.sync(() => {
                  const bytes = stored.get(name) ?? new Uint8Array(size).fill(7);
                  stored.set(name, bytes);
                  return bytes;
                }),
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* Handoffs.Handoffs;
          const leases = yield* ComputerUseLeases.ComputerUseLeases;
          const wake = yield* leases.subscribe;
          const ask = (thread: ThreadId) =>
            Effect.gen(function* () {
              const run = (yield* orchestrator.getThreadProjection(thread)).runs.at(-1)!;
              return yield* service.create({
                kind: "approval",
                title: "Allow computer use on test-host?",
                reason: "Check the build status window",
                requestedBy: {
                  threadId: thread,
                  providerInstanceId: instanceId,
                  path: COMPUTER_USE_GRANT_HANDOFF_PATH,
                },
                target: { environmentId, path: COMPUTER_USE_GRANT_HANDOFF_PATH },
                runId: run.id,
                nodeId: run.rootNodeId!,
                human: { location: "test-host until 00:30" },
                args: { purpose: "check", minutes: 30 },
                expiresAt: DateTime.add(yield* DateTime.now, { minutes: 30 }),
              });
            });
          const first = yield* ask(threadId);
          const second = yield* ask(otherThread);
          yield* worker.drain();
          const firstAddress = { threadId, handoffId: first.handoffId };
          const secondAddress = { threadId: otherThread, handoffId: second.handoffId };
          // Admission needs the same authority as turning computer use on.
          assert.equal(
            (yield* service
              .respond({ ...firstAddress, action: "completed" }, operator.sessionId)
              .pipe(Effect.result))._tag,
            "Failure",
          );
          yield* service.respond({ ...firstAddress, action: "completed" }, owner.sessionId);
          yield* PubSub.take(wake);
          const lease = yield* leases.active(threadId);
          assert.isTrue(Option.isSome(lease));
          assert.deepEqual(yield* leases.holder(otherThread), lease);
          // A second unattended thread waits for the holder.
          const refused = yield* service
            .respond({ ...secondAddress, action: "completed" }, owner.sessionId)
            .pipe(Effect.result);
          assert.equal(refused._tag, "Failure");
          // Ending early is a durable transition every client sees, and it wakes proxies.
          const ended = yield* service.respond(
            { ...firstAddress, action: "cancelled" },
            owner.sessionId,
          );
          assert.equal(ended.state, "cancelled");
          yield* PubSub.take(wake);
          assert.isTrue(Option.isNone(yield* leases.active(threadId)));
          assert.deepEqual(yield* leases.state(threadId, first.handoffId), {
            _tag: "ended",
            reason: "revoked",
          });
          yield* service.respond({ ...secondAddress, action: "completed" }, owner.sessionId);
          assert.equal((yield* leases.state(otherThread, second.handoffId))._tag, "active");
          yield* TestClock.adjust("30 minutes");
          assert.deepEqual(yield* leases.state(otherThread, second.handoffId), {
            _tag: "ended",
            reason: "expired",
          });
          assert.isTrue(Option.isNone(yield* leases.holder()));
        }).pipe(
          Effect.provide(
            Handoffs.layer.pipe(
              Layer.provideMerge(ComputerUseLeases.layer),
              Layer.provide(dependencies),
            ),
          ),
        );
      }),
    ),
);
