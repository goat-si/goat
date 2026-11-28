import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as HostProcess from "@goat/shared/HostProcess";

import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";

const RELEASE_GRACE = Duration.seconds(60);
const WINDOWS_IDLE_EXECUTION_STATE = 2147483649;
const WINDOWS_DISPLAY_EXECUTION_STATE = 2147483651;

export type KeepAwakeAssertion = "idle" | "display";

export type KeepAwakeWanted = boolean | KeepAwakeAssertion | "unknown" | "disabled";

export function supportsKeepAwake(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

function inhibitorCommand(
  platform: NodeJS.Platform,
  serverPid: number,
  level: KeepAwakeAssertion = "idle",
): { readonly command: string; readonly args: ReadonlyArray<string> } | undefined {
  switch (platform) {
    case "darwin":
      return {
        command: "caffeinate",
        args:
          level === "display"
            ? ["-d", "-i", "-w", String(serverPid)]
            : ["-i", "-w", String(serverPid)],
      };
    case "linux":
      return {
        command: "systemd-inhibit",
        args: [
          level === "display" ? "--what=idle:sleep" : "--what=sleep",
          "--who=GOAT",
          "--why=Agents are working",
          "--mode=block",
          "tail",
          `--pid=${serverPid}`,
          "-f",
          "/dev/null",
        ],
      };
    case "win32": {
      const flags =
        level === "display" ? WINDOWS_DISPLAY_EXECUTION_STATE : WINDOWS_IDLE_EXECUTION_STATE;
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$t = Add-Type -Name Power -Namespace GOAT -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [void]$t::SetThreadExecutionState([uint32]${flags}); Wait-Process -Id ${serverPid}`,
        ],
      };
    }
    default:
      return undefined;
  }
}

function normalizeWanted(value: KeepAwakeWanted): KeepAwakeAssertion | "idle_grace" | "release" {
  if (value === "display") return "display";
  if (value === true || value === "idle") return "idle";
  if (value === false) return "idle_grace";
  return "release";
}

function combineActivityWanted(
  runActive: boolean | "unknown",
  desktopCuaActive: boolean,
): KeepAwakeWanted {
  if (desktopCuaActive) return "display";
  if (runActive === true) return "idle";
  return runActive;
}

export const holdWhileWanted = <E, R>(
  wanted: Stream.Stream<KeepAwakeWanted, E, R>,
  hold: Effect.Effect<void> | ((level: KeepAwakeAssertion) => Effect.Effect<void>),
  grace: Duration.Input = RELEASE_GRACE,
) => {
  const acquire = Effect.isEffect(hold) ? () => hold : hold;
  return wanted.pipe(
    Stream.map(normalizeWanted),
    Stream.changes,
    Stream.switchMap((state) =>
      state === "idle_grace"
        ? Stream.fromEffect(Effect.as(Effect.sleep(grace), undefined))
        : Stream.succeed(state === "release" ? undefined : state),
    ),
    Stream.changes,
    Stream.switchMap((level) =>
      level === undefined ? Stream.empty : Stream.fromEffect(acquire(level)),
    ),
    Stream.runDrain,
  );
};

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
    const platform = yield* HostProcess.Platform;
    if (!supportsKeepAwake(platform)) return;
    const settings = yield* Settings.ServerSettingsService;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const leases = yield* Effect.serviceOption(ComputerUseLeases.ComputerUseLeases);

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

    const desktopCuaStream = Option.match(leases, {
      onNone: () => undefined,
      onSome: (service) => service.desktopControlActive,
    });

    const wantedActivity =
      desktopCuaStream === undefined
        ? active.pipe(Stream.map((runActive) => combineActivityWanted(runActive, false)))
        : Stream.suspend(() => {
            let runActive: boolean | "unknown" = false;
            let desktopCuaActive = false;
            const runStream = active.pipe(
              Stream.map((value) => {
                runActive = value;
                return combineActivityWanted(runActive, desktopCuaActive);
              }),
            );
            const cuaStream = desktopCuaStream.pipe(
              Stream.map((value) => {
                desktopCuaActive = value;
                return combineActivityWanted(runActive, desktopCuaActive);
              }),
            );
            return Stream.merge(runStream, cuaStream);
          });

    const hold = (level: KeepAwakeAssertion) => {
      const command = inhibitorCommand(platform, process.pid, level);
      if (command === undefined) return Effect.void;
      return spawner
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
            Effect.logInfo("keep-awake holding sleep inhibitor", {
              pid: Number(child.pid),
              level,
            }),
          ),
          Effect.tap(() =>
            Effect.addFinalizer(() =>
              Effect.logInfo("keep-awake released sleep inhibitor", { level }),
            ),
          ),
          Effect.flatMap((child) => child.exitCode),
          Effect.flatMap((exitCode) =>
            Effect.fail(new KeepAwakeInhibitorExited({ exitCode: Number(exitCode) })),
          ),
          Effect.scoped,
          retryWithBackoff("keep-awake sleep inhibitor stopped"),
          Effect.ignore,
        );
    };

    yield* forkParked(
      holdWhileWanted(
        enabled.pipe(
          Stream.changes,
          Stream.switchMap((on) =>
            on ? wantedActivity : Stream.succeed<KeepAwakeWanted>("disabled"),
          ),
        ),
        hold,
      ).pipe(Effect.catchCause((cause) => Effect.logWarning("keep-awake stopped", { cause }))),
    );
  }),
);
