import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { ChildProcessSpawner } from "effect/process";

export interface AgentProcess {
  readonly pid: number;
  readonly isRunning: () => boolean;
}

export const nodeChildAgentProcess = (child: {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null | undefined;
}): AgentProcess | undefined =>
  child.pid === undefined || child.signalCode === undefined
    ? undefined
    : { pid: child.pid, isRunning: () => child.exitCode === null && child.signalCode === null };
export const handleAgentProcess = (
  handle: ChildProcessSpawner.ChildProcessHandle,
): AgentProcess => ({ pid: Number(handle.pid), isRunning: () => Effect.runSync(handle.isRunning) });

export interface AgentScopeShape {
  readonly watch: (input: {
    readonly process: AgentProcess;
    readonly threadId?: string | undefined;
    readonly shared?: boolean | undefined;
  }) => Effect.Effect<void>;
  readonly wrap: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly name: string;
    readonly threadId?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    /** Terminals may survive restarts; agents must remain eligible for orphan cleanup. */
    readonly survivesRestart?: boolean | undefined;
    /**
     * Keep a shared process running after a tool OOM when supported.
     * Falls back to ordinary scope behavior on older systemd.
     */
    readonly shared?: boolean | undefined;
  }) => Effect.Effect<AgentScopeCommand>;
  readonly oomKilled: (threadId: string) => Effect.Effect<boolean>;
  /**
   * Reaps processes left after the owning agent exits, including setsid
   * descendants outside its process group. Preserves systemd OOM diagnosis.
   */
  readonly stop: (unit: string) => Effect.Effect<void>;
  /**
   * SIGKILLs every process in the thread's own scope, which works even while
   * the kernel throttles them. Shared scopes serve other threads and are never
   * killed here. Succeeds with whether a scope was killed.
   */
  readonly kill: (threadId: string) => Effect.Effect<boolean>;
  /**
   * Forgets the thread's scope. The session manager calls it before it opens
   * a provider session, so a scope only answers for the session that launched
   * it, even when the next session runs without one (Cursor, OpenCode).
   */
  readonly clear: (threadId: string) => Effect.Effect<void>;
}

export interface AgentScopeCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** The systemd scope the command runs in, for `stop`. */
  readonly unit?: string | undefined;
}

export const AgentScope = Context.Reference<AgentScopeShape>("@goat/shared/AgentScope", {
  defaultValue: () => ({
    watch: () => Effect.void,
    wrap: ({ command, args }) => Effect.succeed({ command, args }),
    oomKilled: () => Effect.succeed(false),
    stop: () => Effect.void,
    kill: () => Effect.succeed(false),
    clear: () => Effect.void,
  }),
});

export const AgentScopeThreadId = Context.Reference<string | undefined>(
  "@goat/shared/AgentScope/ThreadId",
  { defaultValue: () => undefined },
);

export const AGENT_OOM_SCORE_ADJ = 800;

export const RAISE_OOM_SCORE_LINE = `{ echo ${AGENT_OOM_SCORE_ADJ} >/proc/self/oom_score_adj; } 2>/dev/null`;

const LAUNCH_SCRIPT = [RAISE_OOM_SCORE_LINE, 'exec "$@"'].join("\n");

// systemd-run needs XDG_RUNTIME_DIR to reach this user's manager.
const SCOPED_LAUNCH_SCRIPT = [
  RAISE_OOM_SCORE_LINE,
  ': "${XDG_RUNTIME_DIR:=$1}"',
  "export XDG_RUNTIME_DIR",
  "shift",
  'exec "$@"',
].join("\n");

export interface AgentSystemdScope {
  readonly systemdRun: string;
  readonly slice: string;
  readonly unit: string;
  readonly runtimeDir: string;
  readonly options: ReadonlyArray<string>;
}

/** Exec at every step preserves the agent PID, stdio, and signals; systemd-run places it and descendants in the scope. */
export function agentScopeCommand(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly scope?: AgentSystemdScope | undefined;
}): AgentScopeCommand {
  const { command, args, scope } = input;
  if (scope === undefined) {
    return { command: "/bin/sh", args: ["-c", LAUNCH_SCRIPT, "t3-agent", command, ...args] };
  }
  return {
    command: "/bin/sh",
    args: [
      "-c",
      SCOPED_LAUNCH_SCRIPT,
      "t3-agent",
      scope.runtimeDir,
      scope.systemdRun,
      "--user",
      "--scope",
      "--quiet",
      `--slice=${scope.slice}`,
      `--unit=${scope.unit}`,
      ...scope.options,
      "--",
      command,
      ...args,
    ],
  };
}
