import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Settings from "../../serverSettings.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as Repository from "../../project/RepositoryIdentityResolver.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { environmentId, makeHarness } from "../../channels/testkit/ChannelHarness.ts";
import * as Quota from "../MemoryQuotaService.ts";
import * as Service from "../MemoryService.ts";
import * as Store from "../MemoryStore.ts";
import * as Adapter from "../MemoryReportAdapter.ts";

export const space = M.MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
export const memory = M.MemoryId.make("00000000-0000-4000-8000-000000000002");
export const resolution = M.MemoryResolutionId.make("00000000-0000-4000-8000-000000000003");
export const reportId = (n = 1) => n.toString(16).padStart(64, "0");
export const insertReport = (n = 1, outcome = "resolved", owner = environmentId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const kind =
      outcome === "resolved" ? "resolve" : outcome === "reverted" ? "revert" : "conflict_failure";
    yield* sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolution_id,resolving_environment_id,outcome,state,created_at,report_kind,report_approved) VALUES (${reportId(n)},${space},${memory},${`00000000-0000-4000-8000-${String(n + 10).padStart(12, "0")}`},${resolution},${owner},${outcome},'pending',0,${kind},1)`;
  });
export const reportRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    state: string;
    automatic_attempts: number;
    claimed_until: number | null;
  }>`SELECT state,automatic_attempts,claimed_until FROM memory_report_outbox ORDER BY report_id`;
});
export function makeReportHarness(hub = false) {
  const database = Sqlite.layerMemory;
  const harness = makeHarness({ databaseLayer: database });
  const storage = Store.layer.pipe(Layer.provideMerge(database));
  const quota = Quota.layer.pipe(Layer.provideMerge(storage));
  const service = Service.layer.pipe(
    Layer.provideMerge(quota),
    Layer.provide(
      Settings.layerTest(
        hub ? { memoryHub: { mode: "hub", memorySpaceId: space } } : {},
        "memoryHub",
      ),
    ),
    Layer.provideMerge(harness.layer),
    Layer.provideMerge(
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provide(
      Layer.mock(Repository.RepositoryIdentityResolver)({ resolve: () => Effect.succeed(null) }),
    ),
  );
  const layer = Adapter.layer.pipe(Layer.provideMerge(service));
  return { ...harness, layer };
}
