// @effect-diagnostics nodeBuiltinImport:off -- real Git fixtures run in temporary repositories.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ThreadId, TurnItemId, type ProjectId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { shell } from "../../storageCleanup.testFixtures.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { layerRealGit } from "../ProviderTurnStartService.testkit.ts";
import { makePrepareTurnWorkspace, workspaceRestoredItem } from "./prepareTurnWorkspace.ts";

const threadId = ThreadId.make("thread-leftover");

interface Row {
  readonly userFile?: boolean;
  readonly unmanaged?: boolean;
  readonly setupFails?: boolean;
}

// `git worktree remove` can skip dependency folders (pnpm junctions on Windows) and leave them behind.
const startTurnOverLeftover = (row: Row) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const root = NodeFS.realpathSync(config.baseDir);
    const repo = NodePath.join(root, "repo");
    const worktreePath = row.unmanaged
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
    NodeFS.mkdirSync(NodePath.join(worktreePath, "node_modules", "pkg"), { recursive: true });
    if (row.userFile) NodeFS.writeFileSync(NodePath.join(worktreePath, "notes.md"), "keep me");
    const thread = shell({ id: threadId, branch: "feature", worktreePath });
    const fakes = Layer.mergeAll(
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        getThreadShell: () => Effect.succeed(thread),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Layer.succeed(ProjectService.ProjectService, {
        getById: () => Effect.succeedSome({ id: "project-1" as ProjectId, workspaceRoot: repo }),
      } as unknown as ProjectService.ProjectService["Service"]),
      Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
        runForThread: (input) =>
          Effect.succeed(
            row.setupFails
              ? {
                  status: "started" as const,
                  scriptId: "setup",
                  scriptName: "setup",
                  scriptCommand: "false",
                  terminalId: "setup",
                  cwd: input.worktreePath,
                  async: false,
                  completion: Effect.succeed({ exitCode: 1, durationMs: 1 }),
                }
              : { status: "no-script" as const },
          ),
      }),
    );
    const prepare = yield* makePrepareTurnWorkspace.pipe(Effect.provide(fakes));
    const prepared = yield* prepare({ ...thread, worktreePath, branch: "feature" });
    const siblings = NodeFS.readdirSync(NodePath.dirname(worktreePath)).toSorted();
    const setAside = siblings.find((name) => name !== "feature");
    const setAsidePath =
      setAside === undefined ? null : NodePath.join(NodePath.dirname(worktreePath), setAside);
    return {
      prepared,
      siblings,
      setAsidePath,
      linked: NodeFS.existsSync(NodePath.join(worktreePath, ".git")),
      inPlace: NodeFS.readdirSync(worktreePath).toSorted(),
      setAsideEntries: setAsidePath === null ? null : NodeFS.readdirSync(setAsidePath),
    };
  }).pipe(
    Effect.provide(
      layerRealGit.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ServerSettings.layerTest(),
            ServerConfig.layerTest(process.cwd(), { prefix: "goat-turn-leftover-" }),
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );

it.effect("a turn sets aside a worktree folder left with only dependencies and recreates it", () =>
  Effect.gen(function* () {
    const { prepared, siblings, setAsidePath, linked, setAsideEntries } =
      yield* startTurnOverLeftover({});
    assert.equal(prepared._tag, "Ready");
    const restored = prepared._tag === "Ready" ? prepared.restored : undefined;
    assert.equal(restored?.restoredFrom, "branch");
    assert.isTrue(linked);
    assert.equal(siblings.length, 2);
    assert.match(setAsidePath ?? "", /feature-set-aside-[^/\\]+$/);
    assert.equal(restored?.setAsidePath, setAsidePath);
    assert.deepEqual(setAsideEntries, ["node_modules"]);
    if (restored === undefined) return;
    const item = workspaceRestoredItem({
      id: TurnItemId.make("restored"),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      turnItems: [],
      now: DateTime.makeUnsafe(0),
      branch: "feature",
      restored,
    });
    assert.include(
      item.type === "notification" ? (item.detail ?? "") : "",
      setAsidePath ?? "missing",
    );
  }),
);

it.effect.each<Row & { readonly name: string }>([
  { name: "a folder that also holds the person's files", userFile: true },
  { name: "a path outside GOAT's worktrees folder", unmanaged: true },
])("a turn leaves the folder in place for $name", (row) =>
  Effect.gen(function* () {
    const { prepared, siblings, linked, inPlace } = yield* startTurnOverLeftover(row);
    assert.equal(prepared._tag, "Ready");
    assert.isUndefined(prepared._tag === "Ready" ? prepared.restored : "not ready");
    assert.isFalse(linked);
    assert.deepEqual(siblings, ["feature"]);
    assert.deepEqual(inPlace, row.userFile ? ["node_modules", "notes.md"] : ["node_modules"]);
  }),
);

it.effect("a failed restore puts the set-aside folder back", () =>
  Effect.gen(function* () {
    const { prepared, siblings, linked, inPlace } = yield* startTurnOverLeftover({
      setupFails: true,
    });
    assert.equal(prepared._tag, "Failed");
    assert.isFalse(linked);
    assert.deepEqual(siblings, ["feature"]);
    assert.deepEqual(inPlace, ["node_modules"]);
  }),
);
