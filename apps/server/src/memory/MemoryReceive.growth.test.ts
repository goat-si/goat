import * as NodeSqlite from "node:sqlite";
import { assert, it, describe, vi } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Console from "effect/Console";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Settings from "../serverSettings.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import { memoryOperationDigest } from "./MemoryDecider.ts";
import { scanUsage } from "./MemoryUsageScan.testkit.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const environmentId = M.EnvironmentId.make("fixture");
const database = Layer.effectDiscard(runMigrations()).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const store = Store.layer.pipe(Layer.provideMerge(database));
const serviceLive = (
  serviceLayer = Service.layer,
  readSettings: Settings.MemoryHubCommittedSettings["Service"]["read"] = Effect.succeed({
    provenance: null,
    settings: { mode: "hub" as const, memorySpaceId: space },
    version: 1,
  }),
) =>
  serviceLayer.pipe(
    Layer.provide(
      Layer.succeed(Settings.MemoryHubCommittedSettings, {
        read: readSettings,
      }),
    ),
    Layer.provide(
      Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(null),
      }),
    ),
    Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(store))),
    Layer.provide(
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
  );
const live = serviceLive();

const decodeOperation = Schema.decodeUnknownSync(M.MemoryOperation);
const operation = (n: number, chain = false): M.MemoryOperation =>
  decodeOperation({
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId: id(chain ? 10 : 10000 + n),
    operationId: id(20000 + n),
    originEnvironmentId: environmentId,
    expectedHeads: chain && n > 0 ? [id(30000 + n - 1)] : [],
    kind: "upsert",
    revision: {
      memorySpaceId: space,
      memoryId: id(chain ? 10 : 10000 + n),
      revisionId: id(30000 + n),
      operationId: id(20000 + n),
      parents: chain && n > 0 ? [id(30000 + n - 1)] : [],
      scope: { kind: "user" },
      payloadRef: id(30000 + n),
      assertionKind: "inference",
      provenance: { environmentId },
      createdAtUtc: "2026-10-14T00:00:00.000Z",
    },
    payload: {
      text: "synthetic receive performance fixture",
      evidence: [],
      derivedFromMemoryRevisions: [],
    },
  });
const receive = (op: M.MemoryOperation, n: number) =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    return yield* service.applyReceived(op, {
      operationId: op.operationId,
      memoryId: op.memoryId,
      operationDigest: memoryOperationDigest(op),
      outcome: "accepted",
      hubSequence: n + 1,
    });
  });
const check = Effect.gen(function* () {
  const storage = yield* Store.MemoryStore;
  assert.deepStrictEqual(
    yield* storage.usage(space, { kind: "user" }),
    yield* scanUsage(space, { kind: "user" }),
  );
});

// StatementSync.stat (Node 26) is not in @types/node 24.
const vmStep = (statement: NodeSqlite.StatementSync) =>
  (statement as unknown as { stat(counter: "vmStep"): number }).stat("vmStep");
// SQLite's VM steps measure the SQL work receive does, however busy the runner is.
const countVmSteps = <E, R>(effect: Effect.Effect<void, E, R>) =>
  Effect.suspend(() => {
    let steps = 0;
    const counted = (method: "all" | "run") => {
      const original = NodeSqlite.StatementSync.prototype[method];
      return vi.spyOn(NodeSqlite.StatementSync.prototype, method).mockImplementation(function (
        this: NodeSqlite.StatementSync,
        ...args: Array<unknown>
      ) {
        const before = vmStep(this);
        try {
          return Reflect.apply(original, this, args);
        } finally {
          steps += vmStep(this) - before;
        }
      });
    };
    return Effect.acquireUseRelease(
      Effect.sync(() => [counted("all"), counted("run")]),
      () => Effect.map(effect, () => steps),
      (spies) => Effect.sync(() => spies.forEach((spy) => spy.mockRestore())),
    );
  });

describe.runIf(process.env.GOAT_MEMORY_GROWTH === "1")("service receive scaling", () => {
  // oxlint-disable-next-line goat/no-test-timeout-or-unreasoned-skip -- Opt-in GOAT_MEMORY_GROWTH benchmark measures thousands of SQLite receives and full chain growth.
  it.effect.each([
    { chain: false, counts: [1000, 2000], label: "1k / 2k independent memories" },
    { chain: true, counts: [250, 500], label: "long chain 250 / 500 revisions" },
  ])(
    "$label",
    (fixture) =>
      Effect.gen(function* () {
        const samples: number[] = [];
        for (const count of fixture.counts) {
          const vmSteps = yield* Effect.gen(function* () {
            const storage = yield* Store.MemoryStore;
            assert.strictEqual((yield* storage.usage(space, { kind: "user" })).spaceItems, 0);
            const steps = yield* countVmSteps(
              Effect.gen(function* () {
                for (let n = 0; n < count; n++) yield* receive(operation(n, fixture.chain), n);
              }),
            );
            yield* check;
            const usage = yield* storage.usage(space, { kind: "user" });
            assert.strictEqual(usage.spaceItems, fixture.chain ? 1 : count);
            assert.strictEqual(usage.logRows, count);
            return steps;
          }).pipe(Effect.provide(live));
          samples.push(vmSteps);
          yield* Console.log(
            "RECEIVE_SAMPLE " +
              JSON.stringify({ chain: fixture.chain, count, vmSteps, perMemory: vmSteps / count }),
          );
        }
        // Fit steps(n) = a·n + c·n² to both samples; a receive that spends k steps per stored row gives c = k/2.
        const [small, large] = fixture.counts as [number, number];
        const perStored =
          (samples[1]! * small - samples[0]! * large) / (small * large * (large - small));
        yield* Console.log("RECEIVE_GROWTH " + JSON.stringify({ chain: fixture.chain, perStored }));
        // Receive already walks the space's events for forget-fragment links (store/ImportLineage.ts), c ≈ 3; any other
        // scan of every stored row costs at least a step per row and adds 0.5 or more. This guards SQL work only.
        if (!fixture.chain && process.env.GOAT_RECEIVE_BASELINE !== "1")
          assert.isBelow(perStored, 3.5);
      }).pipe(Effect.provideService(Console.Console, console)),
    { timeout: 1500000 },
  );
});
