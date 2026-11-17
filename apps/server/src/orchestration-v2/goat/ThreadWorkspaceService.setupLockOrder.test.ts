// @effect-diagnostics nodeBuiltinImport:off -- real Git fixtures run in temporary repositories.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ProjectId, ThreadId } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
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
import { makeRestorePending } from "./restoreThreadWorkspace.ts";
import * as ThreadWorkspace from "./ThreadWorkspaceService.ts";

const threadId = ThreadId.make("thread-setup-lock-order");
const projectId = ProjectId.make("project-setup");

// goat#3674: while a restore holds the worktree and runs setup in a terminal, a person asks for
// another terminal of the same thread. Real TerminalManager and setup runner on a fake PTY;
// it.live because the restore and the fixtures run git as a subprocess.
type Gates = { beforeOpen?: Effect.Effect<void>; beforeSentinel?: Effect.Effect<void> };
const withSetupProject = <A, E, R>(
  setup: { readonly async: boolean; readonly gates?: Gates },
  body: (fixture: {
    readonly worktreePath: string;
    readonly pty: FakePtyAdapter;
    readonly dispatched: Array<{ readonly type: string; readonly worktreePath?: unknown }>;
    readonly git: (cwd: string, ...args: string[]) => string;
    readonly terminals: TerminalManager.TerminalManager["Service"];
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
    const dispatched: Array<{ readonly type: string; readonly worktreePath?: unknown }> = [];
    // The thread's worktree as the projection would show it after a rebind.
    const currentWorktree = () => {
      const rebound = dispatched.findLast((command) => typeof command.worktreePath === "string");
      return typeof rebound?.worktreePath === "string" ? rebound.worktreePath : worktreePath;
    };
    const terminals = yield* TerminalManager.makeWithOptions({
      logsDir: NodePath.join(root, "terminal-logs"),
      ptyAdapter: pty,
      processKillGraceMs: 1,
      threadWorktree: {
        current: () => Effect.suspend(() => Effect.succeedSome(currentWorktree())),
      },
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
              Effect.andThen(
                setup.gates?.beforeOpen ?? Effect.void,
                terminals
                  .open(input)
                  .pipe(
                    Effect.tap(() =>
                      Effect.sync(() => pty.processes.at(-1)?.emitData("$ \x1b[?2004h")),
                    ),
                  ),
              ),
            write: (input) =>
              terminals.write(input).pipe(
                Effect.tap(() => {
                  const sentinel = input.data.match(/__GOAT_SETUP_DONE__[a-f0-9_]+:/)?.[0];
                  if (sentinel === undefined) return Effect.void;
                  const proc = pty.processes.at(-1);
                  return (setup.gates?.beforeSentinel ?? Effect.void).pipe(
                    Effect.andThen(
                      Effect.sync(() => proc?.emitData(`ready\r\n${sentinel}0\r\n$ `)),
                    ),
                  );
                }),
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
    return yield* body({ worktreePath, pty, dispatched, git, terminals, layer });
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

type Person = "open" | "restart" | "attach" | "agent open";

/** The person's request in the restored worktree, with the pid its terminal got. */
const ask = (
  terminals: TerminalManager.TerminalManager["Service"],
  person: Person,
  worktreePath: string,
) =>
  Effect.gen(function* () {
    const input = {
      threadId,
      terminalId: "person",
      cwd: worktreePath,
      worktreePath,
      cols: 80,
      rows: 24,
    };
    switch (person) {
      case "open":
        return (yield* terminals.open(input)).pid;
      case "restart":
        return (yield* terminals.restart(input)).pid;
      case "attach": {
        const pids: Array<number | null> = [];
        const stop = yield* terminals.attachStream(input, (event) =>
          Effect.sync(() => {
            if (event.type === "snapshot") pids.push(event.snapshot.pid);
          }),
        );
        stop();
        return pids[0] ?? null;
      }
      case "agent open":
        return (yield* terminals.agentOpen!({
          threadId,
          cwd: worktreePath,
          owner: "agent",
          authorize: Effect.void,
        })).pid;
    }
  });

const restoreWhileAPersonAsks = (window: keyof Gates, person: Person) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const go = yield* Deferred.make<void>();
    const gate = Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(go)));
    const gates = window === "beforeOpen" ? { beforeOpen: gate } : { beforeSentinel: gate };
    yield* withSetupProject(
      { async: false, gates },
      ({ worktreePath, pty, git, terminals, layer }) =>
        Effect.gen(function* () {
          const pending = yield* markUnfinished(worktreePath, git);
          const service = yield* ThreadWorkspace.ThreadWorkspaceService;
          const restore = yield* service
            .restore({ threadId, mode: "restore" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(reached);
          // Runs until it waits for the folder the restore holds.
          const asked = yield* ask(terminals, person, worktreePath).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.succeed(go, undefined);
          const restored = yield* Fiber.join(restore);
          const pid = yield* Fiber.join(asked);
          assert.strictEqual(restored.setupScript, "started");
          assert.isFalse(yield* pending.marked(worktreePath));
          // The setup's shell first, then the person's, both in the worktree.
          assert.deepEqual(
            pty.spawnInputs.map((input) => input.cwd),
            [worktreePath, worktreePath],
          );
          assert.strictEqual(pid, pty.processes[1]?.pid);
        }).pipe(Effect.provide(ThreadWorkspace.layer.pipe(Layer.provideMerge(layer)))),
    );
  });

it.live.each([
  ["beforeOpen", "open"],
  ["beforeSentinel", "open"],
  ["beforeSentinel", "restart"],
  ["beforeSentinel", "attach"],
  ["beforeSentinel", "agent open"],
] as const)("a restore paused %s and a person's terminal %s both finish", ([window, person]) =>
  restoreWhileAPersonAsks(window, person),
);

it.live(
  "a terminal a person opens during Start in a new worktree's setup starts nothing in the old one",
  () =>
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const go = yield* Deferred.make<void>();
      const gate = Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(go)));
      yield* withSetupProject(
        { async: false, gates: { beforeSentinel: gate } },
        ({ worktreePath, pty, terminals, layer }) =>
          Effect.gen(function* () {
            const service = yield* ThreadWorkspace.ThreadWorkspaceService;
            const fresh = yield* service
              .restore({ threadId, mode: "fresh" })
              .pipe(Effect.forkChild);
            yield* Deferred.await(reached);
            // The person's client still names the thread's old worktree, which the start holds.
            const person = yield* Effect.flip(
              terminals.open({
                threadId,
                terminalId: "person",
                cwd: worktreePath,
                worktreePath,
                cols: 80,
                rows: 24,
              }),
            ).pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.succeed(go, undefined);
            const restored = yield* Fiber.join(fresh);
            const error = yield* Fiber.join(person);
            assert.strictEqual(error._tag, "TerminalCwdStatError");
            if (error._tag === "TerminalCwdStatError") assert.strictEqual(error.cwd, worktreePath);
            assert.notStrictEqual(restored.worktreePath, worktreePath);
            assert.deepEqual(
              pty.spawnInputs.map((input) => input.cwd),
              [restored.worktreePath],
            );
          }).pipe(Effect.provide(ThreadWorkspace.layer.pipe(Layer.provideMerge(layer)))),
      );
    }),
);
