import { assert, it } from "@effect/vitest";
import type { SshHostResult } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

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
