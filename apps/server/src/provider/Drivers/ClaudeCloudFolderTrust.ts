import { ProviderDriverKind, type ProviderInstanceId, type ThreadId } from "@goat/contracts";
import { ProviderDriverError } from "@goat/provider-core/server/errors";
import { ClaudeCloudCli, type ClaudeCloudLogin } from "@goat/provider-claude-cloud/server";
import type { ClaudeCloudError } from "@goat/provider-claude-cloud/server";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Projection from "../../orchestration-v2/ProjectionStore.ts";
import type * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";

const ACTION = "claudeCloud.folderTrust.accept";

/**
 * Claude Code keeps trust per folder in its global config, and a trusted folder covers the
 * folders inside it. Null when the config is not Claude's shape.
 */
export function trustedInClaudeConfig(
  raw: string,
  cwd: string,
  path: Pick<Path.Path, "dirname">,
): boolean | null {
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof config !== "object" || config === null) return null;
  const projects = (config as { readonly projects?: unknown }).projects;
  if (projects === undefined) return false;
  if (typeof projects !== "object" || projects === null) return null;
  for (let folder = cwd; ; folder = path.dirname(folder)) {
    const entry = (projects as Record<string, unknown>)[folder];
    if (
      typeof entry === "object" &&
      entry !== null &&
      (entry as { readonly hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted === true
    )
      return true;
    if (path.dirname(folder) === folder) return false;
  }
}

export const makeClaudeCloudFolderTrust = (input: {
  readonly instanceId: ProviderInstanceId;
  readonly sql: SqlClient.SqlClient;
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
  readonly projection: Projection.ProjectionStoreV2["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly resolveLogin: Effect.Effect<ClaudeCloudLogin, ClaudeCloudError>;
  readonly cli: ClaudeCloudCli.ClaudeCloudCli["Service"];
  /**
   * The main checkout of a Git worktree. Claude keeps a worktree's trust under that root, so a
   * worktree never appears under its own path.
   */
  readonly mainCheckout: (cwd: string) => Effect.Effect<string | null>;
}) => {
  const { sql, path } = input;
  const isLiveRoot = (folder: string) =>
    input.projects.findActiveByWorkspaceRoot(folder).pipe(Effect.map(Option.isSome));
  const isGoatWorktree = Effect.fn("ClaudeCloudFolderTrust.isGoatWorktree")(function* (
    folder: string,
  ) {
    const live = new Set(
      (yield* input.projects.list())
        .filter((row) => row.deletedAt === null)
        .map((row) => row.projectId),
    );
    const shell = yield* input.projection.getShellSnapshot();
    return [...shell.threads, ...shell.archivedThreads].some(
      (thread) =>
        thread.worktreePath !== null &&
        live.has(thread.projectId) &&
        path.resolve(thread.worktreePath) === folder,
    );
  });
  /**
   * Claude records trust for a Git folder at its main checkout, which then covers every folder
   * and worktree of that repository. So GOAT answers only when that checkout is itself a live
   * project, and the folder is that project or a GOAT worktree of one. A registered subfolder or
   * worktree of an unregistered repository would trust the whole unregistered checkout.
   */
  const allowed = Effect.fn("ClaudeCloudFolderTrust.allowed")(
    function* (cwd: string) {
      const folder = path.resolve(cwd);
      const real = yield* input.fileSystem
        .realPath(folder)
        .pipe(Effect.orElseSucceed(() => folder));
      const root = (yield* input.mainCheckout(folder)) ?? real;
      const registered = (yield* isLiveRoot(folder)) || (yield* isGoatWorktree(folder));
      if (!registered) return false;
      if (root === real || root === folder) return true;
      return yield* isLiveRoot(root);
    },
    Effect.orElseSucceed(() => false),
  );
  const audit = Effect.fn("ClaudeCloudFolderTrust.audit")(function* (cwd: string, actor: string) {
    const time = DateTime.formatIso(yield* DateTime.now);
    yield* sql`INSERT INTO audit_events (time, actor, profile, action, target, outcome, decision_id)
        VALUES (${time}, ${actor}, 'system', ${ACTION}, ${path.resolve(cwd)}, 'accepted', NULL)`;
  });
  const record = Effect.fn("ClaudeCloudFolderTrust.record")(
    function* (event: {
      readonly cwd: string;
      readonly threadId: ThreadId;
      readonly prompts: number;
    }) {
      yield* audit(event.cwd, `thread:${event.threadId}`);
      yield* Effect.logInfo("GOAT accepted Claude Code folder trust", {
        instanceId: input.instanceId,
        path: event.cwd,
        threadId: event.threadId,
        prompts: event.prompts,
      });
    },
    // The launch already continued; a lost audit row must not fail it.
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not record a Claude Code folder trust acceptance", { cause }),
    ),
  );
  const acceptedByGoatAt = (cwd: string) =>
    sql<{ readonly time: string }>`SELECT time FROM audit_events
      WHERE action = ${ACTION} AND target = ${path.resolve(cwd)} ORDER BY id DESC LIMIT 1`.pipe(
      Effect.map((rows) => rows[0]?.time ?? null),
      Effect.orElseSucceed(() => null),
    );
  /** Claude's global config, read once per question; GOAT never writes it. */
  const readConfig = Effect.gen(function* () {
    const login = yield* input.resolveLogin;
    const home = login.environment.CLAUDE_CONFIG_DIR ?? login.environment.HOME;
    if (!home) return null;
    return yield* input.fileSystem.readFileString(path.join(home, ".claude.json"));
  }).pipe(Effect.orElseSucceed(() => null));
  const trustedIn = Effect.fn("ClaudeCloudFolderTrust.trustedIn")(function* (
    raw: string | null,
    cwd: string,
  ) {
    if (raw === null) return null;
    const own = trustedInClaudeConfig(raw, path.resolve(cwd), path);
    if (own !== false) return own;
    const root = yield* input.mainCheckout(cwd);
    return root === null ? false : trustedInClaudeConfig(raw, root, path);
  });
  const trusted = (cwd: string) => readConfig.pipe(Effect.flatMap((raw) => trustedIn(raw, cwd)));
  const states = Effect.fn("ClaudeCloudFolderTrust.states")(function* (
    cwds: ReadonlyArray<string>,
  ) {
    const raw = yield* readConfig;
    return yield* Effect.forEach(cwds, (cwd) =>
      Effect.all([trustedIn(raw, cwd), acceptedByGoatAt(cwd)]).pipe(
        Effect.map(([isTrusted, at]) => ({ trusted: isTrusted, acceptedByGoatAt: at })),
      ),
    );
  });
  const failure = (detail: string, cause?: unknown) =>
    new ProviderDriverError({
      driver: ProviderDriverKind.make("claudeCloud"),
      instanceId: input.instanceId,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const accept = Effect.fn("ClaudeCloudFolderTrust.accept")(function* (cwd: string) {
    if (!(yield* allowed(cwd)))
      return yield* failure("GOAT trusts only its own project folders and their worktrees.");
    if ((yield* trusted(cwd)) === true) return;
    const login = yield* input.resolveLogin.pipe(
      Effect.mapError((cause) => failure(cause.detail, cause)),
    );
    yield* input.cli
      .acceptTrust(login, cwd)
      .pipe(Effect.mapError((cause) => failure(cause.detail, cause)));
    // Claude's own config is the proof; an unreadable config leaves the answer standing.
    if ((yield* trusted(cwd)) === false)
      return yield* failure(
        "Claude Code did not record trust for this folder. Open it once with claude and choose Yes, I trust this folder.",
      );
    yield* audit(cwd, "settings").pipe(
      Effect.mapError((cause) => failure("Trusted the folder, but could not record it.", cause)),
    );
  });
  return { policy: { allowed, record }, capability: { states, accept } };
};
