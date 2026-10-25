// @effect-diagnostics nodeBuiltinImport:off -- lstat with bigint dev/ino identifies what a person reviewed.
import * as NodeFSP from "node:fs/promises";
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
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import { listPinnedRuntimes } from "../cloud/pinnedRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as WorktreeInventory from "../mcp/WorktreeInventoryService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "../worktreesDirectory.ts";
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

export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** What a cleanup acts on for one item, kept on the server beside the item it offered. */
export type StorageTarget =
  | { readonly kind: "worktree"; readonly head: string | null; readonly branch: string | null }
  | {
      readonly kind: "path";
      readonly root: string;
      readonly identity: FileIdentity;
      /** Build outputs: the worktree whose lease and liveness guard them. */
      readonly worktree: string | null;
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

interface Lstat {
  readonly identity: FileIdentity;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isLink: boolean;
  readonly mtimeMs: number;
  readonly size: number;
  readonly uid: number;
}

export const lstatOf = (target: string) =>
  Effect.tryPromise(() => NodeFSP.lstat(target, { bigint: true })).pipe(
    Effect.map((stat): Lstat => ({
      identity: { dev: stat.dev, ino: stat.ino },
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      isLink: stat.isSymbolicLink(),
      mtimeMs: Number(stat.mtimeMs),
      size: Number(stat.size),
      uid: Number(stat.uid),
    })),
    Effect.orElseSucceed(() => null),
  );

export const sameIdentity = (left: FileIdentity, right: FileIdentity) =>
  left.dev === right.dev && left.ino === right.ino;

/** Leftover folders younger than this may be a checkout GOAT is still creating. */
const ORPHAN_MIN_AGE_MS = 60 * 60_000;
/** Total time the scan spends measuring folders; later scans measure what this one could not. */
const MEASURE_BUDGET = Duration.seconds(120);
const MEASURE_CONCURRENCY = 6;
/** How deep build outputs are looked for inside a worktree. */
const BUILD_OUTPUT_DEPTH = 3;
const SKIPPED_WHEN_SEARCHING = new Set([".git", "node_modules", "target", ".goat", ".t3"]);

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

  const other = yield* resolveOtherServerPaths(config.dbPath);
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
    const otherReason = otherServerReason(other, entry.path, rules);
    const working = processInside(cwds, [entry.path], rules);
    const decision =
      blocker !== null
        ? state(live || fact.holdsProject ? "protected" : "needs_attention", sentenceCase(blocker))
        : otherReason !== null
          ? state(
              other.bindings.unverified.length > 0 ? "needs_attention" : "protected",
              sentenceCase(otherReason),
            )
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
    const busy = entry.threads.some((thread) => thread.busy);
    for (const output of yield* findBuildOutputs(entry.path)) {
      const stat = yield* lstatOf(output);
      if (stat === null || !stat.isDirectory || stat.isLink) continue;
      const outputDecision = busy
        ? state("protected", "A thread is running in this worktree")
        : otherReason !== null
          ? state(
              other.bindings.unverified.length > 0 ? "needs_attention" : "protected",
              sentenceCase(otherReason),
            )
          : working === null
            ? state("needs_attention", "Running processes could not be listed")
            : working
              ? state("protected", "A process is running in this worktree")
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
        { kind: "path", root: entry.path, identity: stat.identity, worktree: entry.path },
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

  // Leftover folders: <root>/<name> or <root>/<repository>/<name>, as worktrees are laid out.
  if (facts._tag === "Success" && ownRows !== null) {
    const referenced = (target: string) =>
      [...ownBound].some(
        (bound) => samePath(bound, target, rules) || isStrictlyInside(target, bound, rules),
      ) ||
      [...registered].some(
        (known) => samePath(known, target, rules) || isStrictlyInside(target, known, rules),
      ) ||
      ownProjectRoots.some((projectRoot) => overlaps(projectRoot, target, rules));
    const known = [...ownBound, ...registered];
    for (const managedRoot of managedRoots) {
      for (const first of yield* childDirectories(managedRoot)) {
        // <root>/<name> is a checkout itself, or a repository's folder of checkouts.
        if (known.some((value) => samePath(value, first.path, rules))) continue;
        const candidates = (yield* hasGitEntry(first.path))
          ? [first]
          : yield* childDirectories(first.path);
        for (const candidate of candidates) {
          if (referenced(candidate.path)) continue;
          if (now - candidate.stat.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
          const otherReason = otherServerReason(other, candidate.path, rules);
          const working = processInside(cwds, [candidate.path], rules);
          const git = yield* hasGitEntry(candidate.path);
          const decision = git
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
          add(
            {
              kind: "orphan_folder",
              path: candidate.path,
              label: path.relative(managedRoot, candidate.path),
              ...decision,
            },
            { kind: "path", root: managedRoot, identity: candidate.stat.identity, worktree: null },
            [candidate.stat.identity.dev, candidate.stat.identity.ino],
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
  for (const runtime of runtimes.runtimes) {
    const decision =
      runtime.version === packageJson.version
        ? state("protected", "The version this server runs")
        : runtime.version === previous?.version
          ? state("protected", "The previous version, kept to roll back to")
          : !runtimes.decided
            ? state("needs_attention", "Whether it is in use could not be checked")
            : runtime.unused
              ? state("removable", "No service, process or launcher uses it", true)
              : state("protected", "The service, a running process or a launcher uses it");
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
          ...state("removable", "Older than the " + logsAfterDays + " days logs are kept", true),
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
    add(
      {
        kind: "temp",
        path: target,
        label: name,
        ...state("removable", "A temporary folder GOAT left more than a day ago"),
      },
      { kind: "path", root: tempRoot, identity: stat.identity, worktree: null },
      [stat.identity.dev, stat.identity.ino],
    );
    measureLater("temp:" + target, target, 2);
  }

  // Attachments of deleted threads: report only, since deleting a thread already removes them.
  if (ownRows !== null) {
    const live = new Set<string>();
    const deleted = new Set<string>();
    for (const row of ownRows) {
      const segment = toSafeThreadAttachmentSegment(row.id);
      if (segment !== null) (row.deleted === null ? live : deleted).add(segment);
    }
    let bytes = 0;
    let count = 0;
    for (const name of yield* fs
      .readDirectory(config.attachmentsDir)
      .pipe(Effect.orElseSucceed(() => []))) {
      const segment = parseThreadSegmentFromAttachmentId(
        name.slice(0, name.length - path.extname(name).length),
      );
      if (segment === null || live.has(segment) || !deleted.has(segment)) continue;
      const stat = yield* lstatOf(path.join(config.attachmentsDir, name));
      if (stat === null || !stat.isFile) continue;
      bytes += stat.size;
      count += 1;
    }
    if (count > 0)
      add(
        {
          kind: "attachments",
          path: config.attachmentsDir,
          label: count + " files of deleted threads",
          ...state("report_only", "Deleting a thread removes its files; these stayed behind"),
          bytes,
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

/** node_modules folders and Rust target/ folders next to a Cargo.toml, a few levels deep. */
const findBuildOutputs = Effect.fn("storageScan.findBuildOutputs")(function* (worktree: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outputs: Array<string> = [];
  const pending: Array<{ readonly folder: string; readonly depth: number }> = [
    { folder: worktree, depth: 0 },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { folder, depth } = next;
    const names = yield* fs
      .readDirectory(folder)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    if (names.includes("node_modules")) outputs.push(path.join(folder, "node_modules"));
    if (names.includes("target") && names.includes("Cargo.toml"))
      outputs.push(path.join(folder, "target"));
    if (depth >= BUILD_OUTPUT_DEPTH) continue;
    for (const name of names) {
      if (SKIPPED_WHEN_SEARCHING.has(name) || name.startsWith(".")) continue;
      const child = path.join(folder, name);
      const stat = yield* lstatOf(child);
      if (stat !== null && stat.isDirectory && !stat.isLink)
        pending.push({ folder: child, depth: depth + 1 });
    }
  }
  return outputs;
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
    for (const name of yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []))) {
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
