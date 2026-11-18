import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as HostProcess from "@goat/shared/HostProcess";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";

// Bridges gaps between back-to-back runs, so a long-idle machine does not sleep mid-queue.
const RELEASE_GRACE = Duration.seconds(60);

/** Each command holds its inhibitor until it exits, and exits on its own if the server dies. */
export function supportsKeepAwake(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

function inhibitorCommand(
  platform: NodeJS.Platform,
  serverPid: number,
): { readonly command: string; readonly args: ReadonlyArray<string> } | undefined {
  switch (platform) {
    case "darwin":
      return { command: "caffeinate", args: ["-i", "-w", String(serverPid)] };
    case "linux":
      return {
        command: "systemd-inhibit",
        args: [
          "--what=idle:sleep",
          "--who=GOAT",
          "--why=Agents are working",
          "--mode=block",
          "tail",
          `--pid=${serverPid}`,
          "-f",
          "/dev/null",
        ],
      };
    case "win32":
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by this thread until Wait-Process returns.
          `$t = Add-Type -Name Power -Namespace GOAT -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [void]$t::SetThreadExecutionState([uint32]2147483649); Wait-Process -Id ${serverPid}`,
        ],
      };
    default:
      return undefined;
  }
}

/**
 * Grace applies only to a confirmed idle snapshot. Disable and unknown activity release immediately.
 */
export const holdWhileWanted = <E, R>(
  wanted: Stream.Stream<boolean | "unknown" | "disabled", E, R>,
  hold: Effect.Effect<void>,
  grace: Duration.Input = RELEASE_GRACE,
) =>
  wanted.pipe(
    Stream.changes,
    Stream.switchMap((on) =>
      on === false
        ? Stream.fromEffect(Effect.as(Effect.sleep(grace), false))
        : Stream.succeed(on === true),
    ),
    Stream.changes,
    Stream.switchMap((on) => (on ? Stream.fromEffect(hold) : Stream.empty)),
    Stream.runDrain,
  );

// Cap retries for a host without an inhibitor, such as Linux without logind.
const backoff = Schedule.exponential("5 seconds").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.minutes(10))),
  ),
);
const retryWithBackoff =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapCause((cause) => Effect.logWarning(message, { cause })),
      Effect.retry(backoff),
    );

class KeepAwakeInhibitorExited extends Schema.TaggedError<KeepAwakeInhibitorExited>()(
  "KeepAwakeInhibitorExited",
  { exitCode: Schema.Number },
) {}

// Include the recovery index predicate verbatim so SQLite can seek the active statuses.
export const ACTIVE_RUN_SNAPSHOT_SQL = `SELECT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs
        WHERE status IN ('preparing', 'starting', 'running')
          AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
      ) AS active`;

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const command = inhibitorCommand(yield* HostProcess.Platform, process.pid);
    if (command === undefined) return;
    const settings = yield* Settings.ServerSettingsService;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const hasActiveRun = sql.unsafe<{ readonly active: number }>(ACTIVE_RUN_SNAPSHOT_SQL).pipe(
      Effect.map((rows) => rows[0]?.active === 1),
      Effect.timeout("5 seconds"),
    );
    // Read the cursor before the snapshot so a run changing in between is replayed, not missed.
    const active = Stream.unwrap(
      events.latestApplicationSequence.pipe(
        Effect.timeout("5 seconds"),
        Effect.map((afterSequence) =>
          Stream.concat(
            Stream.succeed(undefined),
            events
              .streamApplicationEvents({ afterSequence })
              .pipe(
                Stream.filter(
                  (stored) =>
                    "event" in stored &&
                    (stored.event.type === "run.created" || stored.event.type === "run.updated"),
                ),
              ),
          ),
        ),
      ),
    ).pipe(
      Stream.mapEffect(() => hasActiveRun),
      // A failed subscription resubscribes, which re-reads the cursor and the snapshot.
      Stream.tapError((cause) =>
        Effect.logWarning("keep-awake could not read run activity", { cause }),
      ),
      Stream.catch((cause) =>
        Stream.concat(Stream.succeed("unknown" as const), Stream.fail(cause)),
      ),
      Stream.retry(Schedule.spaced("5 seconds")),
    );
    const enabled = Stream.unwrap(
      Effect.gen(function* () {
        const changes = yield* settings.subscribeChanges;
        const current = yield* settings.getSettings.pipe(
          Effect.map((value) => value.keepAwakeWhileAgentsWork),
          Effect.tapError((cause) =>
            Effect.logWarning("keep-awake could not read settings", { cause }),
          ),
          Effect.orElseSucceed(() => false),
        );
        return Stream.concat(
          Stream.succeed(current),
          Stream.map(changes, (value) => value.keepAwakeWhileAgentsWork),
        );
      }),
    );

    const holdOnce = spawner
      .spawn(
        ChildProcess.make(command.command, command.args, {
          detached: false,
          forceKillAfter: "2 seconds",
          shell: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.tap((child) =>
          Effect.logInfo("keep-awake holding sleep inhibitor", { pid: Number(child.pid) }),
        ),
        Effect.tap(() =>
          Effect.addFinalizer(() => Effect.logInfo("keep-awake released sleep inhibitor")),
        ),
        Effect.flatMap((child) => child.exitCode),
        Effect.flatMap((exitCode) =>
          Effect.fail(new KeepAwakeInhibitorExited({ exitCode: Number(exitCode) })),
        ),
        Effect.scoped,
      );
    const hold = holdOnce.pipe(
      retryWithBackoff("keep-awake sleep inhibitor stopped"),
      Effect.ignore,
    );

    yield* forkParked(
      holdWhileWanted(
        enabled.pipe(
          Stream.changes,
          Stream.switchMap((on) => (on ? active : Stream.succeed("disabled" as const))),
        ),
        hold,
      ).pipe(Effect.catchCause((cause) => Effect.logWarning("keep-awake stopped", { cause }))),
    );
  }),
);
