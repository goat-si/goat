import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MAIN_BOT_ID, BotId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { migrationEntries, runMigrations } from "../persistence/Migrations.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import { filterRoutineOwnWork, layerBackfillChannelWorkerHeads } from "./channelRoutineOwnWork.ts";
import {
  goatInput,
  makeHarness,
  onlyTask,
  ownerId,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

it.effect(
  "filters a bot's repository-qualified launch head before a PR link and refuses unknown bot branches",
  () => {
    const filter = (
      event: string,
      body: Record<string, unknown>,
      allowChecksWithoutPullRequest = false,
    ) =>
      filterRoutineOwnWork({
        ownerId,
        botId: BotId.make(MAIN_BOT_ID),
        allowChecksWithoutPullRequest,
        request: {
          method: "POST",
          path: "/api/hooks/example",
          query: "",
          headers: { "content-type": "application/json", "x-github-event": event },
          bodyText: JSON.stringify(body),
        },
      });
    const pr = (repository: string, branch: string) => ({
      repository: { full_name: "base/repo" },
      pull_request: { number: 42, head: { ref: branch, repo: { full_name: repository } } },
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-work-trigger-" });
      yield* fs.makeDirectory(path.join(root, ".git"));
      const harness = makeHarness({
        workspaceRoot: root,
        repositoryIdentity: {
          canonicalKey: "github.com/fork/repo",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/fork/repo.git",
          },
        },
      });
      yield* Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        yield* gateway.ingest(goatInput("do: inspect the fixture", "before-pr"), rpcContext);
        yield* runtime.drain;
        const work = yield* onlyTask;
        const branch = harness.world.launches[0]?.workspaceStrategy.branch ?? "";
        assert.match(branch, /^goat\/channel-/);
        assert.isUndefined(work.observed?.pullRequests[0]);
        assert.include((yield* filter("pull_request", pr("Fork/Repo", branch))) ?? "", "own work");
        yield* ledger.recordLaunchHead({
          taskId: work.taskId,
          generation: work.generation,
          repository: "Fork/Repo",
          branch: "fixture-branch",
        });
        assert.isUndefined(yield* filter("pull_request", pr("other/repo", "fixture-branch")));
        assert.include(
          (yield* filter("pull_request", pr("fork/repo", "goat/channel-unknown"))) ?? "",
          "possibly",
        );
        const check = { repository: { full_name: "fork/repo" }, check_run: { pull_requests: [] } };
        assert.strictEqual(yield* filter("check_run", check), "Filtered: no pull request.");
        assert.isUndefined(yield* filter("check_run", check, true));
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer));
  },
);

it.effect(
  "filters the first PR from a worker already running on a legacy branch during upgrade",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const migrationId = migrationEntries.find(
        ([, name]) => name === "ChannelWorkerLaunchHeads",
      )?.[0];
      if (migrationId === undefined) return assert.fail("Worker head migration is missing");
      yield* runMigrations({ toMigrationInclusive: migrationId - 1 });
      const at = "2026-11-21T08:00:00.000Z";
      yield* sql`INSERT INTO channel_conversations (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at)
      VALUES ('conversation', ${ownerId}, 'goat', 'goat', 'goat', ${at})`;
      yield* sql`INSERT INTO channel_tasks (task_id, owner_id, conversation_id, status, version, generation, worker_thread_id, task_json, bot_id, created_at, updated_at)
      VALUES ('legacy-task', ${ownerId}, 'conversation', 'running', 2, 1, 'legacy-worker', '{}', ${MAIN_BOT_ID}, ${at}, ${at})`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json
    ) VALUES ('legacy-worker', 'legacy-project', 'Legacy worker', 'codex', 'approval-required', 'default', ${at}, ${at},
      '{"branch":"legacy/worker","worktreePath":"/fixture/legacy-worker"}')`;
      yield* runMigrations();

      const filter = (repository: string) =>
        filterRoutineOwnWork({
          ownerId,
          botId: BotId.make(MAIN_BOT_ID),
          allowChecksWithoutPullRequest: false,
          request: {
            method: "POST",
            path: "/api/hooks/fixture",
            query: "",
            headers: { "content-type": "application/json", "x-github-event": "pull_request" },
            bodyText: JSON.stringify({
              repository: { full_name: "base/repo" },
              pull_request: {
                number: 1,
                head: { ref: "legacy/worker", repo: { full_name: repository } },
              },
            }),
          },
        });
      yield* Effect.gen(function* () {
        assert.strictEqual(yield* filter("Fork/Repo"), "Filtered: this GOAT Bot's own work.");
        assert.isUndefined(yield* filter("other/repo"));
      }).pipe(
        Effect.provide(
          layerBackfillChannelWorkerHeads.pipe(
            Layer.provide(
              Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
                resolve: (workspace) => {
                  assert.strictEqual(workspace, "/fixture/legacy-worker");
                  return Effect.succeed({
                    canonicalKey: "github.com/fork/repo",
                    locator: {
                      source: "git-remote",
                      remoteName: "origin",
                      remoteUrl: "https://github.com/fork/repo.git",
                    },
                  });
                },
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
