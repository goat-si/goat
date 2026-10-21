import {
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadStatusResult,
  type RuntimeMode,
  type ThreadId,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { isTerminalPhase, statusFromRead, threadPhase } from "../../mcp/threadStatus.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import { HostHealthMonitor, type HostConditionSet } from "./HostHealthMonitor.ts";
import {
  classifyThread,
  type ThreadHealth,
  type ThreadStatusSnapshot,
} from "./threadHealthModel.ts";

export type { HostConditionSet } from "./HostHealthMonitor.ts";
export type { ThreadHealth } from "./threadHealthModel.ts";

export interface FleetThreadRef {
  readonly host: string | null;
  readonly threadId: ThreadId;
  readonly watchId: string | null;
}

export interface HealthShape {
  readonly hostCondition: (host: string | null) => Effect.Effect<HostConditionSet>;
  readonly threadHealth: (ref: FleetThreadRef) => Effect.Effect<ThreadHealth>;
}

/** The goal controller's view of hosts and attempts (agentic-k8s.md "Interfaces"). */
export class Health extends Context.Service<Health, HealthShape>()("goat/fleet/health/Health") {}

const REMOTE_TIMEOUT_MS = 15_000;
const decodeStatus = Schema.decodeUnknownEffect(OrchestratorMcpThreadStatusResult);
const decodeRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);

const unreachable = (error: SshRemoteDispatch.SshRemoteDispatchError) =>
  error.reason === "host_unavailable" || error.reason === "ssh_failed";

/** An older GOAT has no goat_thread_status; HostThreadsMcpService falls back the same way. */
const statusUnsupported = (error: SshRemoteDispatch.SshRemoteDispatchError) =>
  error.message.includes(SshRemoteDispatch.REMOTE_THREAD_STATUS_UNSUPPORTED);

/**
 * A thread's status on another host, at most at ceiling, and whether the host answered at all.
 * callHostTool already returns the tool's payload and turns a refusal into remote_refused. status
 * is null when the host did not answer or refused. Every call is recorded as a host contact, so a
 * host that came back clears its outage here.
 */
export const probeRemoteStatus = (host: string, threadId: ThreadId, ceiling: RuntimeMode) =>
  Effect.gen(function* () {
    const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
    const monitor = yield* HostHealthMonitor;
    const read = (tool: string, args: Record<string, unknown>) =>
      dispatch
        .callHostTool(
          { host, tool, arguments: args, writes: false, timeoutMs: REMOTE_TIMEOUT_MS },
          Effect.succeed(ceiling),
        )
        .pipe(Effect.result);
    let answer = yield* read("goat_thread_status", { threadId });
    let fromRead = false;
    if (answer._tag === "Failure" && statusUnsupported(answer.failure)) {
      answer = yield* read("goat_thread_read", { threadId, limit: 1, runLimit: 2 });
      fromRead = true;
    }
    if (answer._tag === "Failure") {
      // Only a refusal proves the host answered; an unknown alias or a changed caller says
      // nothing about the host either way.
      if (unreachable(answer.failure)) yield* monitor.recordContact(host, answer.failure.message);
      const answered = answer.failure.reason === "remote_refused";
      if (answered) yield* monitor.recordContact(host, null);
      return { answered, status: null };
    }
    yield* monitor.recordContact(host, null);
    const status = fromRead
      ? yield* decodeRead(answer.success).pipe(
          Effect.map(statusFromRead),
          Effect.orElseSucceed(() => null),
        )
      : yield* decodeStatus(answer.success).pipe(Effect.orElseSucceed(() => null));
    return { answered: true, status };
  });

const readRemoteStatus = (host: string, threadId: ThreadId, ceiling: RuntimeMode) =>
  probeRemoteStatus(host, threadId, ceiling).pipe(Effect.map((probe) => probe.status));

/** A thread on this machine, from its shell row. */
export const readLocalStatus = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.deletedAt !== null) return null;
    const pending = shell.pendingRuntimeRequest ?? null;
    const runId = shell.activeRunId ?? shell.latestRunId;
    const phase = threadPhase(runId === null ? null : shell.status, pending?.kind ?? null);
    const snapshot: ThreadStatusSnapshot & { readonly terminal: boolean } = {
      phase,
      run: runId === null ? null : { runId },
      pendingRequest: pending,
      // A newer run behind the active one is queued work, as statusFromRead reads it.
      queuedRunId:
        shell.activeRunId !== null &&
        shell.latestRunId !== null &&
        shell.latestRunId !== shell.activeRunId
          ? shell.latestRunId
          : null,
      lastActivityAt: DateTime.formatIso(shell.updatedAt),
      lastErrorClass: shell.lastErrorClass ?? null,
      terminal: isTerminalPhase(phase),
    };
    return snapshot;
  });

const make = Effect.gen(function* () {
  const monitor = yield* HostHealthMonitor;
  const context = yield* Effect.context<
    | SshRemoteDispatch.SshRemoteDispatch
    | ThreadManagementService.ThreadManagementService
    | HostHealthMonitor
  >();

  const threadHealth: HealthShape["threadHealth"] = (ref) =>
    Effect.gen(function* () {
      const conditions = yield* monitor.conditions(ref.host);
      // Reads only, so the lowest runtime mode is enough and grants nothing.
      const status =
        ref.host === null
          ? yield* readLocalStatus(ref.threadId)
          : yield* readRemoteStatus(ref.host, ref.threadId, "approval-required");
      const after = ref.host === null ? conditions : yield* monitor.conditions(ref.host);
      return classifyThread({
        status,
        hostConditions: after.conditions,
        now: yield* Clock.currentTimeMillis,
      });
    }).pipe(Effect.provideContext(context));

  return Health.of({ hostCondition: monitor.conditions, threadHealth });
});

export const layer = Layer.effect(Health, make);
