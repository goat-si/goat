// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import * as NodeChildProcess from "node:child_process";

import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { signalProcessGroup } from "@goat/provider-core/server/processGroup";
import { guardChild } from "@goat/shared/errorGuards";

// fd 4 gates the launch until the server has recorded the process it is about to become.
const CLAUDE_GROUP_WATCH_SCRIPT = [
  "read -r _ <&4 || exit 1",
  "exec 4<&-",
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'cd -P -- "$1" || exit 125',
  "shift",
  'exec "$@" 3<&-',
].join("\n");

/**
 * Kill the CLI's group on exit to stop MCP grandchildren; `onExit` stops its agent scope for
 * setsid daemons. The CLI keeps working after its pipes close, so a watcher stops the group on
 * EOF from a pipe only this server holds, including when the server crashes. `register` records
 * the CLI before it may run, so a restarted server can reap it if the watcher did not.
 */
export function spawnClaudeProcessGroup(
  options: SpawnOptions,
  onExit?: () => void,
  onStderr: (text: string) => void = () => {},
  onStderrClose: () => void = () => {},
  register?: (pid: number) => () => void,
): SpawnedProcess & Pick<NodeChildProcess.ChildProcess, "pid"> {
  const cwd = options.cwd ?? ".";
  const child = guardChild(
    NodeChildProcess.spawn(
      "/bin/sh",
      [
        "-c",
        CLAUDE_GROUP_WATCH_SCRIPT,
        "goat-claude",
        cwd.startsWith("/") ? cwd : `./${cwd}`,
        options.command,
        ...options.args,
      ],
      {
        env: options.env,
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
        detached: true,
      },
    ),
    // The SDK reports the CLI exit after any broken pipe ends the process.
    () => child.kill("SIGKILL"),
  );
  let forget: (() => void) | undefined;
  child.stderr?.setEncoding("utf8").on("data", onStderr).once("close", onStderrClose);
  child.once("exit", () => {
    try {
      signalProcessGroup(child.pid ?? 0, "SIGKILL");
    } catch {}
    try {
      forget?.();
    } catch {}
    onExit?.();
  });
  const gate = child.stdio[4];
  if (child.pid !== undefined && gate !== null && gate !== undefined && "end" in gate) {
    try {
      forget = register?.(child.pid);
      gate.end("ready\n");
    } catch (cause) {
      child.kill("SIGKILL");
      gate.destroy();
      throw cause;
    }
  }
  // Node's typings make stdin and stdout nullable once stdio has a fourth entry; both are pipes.
  return child as SpawnedProcess & Pick<NodeChildProcess.ChildProcess, "pid">;
}

export function spawnClaudeWindowsProcess(
  options: SpawnOptions,
  onStderr: (chunk: string) => void,
): SpawnedProcess {
  const child = guardChild(
    NodeChildProcess.spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }),
    // The SDK reports the CLI exit after any broken pipe ends the process.
    () => child.kill("SIGKILL"),
  );
  child.stderr.setEncoding("utf8").on("data", onStderr);
  return child;
}
