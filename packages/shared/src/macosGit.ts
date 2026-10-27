// @effect-diagnostics nodeBuiltinImport:off -- Async native Xcode command lookup.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export const locateXcodeGitWithXcrun = Effect.fn("shell.locateXcodeGit")((env: NodeJS.ProcessEnv) =>
  Effect.callback<string | undefined>((resume) => {
    let child: NodeChildProcess.ChildProcess;
    try {
      // xcrun honors DEVELOPER_DIR and the xcode-select choice, as the shim does.
      child = NodeChildProcess.execFile(
        "/usr/bin/xcrun",
        ["--find", "git"],
        {
          encoding: "utf8",
          env,
          timeout: 5_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
          killSignal: "SIGKILL",
        },
        (error, stdout) => {
          const located = error ? "" : stdout.trim();
          resume(Effect.succeed(NodePath.isAbsolute(located) ? located : undefined));
        },
      );
    } catch {
      resume(Effect.succeed(undefined));
      return;
    }
    return Effect.sync(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
  }).pipe(Effect.timeoutOption("5 seconds"), Effect.map(Option.getOrUndefined)),
);
