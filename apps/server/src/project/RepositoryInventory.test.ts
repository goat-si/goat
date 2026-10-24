import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, RepositoryInventorySnapshot } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryInventory from "./RepositoryInventory.ts";

const decodeSnapshot = Schema.decodeEffect(RepositoryInventorySnapshot);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "repo-inventory-" }));
  const globalGitConfig = root + "/global.gitconfig";
  yield* fs.writeFileString(globalGitConfig, "");
  const gitEnv = { GIT_CONFIG_GLOBAL: globalGitConfig, GIT_CONFIG_NOSYSTEM: "1" };
  const repo = root + "/checkout ; echo not-a-command";
  yield* fs.makeDirectory(repo);
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    runner.run({ command: "git", args: ["-C", cwd, ...args], env: gitEnv }).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result.code).toBe(0))),
      Effect.map((result) => result.stdout.trim()),
    );
  yield* git(repo, ["init", "-b", "main"]);
  yield* git(repo, ["config", "user.email", "inventory@example.test"]);
  yield* git(repo, ["config", "user.name", "Inventory test"]);
  const commit = (cwd = repo) =>
    git(cwd, ["commit", "--allow-empty", "-m", "fixture"]).pipe(
      Effect.andThen(git(cwd, ["rev-parse", "HEAD"])),
    );
  const inventoryLayer = (roots: ReadonlyArray<string> = [repo], limitWorktreeOutput = false) =>
    RepositoryInventory.layer.pipe(
      Layer.provide(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) =>
            runner.run({
              ...input,
              env: { ...input.env, ...gitEnv },
              ...(limitWorktreeOutput && input.args.includes("worktree")
                ? { maxOutputBytes: 1 }
                : {}),
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({
          listShells: () =>
            Effect.succeed(
              roots.map((workspaceRoot, index) => ({
                id: ProjectId.make(`project-${index}`),
                title: "Fixture",
                workspaceRoot,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              })),
            ),
        }),
      ),
    );
  const read = (roots?: ReadonlyArray<string>) =>
    RepositoryInventory.RepositoryInventory.pipe(
      Effect.flatMap((service) => service.read),
      Effect.provide(inventoryLayer(roots)),
      Effect.tap(decodeSnapshot),
    );
  return { fs, root, repo, git, commit, read, inventoryLayer, globalGitConfig };
});

const layer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.effect("never runs a configured clean filter while inventorying tracked changes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.writeFileString(f.repo + "/tracked.txt", "before");
    yield* f.fs.writeFileString(f.repo + "/.gitattributes", "tracked.txt filter=fixture\n");
    yield* f.git(f.repo, ["add", "."]);
    yield* f.commit();
    const marker = f.root + "/filter-ran";
    yield* f.git(f.repo, ["config", "filter.fixture.clean", `touch '${marker}'; cat`]);
    yield* f.fs.writeFileString(f.repo + "/tracked.txt", "AFTER!");
    const snapshot = yield* f.read();
    expect(yield* f.fs.exists(marker)).toBe(false);
    expect(snapshot.entries[0]?.dirty).toBeNull();
    expect(snapshot.entries[0]?.head).not.toBeNull();
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("leaves dirt unknown when a global clean filter is configured", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.commit();
    const marker = f.root + "/global-filter-ran";
    yield* f.fs.writeFileString(
      f.globalGitConfig,
      `[filter "fixture"]\n  clean = touch '${marker}'; cat\n`,
    );
    const snapshot = yield* f.read();
    expect(snapshot.entries[0]?.dirty).toBeNull();
    expect(snapshot.entries[0]?.head).not.toBeNull();
    expect(yield* f.fs.exists(marker)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("does not parse rename source filenames as branch headers", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const name = "# branch.ab +100 -0";
    yield* f.fs.writeFileString(f.repo + "/" + name, "content");
    yield* f.git(f.repo, ["add", "--", name]);
    yield* f.commit();
    yield* f.git(f.repo, ["mv", "--", name, "renamed.txt"]);
    const entry = (yield* f.read()).entries[0];
    expect(entry?.ahead).toBeNull();
    expect(entry?.dirty).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("reports an unborn checkout without an origin or invented dependency evidence", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.makeDirectory(f.repo + "/node_modules");
    const snapshot = yield* f.read();
    expect(snapshot.entries).toEqual([
      {
        path: f.repo,
        state: "available",
        originKey: null,
        head: null,
        branch: "main",
        upstream: null,
        ahead: null,
        behind: null,
        dirty: false,
        dependencies: { state: "unknown", installedAt: null },
      },
    ]);
    expect(snapshot.truncated).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("normalizes origin rather than upstream and never exposes remote credentials", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const head = yield* f.commit();
    yield* f.git(f.repo, [
      "remote",
      "add",
      "origin",
      "https://fixture-user:fixture-password@github.com/Owner/Repo.git",
    ]);
    yield* f.git(f.repo, ["remote", "add", "upstream", "git@github.com:Other/Repo.git"]);
    const snapshot = yield* f.read();
    expect(snapshot.entries[0]).toMatchObject({
      originKey: "github.com/owner/repo",
      head,
      dirty: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain("fixture-password");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("reports tracked and untracked dirt without running a repository fsmonitor", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.writeFileString(f.repo + "/tracked.txt", "before");
    yield* f.git(f.repo, ["add", "tracked.txt"]);
    yield* f.commit();
    yield* f.fs.writeFileString(f.repo + "/tracked.txt", "after");
    const marker = f.root + "/hook-ran";
    const hook = f.root + "/monitor.sh";
    yield* f.fs.writeFileString(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    yield* f.fs.chmod(hook, 0o755);
    yield* f.git(f.repo, ["config", "core.fsmonitor", hook]);
    const indexBefore = yield* f.fs.readFile(f.repo + "/.git/index");
    expect((yield* f.read()).entries[0]?.dirty).toBe(true);
    expect(yield* f.fs.exists(marker)).toBe(false);
    expect(yield* f.fs.readFile(f.repo + "/.git/index")).toEqual(indexBefore);
    yield* f.fs.writeFileString(f.repo + "/tracked.txt", "before");
    yield* f.fs.writeFileString(f.repo + "/untracked.txt", "new");
    expect((yield* f.read()).entries[0]?.dirty).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("reads ahead and behind from existing refs without fetching", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const base = yield* f.commit();
    yield* f.git(f.repo, ["remote", "add", "origin", "https://invalid.example/owner/repo.git"]);
    yield* f.git(f.repo, ["update-ref", "refs/remotes/origin/main", base]);
    yield* f.git(f.repo, ["branch", "--set-upstream-to=origin/main"]);
    const localHead = yield* f.commit();
    expect((yield* f.read()).entries[0]).toMatchObject({ head: localHead, ahead: 1, behind: 0 });
    yield* f.git(f.repo, ["checkout", "-b", "other", base]);
    yield* f.fs.writeFileString(f.repo + "/other.txt", "other commit");
    yield* f.git(f.repo, ["add", "other.txt"]);
    const otherHead = yield* f.commit();
    yield* f.git(f.repo, ["update-ref", "refs/remotes/origin/main", otherHead]);
    yield* f.git(f.repo, ["checkout", "main"]);
    expect((yield* f.read()).entries[0]).toMatchObject({ head: localHead, ahead: 1, behind: 1 });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "enumerates registered Git worktrees, deduplicates them, and leaves unrelated repos alone",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.commit();
      const sibling = f.root + "/worktree";
      yield* f.git(f.repo, ["worktree", "add", "-b", "sibling", sibling]);
      const unrelated = f.root + "/unregistered";
      yield* f.fs.makeDirectory(unrelated);
      yield* f.git(unrelated, ["init"]);
      const snapshot = yield* f.read([f.repo, sibling]);
      expect(snapshot.entries.map((entry) => entry.path).sort()).toEqual([f.repo, sibling].sort());
      expect(snapshot.entries.find((entry) => entry.path === sibling)?.branch).toBe("sibling");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("keeps missing and non-repository registrations explicit", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const plain = f.root + "/plain";
    yield* f.fs.makeDirectory(plain);
    const snapshot = yield* f.read([f.root + "/missing", plain]);
    expect(snapshot.entries.map((entry) => entry.state)).toEqual(["missing", "not_repository"]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("bounds registered roots and caches one bounded snapshot", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const snapshot = yield* f.read(
      Array.from({ length: 65 }, (_, index) => f.root + `/missing-${index}`),
    );
    expect(snapshot.entries).toHaveLength(64);
    expect(snapshot.truncated).toBe(true);
    yield* Effect.gen(function* () {
      const inventory = yield* RepositoryInventory.RepositoryInventory;
      const first = yield* inventory.read;
      yield* f.fs.writeFileString(f.repo + "/new.txt", "new");
      expect(yield* inventory.read).toBe(first);
    }).pipe(Effect.provide(f.inventoryLayer()));
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "marks a failed worktree enumeration incomplete even when the root can be inspected",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.commit();
      const snapshot = yield* RepositoryInventory.RepositoryInventory.pipe(
        Effect.flatMap((service) => service.read),
        Effect.provide(f.inventoryLayer([f.repo], true)),
      );
      expect(snapshot.entries[0]?.state).toBe("available");
      expect(snapshot.truncated).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
