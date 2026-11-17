// @effect-diagnostics nodeBuiltinImport:off -- real Git fixtures run in temporary repositories.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ProjectId, ThreadId, type TerminalEvent } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
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

const threadId = ThreadId.make("thread-setup-shell");
const projectId = ProjectId.make("project-setup-shell");
const SENTINEL = /__GOAT_SETUP_DONE__[a-f0-9_]+:/;
/** FakePtyAdapter numbers its processes from 9000. */
const FIRST_PTY_PID = 9000;

type Services =
  | ProjectService.ProjectService
  | ProjectSetupScriptRunner.ProjectSetupScriptRunner
  | ProjectionStore.ProjectionStoreV2
  | ThreadManagement.ThreadManagementService
  | WorktreeSnapshotStore;

// A restore recreates the worktree folder at its old path (goat#3691); the thread's setup terminal
// from an earlier run still has its shell in the removed folder. Real TerminalManager and setup
// runner on a fake PTY; it.live because the restore and the fixtures run git as a subprocess.
const withSetupShell = <A, E, R>(
  options: {
    readonly async: boolean;
    /**
     * The first shell shows no prompt and runs a startup child (an rc-file prompt). The fixture
     * reports it busy as it opens, so the runner's quiet fallback never races the manager's poll.
     */
    readonly stuckFirstShell?: boolean;
    /** Holds the restore inside the folder's lease, before it recreates the folder. */
    readonly holdRestore?: {
      readonly entered: Deferred.Deferred<void>;
      readonly go: Deferred.Deferred<void>;
    };
    /** Done when a terminal open is requested. */
    readonly openRequested?: Deferred.Deferred<void>;
  },
  body: (fixture: {
    readonly repo: string;
    readonly worktreePath: string;
    readonly pty: FakePtyAdapter;
    /** Prompts and command writes in order, by PTY index. */
    readonly events: Array<string>;
    readonly closedIdle: Array<string>;
    /** The first PTY whose shell reports the setup command finished with exit code 0. */
    readonly finishFrom: { value: number };
    /** Done once the first setup command was written. */
    readonly firstCommand: Deferred.Deferred<void>;
    /** Done once a command was written to the second PTY. */
    readonly secondCommand: Deferred.Deferred<void>;
    readonly terminals: TerminalManager.TerminalManager["Service"];
    readonly git: (cwd: string, ...args: string[]) => string;
    readonly layer: Layer.Layer<
      Services,
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
          command: "pwd -P",
          icon: "configure",
          runOnWorktreeCreate: true,
          stopOnSettle: false,
          async: options.async,
        },
      ],
    };
    const pty = new FakePtyAdapter();
    const events: Array<string> = [];
    const closedIdle: Array<string> = [];
    const finishFrom = { value: 0 };
    const firstCommand = yield* Deferred.make<void>();
    const secondCommand = yield* Deferred.make<void>();
    const terminals = yield* TerminalManager.makeWithOptions({
      // No process table: an idle check must not depend on the host's processes.
      processTable: Effect.succeed([]),
      ...(options.stuckFirstShell === true
        ? {
            subprocessPollIntervalMs: 50,
            subprocessInspector: (pid: number) =>
              Effect.succeed({
                hasRunningSubprocess: pid === FIRST_PTY_PID,
                childCommand: pid === FIRST_PTY_PID ? "fnm" : null,
                processIds: [],
              }),
          }
        : {}),
      logsDir: NodePath.join(root, "terminal-logs"),
      ptyAdapter: pty,
      processKillGraceMs: 1,
    });
    const latest = () => pty.processes.length - 1;
    const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
    const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (
      listener,
      registerCleanup,
    ) =>
      terminals.subscribe(listener, registerCleanup).pipe(
        Effect.map((stop) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
            stop();
          };
        }),
      );
    const markBusy = (opened: { readonly threadId: string; readonly terminalId: string }) =>
      Effect.forEach(
        [...listeners],
        (listener) =>
          listener({ type: "activity", ...opened, hasRunningSubprocess: true, label: "fnm" }),
        { discard: true },
      );
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
          // A shell that shows its prompt once open and reports the setup command's exit code.
          Layer.succeed(TerminalManager.TerminalManager, {
            ...terminals,
            subscribe,
            open: (input) =>
              (options.openRequested === undefined
                ? Effect.void
                : Deferred.succeed(options.openRequested, undefined)
              ).pipe(
                Effect.andThen(terminals.open(input)),
                Effect.tap((opened) =>
                  options.stuckFirstShell === true && latest() === 0
                    ? markBusy(opened)
                    : Effect.sync(() => {
                        events.push(`prompt ${latest()}`);
                        pty.processes.at(-1)?.emitData("$ \x1b[?2004h");
                      }),
                ),
              ),
            write: (input) =>
              terminals.write(input).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    const sentinel = input.data.match(SENTINEL)?.[0];
                    if (sentinel === undefined) return;
                    events.push(`command ${latest()}`);
                    Deferred.doneUnsafe(firstCommand, Exit.void);
                    if (latest() >= 1) Deferred.doneUnsafe(secondCommand, Exit.void);
                    if (latest() >= finishFrom.value)
                      pty.processes.at(-1)?.emitData(`${worktreePath}\r\n${sentinel}0\r\n$ `);
                  }),
                ),
              ),
            closeIdle: (input) =>
              Effect.sync(() => closedIdle.push(input.terminalId ?? "all")).pipe(
                Effect.andThen(terminals.closeIdle(input)),
              ),
          }),
          GoatProjectFileLoader.layer,
          NodeCrypto.layer,
        ),
      ),
    );
    const layer = Layer.mergeAll(
      projects,
      setupRunner,
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        getThreadShell: () =>
          Effect.succeed(shell({ id: threadId, projectId, branch: "feature", worktreePath })),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Layer.succeed(ThreadManagement.ThreadManagementService, {
        dispatch: () => Effect.void,
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Layer.succeed(WorktreeSnapshotStore, {
        capture: () => Effect.die("unused"),
        latestForThread: () =>
          options.holdRestore === undefined
            ? Effect.succeed(null)
            : Deferred.succeed(options.holdRestore.entered, undefined).pipe(
                Effect.andThen(Deferred.await(options.holdRestore.go)),
                Effect.as(null),
              ),
        markRestored: () => Effect.void,
        deleteForThread: () => Effect.succeed(0),
        purgeDeletedThreads: () => Effect.succeed(0),
        expire: () => Effect.succeed(0),
      }),
    );
    return yield* body({
      repo,
      worktreePath,
      pty,
      events,
      closedIdle,
      finishFrom,
      firstCommand,
      secondCommand,
      terminals: { ...terminals, subscribe },
      git,
      layer,
    });
  }).pipe(
    Effect.provide(
      layerRealGit.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ServerSettings.layerTest(),
            ServerConfig.layerTest(process.cwd(), { prefix: "goat-setup-shell-" }),
            McpProviderSessions.layer,
            ProcessRunner.layer,
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );

/** The launch's setup run: it leaves the thread's setup terminal running in the worktree. */
const earlierSetup = (worktreePath: string, lines?: Array<string>) =>
  Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    return yield* runner.runForThread({
      threadId,
      projectCwd: "unused",
      worktreePath,
      observeCompletion:
        lines === undefined ? {} : { onOutputLine: (line) => Effect.sync(() => lines.push(line)) },
    });
  });

/** The folder gone from its path: moved away, or deleted. */
const removeFolder = (
  how: "moved" | "deleted",
  fixture: {
    readonly repo: string;
    readonly worktreePath: string;
    readonly git: (cwd: string, ...args: string[]) => string;
  },
) => {
  if (how === "moved") NodeFS.renameSync(fixture.worktreePath, `${fixture.worktreePath}-moved`);
  else fixture.git(fixture.repo, "worktree", "remove", "--force", fixture.worktreePath);
  fixture.git(fixture.repo, "worktree", "prune");
};

type EntryPoint = "terminal" | "recreate" | "turn";

const restoreThrough = (entry: EntryPoint, worktreePath: string) =>
  Effect.gen(function* () {
    if (entry === "turn") {
      const prepareTurn = yield* makePrepareTurnWorkspace;
      const prepared = yield* prepareTurn({
        id: threadId,
        projectId,
        worktreePath,
        branch: "feature",
      });
      assert.strictEqual(prepared._tag, "Ready");
      return;
    }
    const service = yield* ThreadWorkspace.ThreadWorkspaceService;
    if (entry === "terminal") yield* service.prepareTerminal({ threadId, cwd: worktreePath });
    else
      assert.strictEqual(
        (yield* service.restore({ threadId, mode: "restore" })).setupScript,
        "started",
      );
  });

const provideAll = (
  layer: Layer.Layer<
    Services,
    never,
    FileSystem.FileSystem | Path.Path | ServerSettings.ServerSettingsService
  >,
) => Effect.provide(ThreadWorkspace.layer.pipe(Layer.provideMerge(layer)));

it.live.each([
  ["moved away", "terminal", "moved"],
  ["moved away", "recreate", "moved"],
  ["moved away", "turn", "moved"],
  ["deleted", "recreate", "deleted"],
] as const)(
  "a restore after the folder was %s runs setup in a new shell in the restored folder (%s)",
  ([, entry, how]) =>
    withSetupShell({ async: false }, (fixture) =>
      Effect.gen(function* () {
        const { worktreePath, pty, events } = fixture;
        yield* earlierSetup(worktreePath);
        assert.strictEqual(pty.processes.length, 1);
        removeFolder(how, fixture);
        yield* restoreThrough(entry, worktreePath);
        assert.isTrue(NodeFS.existsSync(NodePath.join(worktreePath, ".git")));
        assert.strictEqual(pty.processes.length, 2);
        assert.isTrue(pty.processes[0]?.killed);
        assert.strictEqual(pty.spawnInputs[1]?.cwd, worktreePath);
        // Each shell got only its own run's command, the new one after its prompt.
        assert.deepEqual(events, ["prompt 0", "command 0", "prompt 1", "command 1"]);
      }).pipe(provideAll(fixture.layer)),
    ),
);

it.live("a thread's first restore starts exactly one setup shell", () =>
  withSetupShell({ async: false }, (fixture) =>
    Effect.gen(function* () {
      removeFolder("deleted", fixture);
      yield* restoreThrough("recreate", fixture.worktreePath);
      assert.strictEqual(fixture.pty.processes.length, 1);
      assert.deepEqual(fixture.events, ["prompt 0", "command 0"]);
    }).pipe(provideAll(fixture.layer)),
  ),
);

// A recreate that succeeded before its setup failed leaves the marker; the old shell may still live.
it.live("resuming an unfinished restore runs setup in a new shell too", () =>
  withSetupShell({ async: false }, (fixture) =>
    Effect.gen(function* () {
      const { worktreePath, pty, events, git } = fixture;
      yield* earlierSetup(worktreePath);
      const pending = yield* makeRestorePending;
      yield* pending.write(worktreePath, {
        restoredFrom: "branch",
        headSha: git(worktreePath, "rev-parse", "HEAD"),
        snapshotSha: null,
        snapshotRef: null,
      });
      yield* restoreThrough("recreate", worktreePath);
      assert.strictEqual(pty.processes.length, 2);
      assert.isTrue(pty.processes[0]?.killed);
      assert.deepEqual(events, ["prompt 0", "command 0", "prompt 1", "command 1"]);
      assert.isFalse(yield* pending.marked(worktreePath));
    }).pipe(provideAll(fixture.layer)),
  ),
);

// A tracked launch's async setup is still going when a restore replaces its shell: the restart
// ends that run, and the new shell's output is not its output.
it.live("a restart ends an earlier setup run that is still going, with the new shell open", () =>
  withSetupShell({ async: true }, (fixture) =>
    Effect.gen(function* () {
      const { worktreePath, pty, finishFrom, firstCommand, secondCommand } = fixture;
      // Only the restore's new shell reports its command finished.
      finishFrom.value = 1;
      const lines: Array<string> = [];
      const earlier = yield* earlierSetup(worktreePath, lines);
      const earlierCompletion = yield* (
        earlier.status === "started" && earlier.completion !== undefined
          ? earlier.completion
          : Effect.die("no completion")
      ).pipe(Effect.forkChild);
      yield* Deferred.await(firstCommand);
      removeFolder("moved", fixture);
      const pending = yield* makeRestorePending;
      yield* restoreThrough("recreate", worktreePath);
      yield* Deferred.await(secondCommand);
      assert.strictEqual((yield* Fiber.join(earlierCompletion)).exitCode, null);
      assert.isFalse(pty.processes[1]?.killed);
      assert.deepEqual(lines, []);
      assert.isFalse(yield* pending.marked(worktreePath));
    }).pipe(provideAll(fixture.layer)),
  ),
);

// The earlier run waits behind an rc-file prompt when a restore replaces its shell. It must not
// type into the restored shell: there it could finish first and close the shell before the restore's
// own run typed, failing the restore and removing the folder it had just recreated.
it.live("a restore's setup run supersedes an earlier run that has not typed yet", () =>
  withSetupShell({ async: false, stuckFirstShell: true }, (fixture) =>
    Effect.gen(function* () {
      const { worktreePath, pty, events, terminals } = fixture;
      const busy = yield* Deferred.make<void>();
      const unsubscribe = yield* terminals.subscribe((event) =>
        event.type === "activity" && event.hasRunningSubprocess
          ? Deferred.succeed(busy, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      const lines: Array<string> = [];
      const earlier = yield* earlierSetup(worktreePath, lines);
      const earlierCompletion = yield* (
        earlier.status === "started" && earlier.completion !== undefined
          ? earlier.completion
          : Effect.die("no completion")
      ).pipe(Effect.forkChild);
      // The first shell is busy with its startup prompt, so the earlier run keeps waiting.
      yield* Deferred.await(busy);
      unsubscribe();
      removeFolder("moved", fixture);
      yield* restoreThrough("recreate", worktreePath);
      assert.isTrue(NodeFS.existsSync(NodePath.join(worktreePath, ".git")));
      assert.strictEqual((yield* Fiber.join(earlierCompletion)).exitCode, null);
      // Only the restore's run typed, once, into the restored shell.
      assert.deepEqual(events, ["prompt 1", "command 1"]);
      assert.deepEqual(lines, []);
      assert.strictEqual(pty.processes[0]?.writes.length, 0);
    }).pipe(provideAll(fixture.layer)),
  ),
);

// The earlier run's open is still waiting for the folder the restore holds when the restore's run
// restarts the terminal; it comes back with the restarted terminal and must not type there.
it.live("a setup run whose open waited for the restore is superseded too", () =>
  Effect.gen(function* () {
    const holdRestore = { entered: yield* Deferred.make<void>(), go: yield* Deferred.make<void>() };
    const openRequested = yield* Deferred.make<void>();
    return yield* withSetupShell({ async: true, holdRestore, openRequested }, (fixture) =>
      Effect.gen(function* () {
        const { worktreePath, events, firstCommand } = fixture;
        removeFolder("deleted", fixture);
        const restore = yield* restoreThrough("recreate", worktreePath).pipe(Effect.forkChild);
        yield* Deferred.await(holdRestore.entered);
        // A launch's setup run asks for the setup terminal while the restore holds the folder.
        const lines: Array<string> = [];
        const earlierFiber = yield* earlierSetup(worktreePath, lines).pipe(Effect.forkChild);
        yield* Deferred.await(openRequested);
        yield* Deferred.succeed(holdRestore.go, undefined);
        yield* Fiber.join(restore);
        const earlier = yield* Fiber.join(earlierFiber);
        // An async restore leaves the restored shell open; a command typed there is awaited.
        yield* Deferred.await(firstCommand);
        const settled =
          earlier.status === "started" && earlier.completion !== undefined
            ? (yield* earlier.completion).exitCode
            : "no completion";
        assert.isTrue(NodeFS.existsSync(NodePath.join(worktreePath, ".git")));
        assert.strictEqual(settled, null);
        // The restore's run typed once; the earlier run typed nothing.
        assert.strictEqual(events.filter((event) => event.startsWith("command")).length, 1);
        assert.deepEqual(lines, []);
      }).pipe(provideAll(fixture.layer)),
    );
  }),
);
