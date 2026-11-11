import { assert, it } from "@effect/vitest";
import type { SshHostResult } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SessionStore from "../auth/SessionStore.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import {
  computerUseGrantClients,
  instanceId,
  threadId,
  withHarness,
} from "../handoffs/Handoffs.testkit.ts";
import type * as SshRemoteDispatch from "./SshRemoteDispatch.ts";
import { cancelStaleRuntimeUpdates } from "./staleRuntimeUpdates.ts";

const setupRecord = { operationId: "op-1", generation: 0 };

it.effect(
  "a pending runtime update for a host that already runs the requested version is cancelled by the server",
  () =>
    withHarness(({ orchestrator, worker }) =>
      Effect.gen(function* () {
        const { environmentId, dependencies } = yield* computerUseGrantClients(orchestrator);
        yield* Effect.gen(function* () {
          const handoffs = yield* Handoffs.Handoffs;
          const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
          const asked = yield* handoffs.create({
            kind: "approval",
            title: "Update runtime on lidge?",
            reason: "Running agent work gets up to a minute to finish.",
            requestedBy: { threadId, providerInstanceId: instanceId, path: "ssh.runtime_update" },
            target: { environmentId, path: "ssh.runtime_update" },
            runId: run.id,
            nodeId: run.rootNodeId!,
            human: { location: "Update GOAT on lidge now." },
            args: {
              version: 1,
              step: "runtime_update",
              host: "lidge",
              operationId: "op-1",
              aliasGeneration: 0,
              requestedVersion: "0.1.9",
            },
            expiresAt: DateTime.add(yield* DateTime.now, { hours: 24 }),
            sshProgress: {
              host: "lidge",
              operationId: "op-1",
              aliasGeneration: 0,
              environmentId,
              threadId,
            },
          });
          let runtimeVersion = "0.1.8";
          const published: Array<string> = [];
          const setup = {
            status: () =>
              Effect.sync((): SshHostResult => ({
                kind: "ok",
                status: {
                  host: "lidge",
                  state: "ready",
                  runtimeVersion,
                  requestedVersion: "0.1.9",
                  setup: { ...setupRecord, stage: "runtime" },
                },
              })),
          };
          const dispatch: Option.Option<
            Pick<SshRemoteDispatch.SshRemoteDispatch["Service"], "publishSetupOutcome">
          > = Option.some({
            publishSetupOutcome: (_host, _operation, outcome) =>
              Effect.sync(() => published.push(outcome.kind) > 0),
          });
          const address = { threadId, handoffId: asked.handoffId };

          // Still behind: the person may still want this update.
          yield* cancelStaleRuntimeUpdates(handoffs, setup, dispatch);
          assert.equal((yield* handoffs.read(address)).state, "pending");

          runtimeVersion = "0.1.9";
          yield* cancelStaleRuntimeUpdates(handoffs, setup, dispatch);
          yield* worker.drain();
          const ended = yield* handoffs.read(address);
          assert.equal(ended.state, "cancelled");
          assert.deepEqual(ended.actor, { type: "server" });
          assert.include(ended.resultMessage, "already runs GOAT 0.1.9");
          assert.deepEqual(published, ["complete"]);
          // Its setup does not end as a cancelled or failed one.
          assert.deepEqual(yield* handoffs.resolvedSshOutcomes, []);
        }).pipe(Effect.provide(Handoffs.layer.pipe(Layer.provide(dependencies))));
      }),
    ),
);

it.effect("a person's approval that lands while the sweep runs is kept and still continues", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const { owner, environmentId, dependencies } = yield* computerUseGrantClients(orchestrator);
      yield* Effect.gen(function* () {
        const handoffs = yield* Handoffs.Handoffs;
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        const asked = yield* handoffs.create({
          kind: "approval",
          title: "Update runtime on lidge?",
          reason: "Running agent work gets up to a minute to finish.",
          requestedBy: { threadId, providerInstanceId: instanceId, path: "ssh.runtime_update" },
          target: { environmentId, path: "ssh.runtime_update" },
          runId: run.id,
          nodeId: run.rootNodeId!,
          human: { location: "Update GOAT on lidge now." },
          args: {
            version: 1,
            step: "runtime_update",
            host: "lidge",
            operationId: "op-1",
            aliasGeneration: 0,
            requestedVersion: "0.1.9",
          },
          expiresAt: DateTime.add(yield* DateTime.now, { hours: 24 }),
          sshProgress: {
            host: "lidge",
            operationId: "op-1",
            aliasGeneration: 0,
            environmentId,
            threadId,
          },
        });
        // The sweep read the card while it was open; the person approves before it acts.
        const seen = yield* handoffs.pendingContinuations("ssh.runtime_update");
        yield* handoffs.respond(
          { threadId, handoffId: asked.handoffId, action: "completed" },
          owner.sessionId,
        );
        const published: Array<string> = [];
        const dispatch: Option.Option<
          Pick<SshRemoteDispatch.SshRemoteDispatch["Service"], "publishSetupOutcome">
        > = Option.some({
          publishSetupOutcome: (_host, _operation, outcome) =>
            Effect.sync(() => published.push(outcome.kind) > 0),
        });
        yield* cancelStaleRuntimeUpdates(
          { ...handoffs, pendingContinuations: () => Effect.succeed(seen) },
          {
            status: () =>
              Effect.succeed<SshHostResult>({
                kind: "ok",
                status: {
                  host: "lidge",
                  state: "ready",
                  runtimeVersion: "0.1.9",
                  requestedVersion: "0.1.9",
                  setup: { ...setupRecord, stage: "runtime" },
                },
              }),
          },
          dispatch,
        );
        assert.equal(
          (yield* handoffs.read({ threadId, handoffId: asked.handoffId })).state,
          "completed",
        );
        assert.deepEqual(
          (yield* handoffs.completedSshContinuations).map((entry) => entry.handoff.handoffId),
          [asked.handoffId],
        );
        assert.deepEqual(published, []);
      }).pipe(
        Effect.provide(
          Handoffs.layer.pipe(
            Layer.provide(
              Layer.merge(
                dependencies,
                // SSH approvals take environment:maintain.
                Layer.mock(SessionStore.SessionStore)({
                  cookieName: "test",
                  legacyCookieName: undefined,
                  listActive: () =>
                    Effect.succeed([
                      { ...owner, permissions: [...owner.permissions!, "environment:maintain"] },
                    ]),
                }),
              ),
            ),
          ),
        ),
      );
    }),
  ),
);
