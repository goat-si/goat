import {
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  type WorktreeMcpCleanupEntry,
  type WorktreeMcpCleanupInput,
  type WorktreeMcpCleanupResult,
  type WorktreeMcpInventoryEntry,
  type WorktreeMcpInventoryInput,
  type WorktreeMcpInventoryResult,
  type WorktreeMcpRemoveInput,
  type WorktreeMcpRemoveResult,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import { threadHasQueuedTurnStart } from "../orchestration-v2/ThreadSettlementService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "../worktreesDirectory.ts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

type LocalInput<A> = Omit<A, "host">;

/**
 * Lists, removes, and sweeps the git worktrees of this environment's project
 * repositories. Dispatchers create a worktree per thread and nothing removes
 * it when the thread ends, so agents need a safe way to clean up after
 * themselves. A tool call naming a host reaches the same service on that host.
 */
export class WorktreeInventoryService extends Context.Service<
  WorktreeInventoryService,
  {
    readonly inventory: (
      input: LocalInput<WorktreeMcpInventoryInput>,
    ) => Effect.Effect<WorktreeMcpInventoryResult, OrchestratorMcpFailure>;
    /** Refuses busy threads, main checkouts and project folders always; unsaved work unless forced. */
    readonly remove: (
      input: LocalInput<WorktreeMcpRemoveInput>,
    ) => Effect.Effect<WorktreeMcpRemoveResult, OrchestratorMcpFailure>;
    readonly cleanup: (
      input: LocalInput<WorktreeMcpCleanupInput>,
    ) => Effect.Effect<WorktreeMcpCleanupResult, OrchestratorMcpFailure>;
  }
>()("goat/mcp/WorktreeInventoryService") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const BUSY_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** Whether a thread may still use its checkout: a run, queued turn, question, or background work. */
export function worktreeThreadBusy(thread: OrchestrationV2ThreadShell, nowMs: number): boolean {
  return (
    thread.activeRunId !== null ||
    BUSY_STATUSES.has(thread.status) ||
    thread.pendingRuntimeRequest !== null ||
    (thread.pendingBackgroundTasks?.length ?? 0) > 0 ||
    threadHasQueuedTurnStart(thread, nowMs)
  );
}

interface WorktreeRecord {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly bare: boolean;
  readonly prunable: boolean;
}

/** Parses `git worktree list --porcelain -z`: one record per worktree, each ended by an empty field. */
function parseWorktreeRecords(stdout: string): ReadonlyArray<WorktreeRecord> {
  return stdout.split("\0\0").flatMap((record) => {
    const fields = record.split("\0");
    const worktree = fields.find((field) => field.startsWith("worktree "));
    if (worktree === undefined) return [];
    const branch = fields.find((field) => field.startsWith("branch "))?.slice("branch ".length);
    return [
      {
        path: worktree.slice("worktree ".length),
        head: fields.find((field) => field.startsWith("HEAD "))?.slice("HEAD ".length) ?? null,
        branch: branch?.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : null,
        bare: fields.includes("bare"),
        prunable: fields.some((field) => field.startsWith("prunable")),
      },
    ];
  });
}

/** Counts `git status --porcelain=v1 -z` entries; a rename or copy carries its source as an extra field. */
function countStatusEntries(stdout: string): number {
  const records = stdout.split("\0").filter(Boolean);
  let count = 0;
  for (let index = 0; index < records.length; index++) {
    count++;
    if (/^[RC]|^.[RC]/.test(records[index]!)) index++;
  }
  return count;
}

interface WorktreeFacts {
  readonly entry: WorktreeMcpInventoryEntry;
  readonly head: string | null;
  /** The folder is, or contains, a registered project's workspace root. */
  readonly holdsProject: boolean;
  /**
   * The worktree's own path and every bound thread's recorded path: the keys
   * turn start and storage cleanup take the workspace lease under.
   */
  readonly leaseKeys: ReadonlyArray<string>;
}

interface ScanContext {
  readonly threadsByPath: ReadonlyMap<string, ReadonlyArray<OrchestrationV2ThreadShell>>;
  readonly archivedIds: ReadonlySet<string>;
  readonly projectRoots: ReadonlyArray<string>;
  readonly managedRoots: ReadonlyArray<string>;
  readonly nowMs: number;
}

const files = (count: number) => (count === 1 ? "1 file" : String(count) + " files");
const commits = (count: number) => (count === 1 ? "1 commit" : String(count) + " commits");

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const real = (target: string) =>
    fs.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
  const within = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
    );
  };
  const gitRead = (cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({
        operation: "WorktreeInventory.read",
        cwd,
        args,
        allowNonZeroExit: true,
        maxOutputBytes: 256 * 1024,
      })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result : null)),
        Effect.orElseSucceed(() => null),
      );

  const unavailable = (what: string) =>
    Effect.mapError((error: { readonly message: string }) =>
      failure("orchestration_error", "Could not read " + what + ": " + error.message),
    );

  const loadContext = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const active = yield* threads
      .getShellSnapshot({ location: "active" })
      .pipe(unavailable("threads"));
    const archived = yield* threads
      .getShellSnapshot({ location: "archive" })
      .pipe(unavailable("archived threads"));
    const bound = [...active.threads, ...archived.threads].filter(
      (thread) => thread.worktreePath !== null,
    );
    const threadsByPath = new Map<string, Array<OrchestrationV2ThreadShell>>();
    yield* Effect.forEach(
      bound,
      (thread) =>
        real(thread.worktreePath!).pipe(
          Effect.map((key) => {
            const list = threadsByPath.get(key) ?? [];
            if (!list.some((entry) => entry.id === thread.id)) list.push(thread);
            threadsByPath.set(key, list);
          }),
        ),
      { concurrency: 16, discard: true },
    );
    const shells = yield* projects.listShells().pipe(unavailable("projects"));
    const projectRoots = yield* Effect.forEach(shells, (project) => real(project.workspaceRoot));
    const settings = yield* serverSettings.getSettings.pipe(unavailable("server settings"));
    const managedRoots: Array<string> = [];
    for (const directory of managedWorktreesDirectories(
      settings,
      config.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
      yield* HostProcess.Platform,
    )) {
      const root = yield* real(directory);
      if (!isFilesystemRoot(root, path)) managedRoots.push(root);
    }
    return {
      context: {
        threadsByPath,
        archivedIds: new Set(archived.threads.map((thread) => thread.id)),
        projectRoots,
        managedRoots,
        nowMs,
      } satisfies ScanContext,
      repositories: shells.map((project) => project.workspaceRoot),
    };
  });

  /** Every worktree of the repository at `cwd`, or null when it is not a repository. */
  const scanRepository = Effect.fn("WorktreeInventory.scanRepository")(function* (
    cwd: string,
    context: ScanContext,
  ) {
    if (!(yield* fs.exists(cwd).pipe(Effect.orElseSucceed(() => false)))) return null;
    const listed = yield* gitRead(cwd, ["worktree", "list", "--porcelain", "-z"]);
    if (listed === null) return null;
    const records = parseWorktreeRecords(listed.stdout);
    const first = records[0];
    if (first === undefined) return null;
    const repository = path.resolve(cwd, first.path);
    return yield* Effect.forEach(
      records.filter((record) => !record.bare),
      (record) =>
        Effect.gen(function* () {
          const worktreePath = path.resolve(cwd, record.path);
          const key = yield* real(worktreePath);
          const shells = context.threadsByPath.get(key) ?? [];
          const missing =
            record.prunable ||
            !(yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => false)));
          const status = missing
            ? null
            : yield* gitRead(worktreePath, [
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=normal",
                "--ignore-submodules=none",
              ]);
          const ahead =
            record.head === null
              ? null
              : yield* gitRead(repository, [
                  "rev-list",
                  "--count",
                  record.head,
                  "--not",
                  "--remotes",
                ]);
          const aheadCount = ahead === null ? null : Number.parseInt(ahead.stdout.trim(), 10);
          const entry: WorktreeMcpInventoryEntry = {
            path: worktreePath,
            repository,
            branch: record.branch,
            main: record === first,
            missing,
            managed: context.managedRoots.some((root) => root !== key && within(root, key)),
            threads: shells.map((thread) => ({
              threadId: thread.id,
              title: thread.title,
              status: thread.status,
              archived: context.archivedIds.has(thread.id),
              busy: worktreeThreadBusy(thread, context.nowMs),
            })),
            dirtyCount:
              status === null || status.stdoutTruncated ? null : countStatusEntries(status.stdout),
            aheadCount: aheadCount === null || Number.isNaN(aheadCount) ? null : aheadCount,
          };
          return {
            entry,
            head: record.head,
            holdsProject: context.projectRoots.some((root) => within(key, root)),
            leaseKeys: [
              ...new Set([
                worktreePath,
                ...shells.map((thread) => path.resolve(thread.worktreePath!)),
              ]),
            ].toSorted(),
          } satisfies WorktreeFacts;
        }),
      { concurrency: 8 },
    );
  });

  /** The main checkout of the repository at `cwd`, canonical, or null when it is none. */
  const repositoryOf = (cwd: string) =>
    gitRead(cwd, ["worktree", "list", "--porcelain", "-z"]).pipe(
      Effect.flatMap((listed) => {
        const first = listed === null ? undefined : parseWorktreeRecords(listed.stdout)[0];
        return first === undefined
          ? Effect.succeed(null)
          : real(path.resolve(cwd, first.path)).pipe(Effect.map((key): string | null => key));
      }),
    );

  /**
   * Worktrees of `repo`, or of every project repository, each repository once.
   * Only registered projects' repositories count: these tools must never reach
   * a checkout GOAT does not manage.
   */
  const scan = Effect.fn("WorktreeInventory.scan")(function* (repo: string | undefined) {
    const { context, repositories } = yield* loadContext;
    if (repo !== undefined) {
      if (!path.isAbsolute(repo))
        return yield* failure("invalid_request", "repo must be an absolute path.");
      const repository = yield* repositoryOf(repo);
      if (repository === null)
        return yield* failure("invalid_request", repo + " is not inside a git repository.");
      const registered = yield* Effect.forEach(repositories, repositoryOf, { concurrency: 8 });
      if (!registered.includes(repository))
        return yield* failure(
          "invalid_request",
          repo +
            ` is not a repository of a GOAT project. ${goatCallText("project.list")} lists them.`,
        );
      return (yield* scanRepository(repo, context)) ?? [];
    }
    const seen = new Set<string>();
    const facts: Array<WorktreeFacts> = [];
    for (const root of repositories) {
      const scanned = yield* scanRepository(root, context);
      if (scanned === null) continue;
      const repository = scanned[0]?.entry.repository;
      if (repository === undefined || seen.has(repository)) continue;
      seen.add(repository);
      facts.push(...scanned);
    }
    return facts;
  });

  /**
   * Why the worktree's commits survive its removal, or null when some exist
   * only here. Counts remote-tracking refs as of the last fetch.
   */
  const savedBy = Effect.fn("WorktreeInventory.savedBy")(function* (facts: WorktreeFacts) {
    const { entry, head } = facts;
    if (entry.aheadCount === 0) return "every commit is on a remote";
    if (head === null) return null;
    const containing = yield* gitRead(entry.repository, [
      "for-each-ref",
      "--contains",
      head,
      "--format=%(refname:short)",
      "refs/heads",
    ]);
    const other = containing?.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((name) => name !== "" && name !== entry.branch);
    if (other !== undefined) return "its commits are on branch " + other;
    if (entry.branch === null) return null;
    // A squash merge leaves the head outside every branch, and the host often
    // deletes the remote branch, so the merged pull request has to name this head.
    const pullRequest = yield* gitManager
      .branchPullRequest(
        { cwd: entry.missing ? entry.repository : entry.path, branch: entry.branch },
        { refresh: true },
      )
      .pipe(Effect.orElseSucceed(() => null));
    if (
      pullRequest?.state === "merged" &&
      pullRequest.headRef === entry.branch &&
      pullRequest.headSha === head
    )
      return "pull request #" + String(pullRequest.number) + " was merged";
    return null;
  });

  /** Refusals no flag overrides. */
  const hardBlocker = (facts: WorktreeFacts) => {
    if (facts.entry.main) return "it is the repository's main checkout";
    if (facts.holdsProject) return "it is, or contains, a GOAT project's folder";
    const busy = facts.entry.threads.find((thread) => thread.busy);
    if (busy !== undefined)
      return (
        "thread " +
        busy.threadId +
        " (" +
        busy.title +
        ") is running or has pending work; interrupt it or wait for it to finish"
      );
    return null;
  };

  /**
   * Refusals `force` overrides, and what holds the commits (null when nothing
   * outside this worktree's branch does), which also decides branch deletion.
   */
  const unsavedWork = Effect.fn("WorktreeInventory.unsavedWork")(function* (facts: WorktreeFacts) {
    const { entry } = facts;
    const saved = yield* savedBy(facts);
    const dirty = entry.missing
      ? null
      : entry.dirtyCount === null
        ? "its status could not be read"
        : entry.dirtyCount > 0
          ? "it has " + files(entry.dirtyCount) + " with uncommitted changes"
          : null;
    if (dirty !== null) return { blocker: dirty, saved };
    if (saved !== null) return { blocker: null, saved };
    return {
      blocker:
        entry.aheadCount === null
          ? "its commits could not be compared with the remotes"
          : "it has " +
            commits(entry.aheadCount) +
            " on no remote and no branch or merged pull request holds them",
      saved: null,
    };
  });

  const inventory: WorktreeInventoryService["Service"]["inventory"] = (input) =>
    scan(input.repo).pipe(Effect.map((facts) => ({ worktrees: facts.map((fact) => fact.entry) })));

  /** Re-reads one worktree's facts, so a decision uses the state under the lease. */
  const reread = (repository: string, key: string) =>
    Effect.gen(function* () {
      const { context } = yield* loadContext;
      const scanned = (yield* scanRepository(repository, context)) ?? [];
      for (const facts of scanned) if ((yield* real(facts.entry.path)) === key) return facts;
      return null;
    });

  /**
   * The remote's default branch: the recorded remote HEAD, or the remote's
   * own answer when none is recorded, as after `git remote add` and a push.
   */
  const remoteDefaultBranch = (facts: WorktreeFacts, remote: string) =>
    Effect.gen(function* () {
      const recorded = yield* git
        .resolveDefaultBranchName(facts.entry.repository, remote)
        .pipe(Effect.orElseSucceed(() => null));
      if (recorded !== null) return recorded;
      const listed = yield* git
        .execute({
          operation: "WorktreeInventory.remoteHead",
          cwd: facts.entry.repository,
          args: ["ls-remote", "--symref", remote, "HEAD"],
          allowNonZeroExit: true,
          timeoutMs: 15_000,
          maxOutputBytes: 64 * 1024,
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (listed === null || listed.exitCode !== 0) return null;
      return /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(listed.stdout)?.[1] ?? null;
    });

  /** Why a branch must outlive its worktree, or null when deleting it loses nothing. */
  const branchBlocker = Effect.fn("WorktreeInventory.branchBlocker")(function* (
    facts: WorktreeFacts,
    saved: string | null,
    deleteUnsavedBranch: boolean,
  ) {
    const branch = facts.entry.branch;
    if (branch === null) return null;
    const remote = yield* git
      .resolvePrimaryRemoteName(facts.entry.repository)
      .pipe(Effect.orElseSucceed(() => null));
    const defaultBranch = remote === null ? null : yield* remoteDefaultBranch(facts, remote);
    if (defaultBranch !== null) {
      if (branch === defaultBranch)
        return "branch " + branch + " is the repository's default branch";
    } else {
      if (branch === "main" || branch === "master")
        return "branch " + branch + " is the repository's default branch";
      // The remote could not name its default, so any branch it also has might be it.
      const onRemote =
        remote !== null &&
        (yield* git
          .remoteBranchExists({ cwd: facts.entry.repository, remoteName: remote, refName: branch })
          .pipe(Effect.orElseSucceed(() => true)));
      if (onRemote)
        return (
          "branch " +
          branch +
          " may be the repository's default branch: " +
          remote +
          " could not be asked for its default and has a branch of this name"
        );
    }
    if (saved === null && !deleteUnsavedBranch)
      return (
        "branch " +
        branch +
        " holds commits on no remote, other branch, or merged pull request. Pass deleteUnsavedBranch:true to delete it anyway"
      );
    return null;
  });

  /** Runs `effect` holding every lease in `keys`, taken in sorted order. */
  const withLeases = <A, E, R>(
    keys: ReadonlyArray<string>,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    keys.reduceRight((inner, key) => withWorkspaceLease(key, inner), effect);

  /** A thread bound to the worktree at `key` that is busy now, read fresh. */
  const busyNow = (key: string) =>
    loadContext.pipe(
      Effect.map(({ context }) =>
        (context.threadsByPath.get(key) ?? []).find((thread) =>
          worktreeThreadBusy(thread, context.nowMs),
        ),
      ),
    );

  /**
   * Removes one worktree under the workspace leases turn start and storage
   * cleanup take, after checking it again. The busy check repeats right before
   * deletion, since the commit and pull request checks above it can take seconds.
   */
  const removeChecked = Effect.fn("WorktreeInventory.removeChecked")(function* (
    target: WorktreeFacts,
    options: {
      readonly force: boolean;
      readonly deleteBranch: boolean;
      readonly deleteUnsavedBranch: boolean;
    },
  ) {
    const key = yield* real(target.entry.path);
    return yield* withLeases(
      target.leaseKeys,
      Effect.gen(function* () {
        const facts = yield* reread(target.entry.repository, key);
        if (facts === null)
          return yield* failure(
            "invalid_request",
            target.entry.path + " is no longer a worktree of " + target.entry.repository + ".",
          );
        const refuse = (reason: string) =>
          failure("invalid_request", "Refused to remove " + facts.entry.path + ": " + reason + ".");
        const hard = hardBlocker(facts);
        if (hard !== null) return yield* refuse(hard);
        const work = yield* unsavedWork(facts);
        if (work.blocker !== null && !options.force)
          return yield* refuse(work.blocker + ". Pass force:true to remove it anyway");
        const branch = facts.entry.branch;
        if (options.deleteBranch) {
          const blocker = yield* branchBlocker(facts, work.saved, options.deleteUnsavedBranch);
          if (blocker !== null) return yield* refuse(blocker);
        }
        const busy = yield* busyNow(key);
        if (busy !== undefined)
          return yield* refuse("thread " + busy.id + " started while this removal was checked");
        yield* git
          .removeWorktree({
            cwd: facts.entry.repository,
            path: facts.entry.path,
            force: options.force,
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                "git worktree remove failed for " + facts.entry.path + ": " + error.detail,
              ),
            ),
          );
        yield* git.pruneWorktrees({ cwd: facts.entry.repository }).pipe(Effect.ignore);
        const notes: Array<string> = [];
        if (work.blocker !== null) notes.push("Forced past: " + work.blocker + ".");
        let branchDeleted = false;
        if (options.deleteBranch && branch !== null) {
          yield* git
            .deleteLocalBranch({ cwd: facts.entry.repository, refName: branch, force: true })
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  branchDeleted = true;
                }),
              ),
              Effect.catch((error) =>
                Effect.sync(() => notes.push("Branch " + branch + " was kept: " + error.detail)),
              ),
            );
        }
        const resumable = facts.entry.threads.filter((thread) => !thread.archived);
        if (resumable.length > 0)
          notes.push(
            branchDeleted || branch === null
              ? "Thread " +
                  resumable.map((thread) => thread.threadId).join(", ") +
                  " still points at this path and cannot recreate its checkout."
              : "Thread " +
                  resumable.map((thread) => thread.threadId).join(", ") +
                  " still points at this path; it recreates the checkout from branch " +
                  branch +
                  " if it runs again.",
          );
        return { path: facts.entry.path, branch, branchDeleted, notes, saved: work.saved };
      }),
    );
  });

  const remove: WorktreeInventoryService["Service"]["remove"] = Effect.fn(
    "WorktreeInventory.remove",
  )(function* (input) {
    if ((input.path === undefined) === (input.threadId === undefined))
      return yield* failure("invalid_request", "Pass exactly one of path or threadId.");
    let targetPath = input.path;
    if (input.threadId !== undefined) {
      const thread = yield* threads
        .getThreadShell(input.threadId)
        .pipe(unavailable("thread " + input.threadId));
      if (thread === null)
        return yield* failure("thread_not_found", "Thread " + input.threadId + " was not found.");
      if (thread.worktreePath === null)
        return yield* failure(
          "invalid_request",
          "Thread " + input.threadId + " runs in its project folder, not a worktree.",
        );
      targetPath = thread.worktreePath;
    }
    if (!path.isAbsolute(targetPath!))
      return yield* failure("invalid_request", "path must be absolute.");
    const requested = path.resolve(targetPath!);
    const key = yield* real(requested);
    // A folder that still exists names its own repository, which must be a
    // project's; a missing one is found among the project repositories.
    const exists = yield* fs.exists(requested).pipe(Effect.orElseSucceed(() => false));
    const candidates = yield* scan(exists ? requested : undefined);
    let target: WorktreeFacts | undefined;
    for (const facts of candidates)
      if ((yield* real(facts.entry.path)) === key) {
        target = facts;
        break;
      }
    if (target === undefined)
      return yield* failure(
        "invalid_request",
        requested +
          ` is not a git worktree of a GOAT project. ${goatCallText("worktree.inventory")} lists them.`,
      );
    // A symlink to a worktree resolves to it; deleting through an alias would
    // remove a checkout the caller did not name. A path must be the worktree's
    // own; a threadId may also use the path that thread recorded, even when
    // that path is a symlink.
    const named = input.path !== undefined ? [target.entry.path] : target.leaseKeys;
    if (!named.includes(requested))
      return yield* failure(
        "invalid_request",
        requested +
          " is an alias of the worktree at " +
          target.entry.path +
          ". Pass the worktree's own path.",
      );
    const { saved: _saved, ...result } = yield* removeChecked(target, {
      force: input.force === true,
      deleteBranch: input.deleteBranch === true,
      deleteUnsavedBranch: input.deleteUnsavedBranch === true,
    });
    return result;
  });

  /** Why a sweep leaves this worktree alone, or null when only a removal check remains. */
  const sweepBlocker = (facts: WorktreeFacts) => {
    const hard = hardBlocker(facts);
    if (hard !== null) return hard;
    const unfinished = facts.entry.threads.find(
      (thread) => !thread.archived && thread.status === "idle",
    );
    if (unfinished !== undefined)
      return "thread " + unfinished.threadId + " (" + unfinished.title + ") has not finished a run";
    if (facts.entry.threads.length === 0 && !facts.entry.managed)
      return "it is bound to no thread and sits outside GOAT's worktrees folder";
    return null;
  };

  const cleanup: WorktreeInventoryService["Service"]["cleanup"] = Effect.fn(
    "WorktreeInventory.cleanup",
  )(function* (input) {
    const dryRun = input.dryRun !== false;
    const facts = yield* scan(input.repo);
    const removed: Array<WorktreeMcpCleanupEntry> = [];
    const kept: Array<WorktreeMcpCleanupEntry> = [];
    for (const fact of facts) {
      if (fact.entry.main) continue;
      const entry = { path: fact.entry.path, branch: fact.entry.branch };
      const blocker = sweepBlocker(fact);
      if (blocker !== null) {
        kept.push({ ...entry, reason: blocker });
        continue;
      }
      const work = yield* unsavedWork(fact);
      if (work.blocker !== null) {
        kept.push({ ...entry, reason: work.blocker });
        continue;
      }
      const reason = fact.entry.missing ? "its folder is already gone" : work.saved!;
      if (dryRun) {
        removed.push({ ...entry, reason });
        continue;
      }
      yield* removeChecked(fact, {
        force: false,
        deleteBranch: false,
        deleteUnsavedBranch: false,
      }).pipe(
        Effect.match({
          onFailure: (error) => kept.push({ ...entry, reason: error.message }),
          onSuccess: () => removed.push({ ...entry, reason }),
        }),
      );
    }
    return { dryRun, removed, kept };
  });

  return WorktreeInventoryService.of({ inventory, remove, cleanup });
});

export const layer = Layer.effect(WorktreeInventoryService, make);
