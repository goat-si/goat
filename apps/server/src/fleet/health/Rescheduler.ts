import {
  type FleetOwnerKey,
  type ModelSelection,
  type PermissionProfile,
  type RunId,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import { FleetRescheduleClaims } from "./FleetHostStates.ts";
import { isStopped, probeRemoteStatus, readLocalStatus, type FleetThreadRef } from "./Health.ts";
import { HostHealthMonitor } from "./HostHealthMonitor.ts";
import { Placement } from "../resources/Placement.ts";
import {
  fenceNote,
  MAX_ATTEMPTS_PER_WORKER,
  resumeNote,
  type RescheduleReason,
} from "./reschedulePolicy.ts";

export type { RescheduleReason } from "./reschedulePolicy.ts";

/** The caller lost the authority the request was made with. */
export class RescheduleNotAllowed extends Data.TaggedError("RescheduleNotAllowed")<{
  readonly message: string;
}> {}

export interface RescheduleRequest {
  readonly ref: FleetThreadRef;
  readonly owner: FleetOwnerKey;
  /** Fencing token of the attempt being replaced. */
  readonly attempt: number;
  readonly reason: RescheduleReason;
  readonly modelSelection: ModelSelection;
  /** The next attempt's worktree; branch is new per attempt. */
  readonly workspace: {
    readonly baseRef: string;
    readonly branch: string;
    readonly startFromOrigin: boolean;
  };
  /** The replaced attempt's pushed branch, when it has one on origin. */
  readonly previousBranch: string | null;
  readonly replica: { readonly ref: string; readonly commitOid: string } | null;
  readonly prompt: string;
  /** Already clamped to the owner's ceiling. */
  readonly runtimeMode: RuntimeMode;
  readonly clientRequestId: string;
  /** The project, so the same repository is found on the target. */
  readonly project?: { readonly cwd: string; readonly canonicalKey: string | null };
  /** A person's choice of destination; otherwise placement chooses. */
  readonly targetHost?: string | null;
  /**
   * The caller's goatclaw host allowlist. When placement chooses, it chooses only among these,
   * since the MCP gate can check only a host the arguments name.
   */
  readonly allowedHosts?: ReadonlyArray<string>;
  /** Skip only the wait for an unreachable host to be Lost. */
  readonly force?: boolean;
  /**
   * Re-checks the owner and returns its runtime mode now. It runs after the lock is taken and
   * right before every remote write; a lower mode than runtimeMode, or a failure, stops the move.
   */
  readonly authorize?: Effect.Effect<RuntimeMode, RescheduleNotAllowed>;
  /** The caller's goatclaw profile, bound to the moved thread on the destination. */
  readonly permissionProfileCeiling?: PermissionProfile;
  /** Brings the destination's goatclaw policy up to date before the ceiling is forwarded to it. */
  readonly prepareCeiling?: (host: string) => Effect.Effect<void>;
  /** The attempt cap; MAX_ATTEMPTS_PER_WORKER when absent. A goal passes its maxAttemptsPerWorker. */
  readonly maxAttempts?: number;
  /** The destination session's ceiling, when it is higher than the moved thread's runtimeMode. */
  readonly callerRuntimeMode?: RuntimeMode;
  /** Hosts placement must not choose, besides this machine and the old host. */
  readonly excludeHosts?: ReadonlyArray<string>;
  /**
   * A launch that may have started is never retried: it stays Unconfirmed until findMove finds its
   * thread. Goals set this; a person's goat_thread_reschedule retries on the same host instead.
   */
  readonly holdUnconfirmed?: boolean;
  /**
   * Re-checks the caller for a write to the attempt's own host (its interrupt) and returns the
   * session ceiling to stop it under; authorize, at runtimeMode, when absent.
   */
  readonly authorizeSource?: Effect.Effect<RuntimeMode, RescheduleNotAllowed>;
  /** The run this move may stop: an attempt found on another run (a person resumed it) stays. */
  readonly stopRunId?: RunId;
  /** Runs before the attempt's interrupt is sent, so the caller can record the stop as its own. */
  readonly beforeStop?: Effect.Effect<void, RescheduleNotAllowed>;
}

export type RescheduleRefusal =
  | "no_capacity"
  | "host_still_answers"
  | "budget"
  | "no_resume_point"
  | "unsupported_remote"
  | "not_allowed";

export type RescheduleResult =
  | {
      readonly _tag: "Rescheduled";
      readonly host: string | null;
      readonly threadId: ThreadId;
      readonly branch: string;
      readonly resumedFrom: "branch" | "replica" | "base";
    }
  | {
      readonly _tag: "Refused";
      readonly reason: RescheduleRefusal;
      readonly message: string;
      /** The move interrupted the attempt; it continues once the attempt has stopped. */
      readonly stopping?: true;
    }
  /** A launch on host may have started; only finding its thread settles it (holdUnconfirmed). */
  | { readonly _tag: "Unconfirmed"; readonly host: string; readonly message: string };

/** What became of an earlier move under one clientRequestId. */
export type MoveLookup =
  | {
      readonly _tag: "Launched";
      readonly host: string;
      readonly threadId: ThreadId;
      readonly branch: string;
    }
  /** No claim was ever written, so no launch was sent: every move claims before it launches. */
  | { readonly _tag: "NotLaunched" }
  | { readonly _tag: "Unknown"; readonly host: string; readonly message: string };

export interface ReschedulerShape {
  readonly reschedule: (request: RescheduleRequest) => Effect.Effect<RescheduleResult>;
  readonly findMove: (input: {
    readonly clientRequestId: string;
    readonly owner: FleetOwnerKey;
  }) => Effect.Effect<MoveLookup>;
}

/** Moves one attempt to another host (agentic-k8s.md "Resume from the branch or a replica"). */
export class Rescheduler extends Context.Service<Rescheduler, ReschedulerShape>()(
  "goat/fleet/health/Rescheduler",
) {}

const REMOTE_TIMEOUT_MS = 15_000;

const runtimeModeRank: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

const decodeThreadList = Schema.decodeUnknownEffect(
  Schema.Struct({
    threads: Schema.Array(Schema.Struct({ threadId: ThreadId, title: Schema.String })),
  }),
);
const decodeProjects = Schema.decodeUnknownEffect(
  Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({
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

/** FNV-1a, enough to keep two owners' requests for the same branch from sharing a title. */
const shortHash = (text: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/**
 * The new thread's title: the attempt branch and a hash of owner and request id. A retry finds
 * the launch whose answer was lost by it, and another project's thread on the same branch name
 * never matches.
 */
export const attemptTitle = (owner: string, clientRequestId: string, branch: string) =>
  "Resume " + branch + " · " + shortHash(owner + "\n" + clientRequestId);

const unconfirmed = (host: string, message: string): RescheduleResult => ({
  _tag: "Unconfirmed",
  host,
  message,
});

const refused = (reason: RescheduleRefusal, message: string): RescheduleResult => ({
  _tag: "Refused",
  reason,
  message,
});

const clip = (text: string) => Array.from(text).slice(0, 300).join("");

const make = Effect.gen(function* () {
  const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
  const monitor = yield* HostHealthMonitor;
  const claims = yield* FleetRescheduleClaims;
  const placement = yield* Placement;
  const context = yield* Effect.context<
    | SshRemoteDispatch.SshRemoteDispatch
    | HostHealthMonitor
    | ThreadManagementService.ThreadManagementService
  >();
  // One move at a time: a retry of the same request waits for the first, then reads its claim.
  const lock = yield* Semaphore.make(1);

  const recheck = (request: RescheduleRequest) =>
    (request.authorize ?? Effect.succeed(request.runtimeMode)).pipe(
      Effect.flatMap((mode) =>
        runtimeModeRank[mode] >= runtimeModeRank[request.runtimeMode]
          ? Effect.succeed(request.runtimeMode)
          : Effect.fail(
              new RescheduleNotAllowed({
                message: "The caller now runs in " + mode + ", below " + request.runtimeMode + ".",
              }),
            ),
      ),
    );

  /** callHostTool returns the tool's payload; a refusal arrives as remote_refused. */
  const call = (
    request: RescheduleRequest,
    host: string,
    tool: string,
    args: Record<string, unknown>,
    writes: boolean,
  ) =>
    dispatch.callHostTool(
      { host, tool, arguments: args, writes, timeoutMs: REMOTE_TIMEOUT_MS },
      writes ? recheck(request) : Effect.succeed<RuntimeMode>("approval-required"),
    );

  /** Null: the list could not be read or names several, so whether the launch happened is unknown. */
  const findOnHost = (host: string, title: string) =>
    dispatch
      .callHostTool(
        {
          host,
          tool: "goat_thread_list",
          arguments: { allProjects: true, titleContains: title, limit: 20 },
          writes: false,
          timeoutMs: REMOTE_TIMEOUT_MS,
        },
        Effect.succeed<RuntimeMode>("approval-required"),
      )
      .pipe(
        Effect.flatMap(decodeThreadList),
        Effect.map((listed) => listed.threads.filter((entry) => entry.title === title)),
        Effect.map((matches) =>
          matches.length > 1 ? null : { threadId: matches[0]?.threadId ?? null },
        ),
        Effect.orElseSucceed(() => null),
      );

  const targetCwd = (request: RescheduleRequest, host: string) => {
    const project = request.project;
    if (project === undefined) return Effect.succeed(null);
    if (project.canonicalKey === null) return Effect.succeed(project.cwd);
    return call(request, host, "goat_project_list", { limit: 100 }, false).pipe(
      Effect.flatMap(decodeProjects),
      Effect.map(
        (listed) =>
          listed.projects.find(
            (entry) => canonicalKeyOf(entry.repositoryIdentity) === project.canonicalKey,
          )?.workspaceRoot ?? project.cwd,
      ),
      Effect.orElseSucceed(() => project.cwd),
    );
  };

  /**
   * Work leaves a host only when it does not answer now and is Lost (or Unreachable with force),
   * or when it answers and its attempt is confirmed stopped. A remembered outage is never enough:
   * the host is asked first, so one that came back keeps its work. Null means go.
   */
  const gate = (request: RescheduleRequest) =>
    Effect.gen(function* () {
      const host = request.ref.host;
      const where = host ?? "this machine";
      const probe =
        host === null
          ? { answered: true, status: yield* readLocalStatus(request.ref.threadId) }
          : yield* probeRemoteStatus(host, request.ref.threadId, "approval-required");
      if (!probe.answered) {
        const conditions = new Set(
          (yield* monitor.conditions(host)).conditions.map((condition) => condition.type),
        );
        if (conditions.has("Lost")) return null;
        if (conditions.has("Unreachable") && request.force === true) return null;
        return refused(
          "host_still_answers",
          where + " does not answer but is not Lost yet; work moves after 5 minutes unreachable.",
        );
      }
      if (request.reason === "host_unreachable") {
        return refused("host_still_answers", where + " answers again, so its work stays.");
      }
      const status = probe.status;
      if (status === null) {
        return refused("host_still_answers", "Could not read the attempt on " + where + ".");
      }
      const runId = status.run?.runId ?? null;
      // Checked before a stopped attempt is taken over: a run a person started since, even one
      // that already ended, is the caller's to read before anything moves.
      if (request.stopRunId !== undefined && runId !== null && runId !== request.stopRunId) {
        return refused(
          "host_still_answers",
          "The attempt on " + where + " is on another run now, so it stays.",
        );
      }
      if (isStopped(status)) return null;
      if (request.reason === "drain") {
        // Drain never interrupts a turn; the controller asks again between runs.
        return refused(
          "host_still_answers",
          "The attempt is running on " + where + "; drain waits for its run to end.",
        );
      }
      if (host === null) {
        return refused(
          "host_still_answers",
          "The attempt is still active on this machine; stop it first.",
        );
      }
      const recorded = yield* (request.beforeStop ?? Effect.void).pipe(Effect.result);
      if (recorded._tag === "Failure") return refused("not_allowed", recorded.failure.message);
      // The attempt runs under its own mode, which a lowered replacement mode may not cover.
      const interrupted = yield* dispatch
        .callHostTool(
          {
            host,
            tool: "goat_thread_interrupt",
            arguments: {
              threadId: request.ref.threadId,
              // Only the run just read: a run started since then is someone else's.
              ...(runId === null ? {} : { runId }),
              reason: "GOAT is moving this work to another host.",
              clientRequestId: request.clientRequestId + ":interrupt",
            },
            writes: true,
            timeoutMs: REMOTE_TIMEOUT_MS,
          },
          request.authorizeSource ?? recheck(request),
        )
        .pipe(Effect.result);
      if (interrupted._tag === "Failure") {
        const error = interrupted.failure;
        if (error instanceof RescheduleNotAllowed) return refused("not_allowed", error.message);
        if (error.reason === "host_unavailable" || error.reason === "ssh_failed") {
          yield* monitor.recordContact(host, error.message);
        }
        yield* Effect.logWarning("fleet.reschedule.interrupt_failed", {
          owner: request.owner,
          host,
          reason: error.reason,
        });
        // The interrupt may have landed with only its answer lost: the move counts as stopping it.
        return {
          _tag: "Refused",
          reason: "host_still_answers",
          message: "Could not confirm the interrupt on " + host + ": " + clip(error.message),
          stopping: true,
        } satisfies RescheduleResult;
      }
      return {
        _tag: "Refused",
        reason: "host_still_answers",
        message:
          "Interrupt requested on " +
          host +
          "; the move happens on the next reschedule once it stops.",
        stopping: true,
      } satisfies RescheduleResult;
    });

  const launchOn = (
    request: RescheduleRequest,
    target: string,
    title: string,
    resumedFrom: "branch" | "base",
    modelSelection: ModelSelection,
  ) =>
    Effect.gen(function* () {
      const cwd = yield* targetCwd(request, target);
      if (cwd === null) return refused("no_resume_point", "The request names no project folder.");
      const branch = request.workspace.branch;
      yield* claims.claim({
        clientRequestId: request.clientRequestId,
        ownerKey: request.owner,
        targetHost: target,
        title,
        branch,
      });
      const ceiling = request.permissionProfileCeiling;
      if (ceiling !== undefined && request.prepareCeiling !== undefined)
        yield* request.prepareCeiling(target);
      const launched = yield* dispatch
        .launchThread(
          {
            host: target,
            cwd,
            workspace: {
              type: "worktree",
              branch,
              baseRef: request.previousBranch ?? request.workspace.baseRef,
              startFromOrigin: request.workspace.startFromOrigin,
            },
            title,
            message: [
              request.prompt,
              "",
              resumeNote({
                fromHost: request.ref.host ?? "this machine",
                fromThreadId: request.ref.threadId,
                fromBranch: request.previousBranch,
                resumedFrom,
                newBranch: branch,
                reason: request.reason,
              }),
            ].join("\n"),
            modelSelection,
            runtimeMode: request.runtimeMode,
            callerRuntimeMode: request.callerRuntimeMode ?? request.runtimeMode,
            ...(ceiling === undefined ? {} : { permissionProfileCeiling: ceiling }),
          },
          recheck(request).pipe(Effect.asVoid),
        )
        .pipe(Effect.result);
      if (launched._tag === "Success") {
        const threadId = ThreadId.make(launched.success.threadId);
        yield* claims.settle(request.clientRequestId, threadId);
        yield* Effect.logInfo("fleet.reschedule", {
          owner: request.owner,
          from: request.ref.host,
          to: target,
          branch,
          reason: request.reason,
        });
        return {
          _tag: "Rescheduled",
          host: target,
          threadId,
          branch,
          resumedFrom,
        } satisfies RescheduleResult;
      }
      const error = launched.failure;
      if (error instanceof RescheduleNotAllowed) {
        yield* claims.release(request.clientRequestId);
        return refused("not_allowed", error.message);
      }
      // Refused before launching, so the request may place again once the destination updates.
      if (error.remoteCode === "permission_profile_unsupported") {
        yield* claims.release(request.clientRequestId);
        return refused(
          "unsupported_remote",
          target +
            " cannot hold the caller's goatclaw ceiling (permission_profile_unsupported): " +
            clip(error.message),
        );
      }
      // Only a launch that provably never started frees the request to place again. A held request
      // counts every launch failure the destination did not flag as having started.
      const notStarted = request.holdUnconfirmed
        ? error.launchMayHaveStarted !== true
        : error.launchMayHaveStarted === false;
      if (notStarted) yield* claims.release(request.clientRequestId);
      if (request.holdUnconfirmed && !notStarted) {
        yield* Effect.logWarning("fleet.reschedule.launch_unconfirmed", {
          owner: request.owner,
          target,
        });
        return unconfirmed(
          target,
          "Launch on " +
            target +
            " may have started (" +
            clip(error.message) +
            "); nothing else is launched until it is found.",
        );
      }
      yield* Effect.logWarning("fleet.reschedule.launch_failed", {
        owner: request.owner,
        target,
        reason: error.reason,
      });
      return refused(
        error.reason === "remote_refused" && /worktree/i.test(error.message)
          ? "unsupported_remote"
          : "no_capacity",
        "Launch on " +
          target +
          " failed: " +
          clip(error.message) +
          (error.launchMayHaveStarted === false
            ? ""
            : " It may have started; the next reschedule checks " + target + " for it."),
      );
    });

  const reschedule: ReschedulerShape["reschedule"] = (request) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* recheck(request);
          const title = attemptTitle(
            request.owner,
            request.clientRequestId,
            request.workspace.branch,
          );
          const resumedFrom =
            request.previousBranch !== null
              ? "branch"
              : request.replica !== null
                ? "replica"
                : "base";

          // An earlier launch for this request: settled, or of unknown outcome on its target.
          const claim = yield* claims.get(request.clientRequestId);
          if (claim?.threadId != null) {
            return {
              _tag: "Rescheduled",
              host: claim.targetHost,
              threadId: ThreadId.make(claim.threadId),
              branch: claim.branch,
              resumedFrom: resumedFrom === "replica" ? "base" : resumedFrom,
            } satisfies RescheduleResult;
          }
          let pinned: string | null = null;
          if (claim !== null) {
            const found = yield* findOnHost(claim.targetHost, claim.title);
            if (found === null && request.holdUnconfirmed)
              return unconfirmed(
                claim.targetHost,
                claim.targetHost +
                  " cannot be checked for the earlier launch now; nothing else is launched until it can.",
              );
            if (found === null) {
              return refused(
                "no_capacity",
                "An earlier launch on " +
                  claim.targetHost +
                  " may have started and " +
                  claim.targetHost +
                  " cannot be checked now; nothing else is launched until it can.",
              );
            }
            if (found.threadId !== null) {
              yield* claims.settle(request.clientRequestId, found.threadId);
              return {
                _tag: "Rescheduled",
                host: claim.targetHost,
                threadId: found.threadId,
                branch: claim.branch,
                resumedFrom: resumedFrom === "replica" ? "base" : resumedFrom,
              } satisfies RescheduleResult;
            }
            // Not listed: a held request waits for the thread to appear, since the launch may still
            // land; a person's request retries on the same host, where the branch name guards a repeat.
            if (request.holdUnconfirmed)
              return unconfirmed(
                claim.targetHost,
                "An earlier launch on " +
                  claim.targetHost +
                  " is not listed there; nothing else is launched for it.",
              );
            pinned = claim.targetHost;
            // The pin outranks placement, so it must also pass the caller's allowlist.
            if (request.allowedHosts !== undefined && !request.allowedHosts.includes(pinned))
              return refused(
                "not_allowed",
                "An earlier attempt of this move was placed on " +
                  pinned +
                  ", which the caller's goatclaw profile does not allow; nothing is launched.",
              );
          }

          const cap = request.maxAttempts ?? MAX_ATTEMPTS_PER_WORKER;
          if (request.attempt >= cap) {
            return refused(
              "budget",
              "Attempt " + request.attempt + " was the last of " + cap + ".",
            );
          }
          if (pinned !== null && request.excludeHosts?.includes(pinned) === true)
            return refused(
              "not_allowed",
              "An earlier attempt of this move was placed on " +
                pinned +
                ", which the goal now excludes.",
            );
          const blocked = yield* gate(request);
          if (blocked !== null) return blocked;
          if (resumedFrom === "replica") {
            // Goal attempts on this machine recover from their replicas in GoalRecovery; importing a
            // replica on another host waits for remote goal workers (#576).
            return refused(
              "no_resume_point",
              "Resuming from a replica is not supported yet; push the branch or resume from base.",
            );
          }

          const requested = pinned ?? request.targetHost ?? null;
          const allowed = requested === null ? request.allowedHosts : undefined;
          const placed = yield* placement.place({
            owner: request.owner,
            modelSelection: request.modelSelection,
            fallbackChain: null,
            // Moved work runs on another machine over SSH, never here or back on the old host.
            hostSelector:
              requested !== null
                ? { hosts: [requested], exclude: [...(request.excludeHosts ?? [])] }
                : allowed === undefined
                  ? { exclude: [null, ...(request.excludeHosts ?? [])] }
                  : { hosts: allowed, exclude: [null, ...(request.excludeHosts ?? [])] },
            project: { host: null, projectId: null, cwd: request.project?.cwd ?? null },
            avoidHosts: [request.ref.host],
          });
          if (placed._tag === "Refused" || placed.host === null) {
            const reasons =
              placed._tag === "Refused"
                ? placed.reasons.map(
                    (item) => (item.host ?? "this machine") + ": " + item.reason.message,
                  )
                : [];
            return refused(
              "no_capacity",
              (requested !== null
                ? requested + " cannot take the work"
                : allowed === undefined
                  ? "No host can take the work"
                  : allowed.length === 0
                    ? "The caller's goatclaw profile allows no host to take the work"
                    : "No host the caller's goatclaw profile allows (" +
                      allowed.join(", ") +
                      ") can take the work") +
                (reasons.length === 0 ? "." : " (" + reasons.join("; ") + ")."),
            );
          }
          return yield* launchOn(request, placed.host, title, resumedFrom, placed.modelSelection);
        }).pipe(
          Effect.catchTags({
            RescheduleNotAllowed: (error) => Effect.succeed(refused("not_allowed", error.message)),
          }),
        ),
      )
      .pipe(Effect.provideContext(context));

  const findMove: ReschedulerShape["findMove"] = ({ clientRequestId, owner }) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const claim = yield* claims.get(clientRequestId);
          if (claim === null) return { _tag: "NotLaunched" } as const;
          if (claim.ownerKey !== owner)
            return {
              _tag: "Unknown",
              host: claim.targetHost,
              message: "The move's claim belongs to another owner.",
            } as const;
          const settled =
            claim.threadId === null ? null : { threadId: ThreadId.make(claim.threadId) };
          const found = settled ?? (yield* findOnHost(claim.targetHost, claim.title));
          if (found === null || found.threadId === null)
            return {
              _tag: "Unknown",
              host: claim.targetHost,
              message:
                found === null
                  ? claim.targetHost + " cannot be checked for the move's launch now."
                  : "The move's launch on " + claim.targetHost + " is not listed there yet.",
            } as const;
          if (settled === null) yield* claims.settle(clientRequestId, found.threadId);
          return {
            _tag: "Launched",
            host: claim.targetHost,
            threadId: found.threadId,
            branch: claim.branch,
          } as const;
        }),
      )
      .pipe(Effect.provideContext(context));

  return Rescheduler.of({ reschedule, findMove });
});

export const layer = Layer.effect(Rescheduler, make);

/**
 * Stops a superseded attempt whose host came back: one interrupt whose reason says where the work
 * went. No message is sent, since a message would start another turn there. clientRequestId makes
 * a repeat a no-op on the remote. Fails when the host does not answer or refuses; call again later.
 */
export const fenceStaleAttempt = (input: {
  readonly ref: FleetThreadRef & { readonly host: string };
  readonly successorHost: string;
  readonly successorBranch: string;
  readonly clientRequestId: string;
  readonly authorize: Effect.Effect<RuntimeMode, RescheduleNotAllowed>;
}) =>
  Effect.gen(function* () {
    const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
    yield* dispatch.callHostTool(
      {
        host: input.ref.host,
        tool: "goat_thread_interrupt",
        arguments: {
          threadId: input.ref.threadId,
          reason: fenceNote({
            successorHost: input.successorHost,
            successorBranch: input.successorBranch,
          }),
          clientRequestId: input.clientRequestId,
        },
        writes: true,
        timeoutMs: REMOTE_TIMEOUT_MS,
      },
      input.authorize,
    );
  });
