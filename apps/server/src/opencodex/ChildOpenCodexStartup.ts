// @effect-diagnostics nodeBuiltinImport:off -- a detached ocx start must outlive this request.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { OrchestratorMcpFailure } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

export class ChildOpenCodexStartupError extends Schema.TaggedError<ChildOpenCodexStartupError>()(
  "ChildOpenCodexStartupError",
  { reason: Schema.Literals(["service_failed", "health_timeout", "spawn_failed"]) },
) {}

export interface StartInput {
  readonly binaryPath: string;
  readonly platform: string;
  readonly opencodexHome: string;
  readonly environment: NodeJS.ProcessEnv;
  /** Rechecked before every step, so revoked setup stops starting things. */
  readonly authorize: Effect.Effect<void, OrchestratorMcpFailure>;
}

export class ChildOpenCodexStartup extends Context.Service<
  ChildOpenCodexStartup,
  {
    readonly start: (
      input: StartInput,
    ) => Effect.Effect<void, ChildOpenCodexStartupError | OrchestratorMcpFailure>;
  }
>()("goat/opencodex/ChildOpenCodexStartup") {}

// OpenCodex's exact "no usable service manager" answers (src/service/orchestration.ts).
const NO_SYSTEMD = "systemd not found. Run 'ocx start' under your process supervisor.";
const DOCKER = "Docker detected. Run 'ocx start' directly instead of using the service manager.";
const WSL_HINT =
  "WSL detected: enable systemd by adding [boot] systemd=true to /etc/wsl.conf, then run 'wsl --shutdown' from Windows and reopen the distro (WSL 0.67.6+).";

/** Only exit 1 with one of those exact messages falls back to a detached start. */
export const noUsableServiceManager = (platform: string, result: ProcessRunner.ProcessRunOutput) =>
  platform === "linux" &&
  result.code === 1 &&
  !result.timedOut &&
  !result.stderrTruncated &&
  !result.stderrInvalidUtf8 &&
  [DOCKER, NO_SYSTEMD, `${NO_SYSTEMD}\n${WSL_HINT}`].includes(result.stderr.trim());

const failed = (reason: ChildOpenCodexStartupError["reason"]) =>
  new ChildOpenCodexStartupError({ reason });

const detach = Effect.fn("ChildOpenCodexStartup.detach")(function* (input: StartInput) {
  yield* input.authorize;
  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        let log: number | undefined;
        try {
          NodeFS.mkdirSync(input.opencodexHome, { recursive: true, mode: 0o700 });
          log = NodeFS.openSync(NodePath.join(input.opencodexHome, "goat-start.log"), "a", 0o600);
          const child = NodeChildProcess.spawn(input.binaryPath, ["start"], {
            detached: true,
            shell: false,
            env: { ...input.environment, OPENCODEX_HOME: input.opencodexHome },
            stdio: ["ignore", log, log],
          });
          child.once("error", reject);
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
        } catch (error) {
          reject(error);
        } finally {
          if (log !== undefined) NodeFS.closeSync(log);
        }
      }),
    catch: () => failed("spawn_failed"),
  });
});

/**
 * Starts the selected OpenCodex on this Child: its supervised service first, a detached
 * `ocx start` only on the exact no-service-manager signal, then a bounded health wait. A service
 * failure of any other kind stays a failure; GOAT never guesses past it.
 */
const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const start = Effect.fn("ChildOpenCodexStartup.start")(function* (input: StartInput) {
    const env = { ...input.environment, OPENCODEX_HOME: input.opencodexHome };
    const healthy = runner
      .run({
        command: input.binaryPath,
        args: ["health"],
        env,
        stdin: "",
        timeout: "1 second",
        maxOutputBytes: 64 * 1024,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.map((result) => result.code === 0 && !result.timedOut),
        Effect.mapError(() => failed("health_timeout")),
      );
    yield* input.authorize;
    if (yield* healthy) return;
    const result = yield* runner
      .run({
        command: input.binaryPath,
        args: ["service"],
        env,
        stdin: "",
        timeout: "30 seconds",
        maxOutputBytes: 64 * 1024,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.mapError(() => failed("service_failed")));
    yield* input.authorize;
    if (result.code !== 0 || result.timedOut) {
      if (!noUsableServiceManager(input.platform, result)) return yield* failed("service_failed");
      yield* detach(input);
    }
    yield* Effect.gen(function* () {
      yield* input.authorize;
      if (!(yield* healthy)) return yield* failed("health_timeout");
    }).pipe(
      Effect.retry({
        while: (error) =>
          error._tag === "ChildOpenCodexStartupError" && error.reason === "health_timeout",
        schedule: Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 19 })),
      }),
    );
  });
  return ChildOpenCodexStartup.of({ start });
});

export const layer = Layer.effect(ChildOpenCodexStartup, make);
