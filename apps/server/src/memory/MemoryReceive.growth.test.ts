import { assert, it, describe } from "@effect/vitest";
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
          const ms = yield* Effect.gen(function* () {
            const storage = yield* Store.MemoryStore;
            assert.strictEqual((yield* storage.usage(space, { kind: "user" })).spaceItems, 0);
            // oxlint-disable-next-line goat/no-wall-clock-in-tests -- GOAT_MEMORY_GROWTH gates this throughput benchmark; real elapsed time is the quantity being measured.
            const start = performance.now();
            for (let n = 0; n < count; n++) yield* receive(operation(n, fixture.chain), n);
            // oxlint-disable-next-line goat/no-wall-clock-in-tests -- GOAT_MEMORY_GROWTH gates this throughput benchmark; preserve the measured scaling ratio.
            const elapsed = performance.now() - start;
            yield* check;
            const usage = yield* storage.usage(space, { kind: "user" });
            assert.strictEqual(usage.spaceItems, fixture.chain ? 1 : count);
            assert.strictEqual(usage.logRows, count);
            return elapsed;
          }).pipe(Effect.provide(live));
          samples.push(ms);
          yield* Console.log(
            "RECEIVE_SAMPLE " + JSON.stringify({ chain: fixture.chain, count, ms }),
          );
        }
        const ratio = samples[1]! / samples[0]!;
        yield* Console.log(
          "RECEIVE_RATIO " +
            JSON.stringify(fixture.chain ? { chain: ratio } : { independent: ratio }),
        );
        // Large samples absorb startup/JIT noise; optional scheduled benchmark, no millisecond deadline.
        if (!fixture.chain && process.env.GOAT_RECEIVE_BASELINE !== "1")
          assert.isBelow(ratio, 3.25);
      }).pipe(Effect.provideService(Console.Console, console)),
    { timeout: 1500000 },
  );
});
