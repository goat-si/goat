import * as HostProcess from "@goat/shared/HostProcess";
import {
  buildEnvironmentCaptureCommand,
  extractEnvironmentValues,
  listLoginShellCandidates,
  mergePathEntries,
} from "@goat/shared/shell";
import * as Effect from "effect/Effect";
import type * as VcsProcess from "../vcs/VcsProcess.ts";

const names = ["PATH", "__MISE_DIFF", "JAVA_HOME"] as const;

export const refreshDiscoveryPath = Effect.fn("SourceControlDiscovery.refreshPath")(function* (
  process: VcsProcess.VcsProcess["Service"],
  cwd: string,
) {
  const platform = yield* HostProcess.Platform;
  if (platform !== "darwin" && platform !== "linux") return;
  const env = yield* HostProcess.Environment;
  const [shell] = listLoginShellCandidates(platform, env.SHELL);
  if (!shell) return;
  const output = yield* process
    .run({
      operation: "source-control.discovery.refreshPath",
      command: shell,
      args: ["-ilc", buildEnvironmentCaptureCommand(shell, names)],
      cwd,
      env,
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    })
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Login shell PATH refresh failed", { cause }).pipe(Effect.as(null)),
      ),
    );
  if (!output || output.stdoutTruncated || output.stdoutInvalidUtf8) return;
  const captured = extractEnvironmentValues(output.stdout, names);
  if (!captured.PATH) return;
  env.PATH = mergePathEntries(captured.PATH, env.PATH, platform);
  if (captured.__MISE_DIFF) env.__MISE_DIFF = captured.__MISE_DIFF;
  if (!env.JAVA_HOME && captured.JAVA_HOME) env.JAVA_HOME = captured.JAVA_HOME;
});
