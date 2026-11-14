// @effect-diagnostics nodeBuiltinImport:off - probes the host's env executable.
import * as NodeChildProcess from "node:child_process";
import { guardChild } from "./errorGuards.ts";

const ENV = "/usr/bin/env";
let chdirSupport: Promise<boolean> | undefined;

export const supportsEnvChdir = (): Promise<boolean> =>
  (chdirSupport ??= new Promise((resolve) => {
    const child = NodeChildProcess.execFile(ENV, ["-C", "/", "--", "/bin/sh", "-c", ":"], (error) =>
      resolve(error === null),
    );
    guardChild(child, () => resolve(false));
  }));

export function envTrampoline<Arg>(
  command: string,
  args: ReadonlyArray<Arg>,
  cwd: string | undefined,
) {
  if (command === "" || command === "-" || command.includes("=")) return undefined;
  return {
    command: ENV,
    args: [...(cwd === undefined ? [] : ["-C", cwd]), "--", command, ...args],
  };
}
