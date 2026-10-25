// @effect-diagnostics nodeBuiltinImport:off -- os.tmpdir names the temp folder GOAT's one-shot work uses.
import * as NodeOS from "node:os";

import type { HostDiskUsage, StorageItem, StorageItemState } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../package.json" with { type: "json" };
import {
  listPinnedRuntimes,
  PINNED_RUNTIME_PRUNED_PREFIX,
  reachedWithoutLinks,
} from "../cloud/pinnedRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as WorktreeInventory from "../mcp/WorktreeInventoryService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "../worktreesDirectory.ts";
import { buildOutputKeeps, findBuildOutputs } from "./buildOutputs.ts";
import { deletedThreadAttachments } from "./deletedThreadAttachments.ts";
import { goatDataReason, resolveGoatDataPaths } from "./goatData.ts";
import {
  type ContentStamp,
  contentStamp,
  type FileIdentity,
  holdsGitCheckout,
  type Lstat,
  lstatOf,
  withinCheckout,
} from "./fileState.ts";
import { LocalGoatServers, type OtherServerBindings } from "./localGoatServers.ts";
import { measureFolder } from "./measureFolder.ts";
import {
  identityToken,
  isRemovableTempName,
  isRotatedLogName,
  isStrictlyInside,
  kacheCacheDirectory,
  overlaps,
  pathRules,
  samePath,
  TEMP_MIN_AGE_MS,
  type PathRules,
} from "./storagePaths.ts";

/**
 * One pass over GOAT's folders on this machine: what each holds and whether the storage cleanup
 * may remove it. Every decision a deletion depends on is taken again at deletion time
 * (StorageReclaim.clean); this pass only decides what to offer.
 *
 * @module storageScan
 */

/** What a cleanup acts on for one item, kept on the server beside the item it offered. */
export type StorageTarget =
  | { readonly kind: "worktree"; readonly head: string | null; readonly branch: string | null }
  | {
      readonly kind: "path";
      readonly root: string;
      readonly identity: FileIdentity;
      /** Build outputs: the worktree whose lease and liveness guard them. */
      readonly worktree: string | null;
      /** What a reviewed leftover or temp folder held; removal re-reads it and skips on change. */
      readonly stamp: ContentStamp | null;
    }
  | { readonly kind: "stale"; readonly repository: string; readonly missing: ReadonlyArray<string> }
  | { readonly kind: "runtime"; readonly version: string }
  | {
      readonly kind: "files";
      readonly root: string;
      readonly files: ReadonlyArray<{ readonly path: string; readonly identity: FileIdentity }>;
    }
  | { readonly kind: "none" };

export interface StorageScan {
  readonly scannedAt: number;
  readonly disk: HostDiskUsage | null;
  readonly items: ReadonlyArray<StorageItem>;
  readonly targets: ReadonlyMap<string, StorageTarget>;
  readonly notes: ReadonlyArray<string>;
}

/** Leftover folders younger than this may be a checkout GOAT is still creating. */
const ORPHAN_MIN_AGE_MS = 60 * 60_000;
/** Total time the scan spends measuring folders; later scans measure what this one could not. */
const MEASURE_BUDGET = Duration.seconds(120);
const MEASURE_CONCURRENCY = 6;

/** Paths the other GOAT servers on this machine use, compared resolved and real. */
export interface OtherServerPaths {
  readonly bindings: OtherServerBindings;
  readonly bound: ReadonlyArray<string>;
  readonly projectRoots: ReadonlyArray<string>;
}

export const resolveOtherServerPaths = Effect.fn("storageScan.resolveOtherServerPaths")(function* (
  ownDatabase: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bindings = yield* (yield* LocalGoatServers).otherServers(ownDatabase);
  const both = (values: ReadonlyArray<string>) =>
    Effect.forEach(
      values,
      (value) => {
        const resolved = path.resolve(value);
        return fs.realPath(resolved).pipe(
          Effect.orElseSucceed(() => resolved),
          Effect.map((real) => (real === resolved ? [resolved] : [resolved, real])),
        );
      },
      { concurrency: 16 },
    ).pipe(Effect.map((lists) => lists.flat()));
  return {
    bindings,
    bound: yield* both(bindings.worktreePaths),
    projectRoots: yield* both(bindings.projectRoots),
  } satisfies OtherServerPaths;
});

/** Why another GOAT server on this machine keeps this folder, or null. */
export function otherServerReason(
  other: OtherServerPaths,
  target: string,
  rules: PathRules,
): string | null {
  if (other.bindings.unverified.length > 0)
    return (
      "not every GOAT server on this machine could be checked: " + other.bindings.unverified[0]
    );
  if (
    other.bound.some(
      (bound) => samePath(bound, target, rules) || isStrictlyInside(target, bound, rules),
    )
  )
    return "a thread of another GOAT server on this machine uses it";
  if (other.projectRoots.some((projectRoot) => overlaps(projectRoot, target, rules)))
    return "it overlaps a project folder of another GOAT server on this machine";
  return null;
}

/** Whether a process of this user works inside the folder; null when that cannot be told. */
export const processInside = (
  cwds: ReadonlyArray<string> | null,
  targets: ReadonlyArray<string>,
  rules: PathRules,
) =>
  cwds === null
    ? null
    : cwds.some((cwd) =>
        targets.some(
          (target) => samePath(cwd, target, rules) || isStrictlyInside(target, cwd, rules),
        ),
      );

export const scanStorage = Effect.fn("storageScan.scan")(function* (options: {
  readonly measure: boolean;
  readonly sizes: Map<string, { readonly bytes: number; readonly at: number }>;
  /** Item ids whose folder contents are read for their token; all of them when absent. */
  readonly stampOnly?: ReadonlySet<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const worktrees = yield* WorktreeInventory.WorktreeInventoryService;
  const resources = yield* HostResources.HostResources;
  const sql = yield* SqlClient.SqlClient;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  const rules = pathRules(platform, path.sep);
  const now = yield* Clock.currentTimeMillis;
  const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
  const notes: Array<string> = [];
  const items: Array<StorageItem> = [];
  const targets = new Map<string, StorageTarget>();
  const real = (value: string) =>
    fs.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));
  const add = (
    item: Omit<StorageItem, "id" | "token" | "bytes"> & { readonly bytes?: number | null },
    target: StorageTarget,
    identity: ReadonlyArray<string | number | bigint | null>,
  ) => {
    const id = item.kind + ":" + item.path;
    items.push({
      ...item,
      id,
      bytes: item.bytes ?? null,
      token: identityToken([item.kind, item.path, ...identity]),
    });
    targets.set(id, target);
  };
  const state = (value: StorageItemState, reason: string, selected = false) => ({
    state: value,
    reason,
    selected,
  });
  /**
   * Binds an offered leftover folder to its contents: the decision it keeps, plus what its token
   * carries, so editing anything inside after review makes the cleanup skip it.
   */
  const stamped = Effect.fn("storageScan.stamped")(function* (
    id: string,
    folder: string,
    minAgeMs: number,
    decision: ReturnType<typeof state>,
  ) {
    if (decision.state !== "removable" || (options.stampOnly && !options.stampOnly.has(id)))
      return {
        decision,
        token: [] as ReadonlyArray<string | number | bigint>,
        stamp: null as ContentStamp | null,
      };
    const stamp = yield* contentStamp(folder);
    if (stamp === null)
      return {
        decision: state(
          "needs_attention",
          "It holds too many files, or files GOAT cannot read, to confirm nothing in it changed",
        ),
        token: [],
        stamp: null,
      };
    if (now - stamp.newestModifiedMs < minAgeMs)
      return {
        decision: state("needs_attention", "Something inside it changed recently"),
        token: [],
        stamp: null,
      };
    if (stamp.holdsGit)
      return {
        decision: state(
          "needs_attention",
          "It holds a git checkout; check it for work before deleting it yourself",
        ),
        token: [],
        stamp: null,
      };
    return { decision, token: [stamp.entries, stamp.newestChangeNs], stamp };
  });

  const other = yield* resolveOtherServerPaths(config.dbPath);
  const goat = yield* resolveGoatDataPaths(other.bindings.databases);
  const cwds = yield* (yield* LocalGoatServers).workingDirectories;
  if (cwds === null)
    notes.push("Running processes could not be listed, so no checkout is offered for removal.");
  for (const reason of other.bindings.unverified)
    notes.push(
      "Not every GOAT server on this machine could be checked (" +
        reason +
        "), so no checkout is offered for removal.",
    );

  // Every path a thread here ever recorded, deleted and archived ones included.
  const ownRows = yield* sql<{
    readonly id: string;
    readonly path: string | null;
    readonly deleted: string | null;
  }>`
    SELECT thread_id AS "id", json_extract(payload_json, '$.worktreePath') AS "path", deleted_at AS "deleted"
    FROM orchestration_v2_projection_threads
  `.pipe(Effect.orElseSucceed(() => null));
  if (ownRows === null) notes.push("This server's threads could not be read.");
  const ownBound = new Set<string>();
  for (const row of ownRows ?? [])
    if (row.path !== null) {
      ownBound.add(path.resolve(row.path));
      ownBound.add(yield* real(row.path));
    }
  const ownProjects = yield* sql<{ readonly root: string }>`
    SELECT workspace_root AS "root" FROM projection_projects WHERE deleted_at IS NULL
  `.pipe(Effect.orElseSucceed(() => null));
  const ownProjectRoots = yield* Effect.forEach(ownProjects ?? [], (row) => real(row.root));

  const managedRoots: Array<string> = [];
  if (settings !== null)
    for (const directory of managedWorktreesDirectories(
      settings,
      config.worktreesDir,
      path,
      home,
      platform,
    )) {
      if (!(yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false)))) continue;
      const rootPath = yield* real(directory);
      if (
        !isFilesystemRoot(rootPath, path) &&
        !managedRoots.some((known) => samePath(known, rootPath, rules))
      )
        managedRoots.push(rootPath);
    }

  const measured: Array<{ readonly id: string; readonly path: string; readonly priority: number }> =
    [];
  const measureLater = (id: string, target: string, priority: number) =>
    measured.push({ id, path: target, priority });

  // Worktrees and their build outputs.
  const facts = yield* worktrees.facts.pipe(Effect.result);
  const registered = new Set<string>();
  if (facts._tag === "Failure")
    notes.push("Worktrees could not be listed: " + facts.failure.message);
  const stale = new Map<string, Array<string>>();
  for (const fact of facts._tag === "Success" ? facts.success : []) {
    const entry = fact.entry;
    registered.add(path.resolve(entry.path));
    registered.add(yield* real(entry.path));
    if (entry.missing) {
      if (!entry.main)
        stale.set(entry.repository, [...(stale.get(entry.repository) ?? []), entry.path]);
      continue;
    }
    if (entry.main || !entry.managed) continue;
    const blocker = WorktreeInventory.abandonedWorktreeBlocker(fact);
    const live = entry.threads.some((thread) => !thread.archived || thread.busy);
    // Git keeps the path a worktree was added at; another server may record where it really is.
    const realEntry = yield* real(entry.path);
    const otherReason =
      otherServerReason(other, entry.path, rules) ?? otherServerReason(other, realEntry, rules);
    const working = processInside(cwds, [entry.path, realEntry], rules);
    const goatReason = goatDataReason(entry.path, goat, rules);
    // A repository around the worktree may track files in it that the worktree's git cannot see.
    const enclosed = yield* withinCheckout(path.dirname(entry.path));
    const enclosedState =
      enclosed === false
        ? null
        : state(
            "needs_attention",
            enclosed === null
              ? "The folders above it could not be checked for a git checkout"
              : "It sits in another git checkout, which may track its files",
          );
    const decision =
      goatReason !== null
        ? state("protected", sentenceCase(goatReason))
        : blocker !== null
          ? state(
              live || fact.holdsProject ? "protected" : "needs_attention",
              sentenceCase(blocker),
            )
          : otherReason !== null
            ? state(
                other.bindings.unverified.length > 0 ? "needs_attention" : "protected",
                sentenceCase(otherReason),
              )
            : enclosedState !== null
              ? enclosedState
              : working === null
                ? state("needs_attention", "Running processes could not be listed")
                : working
                  ? state("protected", "A process is running in it")
                  : state(
                      "removable",
                      entry.threads.length === 0
                        ? "No thread uses it; no uncommitted changes and every commit is on a remote"
                        : "Only archived threads used it; no uncommitted changes and every commit is on a remote",
                      true,
                    );
    add(
      {
        kind: "worktree",
        path: entry.path,
        label: entry.branch ?? path.basename(entry.path),
        ...decision,
      },
      { kind: "worktree", head: fact.head, branch: entry.branch },
      [fact.head, entry.branch],
    );
    measureLater("worktree:" + entry.path, entry.path, decision.state === "removable" ? 0 : 2);
    for (const output of yield* findBuildOutputs(entry.path)) {
      const stat = yield* lstatOf(output);
      if (stat === null || !stat.isDirectory || stat.isLink) continue;
      // Build outputs regrow, so their token is the folder alone; liveness and git guard them.
      const keeps =
        live || otherReason !== null || working !== false
          ? null
          : yield* buildOutputKeeps(entry.path, output);
      const outputGoatReason = goatDataReason(output, goat, rules);
      const outputDecision =
        outputGoatReason !== null
          ? state("protected", sentenceCase(outputGoatReason))
          : live
            ? state(
                "protected",
                entry.threads.some((thread) => thread.busy)
                  ? "A thread is running in this worktree"
                  : "A thread still uses this worktree; archive it first",
              )
            : otherReason !== null
              ? state(
                  other.bindings.unverified.length > 0 ? "needs_attention" : "protected",
                  sentenceCase(otherReason),
                )
              : enclosedState !== null
                ? enclosedState
                : working === null
                  ? state("needs_attention", "Running processes could not be listed")
                  : working
                    ? state("protected", "A process is running in this worktree")
                    : keeps !== null
                      ? state(
                          "needs_attention",
                          sentenceCase(keeps) + "; check it before deleting it yourself",
                        )
                      : state(
                          "removable",
                          path.basename(output) === "target"
                            ? "Rust build output; cargo rebuilds it"
                            : "Installed packages; an install brings them back",
                        );
      add(
        {
          kind: "build_output",
          path: output,
          label:
            path.relative(entry.path, output) +
            " in " +
            (entry.branch ?? path.basename(entry.path)),
          ...outputDecision,
        },
        {
          kind: "path",
          root: entry.path,
          identity: stat.identity,
          worktree: entry.path,
          stamp: null,
        },
        [stat.identity.dev, stat.identity.ino],
      );
      measureLater("build_output:" + output, output, outputDecision.state === "removable" ? 1 : 3);
    }
  }
  for (const [repository, missing] of stale) {
    const sorted = missing.toSorted();
    add(
      {
        kind: "stale_registration",
        path: repository,
        label: sorted.length === 1 ? "1 missing worktree" : sorted.length + " missing worktrees",
        ...state(
          "removable",
          "Git still lists " + sorted.join(", ") + "; git worktree prune forgets them",
          true,
        ),
        bytes: 0,
      },
      { kind: "stale", repository, missing: sorted },
      sorted,
    );
  }

  /** Whether a thread, worktree or project of this server records the folder or one inside it. */
  const referenced = (target: string) =>
    [...ownBound].some(
      (bound) => samePath(bound, target, rules) || isStrictlyInside(target, bound, rules),
    ) ||
    [...registered].some(
      (known) => samePath(known, target, rules) || isStrictlyInside(target, known, rules),
    ) ||
    ownProjectRoots.some((projectRoot) => overlaps(projectRoot, target, rules));
  /**
   * Why a folder outside the worktrees (temp, runtime) must stay because something uses it: a
   * thread can be launched into any existing folder. Null when nothing does.
   */
  const usedBy = (target: string) => {
    if (ownRows === null)
      return state("needs_attention", "This server's threads could not be read");
    if (referenced(target)) return state("protected", "A thread or project on this server uses it");
    const otherReason = otherServerReason(other, target, rules);
    if (otherReason !== null)
      return state(
        other.bindings.unverified.length > 0 ? "needs_attention" : "protected",
        sentenceCase(otherReason),
      );
    const working = processInside(cwds, [target], rules);
    if (working === null) return state("needs_attention", "Running processes could not be listed");
    if (working) return state("protected", "A process is running in it");
    return null;
  };

  /**
   * Why a GOAT folder of files (logs, attachments) must be left alone: a thread of any local server
   * works in it or inside it, or a process does. Projects that merely contain it do not count.
   */
  const workedIn = (folder: string) => {
    if (ownRows === null)
      return state("needs_attention", "This server's threads could not be read");
    const within = (bound: string) =>
      samePath(bound, folder, rules) || isStrictlyInside(folder, bound, rules);
    if ([...ownBound].some(within) || other.bound.some(within))
      return state("protected", "A thread works in this folder");
    if (other.bindings.unverified.length > 0)
      return state(
        "needs_attention",
        "Not every GOAT server on this machine could be checked: " + other.bindings.unverified[0],
      );
    const working = processInside(cwds, [folder], rules);
    if (working === null) return state("needs_attention", "Running processes could not be listed");
    if (working) return state("protected", "A process is running in this folder");
    return null;
  };

  // Leftover folders: <root>/<name> or <root>/<repository>/<name>, as worktrees are laid out.
  if (facts._tag === "Success" && ownRows !== null) {
    const known = [...ownBound, ...registered];
    for (const managedRoot of managedRoots) {
      // A worktrees folder set inside a repository: its folders are that repository's work.
      if ((yield* withinCheckout(managedRoot)) !== false) continue;
      for (const first of yield* childDirectories(managedRoot)) {
        // <root>/<name> is a checkout itself, or a repository's folder of checkouts.
        if (known.some((value) => samePath(value, first.path, rules))) continue;
        const candidates = (yield* hasGitEntry(first.path))
          ? [first]
          : yield* childDirectories(first.path);
        for (const candidate of candidates) {
          if (referenced(candidate.path)) continue;
          // A worktrees folder set to a GOAT home holds GOAT's own data beside checkouts.
          if (goatDataReason(candidate.path, goat, rules) !== null) continue;
          // Another worktrees folder nested in this one is scanned as its own root.
          if (
            managedRoots.some(
              (root) =>
                isStrictlyInside(managedRoot, root, rules) && overlaps(root, candidate.path, rules),
            )
          )
            continue;
          if (now - candidate.stat.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
          const otherReason = otherServerReason(other, candidate.path, rules);
          const working = processInside(cwds, [candidate.path], rules);
          const git = yield* hasGitEntry(candidate.path);
          const offered = git
            ? state(
                "needs_attention",
                "A git checkout no repository lists any more; check it for work before deleting it yourself",
              )
            : otherReason !== null
              ? state(
                  other.bindings.unverified.length > 0 ? "needs_attention" : "protected",
                  sentenceCase(otherReason),
                )
              : working !== false
                ? state(
                    working === null ? "needs_attention" : "protected",
                    working === null
                      ? "Running processes could not be listed"
                      : "A process is running in it",
                  )
                : state(
                    "removable",
                    "Not a git checkout, and no thread on this machine references it; check it holds nothing you need",
                  );
          const { decision, token, stamp } = yield* stamped(
            "orphan_folder:" + candidate.path,
            candidate.path,
            ORPHAN_MIN_AGE_MS,
            offered,
          );
          add(
            {
              kind: "orphan_folder",
              path: candidate.path,
              label: path.relative(managedRoot, candidate.path),
              ...decision,
            },
            {
              kind: "path",
              root: managedRoot,
              identity: candidate.stat.identity,
              worktree: null,
              stamp,
            },
            [candidate.stat.identity.dev, candidate.stat.identity.ino, ...token],
          );
          measureLater(
            "orphan_folder:" + candidate.path,
            candidate.path,
            decision.state === "removable" ? 1 : 3,
          );
        }
      }
    }
  }

  // Runtimes this GOAT home installed for its service or SSH launches.
  const runtimes = yield* listPinnedRuntimes({
    baseDir: config.baseDir,
    keep: [packageJson.version],
  }).pipe(Effect.orElseSucceed(() => ({ decided: false, runtimes: [] })));
  const previous = runtimes.runtimes
    .filter((runtime) => runtime.version !== packageJson.version)
    .toSorted((left, right) => right.completedAt - left.completedAt)[0];
  /** Whether a folder holds a GOAT home or GOAT data below it, such as another server's home. */
  const holdsOtherGoatData = (target: string) =>
    [...goat.data, ...goat.homes].some((inner) => isStrictlyInside(target, inner, rules));
  for (const runtime of runtimes.runtimes) {
    const realRuntime = yield* real(runtime.directory);
    // Removal renames the folder aside, so a leftover of an earlier removal or a link inside the
    // home (which could lead outside it) keeps it from being offered.
    const linked = !(yield* reachedWithoutLinks(config.baseDir, runtime.directory));
    const blocked = yield* fs
      .exists(
        path.join(path.dirname(runtime.directory), PINNED_RUNTIME_PRUNED_PREFIX + runtime.version),
      )
      .pipe(Effect.orElseSucceed(() => true));
    const decision =
      runtime.version === packageJson.version
        ? state("protected", "The version this server runs")
        : runtime.version === previous?.version
          ? state("protected", "The previous version, kept to roll back to")
          : !runtimes.decided
            ? state("needs_attention", "Whether it is in use could not be checked")
            : !runtime.unused
              ? state("protected", "The service, a running process or a launcher uses it")
              : linked
                ? state("needs_attention", "It is reached through a link inside the GOAT home")
                : blocked
                  ? state(
                      "needs_attention",
                      "An earlier removal of this version left a folder behind; check it yourself",
                    )
                  : (usedBy(runtime.directory) ??
                    usedBy(realRuntime) ??
                    (holdsOtherGoatData(realRuntime)
                      ? state("protected", "It holds another GOAT server's home or data")
                      : null) ??
                    ((yield* holdsGitCheckout(realRuntime)) !== false
                      ? state(
                          "needs_attention",
                          "It holds a git checkout; check it for work before deleting it yourself",
                        )
                      : null) ??
                    ((yield* withinCheckout(path.dirname(runtime.directory))) !== false
                      ? state(
                          "needs_attention",
                          "It sits in a git checkout, which may track its files",
                        )
                      : null) ??
                    state("removable", "No service, process, launcher or thread uses it", true));
    add(
      {
        kind: "runtime_version",
        path: runtime.directory,
        label: "GOAT " + runtime.version,
        ...decision,
      },
      { kind: "runtime", version: runtime.version },
      [runtime.version, runtime.completedAt],
    );
    measureLater(
      "runtime_version:" + runtime.directory,
      runtime.directory,
      decision.state === "removable" ? 1 : 3,
    );
  }

  /** A GOAT folder in a git checkout (a home inside a repository) may hold that checkout's work. */
  const inCheckout = Effect.fn("storageScan.inCheckout")(function* (folder: string) {
    const around = yield* withinCheckout(folder);
    if (around === false) return null;
    return state(
      "needs_attention",
      around === null
        ? "Its folder could not be checked for a git checkout"
        : "Its folder is in a git checkout, which may track these files",
    );
  });

  // Rotated logs past this server's retention.
  const logsAfterDays = settings?.storageCleanup.logsAfterDays ?? null;
  const rotated = yield* rotatedLogFiles(config.logsDir);
  if (rotated.length > 0) {
    const expired =
      logsAfterDays === null
        ? []
        : rotated.filter((file) => file.mtimeMs < now - logsAfterDays * 86_400_000);
    if (logsAfterDays === null)
      add(
        {
          kind: "rotated_logs",
          path: config.logsDir,
          label: rotated.length + " rotated log files",
          ...state(
            "report_only",
            "Log retention is off in Settings > Storage, so none are past it",
          ),
          bytes: rotated.reduce((sum, file) => sum + file.size, 0),
        },
        { kind: "none" },
        [],
      );
    else if (expired.length > 0)
      add(
        {
          kind: "rotated_logs",
          path: config.logsDir,
          label: expired.length + " rotated log files",
          ...(workedIn(config.logsDir) ??
            (yield* inCheckout(config.logsDir)) ??
            state("removable", "Older than the " + logsAfterDays + " days logs are kept", true)),
          bytes: expired.reduce((sum, file) => sum + file.size, 0),
        },
        {
          kind: "files",
          root: config.logsDir,
          files: expired.map(({ path: file, identity }) => ({ path: file, identity })),
        },
        expired.map((file) => file.path + ":" + file.identity.ino).toSorted(),
      );
  }

  // Temp folders a crashed one-shot operation left.
  const tempRoot = yield* real(env.TMPDIR?.trim() || NodeOS.tmpdir());
  const uid = yield* HostProcess.UserId;
  for (const name of yield* fs.readDirectory(tempRoot).pipe(Effect.orElseSucceed(() => []))) {
    if (!isRemovableTempName(name)) continue;
    const target = path.join(tempRoot, name);
    const stat = yield* lstatOf(target);
    if (
      stat === null ||
      !stat.isDirectory ||
      stat.isLink ||
      (uid !== undefined && stat.uid !== uid)
    )
      continue;
    if (now - stat.mtimeMs < TEMP_MIN_AGE_MS) continue;
    if (goatDataReason(target, goat, rules) !== null) continue;
    const { decision, token, stamp } = yield* stamped(
      "temp:" + target,
      target,
      TEMP_MIN_AGE_MS,
      usedBy(target) ?? state("removable", "A temporary folder GOAT left more than a day ago"),
    );
    add(
      {
        kind: "temp",
        path: target,
        label: name,
        ...decision,
      },
      { kind: "path", root: tempRoot, identity: stat.identity, worktree: null, stamp },
      [stat.identity.dev, stat.identity.ino, ...token],
    );
    measureLater("temp:" + target, target, 2);
  }

  // Files deleted threads left behind. Nothing surviving may still point at them.
  if (ownRows !== null) {
    const leftovers = yield* deletedThreadAttachments({
      attachmentsDir: config.attachmentsDir,
      threads: ownRows,
      now,
    });
    const kept =
      leftovers.kept.count === 0
        ? ""
        : "; " +
          leftovers.kept.count +
          " more stay because a surviving thread or task mentions their thread, or they are under a day old";
    if (leftovers.removable.length > 0)
      add(
        {
          kind: "attachments",
          path: config.attachmentsDir,
          label: leftovers.removable.length + " files of deleted threads",
          ...(workedIn(config.attachmentsDir) ??
            (yield* inCheckout(config.attachmentsDir)) ??
            state("removable", "No surviving thread or task mentions their threads" + kept)),
          bytes: leftovers.removable.reduce((sum, file) => sum + file.size, 0),
        },
        {
          kind: "files",
          root: config.attachmentsDir,
          files: leftovers.removable.map(({ path: file, identity }) => ({ path: file, identity })),
        },
        leftovers.removable.map((file) => file.path + ":" + file.identity.ino).toSorted(),
      );
    else if (leftovers.kept.count > 0)
      add(
        {
          kind: "attachments",
          path: config.attachmentsDir,
          label: leftovers.kept.count + " files of deleted threads",
          ...state(
            "report_only",
            "A surviving thread or task mentions their threads, or they are under a day old",
          ),
          bytes: leftovers.kept.bytes,
        },
        { kind: "none" },
        [],
      );
  }

  // kache's cache, which kache keeps under its own size limit.
  const kache = kacheCacheDirectory({ platform, home, env, join: path.join });
  if (kache !== null && (yield* fs.exists(kache).pipe(Effect.orElseSucceed(() => false)))) {
    add(
      {
        kind: "kache",
        path: kache,
        label: "kache build cache",
        ...state(
          "report_only",
          "kache keeps its cache under its own size limit; run kache clean to trim it",
        ),
      },
      { kind: "none" },
      [],
    );
    measureLater("kache:" + kache, kache, 2);
  }

  if (options.measure) {
    const deadline = now + Duration.toMillis(MEASURE_BUDGET);
    let unmeasured = 0;
    const sizes = new Map<string, number | null>();
    yield* Effect.forEach(
      measured.toSorted((left, right) => left.priority - right.priority),
      (entry) =>
        Effect.gen(function* () {
          const remaining = deadline - (yield* Clock.currentTimeMillis);
          const cached = options.sizes.get(entry.path);
          if (remaining <= 0) {
            if (cached === undefined) unmeasured += 1;
            sizes.set(entry.id, cached?.bytes ?? null);
            return;
          }
          const bytes = yield* measureFolder(entry.path, Duration.millis(remaining));
          if (bytes !== null) options.sizes.set(entry.path, { bytes, at: now });
          else if (cached === undefined) unmeasured += 1;
          sizes.set(entry.id, bytes ?? cached?.bytes ?? null);
        }),
      { concurrency: MEASURE_CONCURRENCY, discard: true },
    );
    if (unmeasured > 0)
      notes.push(
        unmeasured +
          (unmeasured === 1 ? " folder was" : " folders were") +
          " not measured in time; scan again to measure more.",
      );
    for (const [index, item] of items.entries())
      if (sizes.has(item.id)) items[index] = { ...item, bytes: sizes.get(item.id) ?? null };
    // A worktree's total includes its build outputs; say how much of it they are.
    for (const [index, item] of items.entries()) {
      if (item.kind !== "worktree") continue;
      const outputs = items.filter(
        (other) => other.kind === "build_output" && isStrictlyInside(item.path, other.path, rules),
      );
      const parts = outputs.flatMap((output) =>
        output.bytes === null ? [] : [path.basename(output.path) + " " + formatGiB(output.bytes)],
      );
      if (parts.length > 0) items[index] = { ...item, detail: parts.join(", ") };
    }
  }

  const disk = yield* resources.read.pipe(
    Effect.map((snapshot) => snapshot.disk),
    Effect.orElseSucceed(() => null),
  );
  return {
    scannedAt: now,
    disk,
    items,
    targets,
    notes,
  } satisfies StorageScan;
});

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const formatGiB = (bytes: number) => (bytes / 1024 ** 3).toFixed(1) + " GiB";

const childDirectories = Effect.fn("storageScan.childDirectories")(function* (parent: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const result: Array<{ readonly path: string; readonly stat: Lstat }> = [];
  for (const name of yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => []))) {
    const child = path.join(parent, name);
    const stat = yield* lstatOf(child);
    if (stat !== null && stat.isDirectory && !stat.isLink) result.push({ path: child, stat });
  }
  return result;
});

const hasGitEntry = Effect.fn("storageScan.hasGitEntry")(function* (folder: string) {
  const path = yield* Path.Path;
  return (yield* lstatOf(path.join(folder, ".git"))) !== null;
});

const rotatedLogFiles = Effect.fn("storageScan.rotatedLogFiles")(function* (logsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<{
    readonly path: string;
    readonly identity: FileIdentity;
    readonly size: number;
    readonly mtimeMs: number;
  }> = [];
  const pending: Array<{ readonly folder: string; readonly depth: number }> = [
    { folder: logsDir, depth: 0 },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { folder, depth } = next;
    const names = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
    // A checkout's files are its work, whatever their names say.
    if (names.some((name) => name.toLowerCase() === ".git")) continue;
    for (const name of names) {
      const target = path.join(folder, name);
      const stat = yield* lstatOf(target);
      if (stat === null || stat.isLink) continue;
      if (stat.isDirectory && depth < 3) pending.push({ folder: target, depth: depth + 1 });
      else if (stat.isFile && isRotatedLogName(name))
        files.push({
          path: target,
          identity: stat.identity,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
    }
  }
  return files;
});

/** The wire report: everything but the server-side targets. */
export const toReport = (scan: StorageScan, durationMs: number) => ({
  scannedAt: DateTime.formatIso(DateTime.makeUnsafe(scan.scannedAt)),
  durationMs: Math.max(0, Math.round(durationMs)),
  disk: scan.disk,
  items: scan.items,
  notes: scan.notes,
});
