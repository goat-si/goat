// @effect-diagnostics nodeBuiltinImport:off -- real Git fixtures run in temporary repositories.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ThreadId, type ProjectId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { shell } from "../../storageCleanup.testFixtures.ts";
import { WorktreeSnapshotStore } from "../../worktreeSnapshots/WorktreeSnapshotStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { layerRealGit } from "../ProviderTurnStartService.testkit.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";
import * as ThreadWorkspace from "./ThreadWorkspaceService.ts";

const threadId = ThreadId.make("thread-terminal");

interface Options {
  readonly unmanaged?: boolean;
  readonly setupExitCode?: number;
  readonly prepare?: (paths: { readonly worktreePath: string; readonly repo: string }) => void;
}

// A thread whose worktree storage cleanup removed, on a branch that still exists.
const openTerminal = (
  cwdOf: (paths: { worktreePath: string; repo: string }) => string,
  options: Options = {},
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const root = NodeFS.realpathSync(config.baseDir);
    const repo = NodePath.join(root, "repo");
    const worktreePath = options.unmanaged
      ? NodePath.join(root, "elsewhere", "feature")
      : NodePath.join(config.worktreesDir, "repo", "feature");
    const git = (cwd: string, ...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    NodeFS.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(
      repo,
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "base",
    );
    git(repo, "worktree", "add", "-q", "-b", "feature", worktreePath);
    git(repo, "worktree", "remove", "--force", worktreePath);
    options.prepare?.({ worktreePath, repo });
    const dispatched: Array<{ readonly type: string; readonly message?: string }> = [];
    const fakes = Layer.mergeAll(
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        getThreadShell: () =>
          Effect.succeed(shell({ id: threadId, branch: "feature", worktreePath })),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Layer.succeed(ProjectService.ProjectService, {
        getById: () => Effect.succeedSome({ id: "project-1" as ProjectId, workspaceRoot: repo }),
      } as unknown as ProjectService.ProjectService["Service"]),
      Layer.succeed(ThreadManagement.ThreadManagementService, {
        dispatch: (command: { readonly type: string; readonly message?: string }) =>
          Effect.sync(() => void dispatched.push(command)),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Layer.succeed(WorktreeSnapshotStore, {
        capture: () => Effect.die("unused"),
        latestForThread: () => Effect.succeed(null),
        markRestored: () => Effect.void,
        deleteForThread: () => Effect.succeed(0),
        purgeDeletedThreads: () => Effect.succeed(0),
        expire: () => Effect.succeed(0),
      }),
      Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
        runForThread: (input) =>
          Effect.succeed(
            options.setupExitCode === undefined
              ? { status: "no-script" as const }
              : {
                  status: "started" as const,
                  scriptId: "setup",
                  scriptName: "setup",
                  scriptCommand: "false",
                  terminalId: "setup",
                  cwd: input.worktreePath,
                  async: false,
                  completion: Effect.succeed({ exitCode: options.setupExitCode, durationMs: 1 }),
                },
          ),
      }),
    );
    const service = yield* ThreadWorkspace.ThreadWorkspaceService.pipe(
      Effect.provide(ThreadWorkspace.layer.pipe(Layer.provide(fakes))),
    );
    yield* service.prepareTerminal({ threadId, cwd: cwdOf({ worktreePath, repo }) });
    const notices = dispatched.filter((command) => command.type === "thread.notice.record");
    const linked = NodeFS.existsSync(NodePath.join(worktreePath, ".git"));
    return { notices, linked, head: linked ? git(worktreePath, "symbolic-ref", "HEAD") : null };
  }).pipe(
    Effect.provide(
      layerRealGit.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ServerSettings.layerTest(),
            ServerConfig.layerTest(process.cwd(), { prefix: "goat-terminal-restore-" }),
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );

it.effect("a terminal opened in a removed worktree brings it back and says so in the thread", () =>
  Effect.gen(function* () {
    const { notices, linked, head } = yield* openTerminal(({ worktreePath }) =>
      NodePath.join(worktreePath, "src"),
    );
    assert.isTrue(linked);
    assert.equal(head, "refs/heads/feature");
    assert.equal(notices.length, 1);
    assert.include(notices[0]?.message ?? "", "Recreated the worktree from branch feature.");
    assert.include(notices[0]?.message ?? "", "Changes that were never committed are not in it.");
  }),
);

it.effect.each<Options & { readonly name: string; readonly inRepo?: boolean }>([
  { name: "a terminal opened in the project folder", inRepo: true },
  { name: "a worktree outside GOAT's worktrees folder", unmanaged: true },
  { name: "a restore whose setup script fails", setupExitCode: 1 },
])("a terminal leaves the worktree missing for $name", ({ inRepo, ...options }) =>
  Effect.gen(function* () {
    const { notices, linked } = yield* openTerminal(
      ({ worktreePath, repo }) => (inRepo ? repo : worktreePath),
      options,
    );
    assert.isFalse(linked);
    assert.deepEqual(notices, []);
  }),
);

it.effect("a terminal opened in a worktree that is in place changes nothing", () =>
  Effect.gen(function* () {
    const { notices, linked } = yield* openTerminal(({ worktreePath }) => worktreePath, {
      prepare: ({ worktreePath, repo }) =>
        void NodeChildProcess.execFileSync(
          "git",
          ["worktree", "add", "-q", worktreePath, "feature"],
          {
            cwd: repo,
          },
        ),
    });
    assert.isTrue(linked);
    assert.deepEqual(notices, []);
  }),
);
