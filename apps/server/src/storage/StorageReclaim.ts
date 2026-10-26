// @effect-diagnostics nodeBuiltinImport:off -- realpath, rm and an append-only deletion log.
import * as NodeFSP from "node:fs/promises";

import {
  ProviderSessionId,
  StorageReclaimError,
  type StorageCleanItem,
  type StorageCleanOutcome,
  type StorageCleanResult,
  type StorageItem,
  type StorageUsageReport,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../package.json" with { type: "json" };
import { removeUnusedPinnedRuntime } from "../cloud/pinnedRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as WorktreeInventory from "../mcp/WorktreeInventoryService.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadHistoryArchive from "../orchestration-v2/ThreadHistoryArchive.ts";
import { tryWithWorkspaceSubtree, withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { buildOutputKeeps, maskedIndexEntry } from "./buildOutputs.ts";
import { deletedThreadAttachments } from "./deletedThreadAttachments.ts";
import { goatDataReason, resolveGoatDataPaths } from "./goatData.ts";
import { LocalGoatServers } from "./localGoatServers.ts";
import {
  type ContentStamp,
  contentStamp,
  type FileIdentity,
  holdsGitCheckout,
  insideCheckout,
  lstatOf,
  sameIdentity,
  withinCheckout,
} from "./fileState.ts";
import {
  otherServerReason,
  processInside,
  resolveOtherServerPaths,
  scanStorage,
  type StorageScan,
  type StorageTarget,
  toReport,
} from "./storageScan.ts";
import { isStrictlyInside, overlaps, pathRules, samePath } from "./storagePaths.ts";

/**
 * GOAT's own disk usage on this machine and the cleanup a person confirms (docs/user, Storage).
 * A cleanup takes item ids and identity tokens from a scan the person saw, scans again, and
 * deletes only items that are still removable with the same identity, checking each again right
 * before it goes. Every deletion is written to storage-cleanup.ndjson in the logs folder first.
 *
 * Threat model: this guards against mistakes, stale previews, links planted inside GOAT's folders
 * and other GOAT servers' work. A process of the same user racing the cleanup on purpose can
 * delete those files itself and is out of scope. GOAT servers share no lock, so writes another
 * server makes to a checkout after the final check and before removal completes are not covered.
 *
 * @module StorageReclaim
 */
export class StorageReclaim extends Context.Service<
  StorageReclaim,
  {
    /** The cached scan when it is recent, otherwise a new one. */
    readonly usage: (input: {
      readonly rescan: boolean;
    }) => Effect.Effect<StorageUsageReport, StorageReclaimError>;
    readonly clean: (input: {
      readonly items: ReadonlyArray<StorageCleanItem>;
      /** Who asked, for the log: a client session or a thread. */
      readonly actor: string;
    }) => Effect.Effect<StorageCleanResult, StorageReclaimError>;
  }
>()("goat/storage/StorageReclaim") {}

/** A scan this recent answers usage without scanning again. */
const FRESH_MS = 5 * 60_000;

const make = Effect.gen(function* () {
  const context = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | ServerConfig.ServerConfig
    | ServerSettings.ServerSettingsService
    | WorktreeInventory.WorktreeInventoryService
    | HostResources.HostResources
    | SqlClient.SqlClient
    | ProcessRunner.ProcessRunner
    | ProviderSessionManager.ProviderSessionManagerV2
    | GitVcsDriver.GitVcsDriver
    | LocalGoatServers
    | ThreadHistoryArchive.ThreadHistoryArchive
  >();
  const config = yield* ServerConfig.ServerConfig;
  const worktrees = yield* WorktreeInventory.WorktreeInventoryService;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const rules = pathRules(yield* HostProcess.Platform, path.sep);
  const logPath = path.join(config.logsDir, "storage-cleanup.ndjson");
  const latest = yield* Ref.make<{
    readonly scan: StorageScan;
    readonly durationMs: number;
  } | null>(null);
  const sizes = new Map<string, { readonly bytes: number; readonly at: number }>();
  const lock = yield* Semaphore.make(1);

  /** stampOnly: the items being cleaned, the only folders whose contents need re-reading. */
  const scanNow = Effect.fn("StorageReclaim.scan")(function* (
    measure: boolean,
    stampOnly?: ReadonlySet<string>,
  ) {
    const startedAt = yield* Clock.currentTimeMillis;
    const scan = yield* scanStorage({ measure, sizes, ...(stampOnly ? { stampOnly } : {}) });
    const durationMs = (yield* Clock.currentTimeMillis) - startedAt;
    if (measure) yield* Ref.set(latest, { scan, durationMs });
    return { scan, durationMs };
  }, Effect.provideContext(context));

  const usage: StorageReclaim["Service"]["usage"] = Effect.fn("StorageReclaim.usage")(
    function* (input) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const cached = yield* Ref.get(latest);
          const now = yield* Clock.currentTimeMillis;
          const current =
            !input.rescan && cached !== null && now - cached.scan.scannedAt < FRESH_MS
              ? cached
              : yield* scanNow(true);
          return toReport(current.scan, current.durationMs);
        }),
      );
    },
  );

  const real = (target: string) =>
    Effect.tryPromise(() => NodeFSP.realpath(target)).pipe(Effect.orElseSucceed(() => null));

  /** One line per intent and outcome; a deletion whose intent cannot be written does not run. */
  const log = Effect.fn("StorageReclaim.log")(function* (
    entry: Omit<typeof StorageLogLine.Type, "at">,
  ) {
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.tryPromise(() => NodeFSP.mkdir(config.logsDir, { recursive: true }));
    yield* Effect.tryPromise(() =>
      NodeFSP.appendFile(logPath, encodeLogLine({ at, ...entry }) + "\n", "utf8"),
    );
  });

  /**
   * Deletes target only while it is still the reviewed folder or file, not a link, with no link in
   * its path, strictly inside root. Node's rm never follows links inside the tree it removes.
   */
  const removeChecked = Effect.fn("StorageReclaim.removeChecked")(function* (
    root: string,
    target: string,
    identity: FileIdentity,
  ) {
    const stat = yield* lstatOf(target);
    if (stat === null) return "it is already gone";
    if (stat.isLink) return "it is a link";
    if (!sameIdentity(stat.identity, identity)) return "it changed since it was reviewed";
    const realRoot = yield* real(root);
    const realTarget = yield* real(target);
    if (realRoot === null || realTarget === null) return "its location could not be resolved";
    if (!samePath(realTarget, path.resolve(target), rules)) return "a link sits in its path";
    if (!isStrictlyInside(realRoot, realTarget, rules)) return "it is outside " + root;
    yield* Effect.tryPromise({
      try: () => NodeFSP.rm(target, { recursive: true, force: false }),
      catch: (cause) =>
        new RemoveFailed({ message: cause instanceof Error ? cause.message : String(cause) }),
    });
    return null;
  });

  /** Why a checkout or its build outputs must stay right now; null when nothing uses it. */
  const inUse = Effect.fn("StorageReclaim.inUse")(function* (folder: string) {
    const other = yield* resolveOtherServerPaths(config.dbPath);
    const realFolder = (yield* real(folder)) ?? folder;
    // Another server may record the folder where it really is, not where it was added.
    const otherReason =
      otherServerReason(other, folder, rules) ?? otherServerReason(other, realFolder, rules);
    if (otherReason !== null) return otherReason;
    const working = processInside(
      yield* (yield* LocalGoatServers).workingDirectories,
      [folder, realFolder],
      rules,
    );
    if (working === null) return "running processes could not be listed";
    if (working) return "a process is running in it";
    const open = yield* sql<{ readonly id: string | null; readonly cwd: string | null }>`
        SELECT json_extract(payload_json, '$.id') AS "id", json_extract(payload_json, '$.cwd') AS "cwd"
        FROM orchestration_v2_projection_provider_sessions WHERE status != 'stopped'
      `.pipe(
      NodeSqliteClient.readOnly,
      Effect.orElseSucceed(() => null),
    );
    if (open === null) return "provider sessions could not be read";
    for (const session of open) {
      if (session.id === null || session.cwd === null) continue;
      const cwd = path.resolve(session.cwd);
      if (
        (samePath(cwd, folder, rules) || isStrictlyInside(folder, cwd, rules)) &&
        (yield* sessions.isLive(ProviderSessionId.make(session.id)))
      )
        return "a provider session is still open in it";
    }
    const pending = yield* sql<{ readonly one: number }>`
        SELECT 1 AS "one" FROM orchestration_v2_effect_outbox AS effect
        JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = effect.thread_id
        WHERE effect.status NOT IN ('succeeded', 'cancelled')
          AND json_extract(thread.payload_json, '$.worktreePath') = ${folder}
        LIMIT 1
      `.pipe(
      NodeSqliteClient.readOnly,
      Effect.orElseSucceed(() => null),
    );
    if (pending === null) return "pending thread work could not be read";
    if (pending.length > 0) return "a thread that used it still has work queued";
    return null;
  }, Effect.provideContext(context));

  /**
   * Why a reviewed leftover or temp folder must stay because its contents differ from what the
   * person approved, read again right before removal: entries, newest change, or a checkout inside.
   */
  const changedSinceReview = Effect.fn("StorageReclaim.changedSinceReview")(function* (
    folder: string,
    reviewed: ContentStamp | null,
  ) {
    if (reviewed === null) return "it was not checked for changes";
    const current = yield* contentStamp(folder);
    if (current === null) return "it could not be read again";
    if (current.holdsGit) return "it holds a git checkout now";
    if (current.entries !== reviewed.entries || current.newestChangeNs !== reviewed.newestChangeNs)
      return "it changed since it was reviewed";
    return null;
  });

  /**
   * Why GOAT's folder of files (logs, attachments) must be left alone now: a thread of any local
   * server works in it or inside it, or a process does.
   */
  const workedInNow = Effect.fn("StorageReclaim.workedInNow")(function* (folder: string) {
    const threads = yield* sql<{ readonly path: string | null }>`
      SELECT json_extract(payload_json, '$.worktreePath') AS "path"
      FROM orchestration_v2_projection_threads
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.orElseSucceed(() => null),
    );
    if (threads === null) return "this server's threads could not be read";
    const other = yield* resolveOtherServerPaths(config.dbPath);
    if (other.bindings.unverified.length > 0)
      return (
        "not every GOAT server on this machine could be checked: " + other.bindings.unverified[0]
      );
    const folders = [path.resolve(folder), (yield* real(folder)) ?? path.resolve(folder)];
    const within = (bound: string) =>
      folders.some((each) => samePath(bound, each, rules) || isStrictlyInside(each, bound, rules));
    for (const row of threads) {
      if (row.path === null) continue;
      if (
        within(path.resolve(row.path)) ||
        within((yield* real(row.path)) ?? path.resolve(row.path))
      )
        return "a thread works in this folder";
    }
    if (other.bound.some(within)) return "a thread of another GOAT server works in this folder";
    const working = processInside(
      yield* (yield* LocalGoatServers).workingDirectories,
      folders,
      rules,
    );
    if (working === null) return "running processes could not be listed";
    if (working) return "a process is running in this folder";
    return null;
  });

  /** Whether a GOAT home or GOAT data lies below folder, read now (another server's home in it). */
  const holdsGoatDataBelow = Effect.fn("StorageReclaim.holdsGoatDataBelow")(function* (
    folder: string,
  ) {
    const goat = yield* resolveGoatDataPaths(
      (yield* resolveOtherServerPaths(config.dbPath)).bindings.databases,
    );
    const folders = [path.resolve(folder), (yield* real(folder)) ?? path.resolve(folder)];
    return [...goat.data, ...goat.homes].some((inner) =>
      folders.some((each) => isStrictlyInside(each, inner, rules)),
    );
  }, Effect.provideContext(context));

  /** Why removing folder would reach GOAT's own data or a GOAT home, read now; null when not. */
  const goatDataNow = Effect.fn("StorageReclaim.goatDataNow")(function* (folder: string) {
    const goat = yield* resolveGoatDataPaths(
      (yield* resolveOtherServerPaths(config.dbPath)).bindings.databases,
    );
    const realFolder = (yield* real(folder)) ?? path.resolve(folder);
    return (
      goatDataReason(path.resolve(folder), goat, rules) ?? goatDataReason(realFolder, goat, rules)
    );
  }, Effect.provideContext(context));

  /**
   * Runs a removal holding the folder whole, so no lease on it or inside it goes to anyone else
   * meanwhile; skipped when something on this server already works inside it.
   */
  const holdingWhole = <E, R>(folder: string, effect: Effect.Effect<string | null, E, R>) =>
    tryWithWorkspaceSubtree(path.resolve(folder), effect).pipe(
      Effect.map(Option.getOrElse(() => "something on this server is working inside it")),
    );

  /**
   * Why this server now uses a leftover folder: a thread bound to it or inside it since the scan,
   * deleted and archived ones included, or a project folder overlapping it. Null when none does.
   */
  const ownReference = Effect.fn("StorageReclaim.ownReference")(function* (folder: string) {
    const threads = yield* sql<{ readonly path: string | null }>`
      SELECT json_extract(payload_json, '$.worktreePath') AS "path"
      FROM orchestration_v2_projection_threads
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.orElseSucceed(() => null),
    );
    const projects = yield* sql<{ readonly root: string }>`
      SELECT workspace_root AS "root" FROM projection_projects WHERE deleted_at IS NULL
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.orElseSucceed(() => null),
    );
    if (threads === null || projects === null) return "this server's threads could not be read";
    const targets = [path.resolve(folder), (yield* real(folder)) ?? path.resolve(folder)];
    for (const row of threads) {
      if (row.path === null) continue;
      const bound = [path.resolve(row.path), (yield* real(row.path)) ?? path.resolve(row.path)];
      if (
        targets.some((target) =>
          bound.some(
            (value) => samePath(value, target, rules) || isStrictlyInside(target, value, rules),
          ),
        )
      )
        return "a thread on this server uses it now";
    }
    for (const row of projects) {
      const root = (yield* real(row.root)) ?? path.resolve(row.root);
      if (targets.some((target) => overlaps(root, target, rules)))
        return "it overlaps a project folder on this server";
    }
    return null;
  });

  /** Why a folder's contents may be a repository's work: a checkout holds it from above. */
  const aroundCheckout = Effect.fn("StorageReclaim.aroundCheckout")(function* (folder: string) {
    const around = yield* withinCheckout(path.dirname(folder));
    if (around === false) return null;
    return around === null
      ? "the folders above it could not be checked for a git checkout"
      : "it sits in a git checkout, which may track its files";
  });

  const act = Effect.fn("StorageReclaim.act")(function* (
    item: StorageItem,
    target: StorageTarget,
    actor: string,
  ) {
    switch (target.kind) {
      case "worktree": {
        // Under the worktree's leases, right before git removes it: what git status cannot see.
        const verify = Effect.gen(function* () {
          const goat = yield* goatDataNow(item.path);
          if (goat !== null) return goat;
          const reason = yield* inUse(item.path);
          if (reason !== null) return reason;
          const masked = yield* maskedIndexEntry(item.path);
          if (masked !== null) return masked;
          const nested = yield* holdsGitCheckout(item.path, { skipOwn: true });
          if (nested !== false)
            return nested === null
              ? "it could not be searched for git checkouts inside it"
              : "it holds another git checkout, whose work its own git status cannot see";
          return yield* aroundCheckout(item.path);
        }).pipe(Effect.provideContext(context));
        return yield* holdingWhole(
          item.path,
          worktrees
            .removeAbandoned({
              path: item.path,
              head: target.head,
              branch: target.branch,
              verify,
            })
            .pipe(
              Effect.map((result) => (result.removed ? null : result.reason)),
              Effect.mapError((error) => new RemoveFailed({ message: error.message })),
            ),
        );
      }
      case "path": {
        if (target.worktree === null) {
          // Leftover and temp folders alike: a thread can be launched into either.
          // Everything on this server that writes into a folder (turn startup, terminals, git
          // workflows, rollback) takes a lease on it or a folder inside it, which the hold turns
          // away, so no write lands between these checks and removal. Recording a binding writes
          // nothing, so one recorded in that moment leaves its thread pointing at a folder whose
          // reviewed, unchanged contents are gone.
          return yield* holdingWhole(
            item.path,
            Effect.gen(function* () {
              const reason = yield* inUse(item.path);
              if (reason !== null) return reason;
              const own = yield* ownReference(item.path);
              if (own !== null) return own;
              const goat = yield* goatDataNow(item.path);
              if (goat !== null) return goat;
              // A batch removes items one after another; this one may have changed meanwhile.
              const changed = yield* changedSinceReview(item.path, target.stamp);
              if (changed !== null) return changed;
              // A folder of a repository is that repository's work, whatever GOAT folder holds it.
              const around = yield* aroundCheckout(item.path);
              if (around !== null) return around;
              return yield* removeChecked(target.root, item.path, target.identity);
            }),
          );
        }
        const worktree = target.worktree;
        const listed = yield* worktrees.facts.pipe(Effect.orElseSucceed(() => null));
        const before = listed?.find((fact) => samePath(fact.entry.path, worktree, rules));
        if (before === undefined) return "its worktree is no longer listed";
        // Turn start leases the path its thread recorded, which can be a folder inside the
        // worktree; holding every such lease keeps those threads from starting mid-removal.
        const keys = [...new Set([path.resolve(worktree), ...before.leaseKeys])].toSorted();
        // Holding the worktree whole also turns away threads bound inside it after this read.
        return yield* holdingWhole(
          worktree,
          keys.reduceRight(
            (inner, key) => withWorkspaceLease(key, inner),
            Effect.gen(function* () {
              const facts = yield* worktrees.facts.pipe(Effect.orElseSucceed(() => null));
              const current = facts?.find((fact) => samePath(fact.entry.path, worktree, rules));
              if (current === undefined) return "its worktree is no longer listed";
              if (current.leaseKeys.some((key) => !keys.includes(key)))
                return "a thread started using its worktree";
              const entry = current.entry;
              if (entry.threads.some((thread) => thread.busy || !thread.archived))
                return "a thread still uses its worktree";
              const reason = yield* inUse(worktree);
              if (reason !== null) return reason;
              const goat = yield* goatDataNow(item.path);
              if (goat !== null) return goat;
              const keeps = yield* buildOutputKeeps(worktree, item.path);
              if (keeps !== null) return keeps;
              const nested = yield* holdsGitCheckout(item.path);
              if (nested !== false)
                return nested === null
                  ? "it could not be searched for git checkouts"
                  : "it holds a git checkout, whose work its worktree's git cannot see";
              const between = yield* insideCheckout(worktree, item.path, { skipRoot: true });
              if (between !== false)
                return between === null
                  ? "the folders above it could not be checked for a git checkout"
                  : "it sits in a git checkout nested in its worktree, whose work its worktree's git cannot see";
              const around = yield* aroundCheckout(worktree);
              if (around !== null) return around;
              return yield* removeChecked(target.root, item.path, target.identity);
            }),
          ),
        );
      }
      case "stale": {
        const listed = yield* git
          .execute({
            operation: "StorageReclaim.staleRegistrations",
            cwd: target.repository,
            args: ["worktree", "list", "--porcelain", "-z"],
            allowNonZeroExit: true,
            maxOutputBytes: 1024 * 1024,
          })
          .pipe(Effect.orElseSucceed(() => null));
        if (listed === null || listed.exitCode !== 0) return "git could not list its worktrees";
        const missing: Array<string> = [];
        for (const record of listed.stdout.split("\0\0")) {
          const field = record.split("\0").find((value) => value.startsWith("worktree "));
          if (field === undefined) continue;
          const worktreePath = path.resolve(target.repository, field.slice("worktree ".length));
          if (
            !(yield* FileSystem.FileSystem.pipe(
              Effect.flatMap((fs) => fs.exists(worktreePath)),
              Effect.orElseSucceed(() => true),
            ))
          )
            missing.push(worktreePath);
        }
        // git prune forgets every missing worktree of the repository, so the set must be the reviewed one.
        if (missing.toSorted().join("\n") !== target.missing.join("\n"))
          return "its missing worktrees changed since it was reviewed";
        yield* git
          .pruneWorktrees({ cwd: target.repository })
          .pipe(Effect.mapError((error) => new RemoveFailed({ message: error.message })));
        return null;
      }
      case "runtime": {
        // A thread can be launched into a folder of an old runtime too.
        return yield* holdingWhole(
          item.path,
          Effect.gen(function* () {
            const reason = yield* inUse(item.path);
            if (reason !== null) return reason;
            const own = yield* ownReference(item.path);
            if (own !== null) return own;
            if (yield* holdsGoatDataBelow(item.path))
              return "it holds another GOAT server's home or data";
            if ((yield* holdsGitCheckout(item.path)) !== false)
              return "it holds a git checkout now, or could not be searched for one";
            const around = yield* aroundCheckout(item.path);
            if (around !== null) return around;
            return yield* removeUnusedPinnedRuntime({
              baseDir: config.baseDir,
              keep: [packageJson.version],
              version: target.version,
            }).pipe(Effect.mapError((error) => new RemoveFailed({ message: error.message })));
          }),
        );
      }
      case "files":
        // A thread can be launched into the logs or attachments folder like any other.
        return yield* holdingWhole(
          target.root,
          Effect.gen(function* () {
            const reason = yield* workedInNow(target.root);
            if (reason !== null) return reason;
            // A checkout anywhere above a file, its GOAT folder included, may track it.
            for (const file of target.files)
              if ((yield* withinCheckout(path.dirname(file.path))) !== false)
                return file.path + " is in a git checkout now, or its folder could not be read";
            return yield* removeGroup(item, target, actor);
          }),
        );
      case "none":
        return "it is shown for information only";
    }
  }, Effect.provideContext(context));

  /** Files of one group: rotated logs, or deleted threads' attachments under the write lock. */
  const removeGroup = Effect.fn("StorageReclaim.removeGroup")(function* (
    item: StorageItem,
    target: Extract<StorageTarget, { readonly kind: "files" }>,
    actor: string,
  ) {
    if (item.kind !== "attachments") return yield* removeFiles(item, target, actor);
    // A message can reference a file of a deleted thread at any moment. Holding the write
    // lock while checking again and unlinking means such a message commits either before the
    // check, which keeps the file, or after it is gone. Only the selected files' threads are
    // read, so writes wait briefly.
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const threads = yield* sql<{ readonly id: string; readonly deleted: string | null }>`
              SELECT thread_id AS "id", deleted_at AS "deleted" FROM orchestration_v2_projection_threads
            `;
        const fresh = yield* deletedThreadAttachments({
          attachmentsDir: target.root,
          threads,
          now: yield* Clock.currentTimeMillis,
          only: new Set(target.files.map((file) => file.path)),
        });
        const still = new Set(fresh.removable.map((file) => file.path + ":" + file.identity.ino));
        if (target.files.some((file) => !still.has(file.path + ":" + file.identity.ino)))
          return "a surviving thread or task mentions some of these files' threads now";
        return yield* removeFiles(item, target, actor);
      }),
    );
  }, Effect.provideContext(context));

  const removeFiles = Effect.fn("StorageReclaim.removeFiles")(function* (
    item: StorageItem,
    target: Extract<StorageTarget, { readonly kind: "files" }>,
    actor: string,
  ) {
    // A group's log line names only its folder, so each file gets its own intent and outcome.
    for (const file of target.files) {
      const intent = yield* log({
        event: "intent",
        actor,
        kind: item.kind,
        path: file.path,
      }).pipe(Effect.result);
      if (intent._tag === "Failure")
        return file.path + ": the cleanup log could not be written, so it was kept";
      const done = yield* removeChecked(target.root, file.path, file.identity).pipe(Effect.result);
      yield* log({
        event: done._tag === "Failure" ? "failed" : done.success === null ? "removed" : "skipped",
        actor,
        kind: item.kind,
        path: file.path,
        ...(done._tag === "Failure"
          ? { reason: done.failure.message }
          : done.success === null
            ? {}
            : { reason: done.success }),
      }).pipe(Effect.ignore);
      if (done._tag === "Failure") return yield* done.failure;
      if (done.success !== null && done.success !== "it is already gone")
        return file.path + ": " + done.success;
    }
    return null;
  });

  const clean: StorageReclaim["Service"]["clean"] = Effect.fn("StorageReclaim.clean")(
    function* (input) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const { scan } = yield* scanNow(
            false,
            new Set(input.items.map((requested) => requested.id)),
          );
          const previous = yield* Ref.get(latest);
          const results: Array<StorageCleanOutcome> = [];
          let freedBytes = 0;
          for (const requested of input.items) {
            const item = scan.items.find((candidate) => candidate.id === requested.id);
            const fallbackPath = requested.id.slice(requested.id.indexOf(":") + 1) || requested.id;
            const outcome = (
              value: StorageCleanOutcome["outcome"],
              reason: string,
              bytes: number | null = null,
            ): StorageCleanOutcome => ({
              id: requested.id,
              kind: item?.kind ?? "worktree",
              path: item?.path ?? fallbackPath,
              outcome: value,
              reason,
              bytes,
            });
            if (item === undefined) {
              results.push(outcome("skipped", "It is no longer there"));
              continue;
            }
            if (item.token !== requested.token) {
              results.push(outcome("skipped", "It changed since it was reviewed"));
              continue;
            }
            if (item.state !== "removable") {
              results.push(outcome("skipped", item.reason));
              continue;
            }
            const target = scan.targets.get(item.id);
            // The confirming scan measured sizes; this one does not.
            const bytes = previous?.scan.items.find((known) => known.id === item.id)?.bytes ?? null;
            // Started, an item runs to its outcome line: an interrupt (its client went away) lands
            // between items. Interrupting a removal would release the item's hold while the
            // filesystem or git keeps deleting, and leave its intent without an outcome.
            const result = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const intent = yield* log({
                  event: "intent",
                  actor: input.actor,
                  kind: item.kind,
                  path: item.path,
                  token: item.token,
                  bytes,
                }).pipe(Effect.result);
                if (intent._tag === "Failure" || target === undefined)
                  return outcome(
                    "failed",
                    "Could not write the cleanup log, so nothing was deleted",
                  );
                const done = yield* act(item, target, input.actor).pipe(Effect.result);
                const finished =
                  done._tag === "Failure"
                    ? outcome("failed", failureMessage(done.failure), bytes)
                    : done.success === null
                      ? outcome("removed", item.reason, bytes)
                      : outcome("skipped", sentenceCase(done.success));
                // What was removed is gone from the cached scan; the next read scans again.
                if (finished.outcome === "removed") yield* Ref.set(latest, null);
                yield* log({
                  event: finished.outcome,
                  actor: input.actor,
                  kind: item.kind,
                  path: item.path,
                  reason: finished.reason,
                }).pipe(Effect.ignore);
                yield* Effect.logInfo("storage cleanup", {
                  outcome: finished.outcome,
                  kind: item.kind,
                  path: item.path,
                  reason: finished.reason,
                });
                return finished;
              }),
            );
            if (result.outcome === "removed") freedBytes += bytes ?? 0;
            results.push(result);
          }
          return { results, freedBytes, logPath } satisfies StorageCleanResult;
        }),
      );
    },
  );

  return StorageReclaim.of({ usage, clean });
});

class RemoveFailed extends Schema.TaggedError<RemoveFailed>()("StorageRemoveFailed", {
  message: Schema.String,
}) {}

const failureMessage = (failure: unknown) =>
  typeof failure === "object" &&
  failure !== null &&
  "message" in failure &&
  typeof failure.message === "string"
    ? failure.message
    : String(failure);

/** One line of storage-cleanup.ndjson. */
const StorageLogLine = Schema.Struct({
  at: Schema.String,
  event: Schema.Literals(["intent", "removed", "skipped", "failed"]),
  actor: Schema.String,
  kind: Schema.String,
  path: Schema.String,
  token: Schema.optional(Schema.String),
  bytes: Schema.optional(Schema.NullOr(Schema.Number)),
  reason: Schema.optional(Schema.String),
});
const encodeLogLine = Schema.encodeSync(Schema.fromJsonString(StorageLogLine));

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const layer = Layer.effect(StorageReclaim, make);
