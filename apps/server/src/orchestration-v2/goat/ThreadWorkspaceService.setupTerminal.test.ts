// @effect-diagnostics nodeBuiltinImport:off -- real Git fixtures run in temporary repositories.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ProjectId, ThreadId } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as GoatProjectFileLoader from "../../project/GoatProjectFileLoader.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { shell } from "../../storageCleanup.testFixtures.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { FakePtyAdapter } from "../../terminal/Manager.testkit.ts";
import { WorktreeSnapshotStore } from "../../worktreeSnapshots/WorktreeSnapshotStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { layerRealGit } from "../ProviderTurnStartService.testkit.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";
import { makePrepareTurnWorkspace } from "./prepareTurnWorkspace.ts";
import { makeRestorePending } from "./restoreThreadWorkspace.ts";
import * as ThreadWorkspace from "./ThreadWorkspaceService.ts";

const threadId = ThreadId.make("thread-setup-terminal");
const projectId = ProjectId.make("project-setup");

// A restore holds the worktree's lease and runs the project's setup script, whose terminal asks
// for the same lease (goat#3674). Real TerminalManager and setup runner; it.live because the
// restore and the fixtures run git as a subprocess.
const withSetupProject = <A, E, R>(
  setup: { readonly async: boolean },
  body: (fixture: {
    readonly worktreePath: string;
    readonly pty: FakePtyAdapter;
    readonly dispatched: Array<{ readonly type: string; readonly worktreePath?: unknown }>;
    readonly git: (cwd: string, ...args: string[]) => string;
    readonly layer: Layer.Layer<
      | ProjectService.ProjectService
      | ProjectSetupScriptRunner.ProjectSetupScriptRunner
      | ProjectionStore.ProjectionStoreV2
      | ThreadManagement.ThreadManagementService
      | WorktreeSnapshotStore,
      never,
      FileSystem.FileSystem | Path.Path | ServerSettings.ServerSettingsService
    >;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const root = NodeFS.realpathSync(config.baseDir);
    const repo = NodePath.join(root, "repo");
    const worktreePath = NodePath.join(config.worktreesDir, "repo", "feature");
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
    const project = {
      id: projectId,
      title: "Setup",
      workspaceRoot: repo,
      scripts: [
        {
          id: "setup",
          name: "Setup",
          command: "true",
          icon: "configure",
          runOnWorktreeCreate: true,
          stopOnSettle: false,
          async: setup.async,
        },
      ],
    };
    const pty = new FakePtyAdapter();
    const terminals = yield* TerminalManager.makeWithOptions({
      logsDir: NodePath.join(root, "terminal-logs"),
      ptyAdapter: pty,
      processKillGraceMs: 1,
    });
    const projects = Layer.succeed(ProjectService.ProjectService, {
      getById: () => Effect.succeedSome(project),
      getByWorkspaceRoot: () => Effect.succeedSome(project),
    } as unknown as ProjectService.ProjectService["Service"]);
    const setupRunner = Layer.effect(
      ProjectSetupScriptRunner.ProjectSetupScriptRunner,
      ProjectSetupScriptRunner.make,
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          projects,
          // A shell that shows its prompt once open and reports the setup command exited with 0.
          Layer.succeed(TerminalManager.TerminalManager, {
            ...terminals,
            open: (input) =>
              terminals
                .open(input)
                .pipe(
                  Effect.tap(() =>
                    Effect.sync(() => pty.processes.at(-1)?.emitData("$ \x1b[?2004h")),
                  ),
                ),
            write: (input) =>
              terminals.write(input).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    const sentinel = input.data.match(/__GOAT_SETUP_DONE__[a-f0-9_]+:/)?.[0];
                    if (sentinel !== undefined)
                      pty.processes.at(-1)?.emitData(`ready\r\n${sentinel}0\r\n$ `);
                  }),
                ),
              ),
          }),
          GoatProjectFileLoader.layer,
          NodeCrypto.layer,
        ),
      ),
    );
    const dispatched: Array<{ readonly type: string; readonly worktreePath?: unknown }> = [];
    const layer = Layer.mergeAll(
      projects,
      setupRunner,
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        getThreadShell: () =>
          Effect.succeed(shell({ id: threadId, projectId, branch: "feature", worktreePath })),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Layer.succeed(ThreadManagement.ThreadManagementService, {
        dispatch: (command: { readonly type: string; readonly worktreePath?: unknown }) =>
          Effect.sync(() => dispatched.push(command)),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Layer.succeed(WorktreeSnapshotStore, {
        capture: () => Effect.die("unused"),
        latestForThread: () => Effect.succeed(null),
        markRestored: () => Effect.void,
        deleteForThread: () => Effect.succeed(0),
        purgeDeletedThreads: () => Effect.succeed(0),
        expire: () => Effect.succeed(0),
      }),
    );
    return yield* body({ worktreePath, pty, dispatched, git, layer });
  }).pipe(
    Effect.provide(
      layerRealGit.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ServerSettings.layerTest(),
            ServerConfig.layerTest(process.cwd(), { prefix: "goat-setup-terminal-" }),
            McpProviderSessions.layer,
            ProcessRunner.layer,
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );

/** What a restore stopped by a restart leaves: the folder, marked until setup has run in it. */
const markUnfinished = (worktreePath: string, git: (cwd: string, ...args: string[]) => string) =>
  Effect.gen(function* () {
    const pending = yield* makeRestorePending;
    yield* pending.write(worktreePath, {
      restoredFrom: "branch",
      headSha: git(worktreePath, "rev-parse", "HEAD"),
      snapshotSha: null,
      snapshotRef: null,
    });
    return pending;
  });

it.live("a turn start that resumes an unfinished restore runs setup and clears the marker", () =>
  withSetupProject({ async: false }, ({ worktreePath, pty, git, layer }) =>
    Effect.gen(function* () {
      const pending = yield* markUnfinished(worktreePath, git);
      const prepareTurn = yield* makePrepareTurnWorkspace;
      const prepared = yield* prepareTurn({
        id: threadId,
        projectId,
        worktreePath,
        branch: "feature",
      });
      assert.strictEqual(prepared._tag, "Ready");
      assert.deepEqual(
        pty.spawnInputs.map((input) => input.cwd),
        [worktreePath],
      );
      assert.isFalse(yield* pending.marked(worktreePath));
    }).pipe(Effect.provide(layer)),
  ),
);

it.live("Run setup now on an unfinished restore runs setup and clears the marker", () =>
  withSetupProject({ async: false }, ({ worktreePath, pty, git, layer }) =>
    Effect.gen(function* () {
      const pending = yield* markUnfinished(worktreePath, git);
      const service = yield* ThreadWorkspace.ThreadWorkspaceService;
      const result = yield* service.restore({ threadId, mode: "restore" });
      assert.strictEqual(result.setupScript, "started");
      assert.deepEqual(
        pty.spawnInputs.map((input) => input.cwd),
        [worktreePath],
      );
      assert.isFalse(yield* pending.marked(worktreePath));
    }).pipe(Effect.provide(ThreadWorkspace.layer.pipe(Layer.provideMerge(layer)))),
  ),
);

it.live.each([
  ["waits for", false],
  ["starts", true],
] as const)(
  "Start in a new worktree %s an async=%s setup script and rebinds the thread",
  ([, async]) =>
    withSetupProject({ async }, ({ worktreePath, pty, dispatched, layer }) =>
      Effect.gen(function* () {
        const service = yield* ThreadWorkspace.ThreadWorkspaceService;
        const result = yield* service.restore({ threadId, mode: "fresh" });
        assert.strictEqual(result.restoredFrom, "fresh");
        assert.strictEqual(result.setupScript, "started");
        assert.notStrictEqual(result.worktreePath, worktreePath);
        assert.deepEqual(
          pty.spawnInputs.map((input) => input.cwd),
          [result.worktreePath],
        );
        assert.deepEqual(
          dispatched.map((command) => [command.type, command.worktreePath]),
          [["thread.metadata.update", result.worktreePath]],
        );
      }).pipe(Effect.provide(ThreadWorkspace.layer.pipe(Layer.provideMerge(layer)))),
    ),
);
