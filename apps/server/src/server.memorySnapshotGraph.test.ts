import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import { markTurnMemoryIncomplete } from "./memory/TurnMemoryReceipts.ts";
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as M from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Digest from "effect/crypto/Digest";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Config from "./config.ts";
import * as Cache from "./memory/MemoryDerivedCache.ts";
import * as Snapshot from "./memory/MemorySnapshot.ts";
import * as Codex from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Server from "./server.ts";

class Hydrated extends Context.Service<
  Hydrated,
  { readonly snapshot: Snapshot.MemorySnapshot["Service"] | undefined }
>()("goat/server.memorySnapshotGraph.test/Hydrated") {}

const threadId = M.ThreadId.make("fixture-thread");
const policy = { grant: "read" as const, policyEpoch: 7 };
const currentPolicy = Effect.succeed(policy);
const execution = { threadId, runId: M.RunId.make("fixture-run") };
const body: M.MemoryContextSnapshot = {
  protocolVersion: 1,
  memorySpaceId: M.MemorySpaceId.make("00000000-0000-4000-8000-000000000001"),
  projectionWatermark: 1,
  items: [],
  renderedText: "fixture-memory",
};

// This is exactly the pre-fix server pipeline. Keeping it runnable lets the red run
// restore ONLY server.ts and observe the adapter context missing the Snapshot.
const compose: typeof Server.provideMemorySnapshot =
  Server.provideMemorySnapshot ??
  ((application, hydration, snapshot) =>
    application.pipe(Layer.provideMerge(snapshot), Layer.provideMerge(hydration)));

const hydration = Layer.effect(
  Hydrated,
  Effect.gen(function* () {
    const captured = Option.getOrUndefined(yield* Effect.serviceOption(Snapshot.MemorySnapshot));
    if (captured) {
      expect(yield* captured.forThread(threadId, policy, currentPolicy)).toBeUndefined();
      expect(yield* captured.revalidate(body, execution, currentPolicy)).toBeUndefined();
      yield* captured.invalidate(threadId);
      yield* (
        captured.recordDelivery?.(threadId, execution.runId, body.memorySpaceId, []) ?? Effect.void
      );
      yield* (
        captured.recordDeliveryUncertain?.(threadId, execution.runId, body.memorySpaceId) ??
          Effect.void
      );
    }
    // Construct the actual Codex adapter in this very context. Opening a CLI is forbidden.
    yield* Codex.makeCodexAdapterV2({
      instanceId: M.ProviderInstanceId.make("codex_fixture"),
      settings: M.CodexSettings.make({
        enabled: false,
        binaryPath: "fixture-forbidden",
        homePath: "",
        shadowHomePath: "",
        launchArgs: "",
        customModels: [],
        modelRoute: "default",
        opencodexBaseUrl: M.DEFAULT_OPENCODEX_BASE_URL,
        opencodexAuth: "openai",
      }),
      environment: {},
      clientFactory: { open: () => Effect.die("fixture must never open a provider") },
      digest: yield* Digest.Digest,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* Config.ServerConfig,
    });
    return { snapshot: captured };
  }),
);
const prerequisites = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  Cache.layer,
  McpProviderSessions.layer,
  Config.layerTest(import.meta.dirname, { prefix: "wp4-compose-graph-" }).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

it.effect("hydration's Codex context and turn-start delegate to one installed Snapshot", () =>
  Effect.gen(function* () {
    let builds = 0;
    const calls: string[] = [];
    const actual = Layer.effect(
      Snapshot.MemorySnapshot,
      Effect.gen(function* () {
        // Models Snapshot → Sync → registry hydration; this cannot build first.
        yield* Hydrated;
        builds++;
        return Snapshot.MemorySnapshot.of({
          recordDelivery: (...args) =>
            Effect.sync(() => {
              expect(args).toEqual([threadId, execution.runId, body.memorySpaceId, []]);
              calls.push("recordDelivery");
            }),
          recordDeliveryUncertain: (...args) =>
            Effect.sync(() => {
              expect(args).toEqual([threadId, execution.runId, body.memorySpaceId]);
              calls.push("recordDeliveryUncertain");
            }),
          forThread: (...args) =>
            Effect.sync(() => {
              expect(args).toEqual([threadId, policy, currentPolicy]);
              calls.push("forThread");
              return body;
            }),
          revalidate: (...args) =>
            Effect.sync(() => {
              expect(args).toEqual([body, execution, currentPolicy]);
              calls.push("revalidate");
              return body;
            }),
          invalidate: (id) =>
            Effect.sync(() => {
              expect(id).toBe(threadId);
              calls.push("invalidate");
            }),
        });
      }),
    );
    const turnStart = Layer.effectDiscard(
      Effect.gen(function* () {
        const adapterContext = yield* Hydrated;
        const snapshot = yield* Snapshot.MemorySnapshot;
        expect(adapterContext.snapshot, "hydration must capture the application proxy").toBe(
          snapshot,
        );
        expect(builds).toBe(1);
        expect(calls).toEqual([]); // all three pre-bind calls were fail-closed
        expect(yield* adapterContext.snapshot!.forThread(threadId, policy, currentPolicy)).toBe(
          body,
        );
        expect(yield* snapshot.forThread(threadId, policy, currentPolicy)).toBe(body);
        expect(yield* snapshot.revalidate(body, execution, currentPolicy)).toBe(body);
        yield* adapterContext.snapshot!.invalidate(threadId);
        yield* (
          snapshot.recordDelivery?.(threadId, execution.runId, body.memorySpaceId, []) ??
            Effect.void
        );
        yield* (
          snapshot.recordDeliveryUncertain?.(threadId, execution.runId, body.memorySpaceId) ??
            Effect.void
        );
        expect(calls).toEqual([
          "forThread",
          "forThread",
          "revalidate",
          "invalidate",
          "recordDelivery",
          "recordDeliveryUncertain",
        ]);
      }),
    );
    yield* Effect.void.pipe(
      Effect.provide(compose(turnStart, hydration, actual).pipe(Layer.provide(prerequisites))),
    );
  }),
);

it.effect("bound Snapshot failures propagate through both captured contexts", () =>
  Effect.gen(function* () {
    const failure = new Snapshot.MemorySnapshotError({ cause: "fixture" });
    const actual = Layer.effect(
      Snapshot.MemorySnapshot,
      Effect.gen(function* () {
        yield* Hydrated;
        return Snapshot.MemorySnapshot.of({
          forThread: () => Effect.fail(failure),
          revalidate: () => Effect.fail(failure),
          invalidate: () => Effect.void,
        });
      }),
    );
    const turnStart = Layer.effectDiscard(
      Effect.gen(function* () {
        const captured = (yield* Hydrated).snapshot;
        const snapshot = yield* Snapshot.MemorySnapshot;
        expect(captured).toBe(snapshot);
        expect(yield* Effect.flip(captured!.forThread(threadId, policy, currentPolicy))).toBe(
          failure,
        );
        expect(yield* Effect.flip(snapshot.revalidate(body, execution, currentPolicy))).toBe(
          failure,
        );
      }),
    );
    yield* Effect.void.pipe(
      Effect.provide(compose(turnStart, hydration, actual).pipe(Layer.provide(prerequisites))),
    );
  }),
);

it.effect(
  "the production Snapshot binding persists an uncertain delivery for inspection (#3836)",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE turn_memory_receipt_failures(thread_id TEXT, run_id TEXT, space TEXT, PRIMARY KEY(thread_id, run_id, space))`;
      const actual = Layer.effect(
        Snapshot.MemorySnapshot,
        Effect.gen(function* () {
          yield* Hydrated;
          return Snapshot.MemorySnapshot.of({
            recordDeliveryUncertain: (thread, run, space) =>
              markTurnMemoryIncomplete(sql, thread, run, space),
            forThread: () => Effect.undefined,
            revalidate: () => Effect.undefined,
            invalidate: () => Effect.void,
          });
        }),
      );
      const turnStart = Layer.effectDiscard(
        Effect.gen(function* () {
          const captured = (yield* Hydrated).snapshot;
          expect(captured?.recordDeliveryUncertain).toBeDefined();
          yield* (
            captured?.recordDeliveryUncertain?.(threadId, execution.runId, body.memorySpaceId) ??
              Effect.void
          );
        }),
      );
      yield* Effect.void.pipe(
        Effect.provide(compose(turnStart, hydration, actual).pipe(Layer.provide(prerequisites))),
      );
      const rows = yield* sql`SELECT thread_id, run_id, space FROM turn_memory_receipt_failures`;
      expect(rows).toEqual([
        { thread_id: threadId, run_id: execution.runId, space: body.memorySpaceId },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
