import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Service from "./MemoryService.ts";
import type { ImportRegistration } from "./imports/MemoryImportTypes.ts";

export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const space = M.MemorySpaceId.make(uuid(1));
export const memoryId = M.MemoryId.make(uuid(2));
export const environmentId = M.EnvironmentId.make("synthetic-import");
export const sourceId = M.MemoryImportSourceId.make(uuid(3));
export const address = { memorySpaceId: space, environmentId };
export const stamp = M.MemoryUtcTimestamp.make("2026-10-15T00:00:00.000Z");
export const identity = Layer.succeed(Environment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(environmentId),
});
export const resolver = Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
  resolve: () => Effect.succeed(null),
});
export const registration = (): ImportRegistration => ({
  ...address,
  sourceId,
  codecVersion: 1,
  version: 0,
  slot: { format: "codex", rootSlot: "synthetic-slot", selection: null },
  source: {
    sourceId,
    format: "codex",
    parserVersion: "fixture-v1",
    profile: "fixture",
    label: "Synthetic",
  },
  sourceLocator: "memory.md",
  session: {
    sessionId: "session-1",
    parserVersion: "fixture-v1",
    profile: "fixture",
    snapshotDigest: "a".repeat(64),
    createdAtUtc: stamp,
    expiresAtUtc: M.MemoryUtcTimestamp.make("2099-01-01T00:00:00.000Z"),
    newItems: 0,
    bodyBytes: 0,
    applied: [],
  },
});
export const setupImport = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_compaction_state(space,published) VALUES (${space},1)`;
  const service = yield* Service.MemoryService;
  yield* service.importPorts.saveRegistration(
    { ...address, next: registration(), expectedVersion: null },
    Effect.void,
  );
});
export const authority = {
  principal: {
    memorySpaceId: space,
    environmentId,
    credentialVersion: 1,
    scopes: ["memory:sync"] as const,
  },
  now: Clock.currentTimeMillis,
  reauthorize: Effect.void,
};
export const seedMember = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at)
    VALUES (${space},${environmentId},${"a".repeat(64)},1,'active',0)`;
});
export const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
