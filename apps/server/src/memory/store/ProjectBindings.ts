import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import { decodeBinding, keyCodec, stored } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { MemoryStoreConflict, strict } from "./StoreModel.ts";

export const makeProjectBindings = (
  kernel: Pick<StoreKernel, "emit" | "nextWatermark" | "sql" | "transact">,
) => {
  const { emit, nextWatermark, sql, transact } = kernel;
  const getProjectBinding = Effect.fn("MemoryStore.getProjectBinding")(function* (
    space: M.MemorySpaceId,
    project: M.ScopedProjectRef,
  ) {
    const rows = yield* stored(
      "binding",
      sql<{
        project_key_json: string | null;
        repository_key_json: string | null;
        version: number;
      }>`SELECT * FROM memory_project_bindings WHERE memory_space_id=${space} AND environment_id=${project.environmentId} AND project_id=${project.projectId}`,
    );
    const row = rows[0];
    return row
      ? yield* stored(
          "binding-codec",
          Effect.gen(function* () {
            return yield* decodeBinding(
              {
                memorySpaceId: space,
                project,
                projectKey: row.project_key_json
                  ? yield* keyCodec.decode(row.project_key_json, strict)
                  : null,
                repositoryKey: row.repository_key_json
                  ? yield* keyCodec.decode(row.repository_key_json, strict)
                  : null,
                version: row.version,
              },
              strict,
            );
          }),
        )
      : undefined;
  });
  const putProjectBinding = Effect.fn("MemoryStore.putProjectBinding")(function* (
    input: M.MemoryProjectBinding,
    expected: number | null,
    now: number,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const binding = yield* stored("binding-codec", decodeBinding(input, strict));
        const old = yield* getProjectBinding(binding.memorySpaceId, binding.project);
        if ((old?.version ?? null) !== expected)
          return yield* new MemoryStoreConflict({ code: "revision_changed" });
        yield* stored(
          "binding-write",
          sql`INSERT INTO memory_project_bindings (memory_space_id,environment_id,project_id,project_key_json,repository_key_json,version,updated_at) VALUES (${binding.memorySpaceId},${binding.project.environmentId},${binding.project.projectId},${binding.projectKey ? yield* keyCodec.encode(binding.projectKey) : null},${binding.repositoryKey ? yield* keyCodec.encode(binding.repositoryKey) : null},${binding.version},${now}) ON CONFLICT(memory_space_id,environment_id,project_id) DO UPDATE SET project_key_json=excluded.project_key_json,repository_key_json=coalesce(memory_project_bindings.repository_key_json,excluded.repository_key_json),version=excluded.version,updated_at=excluded.updated_at`,
        );

        yield* emit({
          memorySpaceId: binding.memorySpaceId,
          projectionWatermark: yield* nextWatermark(binding.memorySpaceId),
          kind: "reset",
        });
      }),
    );
  });
  return {
    getProjectBinding,
    putProjectBinding,
  };
};

export type ProjectBindings = ReturnType<typeof makeProjectBindings>;
