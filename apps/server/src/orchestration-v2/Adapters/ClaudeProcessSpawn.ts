// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import * as NodeChildProcess from "node:child_process";

import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { signalProcessGroup } from "@goat/provider-core/server/processGroup";
import { guardChild } from "@goat/shared/errorGuards";

const CLAUDE_GROUP_WATCH_SCRIPT = [
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'exec "$@" 3<&-',
].join("\n");

/**
 * Kill the CLI's group on exit to stop MCP grandchildren; `onExit` stops its agent scope for
 * setsid daemons. The CLI keeps working after its pipes close, so a watcher stops the group on
 * EOF from a pipe only this server holds, including when the server crashes.
 */
export function spawnClaudeProcessGroup(
  options: SpawnOptions,
  onExit?: () => void,
): SpawnedProcess {
  const child = guardChild(
    NodeChildProcess.spawn(
      "/bin/sh",
      ["-c", CLAUDE_GROUP_WATCH_SCRIPT, "goat-claude", options.command, ...options.args],
      {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        stdio: ["pipe", "pipe", "ignore", "pipe"],
        detached: true,
      },
    ),
    // The SDK reports the CLI exit after any broken pipe ends the process.
    () => child.kill("SIGKILL"),
  );
  child.once("exit", () => {
    try {
      signalProcessGroup(child.pid ?? 0, "SIGKILL");
    } catch {}
    onExit?.();
  });
  // Node's typings make stdin and stdout nullable once stdio has a fourth entry; both are pipes.
  return child as SpawnedProcess;
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
