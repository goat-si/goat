// @effect-diagnostics nodeBuiltinImport:off -- isolated fake SSH uses local shell and independent Node hashing.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  Project,
  ProjectId,
  EnvironmentId,
  SshWorkspaceLaunchInput,
  VcsProcessExitError,
  type SshWorkspaceError,
  type RuntimeMode,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Projects from "../project/ProjectService.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";
import * as Dispatch from "./SshRemoteDispatch.ts";
import * as Sync from "./SshWorkspaceSync.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const decodeProject = Schema.decodeUnknownSync(Project);
const decodeInput = Schema.decodeUnknownSync(SshWorkspaceLaunchInput);
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
  const state = {
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
