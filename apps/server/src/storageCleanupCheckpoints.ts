import { CheckpointScopeId } from "@goat/contracts";
import {
  GOAT_CHECKPOINT_REFS_PREFIX,
  LEGACY_CHECKPOINT_REFS_PREFIX,
  GOAT_ORCHESTRATION_CHECKPOINT_REFS_PREFIX,
  LEGACY_ORCHESTRATION_CHECKPOINT_REFS_PREFIX,
} from "@goat/contracts/legacyT3Names";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Base64Url from "effect/encoding/Base64Url";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { checkpointRefCandidatesForScopeOrdinal } from "./orchestration-v2/CheckpointService.ts";
import type * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

export const cleanCheckpointRefs = Effect.fn("StorageCleanup.cleanCheckpointRefs")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rows = yield* sql<{
    threadId: string;
    worktreePath: string | null;
    workspaceRoot: string | null;
    scopeId: string | null;
    cwd: string | null;
  }>`
    WITH RECURSIVE retained(thread_id) AS (
      SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
      UNION
      SELECT json_extract(t.payload_json, '$.forkedFrom.threadId')
      FROM orchestration_v2_projection_threads t JOIN retained r ON r.thread_id = t.thread_id
      WHERE json_extract(t.payload_json, '$.forkedFrom.type') = 'run'
    )
    SELECT t.thread_id AS "threadId", json_extract(t.payload_json, '$.worktreePath') AS "worktreePath",
      p.workspace_root AS "workspaceRoot", s.scope_id AS "scopeId", json_extract(s.payload_json, '$.cwd') AS cwd
    FROM orchestration_v2_projection_threads t
    LEFT JOIN projection_projects p ON p.project_id = t.project_id
    LEFT JOIN orchestration_v2_projection_checkpoint_scopes s ON s.thread_id = t.thread_id
    WHERE t.deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retained WHERE thread_id = t.thread_id)
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox e WHERE e.thread_id = t.thread_id AND e.status IN ('pending', 'running'))
  `.pipe(NodeSqliteClient.readOnly);
  const targets = new Map<string, Set<string>>();
  for (const row of rows) {
    const prefixes = [GOAT_CHECKPOINT_REFS_PREFIX, LEGACY_CHECKPOINT_REFS_PREFIX].map(
      (prefix) => `${prefix}/${Base64Url.encode(row.threadId)}/turn/`,
    );
    if (row.scopeId !== null) {
      const refs = yield* checkpointRefCandidatesForScopeOrdinal({
        scopeId: CheckpointScopeId.make(row.scopeId),
        ordinalWithinScope: 0,
      });
      prefixes.push(...refs.map((ref) => ref.slice(0, -1)));
    }
    for (const cwd of [row.cwd, row.worktreePath, row.workspaceRoot]) {
      if (cwd === null) continue;
      const key = path.resolve(cwd);
      const owned = targets.get(key) ?? new Set<string>();
      for (const prefix of prefixes) owned.add(prefix);
      targets.set(key, owned);
    }
  }
  const repositories = new Map<string, { cwd: string; prefixes: Set<string> }>();
  for (const [cwd, prefixes] of targets) {
    yield* Effect.gen(function* () {
      if (!(yield* fs.exists(cwd))) return;
      const result = yield* git.execute({
        operation: "StorageCleanup.checkpointRepository",
        cwd,
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        allowNonZeroExit: true,
      });
      if (result.exitCode !== 0 || result.stdoutTruncated || result.stdout.trim() === "") return;
      const common = yield* fs.realPath(result.stdout.trim());
      const repository = repositories.get(common) ?? { cwd, prefixes: new Set<string>() };
      for (const prefix of prefixes) repository.prefixes.add(prefix);
      repositories.set(common, repository);
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("checkpoint repository inspection failed", { cause }),
      ),
    );
  }
  for (const { cwd, prefixes } of repositories.values()) {
    yield* Effect.gen(function* () {
      const result = yield* git.execute({
        operation: "StorageCleanup.listCheckpointRefs",
        cwd,
        args: [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)",
          GOAT_CHECKPOINT_REFS_PREFIX,
          LEGACY_CHECKPOINT_REFS_PREFIX,
          GOAT_ORCHESTRATION_CHECKPOINT_REFS_PREFIX,
          LEGACY_ORCHESTRATION_CHECKPOINT_REFS_PREFIX,
        ],
        maxOutputBytes: 16 * 1024 * 1024,
      });
      if (result.stdoutTruncated || result.stderrTruncated) return;
      const refs = result.stdout.split("\n").flatMap((line) => {
        const [ref, oid] = line.split("\0");
        if (ref === undefined || oid === undefined || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid))
          return [];
        const ordinalStart = ref.lastIndexOf("/") + 1;
        return prefixes.has(ref.slice(0, ordinalStart)) &&
          /^(0|[1-9]\d*)$/.test(ref.slice(ordinalStart))
          ? [{ ref, oid }]
          : [];
      });
      if (refs.length === 0) return;
      yield* git.execute({
        operation: "StorageCleanup.deleteCheckpointRefs",
        cwd,
        args: ["update-ref", "--no-deref", "-z", "--stdin"],
        stdin: refs.map(({ ref, oid }) => `delete ${ref}\0${oid}\0`).join(""),
      });
    }).pipe(Effect.catch((cause) => Effect.logWarning("checkpoint ref cleanup failed", { cause })));
  }
});
