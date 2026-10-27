// @effect-diagnostics nodeBuiltinImport:off -- Kill the captured helper without recursively spawning taskkill.
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class WindowsTaskkillError extends Schema.TaggedError<WindowsTaskkillError>()(
  "WindowsTaskkillError",
  { pid: Schema.Number, cause: Schema.Defect() },
) {
  override get message() {
    return "Owned Windows process tree termination failed.";
  }
}

export const terminateWindowsTree = Effect.fn("WindowsTaskkill.terminateTree")((pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return Effect.fail(new WindowsTaskkillError({ pid, cause: new Error("Invalid owned PID.") }));
  }
  return Effect.callback<void, WindowsTaskkillError>((resume) => {
    const helper = NodeChildProcess.execFile(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024, killSignal: "SIGKILL" },
      (error) =>
        resume(error ? Effect.fail(new WindowsTaskkillError({ pid, cause: error })) : Effect.void),
    );
    return Effect.sync(() => {
      if (helper.exitCode === null) helper.kill("SIGKILL");
    });
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.mapError((cause) =>
      cause instanceof WindowsTaskkillError ? cause : new WindowsTaskkillError({ pid, cause }),
    ),
    Effect.interruptible,
  );
});
