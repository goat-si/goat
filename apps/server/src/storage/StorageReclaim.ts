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
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { LocalGoatServers } from "./localGoatServers.ts";
import { type FileIdentity, lstatOf, sameIdentity } from "./fileState.ts";
import {
  otherServerReason,
  processInside,
  resolveOtherServerPaths,
  scanStorage,
  type StorageScan,
  type StorageTarget,
  toReport,
} from "./storageScan.ts";
import { isStrictlyInside, pathRules, samePath } from "./storagePaths.ts";

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

  const act = Effect.fn("StorageReclaim.act")(function* (item: StorageItem, target: StorageTarget) {
    switch (target.kind) {
      case "worktree": {
        const result = yield* worktrees
          .removeAbandoned({
            path: item.path,
            head: target.head,
            branch: target.branch,
            verify: inUse(item.path),
          })
          .pipe(Effect.mapError((error) => new RemoveFailed({ message: error.message })));
        return result.removed ? null : result.reason;
      }
      case "path": {
        if (target.worktree === null) {
          if (item.kind === "orphan_folder") {
            const reason = yield* inUse(item.path);
            if (reason !== null) return reason;
          }
          return yield* removeChecked(target.root, item.path, target.identity);
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
        for (const file of target.files) {
          const reason = yield* removeChecked(target.root, file.path, file.identity);
          if (reason !== null && reason !== "it is already gone") return file.path + ": " + reason;
        }
        return null;
      }
      case "none":
        return "it is shown for information only";
    }
  }, Effect.provideContext(context));

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
            const done = yield* act(item, target).pipe(Effect.result);
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
