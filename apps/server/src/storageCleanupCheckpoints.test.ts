import { expect, it } from "@effect/vitest";
import { CheckpointScopeId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Sqlite from "./persistence/Sqlite.ts";
import { checkpointRefCandidatesForScopeOrdinal } from "./orchestration-v2/CheckpointService.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { git, initRepoWithCommit, layerTest, makeTmpDir } from "./vcs/testing/gitFixture.ts";
import { cleanCheckpointRefs } from "./storageCleanupCheckpoints.ts";

const layer = Layer.merge(layerTest, Sqlite.layerMemory);
it.live(
  "prunes only deleted unreferenced checkpoint refs, retaining fork ancestry and pending captures",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmpDir("checkpoint-prune-");
      yield* initRepoWithCommit(cwd);
      const timestamp = "2026-01-01T00:00:00Z";
      yield* sql`INSERT INTO projection_projects ${sql.insert({ project_id: "p", title: "p", workspace_root: cwd, scripts_json: "[]", created_at: timestamp, updated_at: timestamp, deleted_at: null })}`;
      const refs: Record<string, string[]> = {};
      for (const [id, deleted, source] of [
        ["prune", true, null],
        ["root", true, null],
        ["child", false, "root"],
        ["pending", true, null],
      ] as const) {
        const scope = CheckpointScopeId.make(`scope:${id}`);
        yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({ thread_id: id, project_id: "p", title: id, default_provider: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: timestamp, updated_at: timestamp, archived_at: id === "child" ? timestamp : null, deleted_at: deleted ? timestamp : null, payload_json: JSON.stringify({ worktreePath: cwd, forkedFrom: source === null ? null : { type: "run", threadId: source } }) })}`;
        yield* sql`INSERT INTO orchestration_v2_projection_checkpoint_scopes ${sql.insert({ scope_id: scope, thread_id: id, node_id: `node:${id}`, kind: "root_run", ordinal_within_parent: 0, advances_app_run_count: 1, created_at: timestamp, payload_json: JSON.stringify({ cwd }) })}`;
        refs[id] = [
          ...(yield* checkpointRefCandidatesForScopeOrdinal({
            scopeId: scope,
            ordinalWithinScope: 0,
          })),
          `refs/t3/checkpoints/${Base64Url.encode(id)}/turn/0`,
          `refs/goat/checkpoints/${Base64Url.encode(id)}/turn/0`,
        ];
        for (const ref of refs[id]) yield* git(cwd, ["update-ref", ref, "HEAD"]);
      }
      yield* sql`INSERT INTO orchestration_v2_effect_outbox ${sql.insert({ effect_id: "capture", command_id: "capture", thread_id: "pending", effect_type: "checkpoint.capture", payload_json: "{}", status: "running", available_at: timestamp, created_at: timestamp, updated_at: timestamp })}`;
      const unknownRef = `refs/goat/checkpoints/${Base64Url.encode("unknown")}/turn/0`;
      yield* git(cwd, ["update-ref", unknownRef, "HEAD"]);
      yield* git(cwd, ["symbolic-ref", refs.prune![0]!, "refs/heads/main"]);
      const tree = yield* git(cwd, ["rev-parse", "HEAD^{tree}"]);
      const concurrentOid = yield* git(cwd, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@test.com",
        "commit-tree",
        tree,
        "-m",
        "concurrent",
      ]);
      let changed = false;
      const raced = {
        ...driver,
        execute: (input: Parameters<typeof driver.execute>[0]) =>
          input.operation === "StorageCleanup.deleteCheckpointRefs" && !changed
            ? Effect.gen(function* () {
                changed = true;
                yield* driver.execute({
                  operation: "test.concurrentRef",
                  cwd,
                  args: ["update-ref", refs.prune![1]!, concurrentOid],
                });
                return yield* driver.execute(input);
              })
            : driver.execute(input),
      };
      yield* cleanCheckpointRefs(raced);
      expect(yield* git(cwd, ["rev-parse", refs.prune![1]!])).toBe(concurrentOid);
      yield* cleanCheckpointRefs(driver);
      const listed = (yield* git(cwd, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/t3/",
        "refs/goat/",
      ]))
        .split("\n")
        .filter(Boolean);
      expect(listed).toEqual([...refs.root!, ...refs.child!, ...refs.pending!, unknownRef].sort());
      yield* git(cwd, ["show-ref", "--verify", "refs/heads/main"]);
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${timestamp} WHERE thread_id = 'child'`;
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded' WHERE effect_id = 'capture'`;
      yield* cleanCheckpointRefs(driver);
      expect(
        (yield* git(cwd, ["for-each-ref", "--format=%(refname)", "refs/t3/", "refs/goat/"]))
          .split("\n")
          .filter(Boolean),
      ).toEqual([unknownRef]);
    }).pipe(Effect.provide(layer), Effect.scoped),
);
