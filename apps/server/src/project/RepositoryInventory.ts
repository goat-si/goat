import {
  RepositoryInventoryKey,
  type RepositoryInventoryEntry,
  type RepositoryInventorySnapshot,
} from "@goat/contracts";
import { normalizeGitRemoteUrl } from "@goat/shared/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "./ProjectService.ts";

const MAX_PROJECTS = 64;
const MAX_ENTRIES = 128;
const SCAN_BUDGET_MS = 5_000;
const CACHE_TTL_MS = 15_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const isRepositoryKey = Schema.is(RepositoryInventoryKey);

export class RepositoryInventory extends Context.Service<
  RepositoryInventory,
  {
    readonly read: Effect.Effect<RepositoryInventorySnapshot>;
    readonly readFresh: Effect.Effect<RepositoryInventorySnapshot>;
  }
>()("goat/project/RepositoryInventory") {}

export const repositoryOriginKey = (origin: string | null) => {
  if (
    origin === null ||
    !/^(?:(?:https?|ssh|git):\/\/|(?:[^\s/@:]+@)?[^\s/:\\]{2,}:)/i.test(origin)
  )
    return null;
  const key = normalizeGitRemoteUrl(origin.trim());
  return isRepositoryKey(key) ? key : null;
};

const empty = (
  path: string,
  state: RepositoryInventoryEntry["state"],
): RepositoryInventoryEntry => ({
  path,
  state,
  originKey: null,
  branch: null,
  head: null,
  upstream: null,
  ahead: null,
  behind: null,
  dirty: null,
  dependencies: { state: "unknown", installedAt: null },
});

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  let cached: RepositoryInventorySnapshot | undefined;

  const git = Effect.fn("RepositoryInventory.git")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    allowNoMatch = false,
  ) {
    return yield* runner
      .run({
        command: "git",
        // Repository-controlled fsmonitor commands must not execute during an inventory read.
        args: [
          "--no-optional-locks",
          "-c",
          "safe.bareRepository=explicit",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          "-C",
          cwd,
          ...args,
        ],
        env: { GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
        timeout: 1_000,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      })
      .pipe(
        Effect.map((result) =>
          (result.code === 0 || (allowNoMatch && result.code === 1)) && !result.stdoutTruncated
            ? result.stdout
            : null,
        ),
        Effect.orElseSucceed(() => null),
      );
  });

  const inspect = Effect.fn("RepositoryInventory.inspect")(function* (cwd: string) {
    const info = yield* fs.stat(cwd).pipe(Effect.option);
    if (Option.isNone(info)) return empty(cwd, "missing");
    if (info.value.type !== "Directory") return empty(cwd, "not_repository");
    const root = yield* git(cwd, ["rev-parse", "--show-toplevel"]);
    if (root === null) return empty(cwd, "not_repository");
    const filters = yield* git(
      cwd,
      ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process)$"],
      true,
    );
    const submodules = yield* fs.exists(path.join(cwd, ".gitmodules"));
    const partial = yield* git(
      cwd,
      [
        "config",
        "--name-only",
        "--get-regexp",
        "^(extensions\\.partialclone|remote\\..*\\.promisor)$",
      ],
      true,
    );
    // Status may run clean/process filters or recurse into submodules. Metadata-only reads
    // retain the checkout identity without claiming that the working tree is clean.
    const status =
      filters === "" && !submodules && partial === ""
        ? yield* git(cwd, [
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=normal",
            "--ignore-submodules=all",
            "-z",
          ])
        : null;
    const entry = { ...empty(cwd, "available") };
    if (status === null) {
      entry.head = (yield* git(cwd, ["rev-parse", "--verify", "HEAD"]))?.trim() ?? null;
      entry.branch =
        (yield* git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim() ?? null;
      entry.upstream =
        (yield* git(cwd, [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ]))?.trim() ?? null;
      if (entry.upstream !== null && partial === "") {
        const counts = yield* git(cwd, [
          "rev-list",
          "--left-right",
          "--count",
          "HEAD...@{upstream}",
        ]);
        const match = counts?.trim().match(/^(\d+)\s+(\d+)$/);
        if (match) {
          entry.ahead = Number(match[1]);
          entry.behind = Number(match[2]);
        }
      }
    } else entry.dirty = false;
    const fields = status?.split("\0") ?? [];
    for (let index = 0; index < fields.length; index++) {
      const field = fields[index]!;
      if (field.startsWith("# branch.oid ")) {
        const oid = field.slice(13);
        entry.head = /^[a-f0-9]{40,64}$/.test(oid) ? oid : null;
      } else if (field.startsWith("# branch.head ")) {
        const branch = field.slice(14);
        entry.branch = branch === "(detached)" ? null : branch;
      } else if (field.startsWith("# branch.upstream ")) {
        entry.upstream = field.slice(18);
      } else if (field.startsWith("# branch.ab ")) {
        const counts = /^# branch.ab \+(\d+) -(\d+)$/.exec(field);
        if (counts) {
          entry.ahead = Number(counts[1]);
          entry.behind = Number(counts[2]);
        }
      } else if (field !== "" && !field.startsWith("# ")) {
        entry.dirty = true;
        if (field.startsWith("2 ")) index++;
      }
    }
    const origin = yield* git(cwd, [
      "config",
      "--local",
      "--no-includes",
      "--get",
      "remote.origin.url",
    ]);
    // Local paths and malformed remotes have no cross-host identity. Never return raw URLs.
    entry.originKey = repositoryOriginKey(origin);
    return entry;
  });

  const scan = Effect.fn("RepositoryInventory.scan")(function* () {
    const sampledAt = yield* Clock.currentTimeMillis;
    const entries: Array<RepositoryInventoryEntry> = [];
    const seen = new Set<string>();
    let truncated = false;
    const work = Effect.gen(function* () {
      const shells = yield* projects.listShells();
      truncated = shells.length > MAX_PROJECTS;
      for (const project of shells.slice(0, MAX_PROJECTS)) {
        const candidates = [project.workspaceRoot];
        const worktrees = yield* git(project.workspaceRoot, [
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]);
        if (worktrees === null) truncated = true;
        else {
          for (const record of worktrees.split("\0\0")) {
            const field = record.split("\0").find((item) => item.startsWith("worktree "));
            if (field !== undefined) candidates.push(field.slice(9));
          }
        }
        for (const candidate of candidates) {
          if (!path.isAbsolute(candidate) || candidate.includes("\0")) continue;
          const real = yield* fs
            .realPath(candidate)
            .pipe(Effect.orElseSucceed(() => path.normalize(candidate)));
          if (seen.has(real)) continue;
          if (entries.length >= MAX_ENTRIES) {
            truncated = true;
            return;
          }
          seen.add(real);
          entries.push(yield* inspect(real));
        }
      }
    });
    const result = yield* work.pipe(Effect.timeoutOption(SCAN_BUDGET_MS), Effect.option);
    if (Option.isNone(result) || Option.isNone(result.value)) truncated = true;
    return { sampledAt, entries, truncated } satisfies RepositoryInventorySnapshot;
  });

  const read = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (cached !== undefined && now - cached.sampledAt < CACHE_TTL_MS) return cached;
    cached = yield* scan();
    return cached;
  }).pipe(lock.withPermits(1));
  const readFresh = scan().pipe(
    Effect.tap((snapshot) =>
      Effect.sync(() => {
        cached = snapshot;
      }),
    ),
    lock.withPermits(1),
  );
  return RepositoryInventory.of({ read, readFresh });
});

export const layer = Layer.effect(RepositoryInventory, make);
