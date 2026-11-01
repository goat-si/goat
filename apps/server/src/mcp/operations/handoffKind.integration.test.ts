import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  type HandoffReadInput,
  ThreadId,
  type TurnItemId,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema } from "effect/ai";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as HandoffsService from "../../handoffs/Handoffs.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import {
  durableHandoffs,
  instanceId,
  threadId,
  withHarness,
} from "../../handoffs/Handoffs.testkit.ts";
import { McpInvocationContext, type McpInvocationScope } from "../McpInvocationContext.ts";
import { ToolDispatch } from "../ToolDispatch.ts";
import { makeOperations } from "../toolkits/agentSurface/operations.ts";
import { makeHandoffReader } from "./handoffReads.ts";
import { makeOperationTokens } from "./OperationTokens.ts";

const environmentId = EnvironmentId.make("operations-environment");
const reviewer = AuthSessionId.make("operations-reviewer");
const asThread = (thread: string): McpInvocationScope => ({
  environmentId,
  requestNamespace: "test",
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 0,
  grantedScopes: [],
  reauthorize: () => Effect.void,
  thread: {
    threadId: ThreadId.make(thread),
    providerSessionId: "provider-session",
    providerInstanceId: instanceId,
  },
  client: undefined,
});
const owner = asThread(threadId);
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "handoff-kind", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "handoff-kind", version: "1" },
  },
  getClient: Effect.die("unused"),
});
// The handoff kind reads its store directly; no tool is dispatched.
const noTools = ToolDispatch.of({
  call: () => Effect.die("the handoff kind dispatches no tool"),
  served: () => undefined,
});
const key = Layer.mock(ServerSecretStore.ServerSecretStore)({
  getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(5)),
});

/** A server process: fresh Handoffs and fresh token signer over the same stores. */
const processOver = <E, R>(start: Effect.Effect<HandoffsService.Handoffs["Service"], E, R>) =>
  Effect.gen(function* () {
    const handoffs = yield* start;
    const tokens = yield* makeOperationTokens.pipe(Effect.provide(key));
    return {
      handoffs,
      operations: makeOperations(noTools, tokens, makeHandoffReader(Option.some(handoffs))),
    };
  });
const as =
  (scope: McpInvocationScope) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
const appliedOutcome = {
  version: 1,
  effects: { install: "done", save: "done" },
  outcome: {
    state: "applied",
    result: {
      kind: "applied",
      action: "add",
      instance: null,
      next: { call: "goat_provider_diagnose" },
    },
  },
} as const;

/**
 * One server process for operation.wait over real provider change handoffs. `reads` takes one entry
 * per finished handoff read, so a test advances the clock only once the waiter is between polls.
 */
const waitOver = (orchestrator: Parameters<typeof durableHandoffs>[0]) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const durable = yield* durableHandoffs(orchestrator, {
      environmentId,
      sessions: Effect.succeed([
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
    });
    const handoffs = yield* durable.start;
    const tokens = yield* makeOperationTokens.pipe(Effect.provide(key));
    const reads = yield* Queue.unbounded<string>();
    const readHandoff = makeHandoffReader(Option.some(handoffs));
    const operations = makeOperations(noTools, tokens, (handoffId) =>
      readHandoff(handoffId).pipe(Effect.tap(() => Queue.offer(reads, handoffId))),
    );
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    const ask = (title: string, expiresAt?: DateTime.Utc) =>
      Effect.gen(function* () {
        const summary = yield* handoffs.create({
          kind: "approval",
          title,
          reason: "An agent asked",
          requestedBy: { threadId, providerInstanceId: instanceId, path: "provider.settings" },
          target: { environmentId, path: "provider.settings" },
          runId: run.id,
          nodeId: run.rootNodeId!,
          human: { location: "Add Devin." },
          args: { title },
          ...(expiresAt === undefined ? {} : { expiresAt }),
        });
        const operationId = yield* tokens.issue("handoff", summary.handoffId, owner);
        return { address: { threadId, handoffId: summary.handoffId }, operationId };
      });
    const wait = (operationId: string, timeoutMs?: number) =>
      Effect.forkChild(operations.wait({ operationId, timeoutMs }).pipe(as(owner)));
    return { handoffs, operations, reads, ask, wait };
  });

it.effect("reads an approved provider change as applying, then applied, across a restart", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const durable = yield* durableHandoffs(orchestrator, {
        environmentId,
        sessions: Effect.succeed([
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
      });
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      const first = yield* processOver(durable.start);
      const ask = (title: string) =>
        first.handoffs.create({
          kind: "approval",
          title,
          reason: "An agent asked",
          requestedBy: { threadId, providerInstanceId: instanceId, path: "provider.settings" },
          target: { environmentId, path: "provider.settings" },
          runId: run.id,
          nodeId: run.rootNodeId!,
          human: { location: "Add Devin." },
          args: { title },
        });
      // goat_call's needs_human result for goat_provider_add carries the handle.
      const handleFor = (summary: Effect.Success<ReturnType<typeof ask>>) =>
        first.operations
          .withOperation(agentSurfaceRegistry["provider.add"], {
            status: "needs_human",
            handoff: {
              handoffId: summary.handoffId,
              kind: summary.kind,
              title: summary.title,
              state: summary.state,
              expiresAt: null,
              targetPath: summary.targetPath,
            },
          })
          .pipe(
            as(owner),
            Effect.map((result) => result.meta!.operation!),
          );
      const addressOf = (handoffId: TurnItemId): HandoffReadInput => ({ threadId, handoffId });

      const applied = yield* ask("Add Devin?");
      const appliedRef = yield* handleFor(applied);
      expect(appliedRef).toMatchObject({
        kind: "handoff",
        state: "waiting_human",
        handoffId: applied.handoffId,
        cancellable: false,
      });
      yield* first.handoffs.respond(
        { ...addressOf(applied.handoffId), action: "completed" },
        reviewer,
      );
      yield* first.handoffs.recordProviderProgress(addressOf(applied.handoffId), {
        version: 1,
        effects: { install: "started" },
      });

      // Restart: approved, not yet applied, and the record survives.
      const second = yield* processOver(durable.start);
      const read = (operationId: string) => second.operations.read({ operationId }).pipe(as(owner));
      const applying = yield* read(appliedRef.operationId);
      expect(applying).toMatchObject({
        operation: { state: "running" },
        result: {
          status: "ok",
          value: {
            handoff: { state: "completed" },
            applying: true,
            change: { effects: { install: "started" } },
          },
        },
      });
      yield* second.handoffs.finishProviderContinuation(addressOf(applied.handoffId), {
        version: 1,
        effects: { install: "done", save: "done" },
        outcome: {
          state: "applied",
          result: {
            kind: "applied",
            action: "add",
            instance: null,
            next: { call: "goat_provider_diagnose" },
          },
        },
      });
      expect((yield* read(appliedRef.operationId)).operation.state).toBe("succeeded");

      // Approved, but whether it applied is unknown: the outcome names the read that settles it.
      const uncertain = yield* ask("Update Devin?");
      const uncertainRef = yield* handleFor(uncertain);
      yield* second.handoffs.respond(
        { ...addressOf(uncertain.handoffId), action: "completed" },
        reviewer,
      );
      const reconcile = { call: "goat_provider_diagnose", arguments: { instanceId: "devin" } };
      yield* second.handoffs.finishProviderContinuation(addressOf(uncertain.handoffId), {
        version: 1,
        effects: { save: "started" },
        outcome: {
          state: "unknown_outcome",
          effect: "save",
          reason: "effect_unconfirmed",
          message: "The save may have landed.",
          reconcile,
        },
      });
      expect(yield* read(uncertainRef.operationId)).toMatchObject({
        operation: { state: "unknown" },
        result: { value: { change: { outcome: { state: "unknown_outcome", reconcile } } } },
      });

      const declined = yield* ask("Remove Devin?");
      const declinedRef = yield* handleFor(declined);
      yield* second.handoffs.respond(
        { ...addressOf(declined.handoffId), action: "declined" },
        reviewer,
      );
      expect((yield* read(declinedRef.operationId)).operation.state).toBe("cancelled");

      // Another thread holds neither the handle nor the handoff.
      const stranger = yield* Effect.flip(
        second.operations.read({ operationId: appliedRef.operationId }),
      ).pipe(as(asThread("thread:stranger")));
      expect(stranger).toMatchObject({ reason: "not_found" });
    }),
  ),
);

it.effect(
  "waits through approval and application, and succeeds only once applied is recorded",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const { handoffs, reads, ask, wait } = yield* waitOver(orchestrator);
        const change = yield* ask("Add Devin?");
        const waiting = yield* wait(change.operationId);
        yield* Queue.take(reads);

        // Approved: the change is applying, so the wait keeps reading.
        yield* handoffs.respond({ ...change.address, action: "completed" }, reviewer);
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(reads);
        expect(waiting.pollUnsafe()).toBeUndefined();
        yield* handoffs.recordProviderProgress(change.address, {
          version: 1,
          effects: { install: "started" },
        });
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(reads);
        expect(waiting.pollUnsafe()).toBeUndefined();

        yield* handoffs.finishProviderContinuation(change.address, appliedOutcome);
        yield* TestClock.adjust("3 seconds");
        const done = yield* Fiber.join(waiting);
        expect(done).toMatchObject({
          operation: { state: "succeeded" },
          result: {
            value: { handoff: { state: "completed" }, change: { outcome: { state: "applied" } } },
          },
        });
        expect(done).not.toHaveProperty("timedOut");
      }),
    ),
);

it.effect(
  "ends a wait as cancelled when the person declines, and failed when the ask expires",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const { handoffs, reads, ask, wait } = yield* waitOver(orchestrator);
        const declined = yield* ask("Remove Devin?");
        const waitingDecline = yield* wait(declined.operationId);
        yield* Queue.take(reads);
        yield* handoffs.respond({ ...declined.address, action: "declined" }, reviewer);
        yield* TestClock.adjust("3 seconds");
        // Consume the terminal read, so the expiry wait below starts from an empty queue.
        yield* Queue.take(reads);
        expect(yield* Fiber.join(waitingDecline)).toMatchObject({
          operation: { state: "cancelled" },
          result: { value: { handoff: { state: "declined" } } },
        });

        const unanswered = yield* ask(
          "Update Devin?",
          DateTime.add(yield* DateTime.now, { seconds: 3 }),
        );
        const waitingExpiry = yield* wait(unanswered.operationId);
        yield* Queue.take(reads);
        // Past its deadline the ask stays pending until the expiry sweep records it.
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(reads);
        expect(waitingExpiry.pollUnsafe()).toBeUndefined();
        yield* handoffs.sweep;
        yield* TestClock.adjust("3 seconds");
        expect(yield* Fiber.join(waitingExpiry)).toMatchObject({
          operation: { state: "failed" },
          result: { value: { handoff: { state: "expired" } } },
        });
      }),
    ),
);

it.effect(
  "times out only the observer: the change keeps applying and a later wait sees it applied",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const { handoffs, operations, reads, ask, wait } = yield* waitOver(orchestrator);
        const change = yield* ask("Add Devin?");
        yield* handoffs.respond({ ...change.address, action: "completed" }, reviewer);
        const progress = { version: 1, effects: { install: "started" } };
        yield* handoffs.recordProviderProgress(change.address, progress);

        const observer = yield* wait(change.operationId, 5_000);
        yield* Queue.take(reads);
        yield* TestClock.adjust("3 seconds");
        yield* Queue.take(reads);
        yield* TestClock.adjust("2 seconds");
        expect(yield* Fiber.join(observer)).toMatchObject({
          operation: { state: "running" },
          result: { value: { applying: true } },
          timedOut: true,
        });
        expect(yield* handoffs.readProviderContinuation(change.address)).toMatchObject({
          handoff: { state: "completed" },
          applying: true,
          progress,
        });

        yield* handoffs.finishProviderContinuation(change.address, appliedOutcome);
        const later = yield* Fiber.join(yield* wait(change.operationId));
        expect(later.operation.state).toBe("succeeded");
        expect(later).not.toHaveProperty("timedOut");
        const read = yield* operations.read({ operationId: change.operationId }).pipe(as(owner));
        expect(read.operation.state).toBe("succeeded");
      }),
    ),
);
it.effect(
  "reads a change in one observation, keeps its plan and arguments private, and stays in its thread",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-handoff-kind-" });
        const store = Context.get(
          yield* Layer.build(
            ServerSecretStore.layer.pipe(
              Layer.provide(ServerConfig.layerTest(home, { prefix: "handoff-kind-" })),
            ),
          ),
          ServerSecretStore.ServerSecretStore,
        );
        // While closed, loading a handoff payload waits, so a finish can land mid-read.
        let closed = false;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const gated = ServerSecretStore.ServerSecretStore.of({
          ...store,
          get: (name) =>
            closed && name.startsWith("handoff-")
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(store.get(name)),
                )
              : store.get(name),
        });
        const now = yield* DateTime.now;
        const handoffs = Context.get(
          yield* Layer.build(
            Layer.fresh(HandoffsService.layer).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(ServerSecretStore.ServerSecretStore, gated),
                  Layer.mock(Environment.ServerEnvironment)({
                    getEnvironmentId: Effect.succeed(environmentId),
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
                ),
              ),
            ),
          ),
          HandoffsService.Handoffs,
        );
        const tokens = yield* makeOperationTokens.pipe(Effect.provide(key));
        const operations = makeOperations(
          noTools,
          tokens,
          makeHandoffReader(Option.some(handoffs)),
        );
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        const approved = (title: string) =>
          Effect.gen(function* () {
            const summary = yield* handoffs.create({
              kind: "approval",
              title,
              reason: "An agent asked",
              requestedBy: { threadId, providerInstanceId: instanceId, path: "provider.settings" },
              target: { environmentId, path: "provider.settings" },
              runId: run.id,
              nodeId: run.rootNodeId!,
              human: { location: "Add Devin." },
              args: { title, token: "ARG-SENTINEL" },
            });
            const address = { threadId, handoffId: summary.handoffId };
            yield* handoffs.respond({ ...address, action: "completed" }, reviewer);
            const issued = yield* tokens.issue("handoff", summary.handoffId, owner);
            return { address, operationId: issued };
          });
        const read = (operationId: string) => operations.read({ operationId }).pipe(as(owner));

        const change = yield* approved("Add Devin?");
        yield* handoffs.recordProviderProgress(change.address, {
          version: 1,
          plan: {
            instanceId: "devin",
            instance: { driver: "codex", displayName: "PLAN-SENTINEL" },
            install: false,
          },
          effects: { save: "started" },
        });
        const applying = yield* read(change.operationId);
        expect(applying.operation.state).toBe("running");
        expect(JSON.stringify(applying)).not.toMatch(/SENTINEL/);

        // The change finishes after the read checked the thread and before it loaded the payload.
        closed = true;
        const reading = yield* Effect.forkChild(read(change.operationId));
        yield* Deferred.await(entered);
        yield* handoffs.finishProviderContinuation(change.address, {
          version: 1,
          plan: {
            instanceId: "devin",
            instance: { driver: "codex", displayName: "PLAN-SENTINEL" },
            install: false,
          },
          effects: { save: "done" },
          outcome: {
            state: "applied",
            result: {
              kind: "applied",
              action: "add",
              instance: null,
              next: { call: "goat_provider_diagnose" },
            },
          },
        });
        yield* Deferred.succeed(release, undefined);
        const finished = yield* Fiber.join(reading);
        closed = false;
        expect(finished.operation.state).toBe("succeeded");
        expect(JSON.stringify(finished)).not.toMatch(/SENTINEL/);

        // Approved, and its record is gone: GOAT cannot say whether it applied.
        const lost = yield* approved("Update Devin?");
        yield* handoffs.finishProviderContinuation(lost.address);
        expect((yield* read(lost.operationId)).operation.state).toBe("unknown");

        // The service itself refuses another thread's handoff.
        const foreign = yield* Effect.flip(
          handoffs.readProviderContinuation({
            threadId: ThreadId.make("thread:stranger"),
            handoffId: change.address.handoffId,
          }),
        );
        expect(foreign).toMatchObject({ reason: "not_found" });
      }),
    ),
);
