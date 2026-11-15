// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { GitActionProgressEvent } from "@goat/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect } from "vite-plus/test";
import { makeTempDir } from "./testkit/fileFixtures.ts";
import { runGit, initRepo } from "./testkit/gitRepository.ts";
import {
  createBareRemote,
  runStackedAction,
  makeManager,
  layerGitManagerTest,
} from "./GitManagerTestHarness.ts";

it.layer(layerGitManagerTest)("GitManager final status", (it) => {
  it.effect("reports a completed push even when its final status read fails", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir("goat-git-manager-");
      yield* initRepo(cwd);
      yield* runGit(cwd, ["checkout", "-b", "feature/status-after-push"]);
      const remote = yield* createBareRemote();
      yield* runGit(cwd, ["remote", "add", "origin", remote]);
      NodeFS.writeFileSync(NodePath.join(cwd, "change.txt"), "change\n");
      const gate = {
        matches: (args: ReadonlyArray<string>) => args[0] === "push",
        reached: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      const events: GitActionProgressEvent[] = [];
      const { manager } = yield* makeManager({ gitSpawnGate: gate });
      const action = yield* Effect.forkChild(
        runStackedAction(
          manager,
          { cwd, action: "commit_push", commitMessage: "Status after push" },
          {
            progressReporter: {
              publish: (event) =>
                Effect.sync(() => {
                  events.push(event);
                }),
            },
          },
        ),
      );
      yield* Deferred.await(gate.reached);
      NodeFS.writeFileSync(NodePath.join(cwd, ".git", "index.lock"), "");
      yield* Deferred.succeed(gate.release, undefined);
      const result = yield* Fiber.join(action);
      expect(result.push.status).toBe("pushed");
      expect(result.toast.cta).toEqual({ kind: "none" });
      expect(events.at(-1)?.kind).toBe("action_finished");
      expect(
        (yield* runGit(remote, [
          "--git-dir=.",
          "log",
          "-1",
          "--pretty=%s",
          "feature/status-after-push",
        ])).stdout.trim(),
      ).toBe("Status after push");
    }),
  );
});
