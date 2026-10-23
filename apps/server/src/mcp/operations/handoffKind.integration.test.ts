import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  type HandoffReadInput,
  ThreadId,
  type TurnItemId,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema } from "effect/ai";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import type * as Handoffs from "../../handoffs/Handoffs.ts";
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
const processOver = <E, R>(start: Effect.Effect<Handoffs.Handoffs["Service"], E, R>) =>
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
