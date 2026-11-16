import {
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpFailure,
  OriginBoundForceStopResult,
  type RunId,
  type RuntimeMode,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { hostFailure } from "../mcp/hostFailure.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";

/** Why a remote task's Force stop was refused here or by its host; nothing was stopped. */
const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "task_not_cancellable", message });
const MODE_CEILING_CODES = new Set([
  "runtime_mode_escalation_denied",
  "interaction_mode_escalation_denied",
]);
/** The child runs in a broader mode than the caller may write to; only a person can force it. */
export const forceModeRefusal = (detail: string, host?: string) =>
  refused(
    `mode: Force stop was refused: ${detail} A person${host === undefined ? "" : ` on ${host}`} must use Force stop on that thread.`,
  );
const unreadable = (message: string) => () =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });
const decodeCapabilities = Schema.decodeUnknownEffect(OrchestratorMcpCapabilitiesResult);
const decodeResult = Schema.decodeUnknownEffect(OriginBoundForceStopResult);
/** The host's own refusal is the caller's answer; a transport failure keeps its host facts. */
const fromHost =
  (host: string) =>
  <E>(error: E | SshRemoteDispatch.SshRemoteDispatchError) =>
    error instanceof SshRemoteDispatch.SshRemoteDispatchError
      ? error.reason === "remote_refused"
        ? MODE_CEILING_CODES.has(error.remoteCode ?? "")
          ? forceModeRefusal(error.message, host)
          : refused(error.message)
        : hostFailure(error)
      : error;

/**
 * goat#2338: the parent's Force stop of its remote task, carried out by the host. Only a host
 * that advertises features.taskForceStop is asked; an older one is sent nothing.
 */
export const forceStopRemoteTask = Effect.fn("remoteReports.forceStopRemoteTask")(function* <E, R>(
  correlationId: string,
  authorize: Effect.Effect<RuntimeMode, E, R>,
) {
  const sql = yield* SqlClient.SqlClient;
  const ssh = yield* SshRemoteDispatch.SshRemoteDispatch;
  const [row] = yield* sql<{
    readonly host: string;
    readonly threadId: ThreadId | null;
    readonly runId: RunId | null;
    readonly readKey: string;
    readonly state: string;
  }>`
    SELECT host, remote_thread_id AS "threadId", launched_run_id AS "runId",
      read_key AS "readKey", state
    FROM remote_dispatches WHERE correlation_id = ${correlationId} AND kind = 'task'
  `.pipe(Effect.mapError(unreadable("The remote task could not be read.")));
  if (row === undefined || !["launching", "running", "idle"].includes(row.state))
    return yield* refused(
      "not_unresponsive: the remote task already ended, so nothing was stopped.",
    );
  const { host, threadId, runId, readKey } = row;
  if (threadId === null || runId === null)
    return yield* refused(
      `not_unresponsive: the remote task has no launched run on ${host} yet, so nothing was stopped.`,
    );
  const capabilities = yield* ssh
    .callHostTool(
      { host, tool: "orchestrator_capabilities", arguments: {}, timeoutMs: 30_000, writes: false },
      authorize,
    )
    .pipe(
      Effect.mapError((error) =>
        error instanceof SshRemoteDispatch.SshRemoteDispatchError ? hostFailure(error) : error,
      ),
      Effect.flatMap((answer) =>
        decodeCapabilities(answer).pipe(
          Effect.mapError(
            unreadable(`GOAT on ${host} answered capabilities this machine cannot read.`),
          ),
        ),
      ),
    );
  if (capabilities.features.taskForceStop !== true)
    return yield* refused(
      `remote: GOAT on ${host} predates force stop of remote tasks, so nothing was stopped. Update GOAT on ${host}, or ask a person there to Force stop thread ${threadId}.`,
    );
  const answer = yield* ssh
    .callHostTool(
      {
        host,
        tool: "goat_origin_force_stop",
        arguments: { correlationId, readKey, threadId, runId },
        timeoutMs: 120_000,
        writes: true,
      },
      authorize,
    )
    .pipe(Effect.mapError(fromHost(host)));
  const forced = yield* decodeResult(answer).pipe(
    Effect.mapError(
      unreadable(
        `GOAT on ${host} force stopped the run but answered unreadably; read the task with task.read.`,
      ),
    ),
  );
  return { host, ...forced };
});
