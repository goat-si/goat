/**
 * Goal workers on other hosts: every remote read and write a fleet goal makes, straight over
 * SshRemoteDispatch. HostThreadsMcpService serves MCP tools, so it reads the calling thread's
 * current mode and needs that thread to own a live run; a goal acts after its owner's turn has
 * ended, under the ceiling it stored. Each write's authorize runs right before the remote request
 * (SshRemoteDispatch reruns it) and re-checks the goal, its owner and the owner's goatclaw profile,
 * as goat_thread_reschedule does (mcp/toolkits/fleet/healthHandlers.ts).
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous digest for a title marker.
import * as NodeCrypto from "node:crypto";

import {
  type FleetGoal,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadStatusResult,
  type PermissionProfile,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as FleetSync from "../../goatclaw/FleetSync.ts";
import type * as Profiles from "../../goatclaw/PermissionProfiles.ts";
import { hostFailure } from "../../mcp/hostFailure.ts";
import { statusFromRead } from "../../mcp/threadStatus.ts";
import type { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";

const REMOTE_TIMEOUT_MS = 15_000;
const TITLE_LIMIT = 200;

const RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
const lower = (left: RuntimeMode, right: RuntimeMode) => (RANK[left] <= RANK[right] ? left : right);

/** The owner's authority as GoalWorkerRuntime.owner reads it; kept structural to avoid a cycle. */
interface Owner {
  readonly scope: Parameters<Profiles.PermissionProfiles["Service"]["resolve"]>[0];
  readonly runtimeMode: RuntimeMode;
}
export type OwnerNow = Effect.Effect<Owner | { readonly unavailable: string }>;

/** Raised by a remote write's authorize: nothing was sent for the refused step. */
export class RemoteAuthorityLost extends Schema.TaggedError<RemoteAuthorityLost>()(
  "RemoteAuthorityLost",
  { message: Schema.String },
) {}

const isAuthorityLost = Schema.is(RemoteAuthorityLost);

/**
 * A remote launch that may have created its thread. The goal's launch record keeps it, and only a
 * thread found under its marker settles it: an empty listing is not proof, so it is never relaunched.
 */
export class RemoteLaunchUnconfirmed extends Schema.TaggedError<RemoteLaunchUnconfirmed>()(
  "RemoteLaunchUnconfirmed",
  { host: Schema.String, message: Schema.String },
) {}

/**
 * The title suffix a remote launch is found by after its answer was lost. The remote keeps no id of
 * ours, so the goal and action ids are hashed into the title, where no other launch repeats them.
 */
export const remoteMarker = (goalId: string, actionId: string) =>
  " · g" +
  NodeCrypto.createHash("sha256")
    .update(goalId + "\n" + actionId)
    .digest("hex")
    .slice(0, 16);

export const remoteTitle = (title: string, marker: string) =>
  Array.from(title)
    .slice(0, TITLE_LIMIT - marker.length)
    .join("") + marker;

/** What a goal may do on one host now, captured before its first remote write there. */
export interface RemoteAuthority<E = never> {
  /** The remote session's ceiling: the goal's ceiling, the owner now and its profile, lowest. */
  readonly sessionMode: RuntimeMode;
  /** What the worker thread runs at: the session ceiling and the goal's worker mode, lowest. */
  readonly workerMode: RuntimeMode;
  /** The owner's goatclaw profile, bound to the remote thread; undefined while goatclaw is off. */
  readonly ceiling: PermissionProfile | undefined;
  /** Re-checks everything above; returns sessionMode, or fails with nothing sent. */
  readonly authorize: Effect.Effect<RuntimeMode, E | RemoteAuthorityLost>;
}

const decodeStatus = Schema.decodeUnknownEffect(OrchestratorMcpThreadStatusResult);
const decodeRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeList = Schema.decodeUnknownEffect(
  Schema.Struct({
    threads: Schema.Array(Schema.Struct({ threadId: ThreadId, title: Schema.String })),
    nextCursor: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
);
const decodeProjects = Schema.decodeUnknownEffect(
  Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        workspaceRoot: Schema.String,
        repositoryIdentity: Schema.optional(Schema.Unknown),
      }),
    ),
  }),
);

const canonicalKeyOf = (identity: unknown) => {
  if (typeof identity !== "object" || identity === null) return null;
  const key = (identity as { readonly canonicalKey?: unknown }).canonicalKey;
  return typeof key === "string" ? key : null;
};

const unknownLaunch = (host: string, message: string) =>
  new OrchestratorMcpFailure({ code: "host_unavailable", message: host + ": " + message });

export const makeRemoteWorkers = (deps: {
  readonly dispatch: SshRemoteDispatch.SshRemoteDispatch["Service"];
  readonly permissions: Profiles.PermissionProfiles["Service"];
  readonly fleet: FleetSync.GoatclawFleetSync["Service"];
  readonly projects: ProjectStoreV2["Service"];
}) => {
  const { dispatch, permissions } = deps;

  const read = (host: string, tool: string, args: Record<string, unknown>) =>
    dispatch.callHostTool(
      { host, tool, arguments: args, writes: false, timeoutMs: REMOTE_TIMEOUT_MS },
      // Reads grant nothing, so the lowest mode is enough.
      Effect.succeed<RuntimeMode>("approval-required"),
    );

  /**
   * Admits a goal's writes on `host` (null when placement has not chosen yet) and builds the
   * authorize every such write runs last. Capabilities are those goat_ssh_thread_launch needs.
   */
  const admit = Effect.fn("GoalRemoteWorkers.admit")(function* <E>(input: {
    readonly owner: Owner;
    readonly ownerNow: OwnerNow;
    readonly goal: Pick<FleetGoal, "spec">;
    readonly host: string | null;
    readonly worktree: boolean;
    /** The controller's last check: the goal and its owner as planned. */
    readonly confirm: Effect.Effect<void, E>;
  }) {
    const context = (runtimeMode: RuntimeMode) =>
      input.host === null ? { runtimeMode } : { runtimeMode, host: input.host };
    const effective = yield* permissions.resolve(input.owner.scope, input.owner.runtimeMode);
    const sessionMode = lower(effective.runtimeMode, input.owner.runtimeMode);
    const workerMode = lower(sessionMode, input.goal.spec.workers.runtimeMode);
    const check = Effect.fn("GoalRemoteWorkers.check")(function* (scope: Owner["scope"]) {
      yield* permissions.require(scope, "threads.launch", context(workerMode));
      yield* permissions.require(scope, "threads.remote", context(workerMode));
      if (input.worktree) yield* permissions.require(scope, "worktree.create", context(workerMode));
    });
    yield* check(input.owner.scope);
    const recheck = Effect.gen(function* () {
      const now = yield* input.ownerNow;
      if ("unavailable" in now) return yield* new RemoteAuthorityLost({ message: now.unavailable });
      if (RANK[now.runtimeMode] < RANK[sessionMode])
        return yield* new RemoteAuthorityLost({
          message:
            "The owner may now act only in " +
            now.runtimeMode +
            " mode, below " +
            sessionMode +
            ".",
        });
      yield* check(now.scope);
      // A profile that narrowed while this write was prepared refuses it.
      yield* permissions.recheck(now.scope, effective, context(workerMode));
      return sessionMode;
    }).pipe(
      Effect.mapError((error) =>
        isAuthorityLost(error) ? error : new RemoteAuthorityLost({ message: error.message }),
      ),
    );
    // The goal's own check first: a goal that moved on is not an owner problem.
    const authorize = Effect.andThen(input.confirm, recheck);
    return {
      sessionMode,
      workerMode,
      ceiling: effective.enabled ? effective.profile : undefined,
      authorize,
    } satisfies RemoteAuthority<E>;
  });

  /**
   * Authorizes stopping a worker on host at mode: the controller's check, then the owner's goatclaw
   * profile must still reach that host. Stopping needs no launch capability.
   */
  const stopAuthorize = <E>(input: {
    readonly scope: Owner["scope"];
    readonly mode: RuntimeMode;
    readonly host: string;
    readonly confirm: Effect.Effect<void, E>;
  }) =>
    Effect.andThen(
      input.confirm,
      permissions
        .require(input.scope, "threads.remote", { host: input.host, runtimeMode: input.mode })
        .pipe(
          Effect.mapError((error) => new RemoteAuthorityLost({ message: error.message })),
          Effect.as(input.mode),
        ),
    );

  /** Brings the destination's goatclaw policy up to date before a ceiling is forwarded to it. */
  const prepare = <E>(authority: RemoteAuthority<E>, host: string) =>
    authority.ceiling === undefined
      ? Effect.void
      : FleetSync.syncBeforeForwarding(deps.fleet, host).pipe(Effect.asVoid);

  /**
   * The worker's status and its last result. A thread the host says does not exist is missing;
   * anything else that cannot be read is unknown.
   */
  const observe = Effect.fn("GoalRemoteWorkers.observe")(function* (
    host: string,
    threadId: ThreadId,
  ) {
    let answer = yield* read(host, "goat_thread_status", { threadId }).pipe(Effect.result);
    let fromRead = false;
    if (
      answer._tag === "Failure" &&
      answer.failure.message.includes(SshRemoteDispatch.REMOTE_THREAD_STATUS_UNSUPPORTED)
    ) {
      answer = yield* read(host, "goat_thread_read", { threadId, limit: 1, runLimit: 2 }).pipe(
        Effect.result,
      );
      fromRead = true;
    }
    if (answer._tag === "Failure")
      return answer.failure.remoteCode === "thread_not_found"
        ? ({ kind: "missing" } as const)
        : ({ kind: "unknown", message: answer.failure.message } as const);
    const status = yield* (
      fromRead
        ? decodeRead(answer.success).pipe(Effect.map(statusFromRead))
        : decodeStatus(answer.success)
    ).pipe(Effect.option);
    if (Option.isNone(status))
      return {
        kind: "unknown",
        message: host + " returned a status this machine cannot read.",
      } as const;
    // The thread's model and result come from its read, which also corrects the slot's model.
    const detail = yield* read(host, "goat_thread_read", {
      threadId,
      limit: 1,
      runLimit: 1,
      maxCharsPerItem: 200,
    }).pipe(Effect.flatMap(decodeRead), Effect.option);
    const thread = Option.getOrUndefined(detail);
    return {
      kind: "seen",
      status: status.value,
      result: thread?.result ?? null,
      modelSelection:
        thread === undefined
          ? null
          : {
              instanceId: thread.thread.providerInstanceId,
              model: thread.thread.model,
            },
    } as const;
  });

  /**
   * The thread a launch under this marker started on host. Only one exact match proves it; no
   * match, several, a truncated list or no answer all leave the launch unknown.
   */
  const find = Effect.fn("GoalRemoteWorkers.find")(function* (host: string, marker: string) {
    const listed = yield* read(host, "goat_thread_list", {
      allProjects: true,
      titleContains: marker.trim(),
      limit: 20,
    }).pipe(
      Effect.flatMap(decodeList),
      Effect.mapError(() => unknownLaunch(host, "its threads could not be listed.")),
    );
    const matches = listed.threads.filter((thread) => thread.title.endsWith(marker));
    const only = matches[0];
    if (matches.length === 1 && only !== undefined)
      return { host, threadId: only.threadId, runId: null as RunId | null };
    return yield* unknownLaunch(
      host,
      matches.length > 1
        ? "several threads carry this launch's marker."
        : "this launch may have started but is not listed there; nothing else is launched for it.",
    );
  });

  /** The goal's project folder and repository, read where the project lives. */
  const project = Effect.fn("GoalRemoteWorkers.project")(function* (goal: Pick<FleetGoal, "spec">) {
    const { host, projectId, cwd } = goal.spec.project;
    if (projectId === null)
      return cwd === null ? null : { cwd, canonicalKey: null as string | null };
    if (host === null) {
      const shell = yield* deps.projects
        .getShell(projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      return Option.isNone(shell)
        ? null
        : {
            cwd: shell.value.workspaceRoot,
            canonicalKey: canonicalKeyOf(shell.value.repositoryIdentity),
          };
    }
    const listed = yield* read(host, "goat_project_list", { limit: 100 }).pipe(
      Effect.flatMap(decodeProjects),
      Effect.option,
    );
    const found = Option.getOrUndefined(listed)?.projects.find((entry) => entry.id === projectId);
    return found === undefined
      ? cwd === null
        ? null
        : { cwd, canonicalKey: null as string | null }
      : { cwd: found.workspaceRoot, canonicalKey: canonicalKeyOf(found.repositoryIdentity) };
  });

  const write = <E>(
    host: string,
    tool: string,
    args: Record<string, unknown>,
    authorize: Effect.Effect<RuntimeMode, E>,
  ) =>
    dispatch
      .callHostTool(
        { host, tool, arguments: args, writes: true, timeoutMs: REMOTE_TIMEOUT_MS },
        authorize,
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof SshRemoteDispatch.SshRemoteDispatchError ? hostFailure(error) : error,
        ),
      );

  /** Starts the worker. A failure that may have created the thread is RemoteLaunchUnconfirmed. */
  const launch = Effect.fn("GoalRemoteWorkers.launch")(function* <E>(
    authority: RemoteAuthority<E>,
    input: {
      readonly host: string;
      readonly cwd: string;
      readonly title: string;
      readonly message: string;
      readonly branch: string;
      readonly baseRef: string;
      readonly startFromOrigin: boolean;
      readonly modelSelection: import("@goat/contracts").ModelSelection;
    },
  ) {
    yield* prepare(authority, input.host);
    return yield* dispatch
      .launchThread(
        {
          host: input.host,
          cwd: input.cwd,
          workspace: {
            type: "worktree",
            branch: input.branch,
            baseRef: input.baseRef,
            startFromOrigin: input.startFromOrigin,
          },
          title: input.title,
          message: input.message,
          modelSelection: input.modelSelection,
          runtimeMode: authority.workerMode,
          callerRuntimeMode: authority.sessionMode,
          interactionMode: "default",
          ...(authority.ceiling === undefined
            ? {}
            : { permissionProfileCeiling: authority.ceiling }),
        },
        authority.authorize.pipe(Effect.asVoid),
      )
      .pipe(
        Effect.map((launched) => ({
          host: input.host,
          threadId: ThreadId.make(launched.threadId),
          runId: launched.runId === null ? null : RunId.make(launched.runId),
        })),
        Effect.mapError((error) =>
          error instanceof SshRemoteDispatch.SshRemoteDispatchError
            ? error.launchMayHaveStarted === true
              ? new RemoteLaunchUnconfirmed({ host: input.host, message: error.message })
              : hostFailure(error)
            : error,
        ),
      );
  });

  /** Queues a message; the action id is the remote's dedupe key, so a repeat delivers once. */
  const send = <E>(
    authority: RemoteAuthority<E>,
    host: string,
    input: { readonly threadId: ThreadId; readonly message: string; readonly actionId: string },
  ) =>
    prepare(authority, host).pipe(
      Effect.andThen(
        write(
          host,
          "goat_thread_send",
          {
            threadId: input.threadId,
            message: input.message,
            clientRequestId: input.actionId,
            // After its current run, as a local goal follow-up is queued.
            mode: "queue",
            ...(authority.ceiling === undefined
              ? {}
              : { permissionProfileCeiling: authority.ceiling }),
          },
          authority.authorize,
        ),
      ),
      Effect.asVoid,
    );

  const interrupt = <E>(
    authorize: Effect.Effect<RuntimeMode, E>,
    host: string,
    input: { readonly threadId: ThreadId; readonly actionId: string },
  ) =>
    write(
      host,
      "goat_thread_interrupt",
      {
        threadId: input.threadId,
        reason: "The fleet goal no longer needs this worker.",
        clientRequestId: input.actionId,
      },
      authorize,
    ).pipe(Effect.asVoid);

  return { admit, stopAuthorize, prepare, observe, find, project, launch, send, interrupt };
};
