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
}) => {
  const { sql, path } = input;
  /** Only a live project's folder, or a GOAT worktree of one, is GOAT's to trust. */
  const allowed = Effect.fn("ClaudeCloudFolderTrust.allowed")(
    function* (cwd: string) {
      const folder = path.resolve(cwd);
      if (Option.isSome(yield* input.projects.findActiveByWorkspaceRoot(folder))) return true;
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
    },
    Effect.orElseSucceed(() => false),
  );
  const audit = (cwd: string, actor: string) =>
    Effect.gen(function* () {
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
  const trusted = (cwd: string) =>
    readConfig.pipe(
      Effect.map((raw) =>
        raw === null ? null : trustedInClaudeConfig(raw, path.resolve(cwd), path),
      ),
    );
  const states = Effect.fn("ClaudeCloudFolderTrust.states")(function* (
    cwds: ReadonlyArray<string>,
  ) {
    const raw = yield* readConfig;
    return yield* Effect.forEach(cwds, (cwd) =>
      acceptedByGoatAt(cwd).pipe(
        Effect.map((at) => ({
          trusted: raw === null ? null : trustedInClaudeConfig(raw, path.resolve(cwd), path),
          acceptedByGoatAt: at,
        })),
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
    yield* audit(cwd, "settings").pipe(
      Effect.mapError((cause) => failure("Trusted the folder, but could not record it.", cause)),
    );
  });
  return { policy: { allowed, record }, capability: { states, accept } };
};
