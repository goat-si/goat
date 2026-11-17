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

/**
 * A setup in a worktree that another thread's work holds, for a thread bound as given: a pull
 * request's, or a restore's fresh-shell run, whose restart comes first. Its terminal waits, then
 * runs again.
 */
const pullRequestSetupWhileHeld = (
  bound: string | null,
  start: "pull request" | "fresh shell" = "pull request",
) =>
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
    const runner = Layer.effect(
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
    );
    const setup =
      start === "pull request"
        ? (yield* makePullRequestSetup.pipe(Effect.provide(runner)))(
            { cwd: repo, reference: "1", mode: "worktree", threadId },
            worktreePath,
          )
        : ProjectSetupScriptRunner.ProjectSetupScriptRunner.pipe(
            Effect.flatMap((scripts) =>
              scripts.runForThread({
                threadId,
                projectCwd: repo,
                worktreePath,
                trigger: "setup",
                // As a restore asks, for a folder that may be new at the old path.
                freshShell: true,
              }),
            ),
            Effect.provide(runner),
          );
    // Another thread's work holds the reused worktree when the setup opens its terminal.
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* withWorkspaceLease(
      worktreePath,
      Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(held);
    const ran = yield* setup.pipe(Effect.forkChild({ startImmediately: true }));
    return {
      pty,
      terminals,
      worktreePath,
      /** Lets the other thread's work end, then waits for the setup. */
      finish: Deferred.succeed(release, undefined).pipe(
        Effect.andThen(Fiber.join(holder)),
        Effect.andThen(Fiber.join(ran)),
      ),
    };
  });

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
      const { pty, worktreePath, finish } = yield* pullRequestSetupWhileHeld(bound);
      yield* finish;
      assert.deepEqual(
        pty.spawnInputs.map((input) => input.cwd),
        [worktreePath],
      );
    }),
  );

  it.effect("a person's open beside a waiting setup is still refused when the thread moved", () =>
    Effect.gen(function* () {
      const { pty, terminals, worktreePath, finish } =
        yield* pullRequestSetupWhileHeld("/elsewhere");
      // Started on its own fiber while the setup's open is in flight, as a client's request is.
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
      yield* finish;
      const error = yield* Fiber.join(person);
      assert.strictEqual(error._tag, "TerminalCwdStatError");
      if (error._tag === "TerminalCwdStatError") assert.strictEqual(error.cwd, worktreePath);
      assert.deepEqual(
        pty.spawnInputs.map((input) => input.cwd),
        [worktreePath],
      );
    }),
  );

  it.effect(
    "a restore's fresh-shell restart that waited runs while the thread is still bound elsewhere",
    () =>
      Effect.gen(function* () {
        const { pty, worktreePath, finish } = yield* pullRequestSetupWhileHeld(
          "/elsewhere",
          "fresh shell",
        );
        yield* finish;
        // The restart's shell, which the setup's open then reuses.
        assert.deepEqual(
          pty.spawnInputs.map((input) => input.cwd),
          [worktreePath],
        );
      }),
  );
});
