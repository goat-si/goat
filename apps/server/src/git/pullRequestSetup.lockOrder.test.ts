import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GoatProjectFileLoader from "../project/GoatProjectFileLoader.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { FakePtyAdapter } from "../terminal/Manager.testkit.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { makePullRequestSetup } from "./pullRequestSetup.ts";

const threadId = ThreadId.make("thread-pull-request");
const projectId = ProjectId.make("project-pull-request");

// goat#3694: a pull request's setup runs in a reused worktree before the thread is bound to it.
it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    McpProviderSessions.layer,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
    ServerSettings.layerTest(),
  ),
  { excludeTestServices: true },
)("pull request setup and the terminal lock order", (it) => {
  it.effect.each([
    ["before the thread is bound", null],
    ["while the thread is still bound to another worktree", "/elsewhere"],
  ] as const)("a pull request setup that waited for its reused worktree runs %s", ([, bound]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const base = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "goat-pr-setup-" }),
      );
      const repo = join(base, "repo");
      const worktreePath = join(base, "pr-worktree");
      yield* fs.makeDirectory(repo);
      yield* fs.makeDirectory(worktreePath);
      const pty = new FakePtyAdapter();
      const terminals = yield* TerminalManager.makeWithOptions({
        logsDir: join(base, "terminal-logs"),
        ptyAdapter: pty,
        processKillGraceMs: 1,
        threadWorktree: { current: () => Effect.succeedSome(bound) },
      });
      const project = {
        id: projectId,
        title: "Pull request",
        workspaceRoot: repo,
        scripts: [
          {
            id: "setup",
            name: "Setup",
            command: "true",
            icon: "configure",
            runOnWorktreeCreate: true,
            stopOnSettle: false,
            async: true,
          },
        ],
      };
      const projects = Layer.succeed(ProjectService.ProjectService, {
        getById: () => Effect.succeedSome(project),
        getByWorkspaceRoot: () => Effect.succeedSome(project),
      } as unknown as ProjectService.ProjectService["Service"]);
      const setup = yield* makePullRequestSetup.pipe(
        Effect.provide(
          Layer.effect(
            ProjectSetupScriptRunner.ProjectSetupScriptRunner,
            ProjectSetupScriptRunner.make,
          ).pipe(
            Layer.provide(
              Layer.mergeAll(
                projects,
                // A shell that shows its prompt once open.
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
                }),
                Layer.mock(ProjectionStore.ProjectionStoreV2)({
                  getThreadShell: () => Effect.succeed(null),
                }),
                GoatProjectFileLoader.layer,
              ),
            ),
          ),
        ),
      );
      // Another thread's work holds the reused worktree when the setup opens its terminal.
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* withWorkspaceLease(
        worktreePath,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const ran = yield* setup(
        { cwd: repo, reference: "1", mode: "worktree", threadId },
        worktreePath,
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(ran);
      assert.deepEqual(
        pty.spawnInputs.map((input) => input.cwd),
        [worktreePath],
      );
    }),
  );
});
