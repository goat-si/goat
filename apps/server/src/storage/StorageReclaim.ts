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
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { buildOutputKeeps, maskedIndexEntry } from "./buildOutputs.ts";
import { deletedThreadAttachments } from "./deletedThreadAttachments.ts";
import { LocalGoatServers } from "./localGoatServers.ts";
import { type FileIdentity, holdsGitCheckout, lstatOf, sameIdentity } from "./fileState.ts";
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
    const otherReason = otherServerReason(other, folder, rules);
    if (otherReason !== null) return otherReason;
    const realFolder = (yield* real(folder)) ?? folder;
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

  const act = Effect.fn("StorageReclaim.act")(function* (
    item: StorageItem,
    target: StorageTarget,
    actor: string,
  ) {
    switch (target.kind) {
      case "worktree": {
        // Under the worktree's leases, right before git removes it: what git status cannot see.
        const verify = Effect.gen(function* () {
          const reason = yield* inUse(item.path);
          if (reason !== null) return reason;
          const masked = yield* maskedIndexEntry(item.path);
          if (masked !== null) return masked;
          const nested = yield* holdsGitCheckout(item.path, { skipOwn: true });
          return nested === false
            ? null
            : nested === null
              ? "it could not be searched for git checkouts inside it"
              : "it holds another git checkout, whose work its own git status cannot see";
        }).pipe(Effect.provideContext(context));
        const result = yield* worktrees
          .removeAbandoned({
            path: item.path,
            head: target.head,
            branch: target.branch,
            verify,
          })
          .pipe(Effect.mapError((error) => new RemoveFailed({ message: error.message })));
        return result.removed ? null : result.reason;
      }
      case "path": {
        if (target.worktree === null) {
          if (item.kind !== "orphan_folder")
            return yield* removeChecked(target.root, item.path, target.identity);
          // Everything on this server that writes into a folder (turn startup, terminals, git
          // workflows, rollback) takes this lease, so no write lands between these checks and
          // removal. Recording a binding writes nothing here, so one recorded in that moment
          // leaves its thread pointing at a folder whose reviewed, unchanged contents are gone.
          return yield* withWorkspaceLease(
            path.resolve(item.path),
            Effect.gen(function* () {
              const reason = yield* inUse(item.path);
              if (reason !== null) return reason;
              const own = yield* ownReference(item.path);
              if (own !== null) return own;
              return yield* removeChecked(target.root, item.path, target.identity);
            }),
          );
        }
        const worktree = target.worktree;
        return yield* withWorkspaceLease(
          path.resolve(worktree),
          Effect.gen(function* () {
            const facts = yield* worktrees.facts.pipe(Effect.orElseSucceed(() => null));
            const entry = facts?.find((fact) => samePath(fact.entry.path, worktree, rules))?.entry;
            if (entry === undefined) return "its worktree is no longer listed";
            if (entry.threads.some((thread) => thread.busy || !thread.archived))
              return "a thread still uses its worktree";
            const reason = yield* inUse(worktree);
            if (reason !== null) return reason;
            const keeps = yield* buildOutputKeeps(worktree, item.path);
            if (keeps !== null) return keeps;
            const nested = yield* holdsGitCheckout(item.path);
            if (nested !== false)
              return nested === null
                ? "it could not be searched for git checkouts"
                : "it holds a git checkout, whose work its worktree's git cannot see";
            return yield* removeChecked(target.root, item.path, target.identity);
          }),
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
        const removed = yield* removeUnusedPinnedRuntime({
          baseDir: config.baseDir,
          keep: [packageJson.version],
          version: target.version,
        }).pipe(Effect.mapError((error) => new RemoveFailed({ message: error.message })));
        return removed ? null : "it is in use now";
      }
      case "files": {
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
            const still = new Set(
              fresh.removable.map((file) => file.path + ":" + file.identity.ino),
            );
            if (target.files.some((file) => !still.has(file.path + ":" + file.identity.ino)))
              return "a surviving thread or task mentions some of these files' threads now";
            return yield* removeFiles(item, target, actor);
          }),
        );
      }
      case "none":
        return "it is shown for information only";
    }
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
            const intent = yield* log({
              event: "intent",
              actor: input.actor,
              kind: item.kind,
              path: item.path,
              token: item.token,
              bytes,
            }).pipe(Effect.result);
            if (intent._tag === "Failure" || target === undefined) {
              results.push(
                outcome("failed", "Could not write the cleanup log, so nothing was deleted"),
              );
              continue;
            }
            const done = yield* act(item, target, input.actor).pipe(Effect.result);
            const result =
              done._tag === "Failure"
                ? outcome("failed", failureMessage(done.failure), bytes)
                : done.success === null
                  ? outcome("removed", item.reason, bytes)
                  : outcome("skipped", sentenceCase(done.success));
            if (result.outcome === "removed") freedBytes += bytes ?? 0;
            yield* log({
              event: result.outcome,
              actor: input.actor,
              kind: item.kind,
              path: item.path,
              reason: result.reason,
            }).pipe(Effect.ignore);
            yield* Effect.logInfo("storage cleanup", {
              outcome: result.outcome,
              kind: item.kind,
              path: item.path,
              reason: result.reason,
            });
            results.push(result);
          }
          // What was removed is gone from the cached scan; the next read scans again.
          if (results.some((result) => result.outcome === "removed")) yield* Ref.set(latest, null);
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
