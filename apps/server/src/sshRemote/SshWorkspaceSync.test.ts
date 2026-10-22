// @effect-diagnostics nodeBuiltinImport:off -- isolated fake SSH uses local shell and independent Node hashing.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import {
  EventId,
  ThreadId,
  RunId,
  MessageId,
  OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  Project,
  ProjectId,
  EnvironmentId,
  SshWorkspaceLaunchInput,
  VcsProcessExitError,
  GitCommandError,
  SshWorkspaceError,
  type RuntimeMode,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { emptyProjection } from "../orchestration-v2/ProjectionStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Projects from "../project/ProjectService.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";
import * as Dispatch from "./SshRemoteDispatch.ts";
import * as Sync from "./SshWorkspaceSync.ts";
import {
  closeServer,
  listenLoopback,
  makeStallRelay,
} from "../../../../packages/ssh/src/stallRelay.fixture.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const findExecutable = (name: string, extraDirs: ReadonlyArray<string> = []) => {
  if (HostProcess.Platform.defaultValue() === "win32") return undefined;
  for (const dir of [...(process.env.PATH ?? "").split(NodePath.delimiter), ...extraDirs]) {
    if (!dir) continue;
    const candidate = NodePath.join(dir, name);
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
};
const realSsh = findExecutable("ssh");
const realSshd = findExecutable("sshd", [
  "/usr/sbin",
  "/sbin",
  "/opt/homebrew/sbin",
  "/usr/local/sbin",
]);
const realSshKeygen = findExecutable("ssh-keygen");
const realGitExecutable = findExecutable("git");
const sshdTestBinaries =
  realSsh !== undefined &&
  realSshd !== undefined &&
  realSshKeygen !== undefined &&
  realGitExecutable !== undefined
    ? {
        ssh: realSsh,
        sshd: realSshd,
        sshKeygen: realSshKeygen,
        gitDir: NodePath.dirname(realGitExecutable),
      }
    : undefined;
const decodeProject = Schema.decodeUnknownSync(Project);
const decodeInput = Schema.decodeUnknownSync(SshWorkspaceLaunchInput);
const decodeTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const target = { alias: "buildbox", hostname: "host.test", username: "runner", port: 2222 };
const baseLayer = Git.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-sync-config-" })),
  Layer.provideMerge(NodeServices.layer),
);
const shell = (script: string, home: string) =>
  Effect.tryPromise(() => exec("/bin/sh", ["-c", script], { env: { ...process.env, HOME: home } }));
const managedName = (root: string) =>
  `${
    root
      .replace(/\/+$/u, "")
      .split("/")
      .at(-1)!
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "repo"
  }-${NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realGit = yield* Git.GitVcsDriver;
  const processService = yield* VcsProcess.VcsProcess;
  const parent = yield* fs
    .makeTempDirectoryScoped({ prefix: "goat-ssh-sync-" })
    .pipe(Effect.flatMap((dir) => fs.realPath(dir)));
  const cwd = path.join(parent, "local repo");
  const home = path.join(parent, "remote home 'quoted'");
  const bin = path.join(parent, "bin");
  yield* fs.makeDirectory(cwd);
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(bin);
  const sshLog = path.join(parent, "ssh.log");
  yield* fs.writeFileString(
    path.join(bin, "ssh"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> '${sshLog}'\nwhile [ "$#" -gt 0 ]; do\n case "$1" in -o|-p) shift; shift;; -*) shift;; *) shift; break;; esac\ndone\ncase "$1" in git-receive-pack*|git-upload-pack*) exec /bin/sh -c "$1";; *) exit 255;; esac\n`,
  );
  yield* fs.chmod(path.join(bin, "ssh"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      process.env.PATH = oldPath;
    }),
  );
  const git = (args: ReadonlyArray<string>, root = cwd) =>
    realGit.execute({ operation: "test", cwd: root, args });
  yield* git(["init"]);
  yield* git(["config", "core.excludesFile", "/dev/null"]);
  yield* git(["config", "user.name", "Test"]);
  yield* git(["config", "user.email", "test@test.invalid"]);
  const write = (name: string, text: string) =>
    fs
      .makeDirectory(path.dirname(path.join(cwd, name)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(cwd, name), text)));
  yield* write("file.txt", "initial\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "initial"]);
  const project = decodeProject({
    id: "source",
    title: "Source",
    workspaceRoot: cwd,
    defaultModelSelection: null,
    scripts: [
      {
        id: "setup",
        name: "Setup",
        command: "echo setup",
        icon: "play",
        runOnWorktreeCreate: true,
        async: true,
      },
    ],
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    deletedAt: null,
  });
  const input = decodeInput({
    sourceProjectId: project.id,
    destination: { connectionId: "saved", expectedEnvironmentId: "remote", target },
    title: "Work",
    modelSelection: { instanceId: "codex", model: "model" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    initialMessage: { text: "Implement" },
  });
  const now = DateTime.makeUnsafe("2026-10-17T00:00:00.000Z");
  const threadId = ThreadId.make("source-thread");
  const projection = emptyProjection({
    type: "thread.created",
    id: EventId.make("created"),
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: project.id,
      title: "Existing work",
      providerInstanceId: input.modelSelection.instanceId,
      modelSelection: input.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      sideChatOf: null,
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  const conversationItem = (
    type: "user_message" | "assistant_message",
    text: string,
    ordinal: number,
    streaming = false,
  ) =>
    decodeTurnItem({
      type,
      text,
      streaming,
      id: `item-${ordinal}`,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      messageId: `message-${ordinal}`,
      inputIntent: "turn_start",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    });
  const run = (status: OrchestrationV2Run["status"]): OrchestrationV2Run => ({
    id: RunId.make("source-run"),
    threadId,
    ordinal: 1,
    providerInstanceId: input.modelSelection.instanceId,
    modelSelection: input.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("input"),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  });
  const state = {
    projection,
    projections: [] as (typeof projection)[],
    projectionReads: 0,
    threadMissing: false,
    noticeFails: false,
    notices: [] as Parameters<Threads.ThreadManagementService["Service"]["dispatch"]>[0][],
    projects: [project],
    missing: false,
    projectReadFails: false,
    snapshotReadFails: false,
    preflightError: undefined as Dispatch.SshRemoteDispatchError | undefined,
    launchError: undefined as Dispatch.SshRemoteDispatchError | undefined,
    environmentId: EnvironmentId.make("remote"),
    realPathFails: false,
    scripts: [] as string[],
    preflights: [] as Parameters<Dispatch.SshRemoteDispatch["Service"]["preflightTarget"]>[0][],
    launches: [] as Dispatch.SshLaunchInput[],
    gitCalls: [] as Git.ExecuteGitInput[],
    scriptHook: undefined as
      | ((
          text: string,
        ) =>
          | Effect.Effect<{ stdout: string; stderr: string }, Dispatch.SshRemoteDispatchError>
          | undefined)
      | undefined,
    gitHook: undefined as
      | ((
          call: Git.ExecuteGitInput,
        ) =>
          | Effect.Effect<Git.ExecuteGitResult, import("@goat/contracts").GitCommandError>
          | undefined)
      | undefined,
    processHook: undefined as
      | ((
          call: Parameters<VcsProcess.VcsProcess["Service"]["run"]>[0],
        ) => ReturnType<VcsProcess.VcsProcess["Service"]["run"]> | undefined)
      | undefined,
  };
  const readError = () =>
    new Projects.ProjectOperationError({
      operation: "read-project",
      cause: new Error("private output"),
    });
  const dispatch = Layer.mock(Dispatch.SshRemoteDispatch)({
    preflightTarget: (call) =>
      Effect.suspend(() => {
        state.preflights.push(call);
        return state.preflightError
          ? Effect.fail(state.preflightError)
          : Effect.succeed({ environmentId: state.environmentId });
      }),
    runRemoteScript: (call) =>
      Effect.suspend(() => {
        state.scripts.push(call.script);
        return (
          state.scriptHook?.(call.script) ??
          shell(call.script, home).pipe(
            Effect.mapError(
              () =>
                new Dispatch.SshRemoteDispatchError({
                  reason: "ssh_failed",
                  message: "private shell output",
                }),
            ),
          )
        );
      }),
    launchThread: (call, beforeLaunch) =>
      beforeLaunch.pipe(
        Effect.andThen(
          Effect.suspend(() => {
            state.launches.push(call);
            return state.launchError
              ? Effect.fail(state.launchError)
              : Effect.succeed({
                  host: target.alias,
                  cwd: call.cwd,
                  projectId: "rp",
                  projectCreated: true,
                  threadId: "rt",
                  reportsSupported: false,
                  runId: "run",
                  workspaceStrategy: { type: "root" as const },
                  runtimeMode: call.runtimeMode,
                  remoteServerKind: "managed" as const,
                  notes: [],
                });
          }),
        ),
      ),
  });
  const layer = Sync.layer.pipe(
    Layer.provide(dispatch),
    Layer.provide(
      Layer.mock(Threads.ThreadManagementService)({
        getThreadProjection: (threadId) =>
          Effect.suspend(() => {
            const projection = state.projections[state.projectionReads++] ?? state.projection;
            return state.threadMissing
              ? Effect.fail(
                  new Orchestrator.OrchestratorProjectionError({
                    threadId,
                    cause: new Error("missing"),
                  }),
                )
              : Effect.succeed(projection);
          }),
        dispatch: (command) =>
          Effect.suspend(() => {
            state.notices.push(command);
            assert.lengthOf(state.launches, 1);
            return state.noticeFails
              ? Effect.fail(
                  new Orchestrator.OrchestratorProjectionError({
                    threadId,
                    cause: new Error("notice failed"),
                  }),
                )
              : Effect.succeed({ sequence: 1, storedEvents: [] });
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(Projects.ProjectService)({
        getById: () =>
          Effect.suspend(() =>
            state.projectReadFails
              ? Effect.fail(readError())
              : Effect.succeed(
                  state.missing
                    ? Option.none()
                    : state.projects[0] === undefined
                      ? Option.none()
                      : Option.some(state.projects[0]),
                ),
          ),
        snapshot: Effect.suspend(() =>
          state.snapshotReadFails
            ? Effect.fail(readError())
            : Effect.succeed({ projects: state.projects, updatedAt: project.updatedAt }),
        ),
      }),
    ),
    Layer.provide(
      Layer.succeed(Git.GitVcsDriver, {
        ...realGit,
        execute: (call) =>
          Effect.suspend(() => {
            state.gitCalls.push(call);
            return state.gitHook?.(call) ?? realGit.execute(call);
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(VcsProcess.VcsProcess, {
        run: (call) => Effect.suspend(() => state.processHook?.(call) ?? processService.run(call)),
      }),
    ),
    Layer.provide(
      Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        realPath: (name) =>
          state.realPathFails ? fs.realPath(path.join(parent, "missing")) : fs.realPath(name),
      }),
    ),
  );
  const context = yield* Layer.build(layer);
  const sync = Context.get(context, Sync.SshWorkspaceSync);
  const remote = path.join(home, ".goat/repos", managedName(project.workspaceRoot));
  const fetchInput = (branch = "feature/result") => ({
    target,
    remoteWorkspaceRoot: remote,
    branch,
  });
  const initRemote = shell(
    `mkdir -p "${remote}"; git init -q "${remote}"; git -C "${remote}" config goat.managed true`,
    home,
  );
  const unchanged = Effect.gen(function* () {
    return {
      head: (yield* git(["rev-parse", "HEAD"])).stdout,
      index: yield* fs.readFile(path.join(cwd, ".git/index")),
      disk: yield* fs.readFileString(path.join(cwd, "file.txt")),
      fetchHead: yield* fs
        .readFileString(path.join(cwd, ".git/FETCH_HEAD"))
        .pipe(Effect.orElseSucceed(() => null)),
    };
  });
  return {
    fs,
    path,
    parent,
    cwd,
    home,
    bin,
    sshLog,
    git,
    write,
    state,
    input,
    project,
    sync,
    remote,
    fetchInput,
    initRemote,
    unchanged,
    realGit,
    processService,
    conversationItem,
    run,
    handoffInput: { sourceThreadId: threadId, target, expectedEnvironmentId: null },
  };
});
const test = <E>(
  name: string,
  body: (f: Effect.Success<typeof fixture>) => Effect.Effect<void, E, never>,
) =>
  it.effect(name, () =>
    Effect.gen(function* () {
      yield* body(yield* fixture);
    }).pipe(Effect.scoped, Effect.provide(baseLayer)),
  );
const testEach = <T, E>(
  cases: ReadonlyArray<readonly [string, T]>,
  body: (value: T, f: Effect.Success<typeof fixture>) => Effect.Effect<void, E>,
) =>
  it.effect.each(cases)("%s", ([_name, value]) =>
    Effect.gen(function* () {
      yield* body(value, yield* fixture);
    }).pipe(Effect.scoped, Effect.provide(baseLayer)),
  );
const rejected = <A>(
  effect: Effect.Effect<A, SshWorkspaceError>,
  stage: SshWorkspaceError["stage"],
  code: SshWorkspaceError["code"],
) =>
  effect.pipe(
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => assert.deepInclude(error, { stage, code }))),
    Effect.asVoid,
  );

test("pushes snapshot then launches remote owned worktree", (f) =>
  Effect.gen(function* () {
    yield* f.write("file.txt", "staged\n");
    yield* f.git(["add", "."]);
    yield* f.write("file.txt", "disk\n");
    yield* f.write("new.txt", "new\n");
    const before = yield* f.unchanged;
    const result = yield* f.sync.launch(f.input);
    assert.deepEqual(yield* f.unchanged, before);
    assert.strictEqual(result.remoteRepoPath, f.remote);
    assert.strictEqual((yield* f.git(["show", `${result.snapshotRef}:file.txt`])).stdout, "disk\n");
    assert.strictEqual((yield* f.git(["show", `${result.snapshotRef}:new.txt`])).stdout, "new\n");
    assert.strictEqual((yield* f.git(["rev-parse", `${result.snapshotOid}^`])).stdout, before.head);
    assert.strictEqual(
      (yield* f.git(
        ["rev-parse", `refs/heads/goat/ssh-base/${result.operationId}`],
        f.remote,
      )).stdout.trim(),
      result.snapshotOid,
    );
    assert.strictEqual(
      (yield* f.git(["rev-parse", "--verify", "HEAD"], f.remote).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.strictEqual(f.state.launches.length, 1);
    assert.deepEqual(f.state.launches[0]?.target, target);
    assert.deepEqual(f.state.launches[0]?.scripts, f.project.scripts);
    assert.strictEqual(f.state.launches[0]?.callerRuntimeMode, "full-access");
    assert.deepEqual(f.state.launches[0]?.workspace, {
      type: "worktree",
      baseRef: `refs/heads/goat/ssh-base/${result.operationId}`,
      branch: result.branch,
      startFromOrigin: false,
    });
    const log = yield* f.fs.readFileString(f.sshLog);
    assert.include(log, "BatchMode=yes");
    assert.include(log, "ServerAliveInterval=15");
    assert.include(log, "ServerAliveCountMax=3");
    assert.include(log, "runner@buildbox");
    assert.include(log, "2222");
  }));
testEach(
  (["approval-required", "auto-accept-edits", "auto", "full-access"] satisfies RuntimeMode[]).map(
    (mode) =>
      [
        `dispatch uses full-access caller ceiling for every requested runtime mode: ${mode}`,
        mode,
      ] as const,
  ),
  (mode, f) =>
    Effect.gen(function* () {
      yield* f.sync.launch({ ...f.input, runtimeMode: mode });
      assert.strictEqual(f.state.preflights[0]?.runtimeMode, "full-access");
      assert.strictEqual(f.state.launches[0]?.callerRuntimeMode, "full-access");
      assert.strictEqual(f.state.launches[0]?.runtimeMode, mode);
      assert.strictEqual(f.state.launches[0]?.interactionMode, f.input.interactionMode);
    }),
);

test("rejects unsafe alias user hostname and invalid ports before SSH", (f) =>
  Effect.gen(function* () {
    for (const patch of [
      { alias: "-oProxyCommand" },
      { alias: "bad/alias" },
      { username: "bad user" },
      { hostname: "host\nname" },
      { port: 0 },
      { port: 65536 },
      { port: 1.5 },
    ])
      yield* rejected(
        f.sync.launch({
          ...f.input,
          destination: { ...f.input.destination, target: { ...target, ...patch } },
        }),
        "validate",
        "invalid_target",
      );
    assert.lengthOf(f.state.gitCalls, 0);
    assert.lengthOf(f.state.preflights, 0);
    assert.lengthOf(f.state.scripts, 0);
  }));
test("rejects missing source project", (f) =>
  Effect.gen(function* () {
    f.state.missing = true;
    yield* rejected(f.sync.launch(f.input), "validate", "project_not_found");
    assert.lengthOf(f.state.gitCalls, 0);
  }));
test("maps failed project reads without output leakage", (f) =>
  Effect.gen(function* () {
    f.state.projectReadFails = true;
    yield* rejected(f.sync.launch(f.input), "validate", "project_read_failed");
    f.state.snapshotReadFails = true;
    yield* rejected(f.sync.fetchBack(f.fetchInput()), "validate", "project_read_failed");
  }));
test("rejects non Git source", (f) =>
  Effect.gen(function* () {
    f.state.projects = [{ ...f.project, workspaceRoot: f.home }];
    yield* rejected(f.sync.launch(f.input), "validate", "not_git_repository");
    assert.lengthOf(f.state.preflights, 0);
  }));
test("rejects a subdirectory project before snapshot", (f) =>
  Effect.gen(function* () {
    const sub = f.path.join(f.cwd, "apps/server");
    yield* f.fs.makeDirectory(sub, { recursive: true });
    f.state.projects = [{ ...f.project, workspaceRoot: sub }];
    const error = yield* f.sync.launch(f.input).pipe(Effect.flip);
    assert.deepInclude(error, { stage: "validate", code: "project_not_repo_root" });
    assert.include(error.message, "repository root");
    assert.lengthOf(f.state.preflights, 0);
    assert.lengthOf(f.state.scripts, 0);
  }));
test("accepts a repository root through a symlink", (f) =>
  Effect.gen(function* () {
    const link = f.path.join(f.parent, "stored-link");
    yield* f.fs.symlink(f.cwd, link);
    f.state.projects = [{ ...f.project, workspaceRoot: link }];
    const result = yield* f.sync.launch(f.input);
    assert.strictEqual(
      result.remoteRepoPath,
      f.path.join(f.home, ".goat/repos", managedName(link)),
    );
  }));
test("maps canonical root read failure", (f) =>
  Effect.gen(function* () {
    f.state.realPathFails = true;
    yield* rejected(f.sync.launch(f.input), "validate", "project_read_failed");
    assert.lengthOf(f.state.preflights, 0);
  }));
testEach(
  (
    [
      ["maps unavailable SSH preflight", "ssh_failed", undefined, "host_unavailable"],
      [
        "rejects obsolete remote before snapshot",
        "remote_refused",
        undefined,
        "remote_unsupported",
      ],
      [
        "rejects remote provider or model unavailable before snapshot",
        "remote_refused",
        "model_unavailable",
        "model_unavailable",
      ],
    ] as const
  ).map(([name, reason, remoteCode, code]) => [name, [name, reason, remoteCode, code]] as const),
  ([_caseName, reason, remoteCode, code], f) =>
    Effect.gen(function* () {
      f.state.preflightError = new Dispatch.SshRemoteDispatchError({
        reason,
        message: "private",
        ...(remoteCode ? { remoteCode } : {}),
      });
      yield* rejected(f.sync.launch(f.input), "preflight", code);
      assert.lengthOf(f.state.scripts, 0);
    }),
);
test("rejects saved environment identity mismatch", (f) =>
  Effect.gen(function* () {
    f.state.environmentId = EnvironmentId.make("other");
    yield* rejected(f.sync.launch(f.input), "preflight", "environment_mismatch");
    assert.lengthOf(f.state.scripts, 0);
  }));
test("rejects unsupported or changed snapshot", (f) =>
  Effect.gen(function* () {
    yield* f.git(["init", "nested"]);
    yield* rejected(f.sync.launch(f.input), "snapshot", "unsupported_snapshot");
    assert.lengthOf(f.state.scripts, 0);
  }));
test("maps Git snapshot failure", (f) =>
  Effect.gen(function* () {
    f.state.processHook = (call) =>
      call.args.includes("write-tree")
        ? Effect.fail(
            new VcsProcessExitError({
              operation: call.operation,
              command: "git",
              cwd: call.cwd,
              exitCode: 1,
              detail: "private",
            }),
          )
        : undefined;
    yield* rejected(f.sync.launch(f.input), "snapshot", "snapshot_failed");
    assert.lengthOf(f.state.scripts, 0);
    assert.isFalse(
      (yield* f.fs.readDirectory(f.path.join(f.cwd, ".git"))).some((name) =>
        name.startsWith("t3-checkpoint-index"),
      ),
    );
  }));
test("warns on every untracked secret-name pattern", (f) =>
  Effect.gen(function* () {
    const names = [
      ".env",
      ".env.test",
      "x.pem",
      "x.key",
      "id_rsa.pub",
      "id_ed25519",
      "x.p12",
      "nested/.env.prod",
    ];
    for (const name of names) yield* f.write(name, "fixture\n");
    const error = yield* f.sync.launch(f.input).pipe(Effect.flip);
    assert.strictEqual(error.code, "secret_candidate");
    assert.sameMembers([...(error.fileNames ?? [])], names);
    assert.lengthOf(f.state.scripts, 0);
    assert.lengthOf(f.state.launches, 0);
  }));
test("ignored secret paths never enter snapshot", (f) =>
  Effect.gen(function* () {
    yield* f.write(".gitignore", ".env\n*.pem\n");
    yield* f.write(".env", "fixture");
    yield* f.write("x.pem", "fixture");
    const result = yield* f.sync.launch(f.input);
    assert.strictEqual(
      (yield* f.git(["ls-tree", "-r", result.snapshotRef, "--", ".env", "x.pem"])).stdout,
      "",
    );
  }));
testEach(
  [false, true].map(
    (staged) =>
      [
        staged
          ? "newly staged secret files also bypass the early warning"
          : "tracked secret files illustrate documented early-warning bypass",
        staged,
      ] as const,
  ),
  (staged, f) =>
    Effect.gen(function* () {
      yield* f.write(".env", "fixture");
      yield* f.git(["add", ".env"]);
      if (!staged) yield* f.git(["commit", "-m", "tracked fixture"]);
      const before = yield* f.unchanged;
      const result = yield* f.sync.launch(f.input);
      assert.strictEqual((yield* f.git(["show", `${result.snapshotRef}:.env`])).stdout, "fixture");
      assert.deepEqual(yield* f.unchanged, before);
    }),
);
test("initializes receiver once without a root checkout", (f) =>
  Effect.gen(function* () {
    yield* f.sync.launch(f.input);
    yield* f.sync.launch(f.input);
    assert.strictEqual(
      (yield* f.git(["config", "--local", "--get", "goat.managed"], f.remote)).stdout.trim(),
      "true",
    );
    assert.strictEqual(
      (yield* f.git(["rev-parse", "--is-bare-repository"], f.remote)).stdout.trim(),
      "false",
    );
    assert.strictEqual(
      (yield* f.git(["rev-parse", "--verify", "HEAD"], f.remote).pipe(Effect.result))._tag,
      "Failure",
    );
  }));
test("accepts its own receiver on a Git Bash host, where git prints C:/ paths", (f) =>
  Effect.gen(function* () {
    // Stand-ins for Git for Windows: `uname -s` says MINGW, `--show-toplevel` answers in drive
    // form (W: + the real path), and cygpath turns it back into the shell form `$HOME` uses.
    const fake = (name: string, body: string) =>
      f.fs
        .writeFileString(f.path.join(f.bin, name), `#!/bin/sh\n${body}\n`)
        .pipe(Effect.andThen(f.fs.chmod(f.path.join(f.bin, name), 0o755)));
    yield* fake("uname", '[ "$1" = -s ] && echo MINGW64_NT-10.0-26100 || exec /usr/bin/uname "$@"');
    yield* fake("cygpath", '[ "$1" = -u ] || exit 2\nprintf "%s\\n" "${2#W:}"');
    yield* fake(
      "git",
      [
        'real="$(PATH="${PATH#*:}" command -v git)"',
        'case "$*" in *.goat/repos/*--show-toplevel*) out="$("$real" "$@")" || exit $?; printf "W:%s\\n" "$out" ;;',
        '*) exec "$real" "$@" ;; esac',
      ].join("\n"),
    );
    yield* f.sync.launch(f.input);
    yield* f.sync.launch(f.input);
    assert.lengthOf(f.state.launches, 2);
  }));
testEach(
  (["file", "directory", "repo", "symlink"] as const).map(
    (kind) => [`refuses foreign file directory repo or symlink: ${kind}`, kind] as const,
  ),
  (kind, f) =>
    Effect.gen(function* () {
      yield* f.fs.makeDirectory(f.path.dirname(f.remote), { recursive: true });
      if (kind === "file") yield* f.fs.writeFileString(f.remote, "foreign");
      else if (kind === "symlink") yield* f.fs.symlink(f.cwd, f.remote);
      else {
        yield* f.fs.makeDirectory(f.remote);
        yield* f.fs.writeFileString(f.path.join(f.remote, "sentinel"), "foreign");
        if (kind === "repo") yield* f.git(["init"], f.remote);
      }
      yield* rejected(f.sync.launch(f.input), "remote_init", "foreign_path");
      if (kind === "file") assert.strictEqual(yield* f.fs.readFileString(f.remote), "foreign");
      else if (kind !== "symlink")
        assert.strictEqual(
          yield* f.fs.readFileString(f.path.join(f.remote, "sentinel")),
          "foreign",
        );
      else assert.strictEqual(yield* f.fs.readLink(f.remote), f.cwd);
      assert.lengthOf(f.state.launches, 0);
    }),
);
test("maps remote init shell failure", (f) =>
  Effect.gen(function* () {
    f.state.scriptHook = () =>
      Effect.fail(
        new Dispatch.SshRemoteDispatchError({ reason: "ssh_failed", message: "private" }),
      );
    yield* rejected(f.sync.launch(f.input), "remote_init", "remote_init_failed");
    assert.lengthOf(f.state.launches, 0);
  }));
test("rejects malformed init and Git responses", (f) =>
  Effect.gen(function* () {
    f.state.scriptHook = () => Effect.succeed({ stdout: "malformed", stderr: "" });
    yield* rejected(f.sync.launch(f.input), "remote_init", "invalid_remote_response");
    f.state.scriptHook = undefined;
    f.state.gitHook = (call) =>
      call.args[0] === "ls-remote"
        ? f.realGit.execute(call).pipe(Effect.map((r) => ({ ...r, stdoutTruncated: true })))
        : undefined;
    yield* rejected(f.sync.launch(f.input), "push", "invalid_remote_response");
    assert.lengthOf(f.state.launches, 0);
  }));
testEach(
  [false, true].map(
    (identical) =>
      [
        identical
          ? "existing identical remote ref is transfer success"
          : "different remote snapshot ref refuses push",
        identical,
      ] as const,
  ),
  (identical, f) =>
    Effect.gen(function* () {
      f.state.gitHook = (call) =>
        call.args[0] === "ls-remote"
          ? Effect.gen(function* () {
              const ref = call.args.at(-1)!;
              const op = ref.split("/").at(-1)!;
              const oid = (yield* f.git([
                "rev-parse",
                identical ? `refs/goat/snapshots/${op}` : "HEAD",
              ])).stdout.trim();
              yield* f.git(["fetch", f.cwd, `${oid}:${ref}`], f.remote);
              return yield* f.realGit.execute(call);
            })
          : undefined;
      if (identical) yield* f.sync.launch(f.input);
      else yield* rejected(f.sync.launch(f.input), "push", "push_ref_conflict");
      assert.isFalse(f.state.gitCalls.some((call) => call.args[0] === "push"));
      assert.lengthOf(f.state.launches, identical ? 1 : 0);
    }),
);
test("ref created between ls-remote and push prevents launch", (f) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<string>();
    const gate = yield* Deferred.make<void>();
    let first = true;
    f.state.gitHook = (call) =>
      call.args[0] === "ls-remote" && first
        ? Effect.gen(function* () {
            first = false;
            const result = yield* f.realGit.execute(call);
            yield* Deferred.succeed(entered, call.args.at(-1)!);
            yield* Deferred.await(gate);
            return result;
          })
        : undefined;
    const fiber = yield* f.sync.launch(f.input).pipe(Effect.result, Effect.forkChild);
    const ref = yield* Deferred.await(entered);
    const head = (yield* f.git(["rev-parse", "HEAD"])).stdout.trim();
    yield* f.git(["fetch", f.cwd, `${head}:${ref}`], f.remote);
    yield* Deferred.succeed(gate, undefined);
    const result = yield* Fiber.join(fiber);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") assert.strictEqual(result.failure.code, "push_failed");
    assert.strictEqual((yield* f.git(["rev-parse", ref], f.remote)).stdout.trim(), head);
    assert.lengthOf(f.state.launches, 0);
  }));
test("maps SSH push failure", (f) =>
  Effect.gen(function* () {
    yield* f.fs.writeFileString(f.path.join(f.bin, "ssh"), "#!/bin/sh\nexit 255\n");
    yield* rejected(f.sync.launch(f.input), "push", "push_failed");
    assert.lengthOf(f.state.launches, 0);
  }));
test("refuses wrong pushed OID", (f) =>
  Effect.gen(function* () {
    let reads = 0;
    f.state.gitHook = (call) =>
      call.args[0] === "ls-remote" && ++reads === 2
        ? f.realGit
            .execute(call)
            .pipe(Effect.map((r) => ({ ...r, stdout: `wrong\t${call.args.at(-1)}\n` })))
        : undefined;
    yield* rejected(f.sync.launch(f.input), "push", "push_oid_mismatch");
    assert.lengthOf(f.state.launches, 0);
  }));
testEach(
  [false, true].map(
    (uncertain) =>
      [
        uncertain
          ? "lost launch acknowledgement is never relaunched"
          : "definite launch refusal retains source snapshot",
        uncertain,
      ] as const,
  ),
  (uncertain, f) =>
    Effect.gen(function* () {
      f.state.launchError = new Dispatch.SshRemoteDispatchError({
        reason: "remote_refused",
        message: "fixture",
        ...(uncertain ? { launchMayHaveStarted: true } : {}),
      });
      const before = yield* f.unchanged;
      const error = yield* f.sync.launch(f.input).pipe(Effect.flip);
      assert.strictEqual(error.code, uncertain ? "launch_uncertain" : "launch_refused");
      assert.strictEqual(error.host, target.alias);
      assert.strictEqual(
        (yield* f.git(["rev-parse", `refs/goat/snapshots/${error.operationId}`])).stdout.trim()
          .length,
        40,
      );
      assert.deepEqual(yield* f.unchanged, before);
      assert.lengthOf(f.state.launches, 1);
    }),
);

const seedFetch = (f: Effect.Success<typeof fixture>, branch = "feature/result") =>
  Effect.gen(function* () {
    yield* f.initRemote;
    const head = (yield* f.git(["rev-parse", "HEAD"])).stdout.trim();
    yield* f.git(["fetch", f.cwd, `${head}:refs/heads/${branch}`], f.remote);
    return head;
  });
test("fetch finds local source by M3 derived root", (f) =>
  Effect.gen(function* () {
    const head = yield* seedFetch(f);
    f.state.projects.unshift({
      ...f.project,
      id: ProjectId.make("other"),
      workspaceRoot: `/other/${f.path.basename(f.cwd)}`,
    });
    const result = yield* f.sync.fetchBack(f.fetchInput());
    assert.strictEqual(result.sourceProjectId, f.project.id);
    assert.strictEqual(result.commitOid, head);
  }));
test("fetch refuses missing or ambiguous source match", (f) =>
  Effect.gen(function* () {
    yield* rejected(
      f.sync.fetchBack({ ...f.fetchInput(), remoteWorkspaceRoot: "/other" }),
      "validate",
      "source_not_found",
    );
    f.state.projects.push(f.project);
    yield* rejected(f.sync.fetchBack(f.fetchInput()), "validate", "source_ambiguous");
    assert.isFalse(f.state.gitCalls.some((call) => call.args[0] === "fetch"));
  }));
test("fetch refuses invalid branch refspecs", (f) =>
  Effect.gen(function* () {
    for (const branch of ["", "-x", "--all", "a:b", "a*", "a..b", "a//b", "@{-1}", "a\nb"])
      yield* rejected(f.sync.fetchBack(f.fetchInput(branch)), "validate", "invalid_branch");
    for (const branch of ["feature/한글", "feature/foo+bar"]) {
      yield* seedFetch(f, branch);
      const result = yield* f.sync.fetchBack(f.fetchInput(branch));
      assert.strictEqual(result.remoteBranch, branch);
    }
  }));
test("fetch refuses foreign receiver marker", (f) =>
  rejected(f.sync.fetchBack(f.fetchInput()), "fetch", "foreign_path"));
test("fetch maps home lookup or remote read failure", (f) =>
  Effect.gen(function* () {
    f.state.scriptHook = () =>
      Effect.fail(
        new Dispatch.SshRemoteDispatchError({ reason: "ssh_failed", message: "private" }),
      );
    yield* rejected(f.sync.fetchBack(f.fetchInput()), "fetch", "host_unavailable");
    f.state.scriptHook = () => Effect.succeed({ stdout: "malformed", stderr: "" });
    yield* rejected(f.sync.fetchBack(f.fetchInput()), "fetch", "invalid_remote_response");
    f.state.scriptHook = undefined;
    yield* f.initRemote;
    yield* rejected(f.sync.fetchBack(f.fetchInput()), "fetch", "fetch_failed");
  }));
test("fetch preserves HEAD index worktree FETCH_HEAD and writes dedicated ref", (f) =>
  Effect.gen(function* () {
    const head = yield* seedFetch(f);
    yield* f.write("file.txt", "staged");
    yield* f.git(["add", "."]);
    yield* f.write("file.txt", "disk");
    yield* f.fs.writeFileString(f.path.join(f.cwd, ".git/FETCH_HEAD"), "existing\n");
    const before = yield* f.unchanged;
    const result = yield* f.sync.fetchBack(f.fetchInput());
    assert.deepEqual(yield* f.unchanged, before);
    assert.strictEqual(result.localRef, `refs/remotes/goat-ssh/${target.alias}/feature/result`);
    assert.strictEqual(result.commitOid, head);
  }));
test("fetch refreshes rewritten remote branch in tracking namespace", (f) =>
  Effect.gen(function* () {
    const first = yield* seedFetch(f);
    const result = yield* f.sync.fetchBack(f.fetchInput());
    const tree = (yield* f.git(["rev-parse", "HEAD^{tree}"])).stdout.trim();
    const second = (yield* f.git(["commit-tree", tree, "-m", "rewrite"])).stdout.trim();
    yield* f.git(["fetch", f.cwd, `+${second}:refs/heads/feature/result`], f.remote);
    const before = yield* f.unchanged;
    const refreshed = yield* f.sync.fetchBack(f.fetchInput());
    assert.notStrictEqual(first, second);
    assert.strictEqual(refreshed.localRef, result.localRef);
    assert.strictEqual(refreshed.commitOid, second);
    assert.deepEqual(yield* f.unchanged, before);
  }));
test("fetch rejects malformed commit OID", (f) =>
  Effect.gen(function* () {
    yield* seedFetch(f);
    f.state.gitHook = (call) =>
      call.args[0] === "rev-parse"
        ? f.realGit.execute(call).pipe(Effect.map((r) => ({ ...r, stdout: "invalid" })))
        : undefined;
    yield* rejected(f.sync.fetchBack(f.fetchInput()), "fetch", "invalid_remote_response");
  }));
it.effect.skipIf(sshdTestBinaries === undefined)(
  "fetch aborts via SSH keepalive when the TCP link stalls mid-transfer",
  () =>
    Effect.gen(function* () {
      if (sshdTestBinaries === undefined) return;
      const f = yield* fixture;
      const hostKey = f.path.join(f.parent, "sshd_host_ed25519");
      const userKey = f.path.join(f.parent, "ssh_user_ed25519");
      const authorizedKeys = f.path.join(f.parent, "authorized_keys");
      yield* Effect.tryPromise(() =>
        exec(sshdTestBinaries.sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]),
      );
      yield* Effect.tryPromise(() =>
        exec(sshdTestBinaries.sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", userKey]),
      );
      yield* f.fs.copyFile(`${userKey}.pub`, authorizedKeys);
      yield* f.fs.chmod(authorizedKeys, 0o600);

      // upload-pack spawns packObjectsHook only after advertising refs downstream and reading the
      // client's want/done negotiation upstream, giving a deterministic mid-fetch stall point.
      const packHookSockets = yield* Queue.unbounded<NodeNet.Socket>();
      const gateSockets = new Set<NodeNet.Socket>();
      const gateServer = NodeNet.createServer((socket) => {
        gateSockets.add(socket);
        socket.on("close", () => gateSockets.delete(socket));
        socket.on("error", () => socket.destroy());
        Queue.offerUnsafe(packHookSockets, socket);
      });
      const gatePort = yield* Effect.acquireRelease(listenLoopback(gateServer), () =>
        Effect.suspend(() => {
          for (const socket of gateSockets) socket.destroy();
          return gateServer.listening ? closeServer(gateServer) : Effect.void;
        }),
      );

      const packHookJs = f.path.join(f.parent, "pack-hook.cjs");
      const packHookSh = f.path.join(f.parent, "pack-hook.sh");
      const gitConfigGlobal = f.path.join(f.parent, "sshd.gitconfig");
      yield* f.fs.writeFileString(
        packHookJs,
        [
          'const net = require("node:net");',
          "process.stdin.resume();",
          `const socket = net.connect(${gatePort}, "127.0.0.1");`,
          'socket.once("data", () => {',
          '  process.stdout.write("PACK" + "\\0".repeat(8192));',
          "});",
          'socket.on("error", () => process.exit(0));',
          'socket.on("close", () => process.exit(0));',
        ].join("\n"),
      );
      yield* f.fs.writeFileString(
        packHookSh,
        `#!/bin/sh\nexec '${process.execPath}' '${packHookJs}'\n`,
      );
      yield* f.fs.chmod(packHookSh, 0o755);
      yield* f.fs.writeFileString(
        gitConfigGlobal,
        `[uploadpack]\n\tkeepAlive = 0\n\tpackObjectsHook = ${packHookSh}\n`,
      );

      const sshdShell = f.path.join(f.parent, "sshd-shell.sh");
      yield* f.fs.writeFileString(
        sshdShell,
        [
          "#!/bin/sh",
          `export PATH='${sshdTestBinaries.gitDir}':"$PATH"`,
          `export GIT_CONFIG_GLOBAL='${gitConfigGlobal}'`,
          'exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"',
          "",
        ].join("\n"),
      );
      yield* f.fs.chmod(sshdShell, 0o755);

      const sshUser = NodeOS.userInfo().username;
      const sshdConfig = f.path.join(f.parent, "sshd_config");

      const { port: sshdPort } = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          for (let attempt = 1; ; attempt++) {
            const probeServer = NodeNet.createServer();
            const port = yield* listenLoopback(probeServer);
            yield* closeServer(probeServer);
            yield* f.fs.writeFileString(
              sshdConfig,
              [
                `ListenAddress 127.0.0.1:${port}`,
                `HostKey ${hostKey}`,
                `AuthorizedKeysFile ${authorizedKeys}`,
                "UsePAM no",
                "StrictModes no",
                "PasswordAuthentication no",
                "KbdInteractiveAuthentication no",
                "PubkeyAuthentication yes",
                `PidFile ${f.path.join(f.parent, "sshd.pid")}`,
                `AllowUsers ${sshUser}`,
                `ForceCommand ${sshdShell}`,
                "LogLevel INFO",
                "",
              ].join("\n"),
            );
            const started = yield* Effect.callback<Option.Option<NodeChildProcess.ChildProcess>>(
              (resume) => {
                const proc = NodeChildProcess.spawn(
                  sshdTestBinaries.sshd,
                  ["-D", "-e", "-f", sshdConfig],
                  { stdio: ["ignore", "ignore", "pipe"] },
                );
                let stderr = "";
                const cleanup = () => {
                  proc.stderr.removeListener("data", onData);
                  proc.removeListener("error", onError);
                  proc.removeListener("close", onClose);
                };
                const onData = (chunk: Buffer) => {
                  stderr += chunk.toString("utf8");
                  if (stderr.includes("Server listening on")) {
                    cleanup();
                    resume(Effect.succeedSome(proc));
                  }
                };
                const onError = (error: Error) => {
                  cleanup();
                  resume(Effect.die(error));
                };
                const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
                  cleanup();
                  if (
                    attempt < 5 &&
                    /Bind to port .* failed|Address already in use|Cannot bind any address/iu.test(
                      stderr,
                    )
                  ) {
                    resume(Effect.succeedNone);
                    return;
                  }
                  resume(
                    Effect.die(
                      new Error(
                        `sshd exited before listening (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
                      ),
                    ),
                  );
                };
                proc.stderr.on("data", onData);
                proc.once("error", onError);
                proc.once("close", onClose);
                return Effect.sync(() => {
                  cleanup();
                  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
                });
              },
            );
            if (Option.isSome(started)) return { child: started.value, port };
          }
        }),
        ({ child }) =>
          Effect.callback<void>((resume) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resume(Effect.void);
              return;
            }
            child.once("exit", () => resume(Effect.void));
            child.kill("SIGTERM");
          }),
      );

      const relay = yield* makeStallRelay(sshdPort);
      // Scale the 15 s x 3 keepalive window down only when GIT_SSH_COMMAND actually supplies those
      // product flags, so removing SSH_KEEPALIVE_ARGS from SshWorkspaceSync leaves keepalive off.
      yield* f.fs.writeFileString(
        f.path.join(f.bin, "ssh"),
        [
          "#!/bin/sh",
          `printf '%s\\n' "$@" >> '${f.sshLog}'`,
          "for arg do",
          "  shift",
          '  case "$arg" in',
          '    ServerAliveInterval=15) set -- "$@" ServerAliveInterval=1 ;;',
          '    ServerAliveCountMax=3) set -- "$@" ServerAliveCountMax=2 ;;',
          '    *) set -- "$@" "$arg" ;;',
          "  esac",
          "done",
          `exec '${sshdTestBinaries.ssh}' -F /dev/null -i '${userKey}' -o User='${sshUser}' -o HostName=127.0.0.1 -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$@"`,
          "",
        ].join("\n"),
      );
      yield* f.fs.chmod(f.path.join(f.bin, "ssh"), 0o755);

      yield* f.initRemote;
      yield* f.fs.writeFileString(f.path.join(f.remote, "remote-only.txt"), "remote change\n");
      yield* f.git(["config", "user.name", "Remote"], f.remote);
      yield* f.git(["config", "user.email", "remote@test.invalid"], f.remote);
      yield* f.git(["add", "remote-only.txt"], f.remote);
      yield* f.git(["commit", "-m", "remote commit"], f.remote);
      yield* f.git(["branch", "-M", "feature/result"], f.remote);

      const fetchStderr: string[] = [];
      const fetchErrors: GitCommandError[] = [];
      f.state.gitHook = (call) =>
        call.args[0] === "fetch"
          ? f.realGit
              .execute({
                ...call,
                progress: {
                  onStderrLine: (line) =>
                    Effect.sync(() => {
                      fetchStderr.push(line);
                    }),
                },
              })
              .pipe(
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    fetchErrors.push(error);
                  }),
                ),
              )
          : undefined;

      const before = yield* f.unchanged;
      // oxlint-disable-next-line goat/no-wall-clock-in-tests -- Real Git over an SSH socket relay must enforce the keepalive deadline; a virtual clock cannot drive OpenSSH.
      const startedAtNs = process.hrtime.bigint();
      const fetchFiber = yield* f.sync
        .fetchBack({
          ...f.fetchInput(),
          target: { ...target, port: relay.port },
        })
        .pipe(Effect.flip, Effect.forkChild);

      const hookSocket = yield* Queue.take(packHookSockets);
      const preStallTraffic = Array.from(yield* Queue.takeAll(relay.traffic));
      assert.isTrue(
        preStallTraffic.some(
          (item) => item.direction === "downstream" && item.forwarded && item.bytes > 0,
        ),
      );
      assert.isTrue(
        preStallTraffic.some(
          (item) => item.direction === "upstream" && item.forwarded && item.bytes > 0,
        ),
      );

      relay.setMode("stall");
      assert.strictEqual(relay.openSockets, 2);
      hookSocket.write("stall\n");

      // Whether upload-pack forwards the hook's bytes before the client gives up depends on the
      // Git build (Ubuntu 24.04's 2.43 holds them), so only the client's dropped keepalive is
      // awaited; waiting for a downstream drop there outlives the fetch it should observe.
      let sawDroppedUpstream = false;
      while (!sawDroppedUpstream) {
        const packet = yield* Queue.take(relay.traffic);
        assert.isFalse(packet.forwarded);
        if (packet.direction === "upstream") sawDroppedUpstream = true;
      }
      assert.strictEqual(relay.openSockets, 2);

      const error = yield* Fiber.join(fetchFiber);
      // oxlint-disable-next-line goat/no-wall-clock-in-tests -- Measure the real OpenSSH keepalive failure deadline while preserving the 30-second regression assertion.
      const elapsedMs = Number(process.hrtime.bigint() - startedAtNs) / 1_000_000;
      assert.deepInclude(error, {
        stage: "fetch",
        code: "fetch_failed",
        host: target.alias,
      });
      assert.isBelow(elapsedMs, 30_000);
      assert.lengthOf(fetchErrors, 1);
      assert.notStrictEqual(fetchErrors[0]?.exitCode, 0);
      const stderrText = fetchStderr.join("\n");
      assert.match(stderrText, /Timeout, server .* not responding\./i);
      const postStallTraffic = Array.from(yield* Queue.takeAll(relay.traffic));
      const droppedKeepalives =
        1 +
        postStallTraffic.filter((item) => item.direction === "upstream" && !item.forwarded).length;
      assert.isAtLeast(droppedKeepalives, 2);
      const sshLog = yield* f.fs.readFileString(f.sshLog);
      assert.include(sshLog, "BatchMode=yes");
      assert.include(sshLog, "ServerAliveInterval=15");
      assert.include(sshLog, "ServerAliveCountMax=3");
      assert.include(sshLog, String(relay.port));
      assert.deepEqual(yield* f.unchanged, before);
    }).pipe(Effect.scoped, Effect.provide(baseLayer)),
);

test("rejects HEAD changed snapshot before remote initialization", (f) =>
  Effect.gen(function* () {
    f.state.processHook = (call) =>
      call.args.includes("write-tree")
        ? f.processService
            .run(call)
            .pipe(
              Effect.tap(() =>
                f.git(["commit", "--allow-empty", "-m", "concurrent HEAD"]).pipe(Effect.orDie),
              ),
            )
        : undefined;
    yield* rejected(f.sync.launch(f.input), "snapshot", "head_changed");
    assert.lengthOf(f.state.scripts, 0);
    assert.lengthOf(f.state.launches, 0);
  }));
test("unborn receiver creates a worktree from the pushed ref without a root checkout", (f) =>
  Effect.gen(function* () {
    const result = yield* f.sync.launch(f.input);
    const worktree = f.path.join(f.parent, "remote worktree");
    yield* f.git(
      [
        "worktree",
        "add",
        "-b",
        result.branch,
        worktree,
        `refs/heads/goat/ssh-base/${result.operationId}`,
      ],
      f.remote,
    );
    assert.strictEqual(
      (yield* f.git(["rev-parse", "HEAD"], worktree)).stdout.trim(),
      result.snapshotOid,
    );
    assert.strictEqual(
      (yield* f.git(["rev-parse", "--verify", "HEAD"], f.remote).pipe(Effect.result))._tag,
      "Failure",
    );
  }));

test("handoff snapshots the thread worktree and carries history before the continuation", (f) =>
  Effect.gen(function* () {
    const worktree = f.path.join(f.parent, "source worktree");
    yield* f.git(["worktree", "add", "-b", "source-feature", worktree]);
    f.state.projection = {
      ...f.state.projection,
      thread: { ...f.state.projection.thread, worktreePath: worktree },
      turnItems: [
        f.conversationItem("user_message", "Keep the existing behavior.", 1),
        f.conversationItem(
          "assistant_message",
          "The implementation is ready for the next step.",
          2,
        ),
        f.conversationItem("assistant_message", "unfinished streaming text", 3, true),
      ],
    };
    f.state.projection = {
      ...f.state.projection,
      visibleTurnItems: f.state.projection.turnItems.map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
        item,
      })),
    };
    yield* f.fs.writeFileString(f.path.join(worktree, "file.txt"), "staged worktree content");
    yield* f.git(["add", "file.txt"], worktree);
    yield* f.fs.writeFileString(f.path.join(worktree, "file.txt"), "unstaged worktree content");
    yield* f.fs.writeFileString(
      f.path.join(worktree, "untracked.txt"),
      "untracked worktree content",
    );
    const indexPath = (yield* f.git(
      ["rev-parse", "--path-format=absolute", "--git-path", "index"],
      worktree,
    )).stdout.trim();
    const beforeIndex = yield* f.fs.readFile(indexPath);
    const beforeRoot = yield* f.unchanged;
    const beforeHead = (yield* f.git(["rev-parse", "HEAD"], worktree)).stdout;
    const result = yield* f.sync.handoffThread({
      ...f.handoffInput,
      message: "Implement the next step.",
    });
    assert.strictEqual(result.remoteRepoPath, f.remote);
    assert.strictEqual(
      (yield* f.git(["show", `${result.snapshotRef}:file.txt`])).stdout,
      "unstaged worktree content",
    );
    assert.strictEqual(
      (yield* f.git(["show", `${result.snapshotRef}:untracked.txt`])).stdout,
      "untracked worktree content",
    );
    assert.deepEqual(yield* f.fs.readFile(indexPath), beforeIndex);
    assert.deepEqual(yield* f.unchanged, beforeRoot);
    assert.strictEqual((yield* f.git(["rev-parse", "HEAD"], worktree)).stdout, beforeHead);
    assert.strictEqual(
      yield* f.fs.readFileString(f.path.join(worktree, "file.txt")),
      "unstaged worktree content",
    );
    assert.strictEqual(
      yield* f.fs.readFileString(f.path.join(worktree, "untracked.txt")),
      "untracked worktree content",
    );
    const launch = f.state.launches[0]!;
    assert.include(launch.message, `GOAT thread ${f.handoffInput.sourceThreadId}`);
    assert.include(launch.message, "Uncommitted changes were copied");
    assert.include(launch.message, "User:\nKeep the existing behavior.");
    assert.include(launch.message, "Assistant:\nThe implementation is ready for the next step.");
    assert.notInclude(launch.message, "unfinished streaming text");
    assert.isTrue(launch.message!.endsWith("\n\nImplement the next step."));
    assert.strictEqual(launch.title, f.state.projection.thread.title);
    assert.deepEqual(launch.modelSelection, f.state.projection.thread.modelSelection);
    assert.strictEqual(launch.runtimeMode, "full-access");
    assert.strictEqual(launch.interactionMode, "plan");
    assert.lengthOf(f.state.notices, 1);
    assert.deepInclude(f.state.notices[0], {
      type: "thread.notice.record",
      threadId: f.handoffInput.sourceThreadId,
      recordKey: `ssh-handoff:${result.operationId}`,
      message: `Continued on buildbox in remote thread rt (branch ${result.branch}).`,
    });
  }));

test("handoff carries visible conversation and excludes a rolled-back user message", (f) =>
  Effect.gen(function* () {
    const rolledBackRun = f.run("rolled_back");
    const hidden = {
      ...f.conversationItem("user_message", "Discarded instruction from rolled-back run", 1),
      runId: rolledBackRun.id,
    };
    const visible = f.conversationItem("user_message", "Keep this visible instruction", 2);
    f.state.projection = {
      ...f.state.projection,
      runs: [rolledBackRun],
      turnItems: [hidden, visible],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: visible.threadId,
          sourceItemId: visible.id,
          item: visible,
        },
      ],
    };
    yield* f.sync.handoffThread(f.handoffInput);
    assert.lengthOf(f.state.launches, 1);
    const message = f.state.launches[0]!.message;
    assert.include(message, "User:\nKeep this visible instruction");
    assert.notInclude(message, "Discarded instruction from rolled-back run");
  }));

test("RPC handoff uses the supplied modes title and continuation", (f) =>
  Effect.gen(function* () {
    yield* f.sync.launch({ ...f.input, sourceThreadId: f.handoffInput.sourceThreadId });
    const launch = f.state.launches[0]!;
    assert.strictEqual(launch.title, f.input.title);
    assert.strictEqual(launch.runtimeMode, f.input.runtimeMode);
    assert.strictEqual(launch.interactionMode, f.input.interactionMode);
    assert.isTrue(launch.message!.endsWith(`\n\n${f.input.initialMessage.text}`));
    assert.lengthOf(f.state.notices, 1);
  }));

test("handoff default continuation and oversized instructions respect the message limit", (f) =>
  Effect.gen(function* () {
    yield* f.sync.handoffThread({ ...f.handoffInput, message: "  " });
    assert.isTrue(
      f.state.launches[0]!.message!.endsWith("\n\nContinue where the previous host left off."),
    );
    f.state.launches.length = 0;
    f.state.notices.length = 0;
    yield* f.sync.handoffThread({ ...f.handoffInput, message: "x".repeat(130_000) });
    assert.strictEqual(f.state.launches[0]!.message!.length, 120_000);
  }));

test("handoff push failure preserves source and never launches or records a notice", (f) =>
  Effect.gen(function* () {
    yield* f.write("file.txt", "staged");
    yield* f.git(["add", "file.txt"]);
    yield* f.write("file.txt", "unstaged");
    yield* f.write("untracked.txt", "untracked");
    const before = yield* f.unchanged;
    f.state.gitHook = (call) =>
      call.args[0] === "push"
        ? Effect.fail(
            new GitCommandError({
              operation: call.operation,
              command: "git",
              cwd: call.cwd,
              detail: "fixture",
            }),
          )
        : undefined;
    yield* rejected(f.sync.handoffThread(f.handoffInput), "push", "push_failed");
    assert.deepEqual(yield* f.unchanged, before);
    assert.strictEqual(
      yield* f.fs.readFileString(f.path.join(f.cwd, "untracked.txt")),
      "untracked",
    );
    assert.lengthOf(f.state.launches, 0);
    assert.lengthOf(f.state.notices, 0);
  }));

testEach(
  (["preparing", "queued", "starting", "running", "waiting"] as const).map(
    (status) => [`handoff rejects ${status} work`, status] as const,
  ),
  (status, f) =>
    Effect.gen(function* () {
      f.state.projection = { ...f.state.projection, runs: [f.run(status)] };
      yield* rejected(f.sync.handoffThread(f.handoffInput), "validate", "thread_busy");
      assert.lengthOf(f.state.preflights, 0);
      assert.lengthOf(f.state.scripts, 0);
      assert.lengthOf(f.state.launches, 0);
      assert.lengthOf(f.state.notices, 0);
    }),
);

test("handoff allows the caller's sole active run and still snapshots uncommitted files", (f) =>
  Effect.gen(function* () {
    const run = f.run("running");
    f.state.projection = { ...f.state.projection, runs: [run] };
    yield* f.write("file.txt", "current turn changes");
    const result = yield* f.sync.handoffThread({ ...f.handoffInput, allowRunId: run.id });
    assert.strictEqual(
      (yield* f.git(["show", `${result.snapshotRef}:file.txt`])).stdout,
      "current turn changes",
    );
    assert.lengthOf(f.state.launches, 1);
    assert.lengthOf(f.state.notices, 1);
  }));

testEach(
  (["queued", "running"] as const).map(
    (status) =>
      [`handoff rejects another ${status} run even with the caller's run allowed`, status] as const,
  ),
  (status, f) =>
    Effect.gen(function* () {
      const ownRun = f.run("running");
      f.state.projection = {
        ...f.state.projection,
        runs: [ownRun, { ...f.run(status), id: RunId.make("another-run"), ordinal: 2 }],
      };
      yield* rejected(
        f.sync.handoffThread({ ...f.handoffInput, allowRunId: ownRun.id }),
        "validate",
        "thread_busy",
      );
      assert.lengthOf(f.state.preflights, 0);
      assert.lengthOf(f.state.scripts, 0);
      assert.lengthOf(f.state.launches, 0);
    }),
);

test("handoff does not exempt a mismatched or queued run", (f) =>
  Effect.gen(function* () {
    for (const status of ["running", "queued"] as const) {
      const run = f.run(status);
      f.state.projection = { ...f.state.projection, runs: [run] };
      yield* rejected(
        f.sync.handoffThread({
          ...f.handoffInput,
          allowRunId: status === "queued" ? run.id : RunId.make("different-run"),
        }),
        "validate",
        "thread_busy",
      );
    }
    assert.lengthOf(f.state.preflights, 0);
    assert.lengthOf(f.state.launches, 0);
  }));

test("RPC handoff rejects a source project mismatch", (f) =>
  Effect.gen(function* () {
    yield* rejected(
      f.sync.launch({
        ...f.input,
        sourceThreadId: f.handoffInput.sourceThreadId,
        sourceProjectId: ProjectId.make("other"),
      }),
      "validate",
      "thread_project_mismatch",
    );
    assert.lengthOf(f.state.preflights, 0);
    assert.lengthOf(f.state.scripts, 0);
    assert.lengthOf(f.state.notices, 0);
  }));

test("handoff rejects a missing thread", (f) =>
  Effect.gen(function* () {
    f.state.threadMissing = true;
    yield* rejected(f.sync.handoffThread(f.handoffInput), "validate", "thread_not_found");
    assert.lengthOf(f.state.scripts, 0);
    assert.lengthOf(f.state.notices, 0);
  }));

testEach(
  ([1, 2, 3, 4] as const).map(
    (check) => [`handoff rejects a deleted thread at check ${check}`, check] as const,
  ),
  (check, f) =>
    Effect.gen(function* () {
      const deleted = {
        ...f.state.projection,
        thread: {
          ...f.state.projection.thread,
          deletedAt: DateTime.makeUnsafe("2026-10-17T01:00:00.000Z"),
        },
      };
      f.state.projections = [
        ...Array.from({ length: check - 1 }, () => f.state.projection),
        deleted,
      ];
      yield* rejected(f.sync.handoffThread(f.handoffInput), "validate", "thread_not_found");
      assert.strictEqual(f.state.projectionReads, check);
      assert.lengthOf(f.state.launches, 0);
      assert.lengthOf(f.state.notices, 0);
      if (check < 3) assert.lengthOf(f.state.scripts, 0);
    }),
);

testEach(
  (["queued", "running"] as const).flatMap((status) =>
    ([2, 3, 4] as const).map(
      (check) =>
        [`handoff rejects new ${status} work at check ${check}`, { status, check }] as const,
    ),
  ),
  ({ status, check }, f) =>
    Effect.gen(function* () {
      const ownRun = f.run("running");
      const initial = { ...f.state.projection, runs: [ownRun] };
      f.state.projections = [
        ...Array.from({ length: check - 1 }, () => initial),
        { ...initial, runs: [ownRun, { ...f.run(status), id: RunId.make("new-run"), ordinal: 2 }] },
      ];
      yield* rejected(
        f.sync.handoffThread({ ...f.handoffInput, allowRunId: ownRun.id }),
        "validate",
        "thread_busy",
      );
      assert.strictEqual(f.state.projectionReads, check);
      assert.lengthOf(f.state.launches, 0);
      assert.lengthOf(f.state.notices, 0);
      if (check === 2) assert.lengthOf(f.state.scripts, 0);
      else assert.isTrue(f.state.gitCalls.some((call) => call.args[0] === "push"));
    }),
);

test("handoff summarizes the projection re-read after transfer", (f) =>
  Effect.gen(function* () {
    const item = f.conversationItem("assistant_message", "Completed during transfer", 1);
    f.state.projections = [
      f.state.projection,
      f.state.projection,
      {
        ...f.state.projection,
        visibleTurnItems: [
          {
            item,
            position: 0,
            sourceThreadId: item.threadId,
            sourceItemId: item.id,
            visibility: "local",
          },
        ],
      },
    ];
    yield* f.sync.handoffThread(f.handoffInput);
    // Entry, before the snapshot, while summarizing, and right before the remote launch.
    assert.strictEqual(f.state.projectionReads, 4);
    assert.include(f.state.launches[0]?.message ?? "", "Completed during transfer");
  }));

testEach(
  ([1, 2, 3] as const).map(
    (check) => [`handoff re-checks caller authority before remote change ${check}`, check] as const,
  ),
  (check, f) =>
    Effect.gen(function* () {
      let checks = 0;
      yield* rejected(
        f.sync.handoffThread({
          ...f.handoffInput,
          beforeRemoteChange: Effect.suspend(() =>
            ++checks === check
              ? Effect.fail(
                  new SshWorkspaceError({ stage: "validate", code: "caller_not_authorized" }),
                )
              : Effect.void,
          ),
        }),
        "validate",
        "caller_not_authorized",
      );
      assert.strictEqual(checks, check);
      assert.lengthOf(f.state.launches, 0);
      assert.lengthOf(f.state.notices, 0);
      if (check === 1) assert.lengthOf(f.state.scripts, 0);
      if (check < 3) assert.isFalse(f.state.gitCalls.some((call) => call.args[0] === "push"));
      else assert.isTrue(f.state.gitCalls.some((call) => call.args[0] === "push"));
    }),
);

testEach(
  (["missing", "subdirectory", "foreign"] as const).map(
    (kind) => [`handoff refuses ${kind} worktree`, kind] as const,
  ),
  (kind, f) =>
    Effect.gen(function* () {
      const worktree = f.path.join(f.parent, "invalid worktree");
      if (kind === "subdirectory") yield* f.fs.makeDirectory(f.path.join(f.cwd, "subdirectory"));
      if (kind === "foreign") {
        yield* f.fs.makeDirectory(worktree);
        yield* f.git(["init"], worktree);
      }
      f.state.projection = {
        ...f.state.projection,
        thread: {
          ...f.state.projection.thread,
          worktreePath: kind === "subdirectory" ? f.path.join(f.cwd, "subdirectory") : worktree,
        },
      };
      yield* rejected(f.sync.handoffThread(f.handoffInput), "validate", "thread_worktree_invalid");
      assert.lengthOf(f.state.preflights, 0);
      assert.lengthOf(f.state.scripts, 0);
      assert.lengthOf(f.state.notices, 0);
    }),
);

test("handoff enforces a supplied environment identity before transfer", (f) =>
  Effect.gen(function* () {
    yield* rejected(
      f.sync.handoffThread({
        ...f.handoffInput,
        expectedEnvironmentId: EnvironmentId.make("different"),
      }),
      "preflight",
      "environment_mismatch",
    );
    assert.lengthOf(f.state.scripts, 0);
    assert.lengthOf(f.state.launches, 0);
    assert.lengthOf(f.state.notices, 0);
  }));

test("source notice failure does not turn a successful handoff into failure", (f) =>
  Effect.gen(function* () {
    f.state.noticeFails = true;
    const result = yield* f.sync.handoffThread(f.handoffInput);
    assert.strictEqual(result.remoteThreadId, "rt");
    assert.lengthOf(f.state.launches, 1);
    assert.lengthOf(f.state.notices, 1);
  }));

test("workspace transfer publishes a project-named snapshot without starting a thread", (f) =>
  Effect.gen(function* () {
    const result = yield* f.sync.transferWorkspace({
      target,
      snapshotCwd: f.cwd,
      projectRoot: f.project.workspaceRoot,
      operationId: "12345678",
    });
    assert.strictEqual(result.remoteRepoPath, f.remote);
    assert.strictEqual(result.snapshotRef, "refs/goat/snapshots/12345678");
    assert.strictEqual(result.pushedRef, "refs/heads/goat/ssh-base/12345678");
    assert.strictEqual(
      (yield* f.git(["rev-parse", result.pushedRef], f.remote)).stdout.trim(),
      result.snapshotOid,
    );
    assert.lengthOf(f.state.launches, 0);
    assert.lengthOf(f.state.notices, 0);
  }));
