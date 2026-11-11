// @effect-diagnostics nodeBuiltinImport:off -- real Git fixtures run in temporary repositories.
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadForkWorkspace,
  type Project,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import { isolatedGitEnv } from "@goat/shared/testing/gitEnv";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../CommandReceiptStore.ts";
import { OrchestratorDispatchError } from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { layerRealGit } from "../ProviderTurnStartService.testkit.ts";
import * as ThreadManagementService from "../ThreadManagementService.ts";
import * as ThreadForkWorkspace from "./ThreadForkWorkspace.ts";

const sourceThreadId = ThreadId.make("thread:fork-ws-source");
const projectId = ProjectId.make("project:fork-ws");
const providerInstanceId = ProviderInstanceId.make("codex");
const sourceRunId = RunId.make("run:fork-ws-source");

const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    env: isolatedGitEnv(),
    encoding: "utf8",
  }).trim();

interface World {
  readonly root: string;
  readonly repo: string;
  readonly threads: Map<ThreadId, OrchestrationV2AppThread>;
  readonly receipts: Map<CommandId, CommandReceiptStore.CommandReceiptV2>;
  readonly dispatches: Array<OrchestrationV2ServerCommand>;
  runs: ReadonlyArray<OrchestrationV2Run>;
  outcome: "accept" | "reject" | "commit_then_fail";
  gate: Deferred.Deferred<void> | null;
  scratch: boolean;
  capabilities: OrchestrationV2ProviderCapabilities;
  setupRuns: number;
  context: Context.Context<
    ThreadForkWorkspace.ThreadForkWorkspaceService | GitWorkflowService.GitWorkflowService
  >;
}

const makeRepo = (world: Pick<World, "repo">) => {
  NodeFS.mkdirSync(world.repo);
  git(world.repo, ["init", "-b", "main"]);
  git(world.repo, ["config", "user.name", "Test"]);
  git(world.repo, ["config", "user.email", "test@example.com"]);
  NodeFS.writeFileSync(NodePath.join(world.repo, "tracked.txt"), "base\n");
  NodeFS.writeFileSync(NodePath.join(world.repo, "deleted.txt"), "doomed\n");
  NodeFS.writeFileSync(NodePath.join(world.repo, "script.sh"), "echo hi\n");
  NodeFS.writeFileSync(NodePath.join(world.repo, ".gitignore"), "*.log\n");
  git(world.repo, ["add", "."]);
  git(world.repo, ["commit", "-m", "base"]);
};

const acquireWorld = Effect.acquireRelease(
  Effect.sync((): World => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-fork-ws-"));
    const world: World = {
      root,
      repo: NodePath.join(root, "repo"),
      threads: new Map(),
      receipts: new Map(),
      dispatches: [],
      runs: [{ id: sourceRunId, status: "completed" } as unknown as OrchestrationV2Run],
      outcome: "accept",
      gate: null,
      scratch: false,
      capabilities: CodexProviderCapabilitiesV2,
      setupRuns: 0,
      context: Context.empty() as World["context"],
    };
    makeRepo(world);
    world.threads.set(sourceThreadId, {
      id: sourceThreadId,
      projectId,
      providerInstanceId,
      branch: "main",
      worktreePath: null,
    } as unknown as OrchestrationV2AppThread);
    return world;
  }),
  (world) => Effect.sync(() => NodeFS.rmSync(world.root, { recursive: true, force: true })),
);

// Built in the test's scope: the test config's temp folder holds the worktrees until the test ends.
const makeWorld = Effect.gen(function* () {
  const world = yield* acquireWorld;
  world.context = yield* Layer.build(
    ThreadForkWorkspace.layer.pipe(
      Layer.provide(layerFakes(world)),
      Layer.provideMerge(layerRealGit),
    ),
  );
  return world;
});

const layerFakes = (world: World) =>
  Layer.mergeAll(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: (threadId: ThreadId) => {
        const thread = world.threads.get(threadId);
        return thread === undefined
          ? Effect.fail(
              new ThreadManagementService.ThreadManagementThreadNotFoundError({
                projectId,
                threadId,
              }),
            )
          : Effect.succeed({ thread, runs: threadId === sourceThreadId ? world.runs : [] });
      },
      dispatch: (command: OrchestrationV2ServerCommand) =>
        Effect.gen(function* () {
          world.dispatches.push(command);
          if (command.type !== "thread.fork") return yield* Effect.die("unexpected command");
          if (world.gate !== null) yield* Deferred.await(world.gate);
          const sequence = world.dispatches.length;
          const receipt = (status: "accepted" | "rejected") =>
            world.receipts.set(command.commandId, {
              commandId: command.commandId,
              threadId: command.targetThreadId,
              commandType: command.type,
              acceptedAt: undefined as never,
              resultSequence: sequence,
              status,
              error: status === "rejected" ? "Refused by the test" : null,
            });
          const refused = new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Refused by the test",
          });
          if (world.outcome === "reject") {
            receipt("rejected");
            return yield* refused;
          }
          const source = world.threads.get(command.sourceThreadId);
          world.threads.set(command.targetThreadId, {
            ...source,
            id: command.targetThreadId,
            branch: command.workspace?.branch ?? source?.branch ?? null,
            worktreePath: command.workspace?.worktreePath ?? source?.worktreePath ?? null,
          } as unknown as OrchestrationV2AppThread);
          receipt("accepted");
          if (world.outcome === "commit_then_fail") return yield* refused;
          return { sequence, storedEvents: [] } as unknown as Effect.Success<
            ReturnType<ThreadManagementService.ThreadManagementServiceShape["dispatch"]>
          >;
        }),
    } as never),
    Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
      getByCommandId: (commandId: CommandId) =>
        Effect.succeed(Option.fromNullishOr(world.receipts.get(commandId))),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: () =>
        Effect.succeedSome({
          id: projectId,
          workspaceRoot: world.repo,
          scripts: [],
        } as unknown as Project),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: NodePath.join(world.root, "projects"),
      isScratchProject: () => Effect.succeed(world.scratch),
    }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      get: () =>
        Effect.succeed({ getCapabilities: () => Effect.succeed(world.capabilities) } as never),
    }),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
      runForThread: () =>
        Effect.sync(() => {
          world.setupRuns += 1;
          return { status: "no-script" } as const;
        }),
    }),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
      // The fork only asks for a refresh; nothing reads the status here.
      refreshStatus: () => Effect.succeed({ isRepo: true } as never),
    }),
  );

const forkIn = (
  world: World,
  options: {
    readonly commandId?: string;
    readonly workspace?: OrchestrationV2ThreadForkWorkspace;
    readonly sourcePoint?:
      | { readonly type: "latest_stable" }
      | { readonly type: "run"; readonly runId: RunId };
  } = {},
) => {
  const commandId = CommandId.make(options.commandId ?? "fork-ws-command");
  return Effect.gen(function* () {
    const forks = yield* ThreadForkWorkspace.ThreadForkWorkspaceService;
    return yield* forks.fork({
      commandId,
      sourceThreadId,
      targetThreadId: ThreadId.make(`${commandId}:fork`),
      sourcePoint: options.sourcePoint ?? { type: "latest_stable" },
      workspace: options.workspace ?? { type: "worktree" },
      createdBy: "user",
      creationSource: "web",
    });
  });
};

const withService =
  (world: World) =>
  <A, E>(
    effect: Effect.Effect<
      A,
      E,
      ThreadForkWorkspace.ThreadForkWorkspaceService | GitWorkflowService.GitWorkflowService
    >,
  ) =>
    Effect.provide(effect, world.context);

const worktreePaths = (repo: string) =>
  git(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
const forkSnapshotRefs = (repo: string) =>
  git(repo, ["for-each-ref", "--format=%(refname)", "refs/goat/snapshots/"])
    .split("\n")
    .filter((ref) => ref.startsWith("refs/goat/snapshots/fork-"));
const read = (dir: string, name: string) => NodeFS.readFileSync(NodePath.join(dir, name), "utf8");

it.effect(
  "a worktree fork starts on a new branch at the source HEAD and leaves the source as it was",
  () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      NodeFS.writeFileSync(NodePath.join(world.repo, "tracked.txt"), "edited in source\n");
      const head = git(world.repo, ["rev-parse", "HEAD"]);
      const statusBefore = git(world.repo, ["status", "--porcelain"]);

      const result = yield* forkIn(world).pipe(withService(world));

      const worktree = result.worktree;
      assert.isDefined(worktree);
      if (worktree === undefined) return;
      assert.notEqual(worktree.worktreePath, world.repo);
      assert.equal(worktree.baseCommit, head);
      assert.equal(git(worktree.worktreePath, ["rev-parse", "HEAD"]), head);
      assert.equal(git(worktree.worktreePath, ["branch", "--show-current"]), worktree.branch);
      assert.equal(worktree.setupScript, "no-script");
      const dispatched = world.dispatches[0];
      assert.equal(dispatched?.type, "thread.fork");
      if (dispatched?.type !== "thread.fork") return;
      assert.deepEqual(dispatched.workspace, {
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
      });
      assert.equal(git(world.repo, ["status", "--porcelain"]), statusBefore);
      assert.equal(read(world.repo, "tracked.txt"), "edited in source\n");
    }).pipe(Effect.scoped),
);

// Modes: the server test setup forces core.filemode=false; GitWorkspaceSnapshotMaterialize.test.ts covers them.
it.effect("carries tracked edits, deletions and new files into the fork without staging them", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    git(world.repo, ["update-ref", "refs/goat/snapshots/other-operation", "HEAD"]);
    NodeFS.writeFileSync(NodePath.join(world.repo, "tracked.txt"), "edited\n");
    NodeFS.rmSync(NodePath.join(world.repo, "deleted.txt"));
    NodeFS.writeFileSync(NodePath.join(world.repo, "staged.txt"), "staged\n");
    git(world.repo, ["add", "staged.txt"]);
    NodeFS.writeFileSync(NodePath.join(world.repo, "untracked.txt"), "new\n");
    NodeFS.writeFileSync(NodePath.join(world.repo, "debug.log"), "ignored\n");
    NodeFS.writeFileSync(NodePath.join(world.repo, "forced.log"), "force-added\n");
    git(world.repo, ["add", "-f", "forced.log"]);
    const head = git(world.repo, ["rev-parse", "HEAD"]);

    const result = yield* forkIn(world).pipe(withService(world));
    const fork = result.worktree?.worktreePath ?? "";

    assert.equal(result.worktree?.uncommitted, "carried");
    assert.equal(read(fork, "tracked.txt"), "edited\n");
    assert.isFalse(NodeFS.existsSync(NodePath.join(fork, "deleted.txt")));
    assert.equal(read(fork, "staged.txt"), "staged\n");
    assert.equal(read(fork, "untracked.txt"), "new\n");
    assert.isFalse(NodeFS.existsSync(NodePath.join(fork, "debug.log")));
    assert.equal(read(fork, "forced.log"), "force-added\n");
    assert.equal(git(fork, ["rev-parse", "HEAD"]), head);
    assert.equal(git(fork, ["diff", "--cached", "--name-only"]), "");
    assert.deepEqual(forkSnapshotRefs(world.repo), []);
    assert.equal(git(world.repo, ["rev-parse", "refs/goat/snapshots/other-operation"]), head);
  }).pipe(Effect.scoped),
);

it.effect("leaves uncommitted changes behind when asked and says whether there were any", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    const clean = yield* forkIn(world, { commandId: "fork-clean" }).pipe(withService(world));
    assert.equal(clean.worktree?.uncommitted, "none");

    NodeFS.writeFileSync(NodePath.join(world.repo, "tracked.txt"), "edited\n");
    const left = yield* forkIn(world, {
      commandId: "fork-left",
      workspace: { type: "worktree", includeUncommitted: false },
    }).pipe(withService(world));
    assert.equal(left.worktree?.uncommitted, "left");
    assert.equal(read(left.worktree?.worktreePath ?? "", "tracked.txt"), "base\n");
  }).pipe(Effect.scoped),
);

it.effect("carries an edit made after git status was cached", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    const result = yield* Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.isTrue((yield* workflow.localStatus({ cwd: world.repo })).isRepo);
      NodeFS.writeFileSync(NodePath.join(world.repo, "tracked.txt"), "after the cache\n");
      return yield* forkIn(world);
    }).pipe(withService(world));
    assert.equal(read(result.worktree?.worktreePath ?? "", "tracked.txt"), "after the cache\n");
  }).pipe(Effect.scoped),
);

it.effect("writes a changed file under the project's sparse exclusion and nothing else there", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    NodeFS.mkdirSync(NodePath.join(world.repo, "vendor"));
    NodeFS.writeFileSync(NodePath.join(world.repo, "vendor/edited.txt"), "vendor base\n");
    NodeFS.writeFileSync(NodePath.join(world.repo, "vendor/sibling.txt"), "sibling\n");
    NodeFS.writeFileSync(
      NodePath.join(world.repo, "goat.json"),
      JSON.stringify({ worktreeSparseExclude: ["vendor/"] }),
    );
    git(world.repo, ["add", "."]);
    git(world.repo, ["commit", "-m", "vendor"]);
    NodeFS.writeFileSync(NodePath.join(world.repo, "vendor/edited.txt"), "vendor edit\n");

    const result = yield* forkIn(world).pipe(withService(world));
    const fork = result.worktree?.worktreePath ?? "";

    assert.equal(result.worktree?.uncommitted, "carried");
    assert.equal(read(fork, "vendor/edited.txt"), "vendor edit\n");
    assert.isFalse(NodeFS.existsSync(NodePath.join(fork, "vendor/sibling.txt")));
  }).pipe(Effect.scoped),
);

it.effect("refuses a source whose changes cannot be snapshotted, and forks it without them", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    const head = git(world.repo, ["rev-parse", "HEAD"]);
    git(world.repo, ["update-index", "--add", "--cacheinfo", `160000,${head},module`]);
    git(world.repo, ["commit", "-m", "gitlink"]);
    git(world.repo, [
      "update-index",
      "--cacheinfo",
      `160000,${git(world.repo, ["rev-parse", "HEAD"])},module`,
    ]);
    const branchesBefore = git(world.repo, ["branch", "--format=%(refname:short)"]);

    const error = yield* forkIn(world, { commandId: "fork-gitlink" }).pipe(
      withService(world),
      Effect.flip,
    );
    assert.equal(error.reason, "uncommitted_unsupported");
    assert.deepEqual(worktreePaths(world.repo), [NodeFS.realpathSync(world.repo)]);
    assert.equal(git(world.repo, ["branch", "--format=%(refname:short)"]), branchesBefore);
    assert.deepEqual(forkSnapshotRefs(world.repo), []);
    assert.deepEqual(world.dispatches, []);

    const without = yield* forkIn(world, {
      commandId: "fork-gitlink-without",
      workspace: { type: "worktree", includeUncommitted: false },
    }).pipe(withService(world));
    assert.equal(without.worktree?.uncommitted, "left");
  }).pipe(Effect.scoped),
);

it.effect.each([
  [
    "side_chat",
    (world: World) =>
      world.threads.set(sourceThreadId, {
        ...world.threads.get(sourceThreadId),
        sideChatOf: ThreadId.make("parent"),
      } as unknown as OrchestrationV2AppThread),
  ],
  [
    "scratch_project",
    (world: World) => {
      world.scratch = true;
    },
  ],
  [
    "cloud_provider",
    (world: World) => {
      world.capabilities = {
        ...CodexProviderCapabilitiesV2,
        sessions: { ...CodexProviderCapabilitiesV2.sessions, executionLocation: "cloud" },
      };
    },
  ],
  [
    "checkout_missing",
    (world: World) =>
      world.threads.set(sourceThreadId, {
        ...world.threads.get(sourceThreadId),
        worktreePath: NodePath.join(world.root, "gone"),
      } as unknown as OrchestrationV2AppThread),
  ],
  [
    "not_git_repository",
    (world: World) => {
      const plain = NodePath.join(world.root, "plain");
      NodeFS.mkdirSync(plain);
      world.threads.set(sourceThreadId, {
        ...world.threads.get(sourceThreadId),
        worktreePath: plain,
      } as unknown as OrchestrationV2AppThread);
    },
  ],
  [
    "branch_exists",
    (world: World) => {
      git(world.repo, ["branch", "taken"]);
    },
  ],
  [
    "fork_failed",
    (world: World) => {
      world.runs = [{ id: sourceRunId, status: "running" } as unknown as OrchestrationV2Run];
    },
  ],
] as const)("refuses %s before creating anything", ([reason, arrange]) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    arrange(world);
    const branchesBefore = git(world.repo, ["branch", "--format=%(refname:short)"]);
    const error = yield* forkIn(world, {
      workspace: { type: "worktree", ...(reason === "branch_exists" ? { branch: "taken" } : {}) },
    }).pipe(withService(world), Effect.flip);
    assert.equal(error.reason, reason);
    assert.deepEqual(worktreePaths(world.repo), [NodeFS.realpathSync(world.repo)]);
    assert.equal(git(world.repo, ["branch", "--format=%(refname:short)"]), branchesBefore);
    assert.deepEqual(world.dispatches, []);
  }).pipe(Effect.scoped),
);

it.effect("removes only what it created when the fork is refused after the worktree exists", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    git(world.repo, ["branch", "pre-existing"]);
    world.outcome = "reject";
    const error = yield* forkIn(world).pipe(withService(world), Effect.flip);
    assert.equal(error.reason, "fork_failed");
    assert.isUndefined(error.retainedWorktreePath);
    assert.deepEqual(worktreePaths(world.repo), [NodeFS.realpathSync(world.repo)]);
    assert.deepEqual(git(world.repo, ["branch", "--format=%(refname:short)"]).split("\n").sort(), [
      "main",
      "pre-existing",
    ]);
  }).pipe(Effect.scoped),
);

it.effect(
  "keeps the checkout and returns the fork when dispatch fails after the fork committed",
  () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      world.outcome = "commit_then_fail";
      const result = yield* forkIn(world).pipe(withService(world));
      const path = result.worktree?.worktreePath ?? "";
      assert.isTrue(NodeFS.existsSync(path));
      assert.equal(world.threads.get(result.targetThreadId)?.worktreePath, path);
    }).pipe(Effect.scoped),
);

it.effect("a retry with the same command replays the first fork without a second checkout", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    const first = yield* forkIn(world).pipe(withService(world));
    const second = yield* forkIn(world).pipe(withService(world));
    assert.equal(second.targetThreadId, first.targetThreadId);
    assert.equal(second.sequence, first.sequence);
    assert.equal(second.worktree?.worktreePath, first.worktree?.worktreePath);
    assert.equal(second.worktree?.setupScript, "unknown");
    assert.isNull(second.worktree?.baseCommit);
    assert.lengthOf(worktreePaths(world.repo), 2);
    assert.equal(world.setupRuns, 1);
  }).pipe(Effect.scoped),
);

it.effect("two concurrent calls with one command make one checkout", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    world.gate = yield* Deferred.make<void>();
    const results = yield* Effect.gen(function* () {
      const first = yield* forkIn(world).pipe(Effect.forkChild);
      const second = yield* forkIn(world).pipe(Effect.forkChild);
      // The first call holds the command's lock inside dispatch; release it.
      yield* Deferred.succeed(world.gate as Deferred.Deferred<void>, undefined);
      return [yield* Fiber.join(first), yield* Fiber.join(second)] as const;
    }).pipe(withService(world));
    assert.equal(results[0].targetThreadId, results[1].targetThreadId);
    assert.lengthOf(worktreePaths(world.repo), 2);
    assert.lengthOf(world.dispatches, 1);
  }).pipe(Effect.scoped),
);

it.effect(
  "forks from the source checkout's current HEAD, also for an older run or a worktree source",
  () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const sourceWorktree = NodePath.join(world.root, "source-worktree");
      git(world.repo, ["worktree", "add", "-b", "source-branch", sourceWorktree]);
      NodeFS.writeFileSync(NodePath.join(sourceWorktree, "tracked.txt"), "worktree commit\n");
      git(sourceWorktree, ["commit", "-am", "worktree commit"]);
      world.threads.set(sourceThreadId, {
        ...world.threads.get(sourceThreadId),
        branch: "source-branch",
        worktreePath: sourceWorktree,
      } as unknown as OrchestrationV2AppThread);

      const result = yield* forkIn(world, {
        sourcePoint: { type: "run", runId: sourceRunId },
      }).pipe(withService(world));
      assert.equal(result.worktree?.baseCommit, git(sourceWorktree, ["rev-parse", "HEAD"]));
      assert.equal(read(result.worktree?.worktreePath ?? "", "tracked.txt"), "worktree commit\n");
    }).pipe(Effect.scoped),
);
