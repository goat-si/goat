// @effect-diagnostics nodeBuiltinImport:off -- Desktop owns the local Pen subprocess and its byte pipes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import { awaitPenReady } from "@goat/pen-protocol/ready";
import { guardChild } from "@goat/shared/errorGuards";
import type { NativePenPin } from "./DesktopPenMembers.ts";

export interface PenPipeDeps {
  readonly resolveBinary: () => Promise<string | undefined>;
  readonly spawn: (
    path: string,
    args: readonly string[],
    options: NodeChildProcess.SpawnOptions,
  ) => NodeChildProcess.ChildProcess;
  readonly requireMember: (pin: NativePenPin) => Promise<boolean>;
  readonly stateDir?: string;
  readonly signal?: AbortSignal;
}

export async function resolvePenBinary({
  platform,
  path,
}: {
  platform: NodeJS.Platform;
  path: string | undefined;
}): Promise<string | undefined> {
  const name = platform === "win32" ? "pen.exe" : "pen";
  for (const dir of (path ?? "").split(NodePath.delimiter)) {
    if (!NodePath.isAbsolute(dir)) continue;
    const candidate = NodePath.join(dir, name);
    try {
      await NodeFSP.access(candidate, NodeFS.constants.X_OK);
      const path = await NodeFSP.realpath(candidate);
      if ((await NodeFSP.stat(path)).isFile()) return path;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function openPenPipe(pin: NativePenPin, deps: PenPipeDeps) {
  if (
    !/^[a-z2-7]{26}$/.test(pin.meshId) ||
    !/^[a-z2-7]{26}$/.test(pin.nodeId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(pin.noisePub)
  )
    throw new Error("invalid Pen pin");
  if (!(await deps.requireMember(pin))) throw new Error("Pen membership unavailable");
  const binary = await deps.resolveBinary();
  if (!binary || !NodePath.isAbsolute(binary)) throw new Error("no Pen binary");
  if (deps.signal?.aborted) throw new Error("Pen dial aborted");
  const args = ["pipe", "--node", pin.nodeId, "--noise", pin.noisePub];
  if (deps.stateDir !== undefined) args.push("--home", deps.stateDir);
  args.push("@goat");
  const child = deps.spawn(binary, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let error: Error | undefined;
  let killing: Promise<void> | undefined;
  const kill = () =>
    (killing ??= new Promise<void>((resolve) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
        return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    }));
  guardChild(child, (cause) => {
    error = cause;
    void kill();
  });
  try {
    await awaitPenReady(child, pin, deps.signal ? { signal: deps.signal } : {});
    if (error || !(await deps.requireMember(pin))) throw error ?? new Error("Pen membership lost");
    if (!child.stdin || !child.stdout) throw new Error("Pen pipe is missing stdio");
    const stdin = child.stdin;
    return {
      child,
      stdout: child.stdout,
      write: (bytes: Uint8Array) =>
        new Promise<void>((resolve, reject) => {
          if (error) return reject(error);
          stdin.write(bytes, (cause) => (cause ? reject(cause) : resolve()));
        }),
      kill,
    };
  } catch (cause) {
    await kill();
    throw cause;
  }
}
