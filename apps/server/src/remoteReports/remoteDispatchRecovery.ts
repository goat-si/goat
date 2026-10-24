/**
 * remoteDispatchRecovery - settles a thread launch whose outcome this origin lost: the remote
 * call failed in transport, or the origin restarted before it recorded the remote thread.
 *
 * The destination binds a correlation id before it creates the thread, so asking it is the only
 * honest source. It answers with the binding and the thread state, or fences the id so a launch
 * still in flight can never bind later. A fence is the one proof that nothing ran; any other
 * answer, an older destination, or an unreachable host leaves the row lost and its capacity held.
 *
 * @module remoteDispatchRecovery
 */
import { RemoteResolveBindingResult } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import { decodeRemoteDispatchRows, type RemoteDispatchRow } from "./remoteDispatchRow.ts";

const decodeResolution = Schema.decodeUnknownEffect(RemoteResolveBindingResult);

type LostLaunchOutcome =
  | { readonly _tag: "rebound"; readonly waitForRun: boolean }
  | { readonly _tag: "settled" }
  | { readonly _tag: "pending" };

const resolveLostThreadLaunch = Effect.fn("remoteReports.resolveLostThreadLaunch")(function* (
  row: RemoteDispatchRow,
) {
  const ssh = yield* SshRemoteDispatch.SshRemoteDispatch;
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // The fence goes out under the origin thread's own ceiling, as the remote task cancel replay
  // does. Launching on another machine needs a full-access caller, so a link that admitted the
  // launch admits its recovery; a thread lowered or deleted since is never exceeded through it.
  const ceiling = threads.getThreadShell(row.origin_thread_id).pipe(
    Effect.map((shell) =>
      shell === null || shell.deletedAt !== null
        ? ("approval-required" as const)
        : shell.runtimeMode,
    ),
    Effect.orElseSucceed(() => "approval-required" as const),
  );
  const answer = yield* ssh.callHostTool(
    {
      host: row.host,
      tool: "goat_origin_resolve_binding",
      // A fence is a durable write on the destination; the read key is its only credential.
      writes: true,
      timeoutMs: 60_000,
      arguments: { correlationId: row.correlation_id, readKey: row.read_key },
    },
    ceiling,
  );
  const resolution = yield* decodeResolution(answer);
  const at = DateTime.formatIso(yield* DateTime.now);
  // Each write keeps its guard: a row another writer already settled is left as it is.
  const settle = (lastError: string) =>
    sql`UPDATE remote_dispatches SET state = 'cancelled', last_error = ${lastError},
        updated_at = ${at}
        WHERE correlation_id = ${row.correlation_id} AND state = 'lost' AND remote_thread_id IS NULL
        RETURNING correlation_id`.pipe(Effect.map((changed) => changed.length > 0));
  const settled = (changed: boolean): LostLaunchOutcome =>
    changed ? { _tag: "settled" } : { _tag: "pending" };
  if (resolution._tag === "fenced") {
    return settled(
      yield* settle(
        `The launch never reached ${row.host}; it is fenced there, so it cannot start late.`,
      ),
    );
  }
  if (resolution.threadDeleted) {
    return settled(yield* settle(`The launched thread was deleted on ${row.host}.`));
  }
  // Bound but no thread yet: the launch may still be creating it, or fail and unbind. Ask again.
  if (!resolution.threadExists) return { _tag: "pending" } as const satisfies LostLaunchOutcome;
  // A destination that answers resolve also serves reports, so the row resumes as a normal
  // running dispatch; without an active run the drain follows the latest run, as at startup.
  const rebound = yield* sql`UPDATE remote_dispatches SET remote_thread_id = ${resolution.threadId},
      launched_run_id = ${resolution.activeRunId}, reports_supported = 1, state = 'running',
      last_error = NULL, updated_at = ${at}
      WHERE correlation_id = ${row.correlation_id} AND state = 'lost' AND remote_thread_id IS NULL
      RETURNING correlation_id`;
  // Another writer settled the row first; it owns any drain, so this pass starts none.
  if (rebound.length === 0) return { _tag: "pending" } as const satisfies LostLaunchOutcome;
  return {
    _tag: "rebound",
    waitForRun: resolution.activeRunId === null,
  } as const satisfies LostLaunchOutcome;
});

// A launch the origin lost may still bind on a slow destination; ask only after this long.
const LOST_RESOLVE_AFTER_MS = 10 * 60_000;
// An inconclusive answer (unreachable host, older GOAT, thread not created yet) is asked again later.
const LOST_RESOLVE_RETRY_MS = 5 * 60_000;

/** One pass over this origin's lost thread launches; it never fails, it logs and asks again. */
export const resolveLostThreadLaunches = Effect.fn("remoteReports.resolveLostThreadLaunches")(
  function* <E>(input: {
    /** Per correlation id, when an inconclusive row may be asked again. Owned by the caller. */
    readonly retryAt: Map<string, number>;
    readonly start: (id: string, waitForRun: boolean) => Effect.Effect<unknown, E>;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const nowMs = yield* Clock.currentTimeMillis;
    const lost = yield* sql`SELECT * FROM remote_dispatches WHERE kind = 'thread'
      AND state = 'lost' AND remote_thread_id IS NULL`.pipe(
      Effect.flatMap(decodeRemoteDispatchRows),
    );
    for (const row of lost) {
      const id = row.correlation_id;
      if (Date.parse(row.updated_at) > nowMs - LOST_RESOLVE_AFTER_MS) continue;
      if ((input.retryAt.get(id) ?? 0) > nowMs) continue;
      input.retryAt.set(id, nowMs + LOST_RESOLVE_RETRY_MS);
      yield* resolveLostThreadLaunch(row).pipe(
        Effect.tap((outcome) => {
          if (outcome._tag !== "pending") input.retryAt.delete(id);
          return outcome._tag === "rebound" ? input.start(id, outcome.waitForRun) : Effect.void;
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("Lost remote launch not resolved yet.", { correlationId: id, cause }),
        ),
      );
    }
  },
  Effect.catchCause((cause) => Effect.logWarning("Lost remote launch pass failed.", { cause })),
);
