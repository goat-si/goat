// @effect-diagnostics nodeBuiltinImport:off -- bounded lsof execution and its real-process fixture use native APIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as HostProcess from "@goat/shared/HostProcess";

export type OpenHandleCommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
};
export type OpenHandleRunner = (uid: number) => Promise<OpenHandleCommandResult>;

const runLsof: OpenHandleRunner = (uid) =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      "lsof",
      ["-n", "-u", String(uid), "-F", "pn"],
      { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: error
            ? typeof error.code === "number" && !error.killed
              ? error.code
              : null
            : 0,
        });
      },
    );
  });

export const findOpenHandles = Effect.fn("openHandles.findOpenHandles")(function* (
  root: string,
  runner: OpenHandleRunner = runLsof,
) {
  if ((yield* HostProcess.Platform) === "win32" || process.getuid === undefined)
    return { complete: false, holders: [] };
  const uid = process.getuid();
  const result = yield* Effect.tryPromise({
    try: async () => ({ root: await NodeFSP.realpath(root), command: await runner(uid) }),
    catch: () => undefined,
  }).pipe(Effect.option);
  if (result._tag === "None") return { complete: false, holders: [] };
  const { command } = result.value;
  const complete =
    command.stderr.length === 0 &&
    (command.exitCode === 0 || (command.exitCode === 1 && command.stdout.length === 0));
  const holders: Array<{ pid: number; path: string }> = [];
  let pid: number | undefined;
  for (const line of command.stdout.split("\n")) {
    if (line.startsWith("p")) {
      const value = Number(line.slice(1));
      pid = Number.isSafeInteger(value) && value > 0 ? value : undefined;
    } else if (line.startsWith("n") && pid !== undefined) {
      const name = line.slice(1);
      const relative = NodePath.relative(result.value.root, name);
      if (
        NodePath.isAbsolute(name) &&
        (relative === "" ||
          (!NodePath.isAbsolute(relative) &&
            relative !== ".." &&
            !relative.startsWith(`..${NodePath.sep}`)))
      )
        holders.push({ pid, path: name });
    }
  }
  return { complete, holders };
});
