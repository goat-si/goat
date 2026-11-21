import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MAIN_BOT_ID, BotId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import { filterRoutineOwnWork } from "./channelRoutineOwnWork.ts";
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
