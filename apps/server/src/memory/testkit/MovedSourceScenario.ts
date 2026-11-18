import { assert } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Client from "../MemoryHubClient.ts";
import * as Service from "../MemoryService.ts";
import type { SourceFixture } from "../MemoryHubSyncScenarios.test.ts";

export const movedSourceScenario = Effect.fn("TestMemory.movedSourceScenario")(function* (
  c: SourceFixture,
) {
  const resultGate = yield* Deferred.make<void>();
  c.a.blockSourceResult(resultGate);
  const held = yield* c.a.sync.readSource(c.validated, Effect.void).pipe(Effect.forkScoped);
  yield* Deferred.await(c.a.sourceRequested);
  yield* c.owner.sync.syncOnce;

  const ownerConnection = yield* c.owner.connection;
  const move = yield* c.owner.run(
    Client.MemoryHubClient.use((client) =>
      client.push(ownerConnection, {
        protocolVersion: 1,
        memorySpaceId: c.space,
        environmentId: c.owner.identity,
        operations: [
          {
            kind: "move",
            protocolVersion: 1,
            operationId: M.MemoryOperationId.make("00000000-0000-4000-8000-000000009120"),
            memorySpaceId: c.space,
            memoryId: c.target,
            originEnvironmentId: c.owner.identity,
            expectedHeads: [c.sourceOperation.revision.revisionId],
            expectedScopeVersion: 0,
            fromScope: { kind: "user" },
            toScope: { kind: "thread", thread: c.thread },
          },
        ],
      }),
    ),
  );
  assert.strictEqual(move.receipts[0]?.outcome, "accepted");
  yield* Deferred.succeed(resultGate, undefined);
  assert.deepStrictEqual(yield* Fiber.join(held), {
    kind: "unavailable",
    code: "source_invalidated",
  });
  yield* c.a.tick;
  yield* c.owner.tick;

  const read = {
    memorySpaceId: c.space,
    memoryId: c.target,
    sourceThread: c.thread,
    messageIds: [c.messageId, c.assistantId],
    limit: 10,
  };
  const prepare = Service.MemoryService.use((service) =>
    service.prepareSourceRead(read, Effect.void),
  );
  const allowed = yield* c.owner.run(prepare);
  const requesterConnection = yield* c.a.connection;
  const hubAdmission = yield* c.a
    .run(
      Client.MemoryHubClient.use((client) =>
        client.requestSourceRead(requesterConnection, allowed.request),
      ),
    )
    .pipe(Effect.result);
  const requesterPreparation = yield* c.a.run(prepare).pipe(Effect.result);
  assert.strictEqual(hubAdmission._tag, "Failure", "hub must authorize the current memory scope");
  assert.strictEqual(
    requesterPreparation._tag,
    "Failure",
    "preparation must authorize the current memory scope",
  );
  assert.strictEqual(allowed.request.scopeVersion, 1);

  yield* c.owner.commitSourcePolicy({
    allowedRequesterEnvironmentIds: [c.a.identity, c.owner.identity],
    ownerPolicyEpoch: 2,
    removals: [],
    enrollments: [c.a.identity, c.owner.identity].map((requesterEnvironmentId) => ({
      memorySpaceId: c.space,
      ownerEnvironmentId: c.owner.identity,
      requesterEnvironmentId,
      ownerPolicyEpoch: 2,
      state: "active" as const,
    })),
  });
  const outcome = yield* c.owner.sync.readSource(allowed, Effect.void);
  assert.strictEqual(outcome.kind, "available");
  if (outcome.kind === "available")
    assert.deepStrictEqual(outcome.page.messages, [
      { messageId: c.messageId, text: "synthetic original from owner" },
      { messageId: c.assistantId, text: "synthetic completed answer" },
    ]);
});
