import {
  ProjectId,
  ThreadId,
  SshWorkspaceError,
  type DesktopSshEnvironmentTarget,
  type SshWorkspaceLaunchInput,
  type SshWorkspaceLaunchResult,
  type SshWorkspaceFetchBackInput,
  type SshWorkspaceFetchBackResult,
  type SshWorkspaceStage,
  type SshWorkspaceCode,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Projects from "../project/ProjectService.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Dispatch from "./SshRemoteDispatch.ts";

const SSH_SCRIPT_TIMEOUT_MS = 30_000;
const GIT_TRANSFER_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT_BYTES = 1_000_000;
const safeAlias = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;
const safeUser = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;
const safeHostname = /^[A-Za-z0-9_[][A-Za-z0-9_.:\]-]*$/u;
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const secretName = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12)|id_rsa.*|id_ed25519.*)$/u;
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

export class SshWorkspaceSync extends Context.Service<
  SshWorkspaceSync,
  {
    readonly launch: (
      input: SshWorkspaceLaunchInput,
    ) => Effect.Effect<SshWorkspaceLaunchResult, SshWorkspaceError>;
    readonly fetchBack: (
      input: SshWorkspaceFetchBackInput,
    ) => Effect.Effect<SshWorkspaceFetchBackResult, SshWorkspaceError>;
  }
>()("goat/sshRemote/SshWorkspaceSync") {}

const make = Effect.gen(function* () {
  const projects = yield* Projects.ProjectService;
  const git = yield* Git.GitVcsDriver;
  const snapshots = yield* Git.makeVcsDriverShape();
  const dispatch = yield* Dispatch.SshRemoteDispatch;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;

  const validateTarget = Effect.fn("SshWorkspaceSync.validateTarget")(function* (
    target: DesktopSshEnvironmentTarget,
  ) {
    if (
      !safeAlias.test(target.alias) ||
      !safeHostname.test(target.hostname) ||
      (target.username !== null && !safeUser.test(target.username)) ||
      (target.port !== null &&
        (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535))
    )
      return yield* new SshWorkspaceError({ stage: "validate", code: "invalid_target" });
  });

  // SCP-style URL keeps SSH-config alias semantics; Git supplies this host argument to ssh.
  const remoteHost = (target: DesktopSshEnvironmentTarget) =>
    target.username === null ? target.alias : `${target.username}@${target.alias}`;
  const sshEnvironment = (target: DesktopSshEnvironmentTarget) => ({
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_VARIANT: "ssh",
    GIT_SSH_COMMAND: [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      ...(target.port === null ? [] : ["-p", String(target.port)]),
    ]
      .map(quote)
      .join(" "),
  });
  const repoName = Effect.fn("SshWorkspaceSync.repoName")(function* (workspaceRoot: string) {
    const basename = path.basename(workspaceRoot.replace(/[\\/]+$/u, ""));
    const slug =
      basename
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "") || "repo";
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(workspaceRoot))
      .pipe(Effect.orDie);
    return `${slug}-${Hex.encode(digest).slice(0, 8)}`;
  });
  const script = (
    target: DesktopSshEnvironmentTarget,
    text: string,
    stage: SshWorkspaceStage,
    code: SshWorkspaceCode,
    operationId?: string,
  ) =>
    dispatch.runRemoteScript({ target, script: text, timeoutMs: SSH_SCRIPT_TIMEOUT_MS }).pipe(
      Effect.mapError(
        () =>
          new SshWorkspaceError({
            stage,
            code,
            host: target.alias,
            ...(operationId === undefined ? {} : { operationId }),
          }),
      ),
    );
  const runGit = (
    cwd: string,
    args: ReadonlyArray<string>,
    stage: SshWorkspaceStage,
    code: SshWorkspaceCode,
    target: DesktopSshEnvironmentTarget,
    operationId?: string,
  ) =>
    git
      .execute({
        operation: `SshWorkspaceSync.${stage}`,
        cwd,
        args,
        env: sshEnvironment(target),
        timeoutMs: GIT_TRANSFER_TIMEOUT_MS,
        maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
      })
      .pipe(
        Effect.mapError(
          () =>
            new SshWorkspaceError({
              stage,
              code,
              host: target.alias,
              ...(operationId === undefined ? {} : { operationId }),
            }),
        ),
      );

  const initScript = (name: string) => `set -eu
umask 077
repo="$HOME/.goat/repos/${name}"
if [ -e "$repo" ] || [ -L "$repo" ]; then
  if [ -L "$repo" ] || [ ! -d "$repo/.git" ] || [ -L "$repo/.git" ] ||
     [ "$(git -C "$repo" config --local --get goat.managed 2>/dev/null || true)" != true ]; then
    printf 'GOAT_FOREIGN_PATH\\n'
    exit 0
  fi
else
  mkdir -p "$HOME/.goat/repos"
  if mkdir "$repo" 2>/dev/null; then
    git init --quiet "$repo"
    git -C "$repo" config --local goat.managed true
  else
    if [ -L "$repo" ] || [ ! -d "$repo/.git" ] ||
       [ "$(git -C "$repo" config --local --get goat.managed 2>/dev/null || true)" != true ]; then
      printf 'GOAT_FOREIGN_PATH\\n'
      exit 0
    fi
  fi
fi
if [ "$(git -C "$repo" rev-parse --is-bare-repository)" != false ] ||
   [ "$(git -C "$repo" rev-parse --show-toplevel)" != "$repo" ]; then
  printf 'GOAT_FOREIGN_PATH\\n'
  exit 0
fi
printf 'GOAT_REPO\\n%s\\n' "$repo"
`;
  const readRepoPath = Effect.fn("SshWorkspaceSync.readRepoPath")(function* (
    stdout: string,
    target: DesktopSshEnvironmentTarget,
    name: string,
    operationId?: string,
  ) {
    const lines = stdout.trimEnd().split(/\r?\n/u);
    if (lines.at(-1) === "GOAT_FOREIGN_PATH")
      return yield* new SshWorkspaceError({
        stage: "remote_init",
        code: "foreign_path",
        host: target.alias,
        ...(operationId === undefined ? {} : { operationId }),
      });
    const repo = lines.at(-1);
    if (
      lines.at(-2) !== "GOAT_REPO" ||
      repo === undefined ||
      !repo.startsWith("/") ||
      !repo.endsWith(`/.goat/repos/${name}`) ||
      /[\0\r\n]/u.test(repo)
    )
      return yield* new SshWorkspaceError({
        stage: "remote_init",
        code: "invalid_remote_response",
        host: target.alias,
        ...(operationId === undefined ? {} : { operationId }),
      });
    return repo;
  });
  const readOid = Effect.fn("SshWorkspaceSync.readOid")(function* (
    stdout: string,
    stage: SshWorkspaceStage,
    target: DesktopSshEnvironmentTarget,
    operationId?: string,
  ) {
    const oid = stdout.trim();
    if (!oidPattern.test(oid))
      return yield* new SshWorkspaceError({
        stage,
        code: "invalid_remote_response",
        host: target.alias,
        ...(operationId === undefined ? {} : { operationId }),
      });
    return oid;
  });

  const launch = Effect.fn("SshWorkspaceSync.launch")(function* (input: SshWorkspaceLaunchInput) {
    const target = input.destination.target;
    yield* validateTarget(target);
    const found = yield* projects
      .getById(input.sourceProjectId)
      .pipe(
        Effect.mapError(
          () => new SshWorkspaceError({ stage: "validate", code: "project_read_failed" }),
        ),
      );
    if (Option.isNone(found))
      return yield* new SshWorkspaceError({ stage: "validate", code: "project_not_found" });
    const project = found.value;
    const status = yield* git
      .execute({
        operation: "SshWorkspaceSync.validateRepository",
        cwd: project.workspaceRoot,
        args: ["rev-parse", "--show-toplevel"],
      })
      .pipe(
        Effect.mapError(
          () => new SshWorkspaceError({ stage: "validate", code: "not_git_repository" }),
        ),
      );
    if (status.stdoutTruncated || status.stdout.trim().length === 0)
      return yield* new SshWorkspaceError({ stage: "validate", code: "not_git_repository" });
    const canonicalProjectRoot = yield* fileSystem
      .realPath(project.workspaceRoot)
      .pipe(
        Effect.mapError(
          () => new SshWorkspaceError({ stage: "validate", code: "project_read_failed" }),
        ),
      );
    const canonicalRepoRoot = yield* fileSystem
      .realPath(status.stdout.trim())
      .pipe(
        Effect.mapError(
          () => new SshWorkspaceError({ stage: "validate", code: "project_read_failed" }),
        ),
      );
    if (canonicalProjectRoot !== canonicalRepoRoot)
      return yield* new SshWorkspaceError({ stage: "validate", code: "project_not_repo_root" });
    const preflight = yield* dispatch
      .preflightTarget({ target, runtimeMode: "full-access", modelSelection: input.modelSelection })
      .pipe(
        Effect.mapError(
          (error) =>
            new SshWorkspaceError({
              stage: "preflight",
              code:
                error.remoteCode === "model_unavailable"
                  ? "model_unavailable"
                  : error.reason === "remote_refused"
                    ? "remote_unsupported"
                    : "host_unavailable",
              host: target.alias,
            }),
        ),
      );
    if (preflight.environmentId !== input.destination.expectedEnvironmentId)
      return yield* new SshWorkspaceError({
        stage: "preflight",
        code: "environment_mismatch",
        host: target.alias,
      });
    const operationId = (yield* crypto.randomUUIDv4.pipe(Effect.orDie))
      .replaceAll("-", "")
      .slice(0, 8);
    const snapshotRef = `refs/goat/snapshots/${operationId}`;
    const pushedRef = `refs/heads/goat/ssh-base/${operationId}`;
    const branch = `goat/ssh/${operationId}`;
    const snapshot = yield* snapshots
      .captureWorkspaceSnapshot({ cwd: project.workspaceRoot, snapshotRef })
      .pipe(
        Effect.mapError(
          (error) =>
            new SshWorkspaceError({
              stage: "snapshot",
              operationId,
              host: target.alias,
              code: error._tag === "GitWorkspaceSnapshotError" ? error.code : "snapshot_failed",
            }),
        ),
      );
    const fileNames = snapshot.addedUntrackedPaths.filter((name) =>
      secretName.test(name.split("/").at(-1) ?? name),
    );
    if (fileNames.length > 0)
      return yield* new SshWorkspaceError({
        stage: "snapshot",
        code: "secret_candidate",
        operationId,
        host: target.alias,
        fileNames,
      });
    const name = yield* repoName(project.workspaceRoot);
    const initialized = yield* script(
      target,
      initScript(name),
      "remote_init",
      "remote_init_failed",
      operationId,
    );
    const remoteRepoPath = yield* readRepoPath(initialized.stdout, target, name, operationId);
    const remote = `${remoteHost(target)}:${remoteRepoPath}`;
    const prior = yield* runGit(
      project.workspaceRoot,
      ["ls-remote", "--refs", remote, pushedRef],
      "push",
      "push_failed",
      target,
      operationId,
    );
    if (prior.stdoutTruncated)
      return yield* new SshWorkspaceError({
        stage: "push",
        code: "invalid_remote_response",
        host: target.alias,
        operationId,
      });
    if (prior.stdout.trim().length > 0 && prior.stdout.split(/\s/u)[0] !== snapshot.commitOid)
      return yield* new SshWorkspaceError({
        stage: "push",
        code: "push_ref_conflict",
        host: target.alias,
        operationId,
      });
    // Create-only publication: an empty lease value makes git refuse the push when the ref already
    // exists on the remote, so a concurrent writer cannot be overwritten between ls-remote and push.
    if (prior.stdout.trim().length === 0)
      yield* runGit(
        project.workspaceRoot,
        [
          "push",
          "--porcelain",
          `--force-with-lease=${pushedRef}:`,
          remote,
          `${snapshotRef}:${pushedRef}`,
        ],
        "push",
        "push_failed",
        target,
        operationId,
      );
    const pushed = yield* runGit(
      project.workspaceRoot,
      ["ls-remote", "--refs", remote, pushedRef],
      "push",
      "push_failed",
      target,
      operationId,
    );
    if (pushed.stdoutTruncated || pushed.stdout.trim() !== `${snapshot.commitOid}\t${pushedRef}`)
      return yield* new SshWorkspaceError({
        stage: "push",
        code: "push_oid_mismatch",
        host: target.alias,
        operationId,
      });
    const remoteThread = yield* dispatch
      .launchThread(
        {
          target,
          cwd: remoteRepoPath,
          projectTitle: project.title,
          scripts: project.scripts,
          workspace: { type: "worktree", baseRef: pushedRef, branch, startFromOrigin: false },
          title: input.title,
          message: input.initialMessage.text,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          callerRuntimeMode: "full-access",
          interactionMode: input.interactionMode,
        },
        Effect.void,
      )
      .pipe(
        Effect.mapError(
          (error) =>
            new SshWorkspaceError({
              stage: "launch",
              operationId,
              host: target.alias,
              code:
                error.launchMayHaveStarted === true
                  ? "launch_uncertain"
                  : error.reason === "remote_refused" || error.reason === "invalid_request"
                    ? "launch_refused"
                    : "launch_uncertain",
            }),
        ),
      );
    return {
      operationId,
      snapshotRef,
      snapshotOid: snapshot.commitOid,
      remoteEnvironmentId: preflight.environmentId,
      remoteProjectId: ProjectId.make(remoteThread.projectId),
      remoteThreadId: ThreadId.make(remoteThread.threadId),
      remoteRepoPath,
      branch,
    } satisfies SshWorkspaceLaunchResult;
  });

  const fetchBack = Effect.fn("SshWorkspaceSync.fetchBack")(function* (
    input: SshWorkspaceFetchBackInput,
  ) {
    const { target, branch } = input;
    yield* validateTarget(target);
    // Query home without creating/adopting a repository; fetch-back is not initialization.
    const homeResult = yield* script(
      target,
      'printf "GOAT_HOME\\n%s\\n" "$HOME"\n',
      "fetch",
      "host_unavailable",
    );
    const homeLines = homeResult.stdout.trimEnd().split(/\r?\n/u);
    const home = homeLines.at(-1);
    if (
      homeLines.at(-2) !== "GOAT_HOME" ||
      home === undefined ||
      !home.startsWith("/") ||
      /[\0\r\n]/u.test(home)
    )
      return yield* new SshWorkspaceError({
        stage: "fetch",
        code: "invalid_remote_response",
        host: target.alias,
      });
    const localProjects = yield* projects.snapshot.pipe(
      Effect.mapError(
        () => new SshWorkspaceError({ stage: "validate", code: "project_read_failed" }),
      ),
    );
    const matches = [];
    for (const project of localProjects.projects) {
      if (
        `${home}/.goat/repos/${yield* repoName(project.workspaceRoot)}` ===
        input.remoteWorkspaceRoot.replace(/\/+$/u, "")
      )
        matches.push(project);
    }
    if (matches.length !== 1)
      return yield* new SshWorkspaceError({
        stage: "validate",
        code: matches.length === 0 ? "source_not_found" : "source_ambiguous",
        host: target.alias,
      });
    const project = matches[0]!;
    const localRef = `refs/remotes/goat-ssh/${target.alias}/${branch}`;
    // Full refs alone accept refs/heads/-x, so reject a leading '-' explicitly; check-ref-format below
    // owns every other rule (space, control, ~^:?*[\, '..', '@{'), so valid Unicode/punctuation names pass.
    if (branch.length === 0 || branch.startsWith("-"))
      return yield* new SshWorkspaceError({
        stage: "validate",
        code: "invalid_branch",
        host: target.alias,
      });
    // Full refs avoid check-ref-format --branch accepting @{-1} expansion.
    yield* runGit(
      project.workspaceRoot,
      ["check-ref-format", `refs/heads/${branch}`],
      "validate",
      "invalid_branch",
      target,
    );
    yield* runGit(
      project.workspaceRoot,
      ["check-ref-format", localRef],
      "validate",
      "invalid_branch",
      target,
    );
    const marker = yield* script(
      target,
      `set -eu\nrepo=${quote(input.remoteWorkspaceRoot.replace(/\/+$/u, ""))}\n` +
        'if [ -L "$repo" ] || [ ! -d "$repo/.git" ] || [ -L "$repo/.git" ] || ' +
        '[ "$(git -C "$repo" config --local --get goat.managed 2>/dev/null || true)" != true ]; then ' +
        'printf "GOAT_FOREIGN_PATH\\n"; else printf "GOAT_MANAGED\\n"; fi\n',
      "fetch",
      "fetch_failed",
    );
    if (marker.stdout.trimEnd().split(/\r?\n/u).at(-1) !== "GOAT_MANAGED")
      return yield* new SshWorkspaceError({
        stage: "fetch",
        code: "foreign_path",
        host: target.alias,
      });
    yield* runGit(
      project.workspaceRoot,
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        `${remoteHost(target)}:${input.remoteWorkspaceRoot.replace(/\/+$/u, "")}`,
        `+refs/heads/${branch}:${localRef}`,
      ],
      "fetch",
      "fetch_failed",
      target,
    );
    const resolved = yield* runGit(
      project.workspaceRoot,
      ["rev-parse", "--verify", `${localRef}^{commit}`],
      "fetch",
      "fetch_failed",
      target,
    );
    if (resolved.stdoutTruncated)
      return yield* new SshWorkspaceError({
        stage: "fetch",
        code: "invalid_remote_response",
        host: target.alias,
      });
    const commitOid = yield* readOid(resolved.stdout, "fetch", target);
    return {
      sourceProjectId: project.id,
      localWorkspaceRoot: project.workspaceRoot,
      localRef,
      commitOid,
      remoteBranch: branch,
    } satisfies SshWorkspaceFetchBackResult;
  });
  return SshWorkspaceSync.of({ launch, fetchBack });
});
export const layer = Layer.effect(SshWorkspaceSync, make);
