import { makeTempDir } from "./testkit/fileFixtures.ts";
import { runGit, initRepo } from "./testkit/gitRepository.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitManager from "./GitManager.ts";
import {
  type FakeProviderScenario,
  createBareRemote,
  makeManager,
  layerGitManagerTest,
} from "./GitManagerTestHarness.ts";

it.layer(layerGitManagerTest)("GitManager", (it) => {
  it.effect(
    "publishes local Git changes during a held PR lookup without caching its old branch",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("goat-refresh-status-gh-gate-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "release"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "release"]);
        yield* runGit(repoDir, ["tag", "release"]);
        const oldPr = {
          number: 613,
          title: "Release PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/613",
          baseRefName: "main",
          headRefName: "release",
        };
        const newPr = { ...oldPr, number: 614, headRefName: "heads/release" };
        const providerScenario: FakeProviderScenario = {
          prListSequence: [oldPr, oldPr, newPr].map((pr) => [pr]),
        };
        const { manager } = yield* makeManager({ providerScenario });
        const context = yield* Layer.build(
          VcsStatusBroadcaster.layer.pipe(
            Layer.provide(
              GitWorkflowService.layer.pipe(
                Layer.provide(Layer.succeed(GitManager.GitManager, manager)),
                Layer.provide(
                  VcsDriverRegistry.layer.pipe(
                    Layer.provide(VcsProjectConfig.layer),
                    Layer.provide(VcsProcess.layer),
                  ),
                ),
              ),
            ),
            Layer.provide(
              Layer.mock(BackgroundPolicy.BackgroundPolicy)({
                shouldRunScopeWork: () => Effect.succeed(true),
              }),
            ),
          ),
        );
        const broadcaster = Context.get(context, VcsStatusBroadcaster.VcsStatusBroadcaster);
        const initial = yield* broadcaster.getStatus({ cwd: repoDir });
        expect(initial.refName).toBe("release");
        expect(initial.pr?.number).toBe(613);

        const subscribed = yield* Deferred.make<void>();
        const published = yield* Deferred.make<void>();
        yield* broadcaster.streamStatus({ cwd: repoDir, includeRemote: false }).pipe(
          Stream.runForEach((event) => {
            if (event._tag === "snapshot") return Deferred.succeed(subscribed, undefined);
            if (event._tag === "localUpdated" && event.local.hasWorkingTreeChanges) {
              return Deferred.succeed(published, undefined);
            }
            return Effect.void;
          }),
          Effect.forkScoped,
        );
        yield* Deferred.await(subscribed);
        const gate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        providerScenario.prListGate = gate;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(NodePath.join(repoDir, "README.md"), "changed before refresh\n");
        const completed = yield* Deferred.make<void>();
        const refresh = yield* broadcaster
          .refreshStatus(repoDir)
          .pipe(Effect.ensuring(Deferred.succeed(completed, undefined)), Effect.forkScoped);
        yield* Deferred.await(gate.started);
        const pending = Option.getOrThrow(
          yield* Stream.runHead(broadcaster.streamStatus({ cwd: repoDir, includeRemote: false })),
        );
        expect(pending._tag).toBe("snapshot");
        if (pending._tag === "snapshot") expect(pending.local.hasWorkingTreeChanges).toBe(true);
        yield* Deferred.await(published);
        expect(yield* Deferred.isDone(completed)).toBe(false);

        yield* runGit(repoDir, ["checkout", "-b", "heads/release"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "refs/heads/heads/release"]);
        yield* Deferred.succeed(gate.release, undefined);
        const refreshed = yield* Fiber.join(refresh);
        expect(refreshed.refName).toBe("heads/release");
        expect(refreshed.hasWorkingTreeChanges).toBe(true);
        expect(refreshed.pr).toBeNull();
        const snapshot = Option.getOrThrow(
          yield* Stream.runHead(broadcaster.streamStatus({ cwd: repoDir, includeRemote: false })),
        );
        expect(snapshot._tag).toBe("snapshot");
        if (snapshot._tag === "snapshot") expect(snapshot.remote).toBeNull();

        delete providerScenario.prListGate;
        const recovered = yield* broadcaster.getStatus({ cwd: repoDir });
        expect(recovered.refName).toBe("heads/release");
        expect(recovered.pr?.number).toBe(614);
        expect((yield* broadcaster.getStatus({ cwd: repoDir })).pr?.number).toBe(614);
      }),
  );
});
