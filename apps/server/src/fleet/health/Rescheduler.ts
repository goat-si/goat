import {
  type FleetOwnerKey,
  type ModelSelection,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { isTerminalPhase } from "../../mcp/threadStatus.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import { FleetRescheduleClaims } from "./FleetHostStates.ts";
import { probeRemoteStatus, readLocalStatus, type FleetThreadRef } from "./Health.ts";
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
  | { readonly _tag: "Refused"; readonly reason: RescheduleRefusal; readonly message: string };

export interface ReschedulerShape {
  readonly reschedule: (request: RescheduleRequest) => Effect.Effect<RescheduleResult>;
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

  /** Null: the list could not be read, so whether the launch happened is unknown. */
  const findOnHost = (request: RescheduleRequest, host: string, title: string) =>
    call(
      request,
      host,
      "goat_thread_list",
      { allProjects: true, titleContains: title, limit: 20 },
      false,
    ).pipe(
      Effect.flatMap(decodeThreadList),
      Effect.map((listed) => ({
        threadId: listed.threads.find((entry) => entry.title === title)?.threadId ?? null,
      })),
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
      const stopped =
        (isTerminalPhase(status.phase) || status.phase === "idle") &&
        status.queuedRunId === null &&
        status.pendingRequest === null;
      if (stopped) return null;
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
      const interrupted = yield* call(
        request,
        host,
        "goat_thread_interrupt",
        {
          threadId: request.ref.threadId,
          reason: "GOAT is moving this work to another host.",
          clientRequestId: request.clientRequestId + ":interrupt",
        },
        true,
      ).pipe(Effect.result);
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
        return refused(
          "host_still_answers",
          "Could not interrupt the attempt on " + host + ": " + clip(error.message),
        );
      }
      return refused(
        "host_still_answers",
        "Interrupt requested on " +
          host +
          "; the move happens on the next reschedule once it stops.",
      );
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
            callerRuntimeMode: request.runtimeMode,
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
      // Only a launch that provably never started frees the request to place again.
      if (error.launchMayHaveStarted === false) yield* claims.release(request.clientRequestId);
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
            const found = yield* findOnHost(request, claim.targetHost, title);
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
            // Confirmed absent: retry on the same host, where the branch name also guards a repeat.
            pinned = claim.targetHost;
          }

          if (request.attempt >= MAX_ATTEMPTS_PER_WORKER) {
            return refused(
              "budget",
              "Attempt " + request.attempt + " was the last of " + MAX_ATTEMPTS_PER_WORKER + ".",
            );
          }
          const blocked = yield* gate(request);
          if (blocked !== null) return blocked;
          if (resumedFrom === "replica") {
            // Replica import at the destination lands with replica capture for goal attempts (#525).
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
                ? { hosts: [requested] }
                : allowed === undefined
                  ? { exclude: [null] }
                  : { hosts: allowed, exclude: [null] },
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

  return Rescheduler.of({ reschedule });
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
