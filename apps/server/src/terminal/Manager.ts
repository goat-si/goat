// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto digest is effectful; a sync hash keeps historyPath a plain function.
import * as NodeCrypto from "node:crypto";

import {
  createAgentTerminalState,
  resetAgentTerminal,
  makeAgentTerminalOperations,
  type AgentTerminalMethods,
  type AgentTerminalSession,
  type AgentTerminalMutateInput,
} from "./AgentTerminalState.ts";
import { BoundedTerminalHistory, DEFAULT_HISTORY_BYTE_LIMIT } from "./BoundedTerminalHistory.ts";
import {
  neutralizeInheritedHistory,
  sanitizeTerminalHistoryChunk,
} from "./terminalHistoryReplay.ts";
export { BoundedTerminalHistory } from "./BoundedTerminalHistory.ts";

import {
  isWorkspaceLeaseUnavailableError,
  withWorkspaceLease,
} from "../workspace/workspaceLease.ts";
import {
  DEFAULT_TERMINAL_ID,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  type OrchestratorMcpFailure,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalObserveInput,
  type TerminalResizeInput,
  type ResourceMonitorProcessTableEntry,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalSummary,
  type TerminalWriteInput,
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
} from "@goat/contracts";
import { makeKeyedCoalescingWorker } from "@goat/shared/KeyedCoalescingWorker";
import * as KeyedLock from "@goat/shared/KeyedLock";
import { AgentScope } from "@goat/shared/AgentScope";
import * as HostProcess from "@goat/shared/HostProcess";
import { mergePathEntries } from "@goat/shared/shell";

import { acpRegistryManagedBinaryDirectories } from "@goat/provider-acp-registry/server";
import { getTerminalLabel } from "@goat/shared/terminalLabels";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerConfig from "../config.ts";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  increment,
  terminalRestartsTotal,
  terminalSessionsTotal,
} from "../observability/Metrics.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as PtyAdapter from "@goat/shared/PtyAdapter";
import { createTerminalSpawnEnv } from "./spawnEnvironment.ts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { withThreadMcpEnvironment } from "@goat/provider-core/server/mcpSession";
import { ThreadId } from "@goat/contracts";
import { terminalOutputStream } from "./OutputProtocol.ts";

export {
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
};

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
// eCryptfs permits 143-byte names.
const MAX_HISTORY_FILENAME_BYTES = 143;
const DEFAULT_PERSIST_DEBOUNCE_MS = 250;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const MAX_SUBPROCESS_POLL_INTERVAL_MS = 60_000;
// `ps` and WMI can take seconds on a loaded host and their tables are still
// valid then; the timeout only ends a query that is truly stuck.
const PROCESS_TABLE_QUERY_TIMEOUT = "15 seconds";
// closeIdle uses a short budget for its immediate inspection.
const CLOSE_IDLE_QUERY_TIMEOUT = { posix: "1 second", win32: "1500 millis" } as const;
// Discover children started without terminal input or output.
const QUIET_SUBPROCESS_SNAPSHOT_EVERY_TICKS = 30;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const MAX_TERMINAL_LABEL_LENGTH = 128;
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

class TerminalSubprocessCheckError extends Schema.TaggedError<TerminalSubprocessCheckError>()(
  "TerminalSubprocessCheckError",
  {
    cause: Schema.optional(Schema.Defect()),
    command: Schema.Literals(["powershell", "ps", "resource-monitor"]),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    timedOut: Schema.optional(Schema.Boolean),
    stdoutTruncated: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    const details = [
      this.exitCode !== undefined && this.exitCode !== null ? `exit code ${this.exitCode}` : null,
      this.timedOut ? "timed out" : null,
      this.stdoutTruncated ? "output truncated" : null,
    ]
      .filter((detail) => detail !== null)
      .join(", ");
    return `Failed to inspect terminal subprocesses with ${this.command}${details.length > 0 ? ` (${details})` : ""}`;
  }
}

class TerminalProcessSignalError extends Schema.TaggedError<TerminalProcessSignalError>()(
  "TerminalProcessSignalError",
  {
    cause: Schema.optional(Schema.Defect()),
    signal: Schema.Literals(["SIGTERM", "SIGKILL"]),
    terminalPid: Schema.Number,
  },
) {
  override get message(): string {
    return `Failed to send ${this.signal} to terminal process ${this.terminalPid}`;
  }
}

export class TerminalManager extends Context.Service<
  TerminalManager,
  {
    readonly agentList?: AgentTerminalMethods["agentList"];
    readonly agentOpen?: AgentTerminalMethods["agentOpen"];
    readonly agentRead?: AgentTerminalMethods["agentRead"];
    readonly agentMutate?: AgentTerminalMethods["agentMutate"];

    readonly open: (
      input: TerminalOpenInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    readonly getShell: (input: TerminalObserveInput) => Effect.Effect<string, TerminalError>;

    /**
     * Attached viewers share one PTY sized to the smallest of them, so a narrow client
     * still sees the whole TUI. Streams and resizes with the same `viewerId` (one client
     * connection) count as one viewer; streams without one are each their own viewer.
     */
    readonly attachStream: (
      input: TerminalAttachInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
      registerCleanup?: (stop: () => void) => void,
      viewerId?: string,
    ) => Effect.Effect<() => void, TerminalError>;

    /**
     * The `terminal.attach` RPC stream. Overflow recovery swaps the inner subscription, so
     * `viewerId` and the size it reported stay attached until the whole stream ends.
     */
    readonly attachOutputStream: (
      input: TerminalAttachInput,
      viewerId: string,
    ) => Stream.Stream<TerminalAttachStreamEvent, TerminalError>;

    readonly observeStream: (
      input: TerminalObserveInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
      registerCleanup?: (stop: () => void) => void,
    ) => Effect.Effect<() => void, TerminalError>;

    readonly resyncStream: (
      input: TerminalObserveInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
      registerCleanup?: (stop: () => void) => void,
    ) => Effect.Effect<() => void, TerminalError>;

    readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

    readonly resize: (
      input: TerminalResizeInput,
      viewerId?: string,
    ) => Effect.Effect<void, TerminalError>;

    readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

    /** Resets history before spawning. */
    readonly restart: (
      input: TerminalRestartInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    /** Omit terminalId to close all sessions for the thread. */
    readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

    readonly closeIdle: (input: {
      readonly threadId: string;
      readonly terminalId?: string;
    }) => Effect.Effect<void>;

    readonly subscribe: (
      listener: (event: TerminalEvent) => Effect.Effect<void>,
      registerCleanup?: (stop: () => void) => void,
    ) => Effect.Effect<() => void>;

    readonly subscribeMetadata: (
      listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
  }
>()("goat/terminal/Manager/TerminalManager") {}

interface TerminalSubprocessInspectResult {
  readonly hasRunningSubprocess: boolean;
  readonly childCommand: string | null;
  readonly processIds: ReadonlyArray<number>;
}

interface TerminalSubprocessInspector {
  (
    terminalPid: number,
  ): Effect.Effect<TerminalSubprocessInspectResult, TerminalSubprocessCheckError>;
}

const resizePtyProcess = (
  session: TerminalSessionState,
  process: PtyAdapter.PtyProcess,
  cols: number,
  rows: number,
) =>
  Effect.try({
    try: () => process.resize(cols, rows),
    catch: (cause) =>
      new TerminalResizeError({
        threadId: session.threadId,
        terminalId: session.terminalId,
        terminalPid: process.pid,
        cols,
        rows,
        cause,
      }),
  });

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export interface TerminalStartInput extends TerminalOpenInput {
  cols: number;
  rows: number;
}

interface TerminalSessionState extends AgentTerminalSession {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  history: BoundedTerminalHistory;
  pendingHistoryControlSequence: string;
  pendingProcessEvents: Array<PendingProcessEvent | undefined>;
  pendingProcessEventIndex: number;
  processEventDrainRunning: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  eventSequence: number;
  inputCount: number;
  cols: number;
  rows: number;
  process: PtyAdapter.PtyProcess | null;
  shell: string | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  childCommandLabel: string | null;
  runtimeEnv: Record<string, string> | null;
}

interface TerminalGrid {
  readonly cols: number;
  readonly rows: number;
}

/** One client connection attached to a terminal, possibly through several streams. */
interface TerminalViewer {
  streams: number;
  grid: TerminalGrid | null;
}

interface PersistHistoryRequest {
  history: BoundedTerminalHistory;
  immediate: boolean;
}

type PendingProcessEvent =
  | { type: "output"; data: string }
  | { type: "exit"; event: PtyAdapter.PtyExitEvent };

type DrainProcessEventAction =
  | { type: "idle" }
  | {
      type: "output";
      threadId: string;
      terminalId: string;
      sequence: number;
      history: BoundedTerminalHistory | null;
      data: string;
    }
  | {
      type: "exit";
      process: PtyAdapter.PtyProcess | null;
      threadId: string;
      terminalId: string;
      sequence: number;
      exitCode: number | null;
      exitSignal: number | null;
    };

interface TerminalManagerState {
  sessions: Map<string, TerminalSessionState>;
  killFibers: Map<PtyAdapter.PtyProcess, Fiber.Fiber<void, never>>;
}

function truncateTerminalWireLabel(value: string): string {
  if (value.length <= MAX_TERMINAL_LABEL_LENGTH) return value;
  return value.slice(0, MAX_TERMINAL_LABEL_LENGTH);
}

function normalizeChildCommandName(raw: string, platform: NodeJS.Platform): string | null {
  let trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("(") && trimmed.endsWith(")"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  const firstToken = (trimmed.split(/\s+/)[0] ?? trimmed).trim();
  if (firstToken.length === 0) return null;
  const separators = platform === "win32" ? /[\\/]/ : /\//;
  const base = firstToken.split(separators).at(-1) ?? firstToken;
  const withoutExe =
    platform === "win32" && base.toLowerCase().endsWith(".exe") ? base.slice(0, -4) : base;
  return withoutExe.length > 0 ? withoutExe : null;
}

function terminalWireLabel(session: TerminalSessionState): string {
  if (session.hasRunningSubprocess && session.childCommandLabel) {
    const trimmed = session.childCommandLabel.trim();
    if (trimmed.length > 0) {
      return truncateTerminalWireLabel(trimmed);
    }
  }
  return truncateTerminalWireLabel(getTerminalLabel(session.terminalId));
}

function snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    history: session.history.value(),
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
    sequence: session.eventSequence,
    cols: session.cols,
    rows: session.rows,
  };
}

function summary(session: TerminalSessionState): TerminalSummary {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    hasRunningSubprocess: session.hasRunningSubprocess,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
  };
}

function shouldPublishTerminalMetadataEvent(event: TerminalEvent): boolean {
  switch (event.type) {
    case "started":
    case "restarted":
    case "exited":
    case "closed":
    case "error":
    case "activity":
      return true;
    case "output":
    case "cleared":
      return false;
  }
}

function terminalEventToAttachEvent(event: TerminalEvent): TerminalAttachStreamEvent | null {
  switch (event.type) {
    case "started":
      return {
        type: "snapshot",
        snapshot: event.snapshot,
      };
    case "output":
    case "exited":
    case "closed":
    case "error":
    case "cleared":
    case "restarted":
    case "activity":
      return event;
  }
}

function isDuplicateAttachSnapshotEvent(
  event: TerminalEvent,
  initialSnapshot: TerminalSessionSnapshot,
) {
  return typeof event.sequence === "number" && typeof initialSnapshot.sequence === "number"
    ? event.sequence <= initialSnapshot.sequence
    : event.type === "started" &&
        event.snapshot.threadId === initialSnapshot.threadId &&
        event.snapshot.terminalId === initialSnapshot.terminalId &&
        event.snapshot.updatedAt <= initialSnapshot.updatedAt;
}

function advanceEventSequence(session: TerminalSessionState): {
  readonly updatedAt: string;
  readonly sequence: number;
} {
  const updatedAt = DateTime.formatIso(DateTime.nowUnsafe());
  session.eventSequence += 1;
  session.updatedAt = updatedAt;
  return { updatedAt, sequence: session.eventSequence };
}

function terminalActivityMark(session: TerminalSessionState): number {
  return session.eventSequence + session.inputCount;
}

interface QuietTerminalSession {
  readonly process: PtyAdapter.PtyProcess | null;
  readonly mark: number;
  readonly idleSnapshots: number;
}

function cleanupProcessHandles(session: TerminalSessionState): void {
  session.unsubscribeData?.();
  session.unsubscribeData = null;
  session.unsubscribeExit?.();
  session.unsubscribeExit = null;
}

function enqueueProcessEvent(
  session: TerminalSessionState,
  expectedPid: number,
  event: PendingProcessEvent,
): boolean {
  if (!session.process || session.status !== "running" || session.pid !== expectedPid) {
    return false;
  }

  session.pendingProcessEvents.push(event);
  if (session.processEventDrainRunning) {
    return false;
  }

  session.processEventDrainRunning = true;
  return true;
}

function defaultShellResolver(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    return "pwsh.exe";
  }
  return env.SHELL ?? "bash";
}

function normalizeShellCommand(
  value: string | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function basenameForPlatform(command: string, platform: NodeJS.Platform): string {
  const normalized =
    platform === "win32" ? command.replaceAll("/", "\\") : command.replaceAll("\\", "/");
  const parts = normalized
    .split(platform === "win32" ? /\\+/ : /\/+/)
    .filter((part) => part.length > 0);
  return parts.at(-1) ?? normalized;
}

function joinWindowsPath(...parts: ReadonlyArray<string>): string {
  return parts
    .map((part, index) => {
      if (index === 0) return part.replace(/[\\/]+$/g, "");
      return part.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .filter((part) => part.length > 0)
    .join("\\");
}

function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = basenameForPlatform(command, platform).toLowerCase();
  if (platform === "win32" && (shellName === "pwsh.exe" || shellName === "powershell.exe")) {
    return { shell: command, args: ["-NoLogo"] };
  }
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(
    windowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsCmdPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(windowsSystemRoot(env), "System32", "cmd.exe");
}

function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function resolveShellCandidates(
  shellResolver: () => string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ShellCandidate[] {
  const requested = shellCandidateFromCommand(
    normalizeShellCommand(shellResolver(), platform),
    platform,
  );

  if (platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand("pwsh.exe", platform),
      shellCandidateFromCommand(windowsPowerShellPath(env), platform),
      shellCandidateFromCommand("powershell.exe", platform),
      shellCandidateFromCommand(env.ComSpec ?? null, platform),
      shellCandidateFromCommand(windowsCmdPath(env), platform),
      shellCandidateFromCommand("cmd.exe", platform),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(env.SHELL, platform), platform),
    shellCandidateFromCommand("/bin/zsh", platform),
    shellCandidateFromCommand("/bin/bash", platform),
    shellCandidateFromCommand("/bin/sh", platform),
    shellCandidateFromCommand("zsh", platform),
    shellCandidateFromCommand("bash", platform),
    shellCandidateFromCommand("sh", platform),
  ]);
}

function isRetryableShellSpawnError(error: PtyAdapter.PtySpawnError): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      if (current.cause) {
        queue.push(current.cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

interface TerminalProcessTableSnapshot {
  readonly childrenByParent: ReadonlyMap<number, ReadonlyArray<number>>;
  readonly commandById: ReadonlyMap<number, string>;
}

// Idles at least four times as long as the last fallback query took, so a slow
// process table never keeps the poll loop busy most of the time.
function subprocessSnapshotPollDelayMs(
  pollIntervalMs: number,
  failureCount: number,
  queryElapsedMs: number,
): number {
  return Math.min(
    Math.max(pollIntervalMs * 2 ** failureCount, queryElapsedMs * 4),
    MAX_SUBPROCESS_POLL_INTERVAL_MS,
  );
}

function parsePosixProcessTable(stdout: string): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/g)) {
    // The final comm column can contain spaces; only the first two tokens are structural.
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    commandById.set(pid, (match[3] ?? "").trim());
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  return { childrenByParent, commandById };
}

function processTableSnapshotFromProcesses(
  processes: ReadonlyArray<ResourceMonitorProcessTableEntry>,
): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const process of processes) {
    const { pid, ppid: parentPid, name } = process;
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    commandById.set(pid, name.trim());
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  return { childrenByParent, commandById };
}

function deriveSubprocessInspectResult(
  snapshot: TerminalProcessTableSnapshot,
  terminalPid: number,
  platform: NodeJS.Platform,
): TerminalSubprocessInspectResult {
  const commandName = (pid: number) =>
    normalizeChildCommandName(snapshot.commandById.get(pid) ?? "", platform);
  const shellName = commandName(terminalPid);
  // Async prompt themes fork childless shell helpers that are not user commands.
  const childPid = (snapshot.childrenByParent.get(terminalPid) ?? []).find(
    (pid) =>
      shellName === null ||
      commandName(pid) !== shellName ||
      (snapshot.childrenByParent.get(pid)?.length ?? 0) > 0,
  );
  if (childPid === undefined) {
    return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
  }
  const processIds = new Set<number>([terminalPid]);
  const pending = [terminalPid];
  while (pending.length > 0) {
    const parentPid = pending.pop();
    if (parentPid === undefined) continue;
    for (const pid of snapshot.childrenByParent.get(parentPid) ?? []) {
      if (processIds.has(pid)) continue;
      processIds.add(pid);
      pending.push(pid);
    }
  }
  const normalized = commandName(childPid);
  return {
    hasRunningSubprocess: true,
    childCommand: normalized ? truncateTerminalWireLabel(normalized) : null,
    processIds: [...processIds],
  };
}

const POSIX_PS_ABSOLUTE_PATHS = ["/bin/ps", "/usr/bin/ps"] as const;

// Resolve ps once; bare-name spawns repeatedly probe long PATHs during one-second polling.
const resolvePosixPsCommand = Effect.fn("terminal.resolvePosixPsCommand")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of POSIX_PS_ABSOLUTE_PATHS) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  return "ps";
});

const posixProcessTableSnapshot = Effect.fn("terminal.posixProcessTableSnapshot")(function* (
  psCommand: string,
  timeout: Duration.Input,
): Effect.fn.Return<
  TerminalProcessTableSnapshot,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: psCommand,
      args: ["-eo", "pid=,ppid=,comm="],
      timeout,
      maxOutputBytes: 524_288,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new TerminalSubprocessCheckError({
            cause,
            command: "ps",
          }),
      ),
    );
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
    // Reject partial tables; treating them as authoritative would clear process ids and mark terminals idle.
    return yield* new TerminalSubprocessCheckError({
      command: "ps",
      exitCode: result.code,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
    });
  }
  return parsePosixProcessTable(result.stdout);
});

const windowsProcessTableSnapshot = Effect.fn("terminal.windowsProcessTableSnapshot")(function* (
  timeout: Duration.Input,
): Effect.fn.Return<
  TerminalProcessTableSnapshot,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const command =
    'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }';
  const result = yield* processRunner
    .run({
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
      timeout,
      maxOutputBytes: 262_144,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) => new TerminalSubprocessCheckError({ cause, command: "powershell" }),
      ),
    );
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
    return yield* new TerminalSubprocessCheckError({
      command: "powershell",
      exitCode: result.code,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
    });
  }
  const processes = result.stdout.split(/\r?\n/g).flatMap((line) => {
    const [pidRaw, ppidRaw, name = ""] = line.trim().split("|", 3);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    return Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid) ? [{ pid, ppid, name }] : [];
  });
  return processTableSnapshotFromProcesses(processes);
});

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function encodedHistoryThreadPart(threadId: string): string {
  return `terminal_${Base64Url.encode(threadId)}`;
}

function hashId(id: string): string {
  return NodeCrypto.createHash("sha256").update(id).digest("base64url");
}

// "." is outside the base64url alphabet, so a hashed name can never collide with an encoded one.
function hashedHistoryThreadPart(threadId: string): string {
  return `terminal_sha256.${hashId(threadId)}`;
}

function joinHistoryFileName(threadPart: string, terminalPart: string | null): string {
  return terminalPart === null ? `${threadPart}.log` : `${threadPart}_${terminalPart}.log`;
}

function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

interface TerminalManagerOptions {
  logsDir: string;
  historyLineLimit?: number;
  historyByteLimit?: number;
  ptyAdapter: PtyAdapter.PtyAdapter["Service"];
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  managedBinaryCacheDir?: string;
  managedBinaryToolsDir?: string;
  subprocessInspector?: TerminalSubprocessInspector;
  processTable?: Effect.Effect<
    ReadonlyArray<ResourceMonitorProcessTableEntry>,
    TerminalSubprocessCheckError
  >;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  registerTerminalProcesses?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly processIds: ReadonlyArray<number>;
  }) => Effect.Effect<void>;
  unregisterTerminal?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<void>;
  resolveProviderInstanceEnvironment?: (
    providerInstanceId: string,
    env: Record<string, string> | undefined,
  ) => Effect.Effect<
    Record<string, string>,
    TerminalProviderInstanceNotFoundError | TerminalProviderEnvironmentError
  >;
}

export const resolveProviderInstanceTerminalEnvironment = Effect.fn(
  "terminal.resolveProviderInstanceTerminalEnvironment",
)(function* (input: {
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly path: Path.Path;
  readonly rawProviderInstanceId: string;
  readonly env: Record<string, string> | undefined;
}) {
  const providerInstanceId = ProviderInstanceId.make(input.rawProviderInstanceId);
  const settings = yield* input.serverSettings.getSettings.pipe(
    Effect.mapError((cause) => new TerminalProviderEnvironmentError({ providerInstanceId, cause })),
  );
  const instance = deriveProviderInstanceConfigMap(settings)[providerInstanceId];
  if (instance === undefined) {
    return yield* new TerminalProviderInstanceNotFoundError({ providerInstanceId });
  }

  let resolved = yield* mergeProviderInstanceEnvironment(instance.environment, input.env ?? {});
  if (instance.driver === "codex") {
    const config = decodeCodexSettings(instance.config ?? {});
    if (Option.isSome(config)) {
      const layout = yield* resolveCodexHomeLayout(config.value).pipe(
        Effect.provideService(Path.Path, input.path),
      );
      if (layout.effectiveHomePath)
        resolved = { ...resolved, CODEX_HOME: layout.effectiveHomePath };
    }
  } else if (instance.driver === "claudeAgent") {
    const config = decodeClaudeSettings(instance.config ?? {});
    if (Option.isSome(config)) {
      resolved = yield* makeClaudeEnvironment(config.value, resolved).pipe(
        Effect.provideService(Path.Path, input.path),
      );
    }
  }

  return Object.fromEntries(
    Object.entries(resolved).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
});

/** @public */
export const make = Effect.fn("TerminalManager.make")(function* () {
  const { terminalLogsDir, providerStatusCacheDir, baseDir } = yield* ServerConfig.ServerConfig;
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const portDiscovery = yield* PortScanner.PortDiscovery;
  const nativeTelemetry = yield* NativeTelemetryClient.NativeTelemetryClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const resolveProviderInstanceEnvironment = Effect.fn(
    "terminal.resolveProviderInstanceEnvironment",
  )((rawProviderInstanceId: string, env: Record<string, string> | undefined) =>
    resolveProviderInstanceTerminalEnvironment({
      serverSettings,
      path,
      rawProviderInstanceId,
      env,
    }),
  );
  return yield* makeWithOptions({
    logsDir: terminalLogsDir,
    ptyAdapter,
    processTable: nativeTelemetry.processTable.pipe(
      Effect.mapError(
        (cause) => new TerminalSubprocessCheckError({ cause, command: "resource-monitor" }),
      ),
    ),
    managedBinaryCacheDir: providerStatusCacheDir,
    managedBinaryToolsDir: path.join(baseDir, "tools"),
    registerTerminalProcesses: portDiscovery.registerTerminalProcesses,
    unregisterTerminal: portDiscovery.unregisterTerminal,
    resolveProviderInstanceEnvironment,
  });
});

export const makeWithOptions = Effect.fn("TerminalManager.makeWithOptions")(function* (
  options: TerminalManagerOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const logsDir = options.logsDir;
  const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
  const historyByteLimit = options.historyByteLimit ?? DEFAULT_HISTORY_BYTE_LIMIT;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const agentScope = yield* AgentScope;
  // Inherit the full environment minus createTerminalSpawnEnv's blocklist; allowlists silently drop user tooling variables.
  const baseEnv = options.env ?? process.env;
  const shellResolver = options.shellResolver ?? (() => defaultShellResolver(platform, baseEnv));
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const resolveLaunchInputEnvironment = Effect.fn("terminal.resolveLaunchInputEnvironment")(
    function* <Input extends TerminalOpenInput | TerminalAttachInput | TerminalRestartInput>(
      input: Input,
    ): Effect.fn.Return<
      Input,
      TerminalProviderInstanceNotFoundError | TerminalProviderEnvironmentError
    > {
      if (input.providerInstanceId === undefined) return input;
      const resolver = options.resolveProviderInstanceEnvironment;
      if (resolver === undefined) {
        return yield* new TerminalProviderInstanceNotFoundError({
          providerInstanceId: ProviderInstanceId.make(input.providerInstanceId),
        });
      }
      const env = yield* resolver(input.providerInstanceId, input.env);
      return { ...input, env };
    },
  );
  // Share one process table per poll; per-terminal scans can exhaust PIDs on busy hosts.
  // Timed on success and failure so the poll loop can pace the next query.
  const posixPsCommand = platform === "win32" ? undefined : yield* resolvePosixPsCommand();
  const fallbackProcessTableSnapshot = (timeout: Duration.Input) =>
    (posixPsCommand === undefined
      ? windowsProcessTableSnapshot(timeout)
      : posixProcessTableSnapshot(posixPsCommand, timeout)
    ).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      Effect.result,
      Effect.timed,
      Effect.map(([elapsed, snapshot]) => ({
        snapshot,
        queryElapsedMs: Duration.toMillis(elapsed),
      })),
    );
  // `fallbackTimeout` only bounds the ps/WMI fallback; a native process table
  // or custom inspector is unaffected.
  const fetchProcessTableSnapshot = (
    fallbackTimeout: Duration.Input,
  ): Effect.Effect<{
    readonly snapshot: Result.Result<TerminalProcessTableSnapshot, TerminalSubprocessCheckError>;
    readonly snapshotSucceeded: boolean;
    readonly queryElapsedMs: number;
  }> =>
    options.processTable
      ? options.processTable.pipe(
          Effect.map((entries) => ({
            snapshot: Result.succeed(processTableSnapshotFromProcesses(entries)),
            snapshotSucceeded: true,
            queryElapsedMs: 0,
          })),
          Effect.catch(() =>
            fallbackProcessTableSnapshot(fallbackTimeout).pipe(
              Effect.map((fallback) => ({ ...fallback, snapshotSucceeded: false })),
            ),
          ),
        )
      : fallbackProcessTableSnapshot(fallbackTimeout).pipe(
          Effect.map((fallback) => ({
            ...fallback,
            snapshotSucceeded: Result.isSuccess(fallback.snapshot),
          })),
        );
  const customSubprocessInspector = options.subprocessInspector;
  const acquireSubprocessInspector = (
    fallbackTimeout: Duration.Input,
  ): Effect.Effect<{
    readonly inspector: Result.Result<TerminalSubprocessInspector, TerminalSubprocessCheckError>;
    readonly snapshotSucceeded: boolean;
    readonly queryElapsedMs: number;
  }> =>
    customSubprocessInspector !== undefined
      ? Effect.succeed({
          inspector: Result.succeed(customSubprocessInspector),
          snapshotSucceeded: true,
          queryElapsedMs: 0,
        })
      : Effect.map(
          fetchProcessTableSnapshot(fallbackTimeout),
          ({ snapshot, snapshotSucceeded, queryElapsedMs }) => ({
            inspector: Result.map(
              snapshot,
              (table): TerminalSubprocessInspector =>
                (terminalPid) =>
                  Effect.succeed(deriveSubprocessInspectResult(table, terminalPid, platform)),
            ),
            snapshotSucceeded,
            queryElapsedMs,
          }),
        );
  const subprocessPollIntervalMs =
    options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
  const processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
  const maxRetainedInactiveSessions =
    options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;
  const registerTerminalProcesses = options.registerTerminalProcesses ?? (() => Effect.void);
  const unregisterTerminal = options.unregisterTerminal ?? (() => Effect.void);

  yield* fileSystem.makeDirectory(logsDir, { recursive: true }).pipe(Effect.orDie);

  const managerStateRef = yield* SynchronizedRef.make<TerminalManagerState>({
    sessions: new Map(),
    killFibers: new Map(),
  });
  // Keep close markers in memory so unknown IDs recover after a server restart.
  const closedSessionKeys = new Set<string>();
  const threadLocks = yield* KeyedLock.make<string>();
  const terminalEventListeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const workerScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

  const publishEvent =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (event: TerminalEvent) {
      for (const listener of terminalEventListeners) {
        yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
      }
    });

  const encodedHistoryPath = (threadId: string, terminalId: string) =>
    path.join(
      logsDir,
      joinHistoryFileName(
        encodedHistoryThreadPart(threadId),
        terminalId === DEFAULT_TERMINAL_ID ? null : Base64Url.encode(terminalId),
      ),
    );

  const historyPath = (threadId: string, terminalId: string) => {
    const encoded = encodedHistoryPath(threadId, terminalId);
    if (path.basename(encoded).length <= MAX_HISTORY_FILENAME_BYTES) return encoded;
    return path.join(
      logsDir,
      joinHistoryFileName(
        hashedHistoryThreadPart(threadId),
        terminalId === DEFAULT_TERMINAL_ID ? null : hashId(terminalId),
      ),
    );
  };

  const legacyHistoryPath = (threadId: string) =>
    path.join(logsDir, `${legacySafeThreadId(threadId)}.log`);

  const historyPaths = (threadId: string, terminalId: string) => [
    ...new Set([
      historyPath(threadId, terminalId),
      encodedHistoryPath(threadId, terminalId),
      ...(terminalId === DEFAULT_TERMINAL_ID ? [legacyHistoryPath(threadId)] : []),
    ]),
  ];

  const historyExists = (filePath: string) => {
    const name = path.basename(filePath);
    // An oversized old path can itself fail on access. Directory entries also
    // preserve migration of such histories on filesystems with a larger limit.
    return name.length <= MAX_HISTORY_FILENAME_BYTES
      ? fileSystem.exists(filePath)
      : fileSystem.readDirectory(logsDir).pipe(Effect.map((entries) => entries.includes(name)));
  };

  const readManagerState = SynchronizedRef.get(managerStateRef);

  const modifyManagerState = <A>(
    f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
  ) => SynchronizedRef.modify(managerStateRef, f);

  const withThreadLock = <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => threadLocks.withLock(threadId, effect);

  const terminalViewers = new Map<string, Map<string, TerminalViewer>>();
  let anonymousViewerCount = 0;

  const retainViewer = (sessionKey: string, viewerId: string, grid: TerminalGrid | null) => {
    let viewers = terminalViewers.get(sessionKey);
    if (!viewers) {
      viewers = new Map();
      terminalViewers.set(sessionKey, viewers);
    }
    const viewer = viewers.get(viewerId);
    if (viewer) {
      viewer.streams += 1;
      // After a viewer's first size, resizes own it; attach retries resend the original size.
      viewer.grid ??= grid;
    } else {
      viewers.set(viewerId, { streams: 1, grid });
    }
  };

  /** Returns whether the viewer left, which can grow the shared grid. */
  const releaseViewer = (sessionKey: string, viewerId: string) => {
    const viewers = terminalViewers.get(sessionKey);
    const viewer = viewers?.get(viewerId);
    if (!viewers || !viewer) return false;
    viewer.streams -= 1;
    if (viewer.streams > 0) return false;
    viewers.delete(viewerId);
    if (viewers.size === 0) terminalViewers.delete(sessionKey);
    return true;
  };

  // The smallest attached viewer bounds each axis, so every viewer can draw the whole grid.
  const sharedViewerGrid = (sessionKey: string): TerminalGrid | null => {
    let shared: TerminalGrid | null = null;
    for (const viewer of terminalViewers.get(sessionKey)?.values() ?? []) {
      if (!viewer.grid) continue;
      shared = shared
        ? {
            cols: Math.min(shared.cols, viewer.grid.cols),
            rows: Math.min(shared.rows, viewer.grid.rows),
          }
        : viewer.grid;
    }
    return shared;
  };

  /** Attached viewers own the size; a caller's own size only applies when none has reported one. */
  const withSharedGrid = <
    A extends { readonly cols?: number | undefined; readonly rows?: number | undefined },
  >(
    sessionKey: string,
    input: A,
  ): A => {
    const shared = sharedViewerGrid(sessionKey);
    return shared ? { ...input, cols: shared.cols, rows: shared.rows } : input;
  };

  // Renderers draw the PTY grid, so every size change reaches them. It rides on activity
  // because older clients reject unknown event types.
  const resizeSession = Effect.fnUntraced(function* (
    session: TerminalSessionState,
    process: PtyAdapter.PtyProcess,
    cols: number,
    rows: number,
  ) {
    yield* resizePtyProcess(session, process, cols, rows);
    session.cols = cols;
    session.rows = rows;
    session.updatedAt = yield* nowIso;
    const eventStamp = advanceEventSequence(session);
    yield* publishEvent({
      type: "activity",
      threadId: session.threadId,
      terminalId: session.terminalId,
      sequence: eventStamp.sequence,
      hasRunningSubprocess: session.hasRunningSubprocess,
      label: terminalWireLabel(session),
      cols,
      rows,
    });
  });

  const applySharedGrid = Effect.fnUntraced(function* (threadId: string, terminalId: string) {
    const session = yield* getSession(threadId, terminalId);
    if (Option.isNone(session)) return;
    const process = session.value.process;
    const shared = sharedViewerGrid(toSessionKey(threadId, terminalId));
    if (
      !process ||
      session.value.status !== "running" ||
      !shared ||
      (shared.cols === session.value.cols && shared.rows === session.value.rows)
    ) {
      return;
    }
    yield* resizeSession(session.value, process, shared.cols, shared.rows);
  });

  const clearKillFiber = Effect.fn("terminal.clearKillFiber")(function* (
    process: PtyAdapter.PtyProcess | null,
  ) {
    if (!process) return;
    const fiber: Option.Option<Fiber.Fiber<void, never>> = yield* modifyManagerState<
      Option.Option<Fiber.Fiber<void, never>>
    >((state) => {
      const existing: Option.Option<Fiber.Fiber<void, never>> = Option.fromNullishOr(
        state.killFibers.get(process),
      );
      if (Option.isNone(existing)) {
        return [Option.none<Fiber.Fiber<void, never>>(), state] as const;
      }
      const killFibers = new Map(state.killFibers);
      killFibers.delete(process);
      return [existing, { ...state, killFibers }] as const;
    });
    if (Option.isSome(fiber)) {
      yield* Fiber.interrupt(fiber.value).pipe(Effect.ignore);
    }
  });

  const registerKillFiber = Effect.fn("terminal.registerKillFiber")(function* (
    process: PtyAdapter.PtyProcess,
    fiber: Fiber.Fiber<void, never>,
  ) {
    yield* modifyManagerState((state) => {
      // Children may finalize before registration; check inside the synchronized update to avoid retaining finished fibers.
      if (fiber.pollUnsafe() !== undefined) {
        return [undefined, state] as const;
      }
      const killFibers = new Map(state.killFibers);
      killFibers.set(process, fiber);
      return [undefined, { ...state, killFibers }] as const;
    });
  });

  const runKillEscalation = Effect.fn("terminal.runKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    threadId: string,
    terminalId: string,
  ) {
    // Subscribe before SIGTERM to catch immediate exits; Effect.ensuring releases even on interruption, unlike JS finally.
    const exited = Deferred.makeUnsafe<void>();
    const unsubscribeExit = process.onExit(() => {
      Deferred.doneUnsafe(exited, Effect.void);
    });
    yield* Effect.gen(function* () {
      const terminated = yield* Effect.try({
        try: () => process.kill("SIGTERM"),
        catch: (cause) =>
          new TerminalProcessSignalError({
            cause,
            signal: "SIGTERM",
            terminalPid: process.pid,
          }),
      }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("failed to kill terminal process", {
            threadId,
            terminalId,
            signal: "SIGTERM",
            cause: error,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!terminated) {
        return;
      }

      const exitedBeforeGrace = yield* Deferred.await(exited).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: processKillGraceMs,
          orElse: () => Effect.succeed(false),
        }),
      );
      if (exitedBeforeGrace) {
        return;
      }

      yield* Effect.try({
        try: () => process.kill("SIGKILL"),
        catch: (cause) =>
          new TerminalProcessSignalError({
            cause,
            signal: "SIGKILL",
            terminalPid: process.pid,
          }),
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to force-kill terminal process", {
            threadId,
            terminalId,
            signal: "SIGKILL",
            cause: error,
          }),
        ),
      );
    }).pipe(Effect.ensuring(Effect.sync(unsubscribeExit)));
  });

  const startKillEscalation = Effect.fn("terminal.startKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    threadId: string,
    terminalId: string,
  ) {
    const fiber = yield* runKillEscalation(process, threadId, terminalId).pipe(
      Effect.ensuring(
        modifyManagerState((state) => {
          if (!state.killFibers.has(process)) {
            return [undefined, state] as const;
          }
          const killFibers = new Map(state.killFibers);
          killFibers.delete(process);
          return [undefined, { ...state, killFibers }] as const;
        }),
      ),
      Effect.forkIn(workerScope),
    );

    yield* registerKillFiber(process, fiber);
  });

  const persistWorker = yield* makeKeyedCoalescingWorker<
    string,
    PersistHistoryRequest,
    never,
    never
  >({
    merge: (current, next) => ({
      history: next.history,
      immediate: current.immediate || next.immediate,
    }),
    process: Effect.fn("terminal.persistHistoryWorker")(function* (sessionKey, request) {
      if (!request.immediate) {
        yield* Effect.sleep(DEFAULT_PERSIST_DEBOUNCE_MS);
      }

      const [threadId, terminalId] = sessionKey.split("\u0000");
      if (!threadId || !terminalId) {
        return;
      }

      yield* fileSystem
        .writeFileString(historyPath(threadId, terminalId), request.history.value())
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to persist terminal history", {
              threadId,
              terminalId,
              error,
            }),
          ),
        );
    }),
  });

  const queuePersist = Effect.fn("terminal.queuePersist")(function* (
    threadId: string,
    terminalId: string,
    history: BoundedTerminalHistory,
  ) {
    yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
      history,
      immediate: false,
    });
  });

  const flushPersist = Effect.fn("terminal.flushPersist")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* persistWorker.drainKey(toSessionKey(threadId, terminalId));
  });

  const persistHistory = Effect.fn("terminal.persistHistory")(function* (
    threadId: string,
    terminalId: string,
    history: BoundedTerminalHistory,
  ) {
    yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
      history,
      immediate: true,
    });
    yield* flushPersist(threadId, terminalId);
  });

  const readHistoryTail = Effect.fn("terminal.readHistoryTail")(function* (filePath: string) {
    const file = yield* fileSystem.open(filePath, { flag: "r" });
    const info = yield* file.stat;
    const limit = BigInt(historyByteLimit);
    const offset = info.size > limit ? info.size - limit : 0n;
    yield* file.seek(offset, "start");
    const bytes = new Uint8Array(Number(info.size - offset));
    let length = 0;
    while (length < bytes.length) {
      const read = Number(yield* file.read(bytes.subarray(length)));
      if (read === 0) break;
      length += read;
    }
    let start = 0;
    if (offset > 0n) {
      // A tail read can start inside a UTF-8 code point. Skip its remaining bytes.
      while (start < length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
    }
    return {
      history: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(start, length)),
      truncated: offset > 0n,
    };
  });

  const readHistory = Effect.fn("terminal.readHistory")(function* (
    threadId: string,
    terminalId: string,
  ) {
    const nextPath = historyPath(threadId, terminalId);
    for (const sourcePath of historyPaths(threadId, terminalId)) {
      const migrating = sourcePath !== nextPath;
      const operation = migrating ? "migrate" : "read";
      if (
        !(yield* historyExists(sourcePath).pipe(
          Effect.mapError(
            (cause) => new TerminalHistoryError({ operation, threadId, terminalId, cause }),
          ),
        ))
      )
        continue;
      const { history: raw, truncated } = yield* readHistoryTail(sourcePath).pipe(
        Effect.scoped,
        Effect.mapError(
          (cause) => new TerminalHistoryError({ operation, threadId, terminalId, cause }),
        ),
      );
      const history = new BoundedTerminalHistory(historyLineLimit, raw, historyByteLimit);
      const capped = history.value();
      if (migrating || truncated || capped !== raw) {
        const write = migrating
          ? Effect.gen(function* () {
              const temporaryPath = yield* fileSystem.makeTempFileScoped({
                directory: logsDir,
                prefix: ".history-",
              });
              yield* fileSystem.writeFileString(temporaryPath, capped);
              yield* fileSystem.rename(temporaryPath, nextPath);
            }).pipe(Effect.scoped)
          : fileSystem.writeFileString(nextPath, capped);
        yield* write.pipe(
          Effect.mapError(
            (cause) =>
              new TerminalHistoryError({
                operation: migrating ? "migrate" : "truncate",
                threadId,
                terminalId,
                cause,
              }),
          ),
        );
      }
      if (migrating) {
        yield* fileSystem.remove(sourcePath, { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to remove legacy terminal history", {
              threadId,
              terminalId,
              error,
            }),
          ),
        );
      }
      return history;
    }
    return new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit);
  });

  const deleteHistory = Effect.fn("terminal.deleteHistory")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* Effect.forEach(
      historyPaths(threadId, terminalId),
      (filePath) =>
        Effect.gen(function* () {
          if (yield* historyExists(filePath)) {
            yield* fileSystem.remove(filePath, { force: true });
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to delete terminal history", {
              threadId,
              terminalId,
              error,
            }),
          ),
        ),
      { discard: true },
    );
  });

  const deleteAllHistoryForThread = Effect.fn("terminal.deleteAllHistoryForThread")(function* (
    threadId: string,
  ) {
    const threadParts = [encodedHistoryThreadPart(threadId), hashedHistoryThreadPart(threadId)];
    const entries = yield* fileSystem
      .readDirectory(logsDir, { recursive: false })
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    yield* Effect.forEach(
      entries.filter(
        (name) =>
          name === `${legacySafeThreadId(threadId)}.log` ||
          threadParts.some((part) => name === `${part}.log` || name.startsWith(`${part}_`)),
      ),
      (name) =>
        fileSystem.remove(path.join(logsDir, name), { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to delete terminal histories for thread", {
              threadId,
              error,
            }),
          ),
        ),
      { discard: true },
    );
  });

  const assertValidCwd = Effect.fn("terminal.assertValidCwd")(function* (cwd: string) {
    const stats = yield* fileSystem.stat(cwd).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? new TerminalCwdNotFoundError({ cwd })
            : new TerminalCwdStatError({ cwd, cause }),
      }),
    );
    if (stats.type !== "Directory") {
      return yield* new TerminalCwdNotDirectoryError({ cwd });
    }
  });

  const getSession = Effect.fn("terminal.getSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<Option.Option<TerminalSessionState>> {
    return yield* Effect.map(readManagerState, (state) =>
      Option.fromNullishOr(state.sessions.get(toSessionKey(threadId, terminalId))),
    );
  });

  const requireSession = Effect.fn("terminal.requireSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<TerminalSessionState, TerminalSessionLookupError> {
    return yield* Effect.flatMap(getSession(threadId, terminalId), (session) =>
      Effect.fromOption(session, () => new TerminalSessionLookupError({ threadId, terminalId })),
    );
  });

  const sessionsForThread = Effect.fn("terminal.sessionsForThread")(function* (threadId: string) {
    return yield* readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()].filter((session) => session.threadId === threadId),
      ),
    );
  });

  const evictInactiveSessionsIfNeeded = Effect.fn("terminal.evictInactiveSessionsIfNeeded")(
    function* () {
      yield* modifyManagerState((state) => {
        const inactive = [...state.sessions.values()].filter(
          (session) => session.status !== "running",
        );
        const inactiveSessions = inactive.filter(
          (session) => session.status !== "starting" && !session.agentBusy,
        );
        if (inactive.length <= maxRetainedInactiveSessions) {
          return [undefined, state] as const;
        }

        inactiveSessions.sort(
          (left, right) =>
            left.updatedAt.localeCompare(right.updatedAt) ||
            left.threadId.localeCompare(right.threadId) ||
            left.terminalId.localeCompare(right.terminalId),
        );

        const sessions = new Map(state.sessions);

        const toEvict = inactive.length - maxRetainedInactiveSessions;
        for (const session of inactiveSessions.slice(0, toEvict)) {
          const key = toSessionKey(session.threadId, session.terminalId);
          resetAgentTerminal(session);
          session.agentRetired = true;
          sessions.delete(key);
          closedSessionKeys.add(key);
        }

        return [undefined, { ...state, sessions }] as const;
      });
    },
  );

  const drainProcessEvents = Effect.fn("terminal.drainProcessEvents")(function* (
    session: TerminalSessionState,
    expectedPid: number,
  ) {
    while (true) {
      const action: DrainProcessEventAction = yield* Effect.sync(() => {
        if (session.pid !== expectedPid || !session.process || session.status !== "running") {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        const nextEvent = session.pendingProcessEvents[session.pendingProcessEventIndex];
        if (!nextEvent) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        session.pendingProcessEvents[session.pendingProcessEventIndex] = undefined;
        session.pendingProcessEventIndex += 1;
        if (session.pendingProcessEventIndex * 2 >= session.pendingProcessEvents.length) {
          session.pendingProcessEvents = session.pendingProcessEvents.slice(
            session.pendingProcessEventIndex,
          );
          session.pendingProcessEventIndex = 0;
        }

        if (nextEvent.type === "output") {
          const sanitized = sanitizeTerminalHistoryChunk(
            session.pendingHistoryControlSequence,
            nextEvent.data,
          );
          session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
          if (sanitized.visibleText.length > 0) {
            session.history.append(sanitized.visibleText);
          }
          const eventStamp = advanceEventSequence(session);

          return {
            type: "output",
            threadId: session.threadId,
            terminalId: session.terminalId,
            sequence: eventStamp.sequence,
            history: sanitized.visibleText.length > 0 ? session.history : null,
            data: nextEvent.data,
          } as const;
        }

        const process = session.process;
        cleanupProcessHandles(session);
        session.process = null;
        session.pid = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.status = "exited";
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        session.exitCode = Number.isInteger(nextEvent.event.exitCode)
          ? nextEvent.event.exitCode
          : null;
        session.exitSignal = Number.isInteger(nextEvent.event.signal)
          ? nextEvent.event.signal
          : null;
        const eventStamp = advanceEventSequence(session);

        return {
          type: "exit",
          process,
          threadId: session.threadId,
          terminalId: session.terminalId,
          sequence: eventStamp.sequence,
          exitCode: session.exitCode,
          exitSignal: session.exitSignal,
        } as const;
      });

      if (action.type === "idle") {
        return;
      }

      if (action.type === "output") {
        if (action.history !== null) {
          yield* queuePersist(action.threadId, action.terminalId, action.history);
        }

        yield* publishEvent({
          type: "output",
          threadId: action.threadId,
          terminalId: action.terminalId,
          sequence: action.sequence,
          data: action.data,
        });
        continue;
      }

      yield* clearKillFiber(action.process);
      yield* unregisterTerminal({
        threadId: action.threadId,
        terminalId: action.terminalId,
      });
      yield* publishEvent({
        type: "exited",
        threadId: action.threadId,
        terminalId: action.terminalId,
        sequence: action.sequence,
        exitCode: action.exitCode,
        exitSignal: action.exitSignal,
      });
      yield* evictInactiveSessionsIfNeeded();
      return;
    }
  });

  const stopProcess = Effect.fn("terminal.stopProcess")(function* <
    E extends OrchestratorMcpFailure = never,
  >(
    session: TerminalSessionState,
    authorize: Effect.Effect<void, E> = Effect.void,
  ): Effect.fn.Return<void, E> {
    const process = session.process;
    if (!process) return;

    yield* clearKillFiber(process);
    const updatedAt = yield* nowIso;
    yield* authorize;
    // An accepted stop must schedule its kill before interruption can leave a detached process.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* modifyManagerState((state) => {
          cleanupProcessHandles(session);
          session.process = null;
          session.pid = null;
          session.hasRunningSubprocess = false;
          session.childCommandLabel = null;
          session.status = "exited";
          session.pendingHistoryControlSequence = "";
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          session.updatedAt = updatedAt;
          return [undefined, state] as const;
        });
        yield* startKillEscalation(process, session.threadId, session.terminalId);
      }),
    );
    yield* unregisterTerminal({
      threadId: session.threadId,
      terminalId: session.terminalId,
    });
    yield* evictInactiveSessionsIfNeeded();
  });

  const trySpawn = Effect.fn("terminal.trySpawn")(function* <
    E extends OrchestratorMcpFailure = never,
  >(
    shellCandidates: ReadonlyArray<ShellCandidate>,
    spawnEnv: NodeJS.ProcessEnv,
    session: TerminalSessionState,
    authorize: Effect.Effect<void, E> = Effect.void,
    index = 0,
    lastError: PtyAdapter.PtySpawnError | null = null,
  ): Effect.fn.Return<
    { process: PtyAdapter.PtyProcess; shell: string; shellLabel: string },
    PtyAdapter.PtySpawnError | E
  > {
    if (index >= shellCandidates.length) {
      return yield* new PtyAdapter.PtySpawnError({
        adapter: "terminal-manager",
        attemptedShells: shellCandidates.map((candidate) => formatShellCandidate(candidate)),
        ...(lastError ? { cause: lastError } : {}),
      });
    }

    const candidate = shellCandidates[index];
    if (!candidate) {
      return yield* (
        lastError ??
          new PtyAdapter.PtySpawnError({
            adapter: "terminal-manager",
            attemptedShells: [],
          })
      );
    }

    const launch = yield* agentScope.wrap({
      command: candidate.shell,
      args: candidate.args ?? [],
      name: "terminal",
      env: spawnEnv,
      survivesRestart: true,
    });
    yield* authorize;
    const attempt = yield* Effect.result(
      options.ptyAdapter.spawn({
        shell: launch.command,
        ...(launch.args.length > 0 ? { args: [...launch.args] } : {}),
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        env: spawnEnv,
      }),
    );

    if (attempt._tag === "Success") {
      return {
        process: attempt.success,
        shell: candidate.shell,
        shellLabel: formatShellCandidate(candidate),
      };
    }

    const spawnError = attempt.failure;
    if (!isRetryableShellSpawnError(spawnError)) {
      return yield* spawnError;
    }

    return yield* trySpawn(shellCandidates, spawnEnv, session, authorize, index + 1, spawnError);
  });

  const startSession = Effect.fn("terminal.startSession")(function* <
    E extends OrchestratorMcpFailure = never,
  >(
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
    authorize: Effect.Effect<void, E> = Effect.void,
  ): Effect.fn.Return<void, E> {
    yield* stopProcess(session, authorize);
    yield* Effect.annotateCurrentSpan({
      "terminal.thread_id": session.threadId,
      "terminal.id": session.terminalId,
      "terminal.event_type": eventType,
      "terminal.cwd": input.cwd,
    });

    const startingAt = yield* nowIso;
    yield* authorize;
    yield* modifyManagerState((state) => {
      session.status = "starting";
      session.shell = null;
      session.cwd = input.cwd;
      session.worktreePath = input.worktreePath ?? null;
      session.cols = input.cols;
      session.rows = input.rows;
      session.exitCode = null;
      session.exitSignal = null;
      session.hasRunningSubprocess = false;
      session.childCommandLabel = null;
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = startingAt;
      return [undefined, state] as const;
    });

    let ptyProcess: PtyAdapter.PtyProcess | null = null;
    let startedShell: string | null = null;

    const startResult = yield* Effect.result(
      increment(terminalSessionsTotal, { lifecycle: eventType }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const shellCandidates = resolveShellCandidates(shellResolver, platform, baseEnv);
            const terminalEnv = withThreadMcpEnvironment(
              createTerminalSpawnEnv(
                baseEnv,
                session.runtimeEnv,
                platform,
                yield* HostProcess.HomeDirectory,
              ),
              yield* mcpSessions.read(ThreadId.make(session.threadId)),
            );
            // Append managed install directories so agent commands resolve without shadowing user/system tools.
            if (
              options.managedBinaryCacheDir !== undefined &&
              options.managedBinaryToolsDir !== undefined
            ) {
              const managedDirectories = yield* acpRegistryManagedBinaryDirectories({
                cacheDir: options.managedBinaryCacheDir,
                toolsDir: options.managedBinaryToolsDir,
                platform,
                architecture,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              );
              if (managedDirectories.length > 0) {
                const delimiter = platform === "win32" ? ";" : ":";
                const pathKey =
                  platform === "win32"
                    ? (Object.keys(terminalEnv).find(
                        (candidate) => candidate.toLowerCase() === "path",
                      ) ?? "PATH")
                    : "PATH";
                const merged = mergePathEntries(
                  terminalEnv[pathKey],
                  managedDirectories.join(delimiter),
                  platform,
                );
                if (merged !== undefined) {
                  terminalEnv[pathKey] = merged;
                }
              }
            }
            const spawnResult = yield* trySpawn(shellCandidates, terminalEnv, session, authorize);
            ptyProcess = spawnResult.process;
            startedShell = spawnResult.shellLabel;

            const processPid = ptyProcess.pid;
            let eventsActivated = false;

            let eventStamp: ReturnType<typeof advanceEventSequence> = {
              updatedAt: session.updatedAt,
              sequence: session.eventSequence,
            };
            yield* modifyManagerState((state) => {
              session.process = ptyProcess;
              session.shell = spawnResult.shell;
              session.pid = processPid;
              session.status = "running";
              // onExit may replay an exit immediately; accept it before subscribing.
              session.unsubscribeData = spawnResult.process.onData((data) => {
                if (!enqueueProcessEvent(session, processPid, { type: "output", data })) {
                  return;
                }
                if (eventsActivated) runFork(drainProcessEvents(session, processPid));
              });
              session.unsubscribeExit = spawnResult.process.onExit((event) => {
                if (!enqueueProcessEvent(session, processPid, { type: "exit", event })) {
                  return;
                }
                if (eventsActivated) runFork(drainProcessEvents(session, processPid));
              });
              eventStamp = advanceEventSequence(session);
              return [undefined, state] as const;
            });

            yield* publishEvent({
              type: eventType,
              threadId: session.threadId,
              terminalId: session.terminalId,
              sequence: eventStamp.sequence,
              snapshot: snapshot(session),
            });
            // Publish startup before draining any events replayed during subscription.
            eventsActivated = true;
            if (session.processEventDrainRunning) runFork(drainProcessEvents(session, processPid));
          }),
        ),
      ),
    );

    if (startResult._tag === "Success") {
      return;
    }

    {
      const error = startResult.failure;
      if (ptyProcess) {
        yield* startKillEscalation(ptyProcess, session.threadId, session.terminalId);
      }

      yield* modifyManagerState((state) => {
        cleanupProcessHandles(session);
        session.status = "error";
        session.pid = null;
        session.process = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        advanceEventSequence(session);
        return [undefined, state] as const;
      });
      yield* unregisterTerminal({
        threadId: session.threadId,
        terminalId: session.terminalId,
      });

      yield* evictInactiveSessionsIfNeeded();

      if (error._tag === "OrchestratorMcpFailure") return yield* error;
      const message = error.message;
      yield* publishEvent({
        type: "error",
        threadId: session.threadId,
        terminalId: session.terminalId,
        sequence: session.eventSequence,
        message,
      });
      yield* Effect.logError("failed to start terminal", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        cause: error,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  });

  const closeSession = Effect.fn("terminal.closeSession")(function* <
    E extends OrchestratorMcpFailure = never,
  >(
    threadId: string,
    terminalId: string,
    deleteHistoryOnClose: boolean,
    authorize: Effect.Effect<void, E> = Effect.void,
  ): Effect.fn.Return<void, TerminalError | E> {
    const key = toSessionKey(threadId, terminalId);
    const session = yield* getSession(threadId, terminalId);
    const closedEventSequence = Option.isSome(session) ? session.value.eventSequence + 1 : 0;

    yield* authorize;
    if (Option.isSome(session)) {
      yield* stopProcess(session.value, authorize);
      resetAgentTerminal(session.value);
      session.value.agentRetired = true;
      yield* unregisterTerminal({ threadId, terminalId });
      yield* persistHistory(threadId, terminalId, session.value.history);
    }

    yield* flushPersist(threadId, terminalId);

    const removed = yield* modifyManagerState((state) => {
      closedSessionKeys.add(key);
      if (!state.sessions.has(key)) {
        return [false, state] as const;
      }
      const sessions = new Map(state.sessions);
      sessions.delete(key);
      return [true, { ...state, sessions }] as const;
    });

    if (removed) {
      yield* publishEvent({
        type: "closed",
        threadId,
        terminalId,
        sequence: closedEventSequence,
      });
    }

    if (deleteHistoryOnClose) {
      yield* deleteHistory(threadId, terminalId);
    }
  });

  // Two unchanged snapshots cover children forked just after the first snapshot.
  // Process identity prevents a restarted shell from inheriting quiet state.
  let quietSessions = new WeakMap<TerminalSessionState, QuietTerminalSession>();
  let skippedQuietTicks = 0;
  const isQuiet = (session: TerminalSessionState & { pid: number }) => {
    const quiet = quietSessions.get(session);
    return (
      quiet !== undefined &&
      quiet.idleSnapshots === 2 &&
      quiet.process === session.process &&
      quiet.mark === terminalActivityMark(session) &&
      !session.hasRunningSubprocess
    );
  };

  const pollSubprocessActivity = Effect.fn("terminal.pollSubprocessActivity")(function* () {
    const state = yield* readManagerState;
    const runningSessions = [...state.sessions.values()]
      .filter(
        (session): session is TerminalSessionState & { pid: number } =>
          session.status === "running" && Number.isInteger(session.pid),
      )
      .map((session) => ({
        session,
        terminalPid: session.pid,
        process: session.process,
        mark: terminalActivityMark(session),
      }));

    if (runningSessions.length === 0) {
      return { snapshotSucceeded: true, queryElapsedMs: 0 };
    }
    if (
      runningSessions.every(({ session }) => isQuiet(session)) &&
      skippedQuietTicks < QUIET_SUBPROCESS_SNAPSHOT_EVERY_TICKS - 1
    ) {
      skippedQuietTicks += 1;
      return { snapshotSucceeded: true, queryElapsedMs: 0 };
    }
    skippedQuietTicks = 0;

    const { inspector, snapshotSucceeded, queryElapsedMs } = yield* acquireSubprocessInspector(
      PROCESS_TABLE_QUERY_TIMEOUT,
    );
    if (Result.isFailure(inspector)) {
      yield* Effect.logWarning("failed to snapshot processes for terminal subprocess polling", {
        reason: inspector.failure,
      });
      quietSessions = new WeakMap();
      return { snapshotSucceeded: false, queryElapsedMs };
    }

    const subprocessInspector = inspector.success;
    const checkSubprocessActivity = Effect.fn("terminal.checkSubprocessActivity")(function* (
      candidate: (typeof runningSessions)[number],
    ) {
      const { session, terminalPid, process } = candidate;
      let mark = candidate.mark;
      const previous = quietSessions.get(session);
      quietSessions.delete(session);
      const inspectResult = yield* subprocessInspector(terminalPid).pipe(
        Effect.asSome,
        Effect.catch((reason) =>
          Effect.logWarning("failed to check terminal subprocess activity", {
            threadId: session.threadId,
            terminalId: session.terminalId,
            terminalPid,
            reason,
          }).pipe(Effect.as(Option.none<TerminalSubprocessInspectResult>())),
        ),
      );

      if (
        Option.isNone(inspectResult) ||
        session.status !== "running" ||
        session.pid !== terminalPid ||
        session.process !== process
      ) {
        return;
      }

      const next = inspectResult.value;
      yield* registerTerminalProcesses({
        threadId: session.threadId,
        terminalId: session.terminalId,
        processIds: next.processIds,
      });
      const nextChildLabel = next.hasRunningSubprocess ? next.childCommand : null;
      const event = yield* modifyManagerState((state) => {
        const liveSession: Option.Option<TerminalSessionState> = Option.fromNullishOr(
          state.sessions.get(toSessionKey(session.threadId, session.terminalId)),
        );
        if (
          Option.isNone(liveSession) ||
          liveSession.value !== session ||
          liveSession.value.status !== "running" ||
          liveSession.value.pid !== terminalPid ||
          liveSession.value.process !== process ||
          (liveSession.value.hasRunningSubprocess === next.hasRunningSubprocess &&
            liveSession.value.childCommandLabel === nextChildLabel)
        ) {
          return [Option.none(), state] as const;
        }

        liveSession.value.hasRunningSubprocess = next.hasRunningSubprocess;
        liveSession.value.childCommandLabel = nextChildLabel;
        const eventStamp = advanceEventSequence(liveSession.value);
        // Only this poll's own event may advance the mark without waking it.
        mark += 1;

        return [
          Option.some({
            type: "activity" as const,
            threadId: liveSession.value.threadId,
            terminalId: liveSession.value.terminalId,
            sequence: eventStamp.sequence,
            hasRunningSubprocess: next.hasRunningSubprocess,
            label: terminalWireLabel(liveSession.value),
          }),
          state,
        ] as const;
      });

      if (Option.isSome(event)) {
        yield* publishEvent(event.value);
      }

      if (
        snapshotSucceeded &&
        !next.hasRunningSubprocess &&
        session.status === "running" &&
        session.pid === terminalPid &&
        session.process === process &&
        terminalActivityMark(session) === mark
      ) {
        quietSessions.set(session, {
          process,
          mark,
          idleSnapshots: previous?.process === process && previous.mark === mark ? 2 : 1,
        });
      }
    });

    yield* Effect.forEach(runningSessions, checkSubprocessActivity, {
      concurrency: "unbounded",
      discard: true,
    });

    return { snapshotSucceeded, queryElapsedMs };
  });

  const hasRunningSessions = readManagerState.pipe(
    Effect.map((state) =>
      [...state.sessions.values()].some((session) => session.status === "running"),
    ),
  );

  let subprocessSnapshotFailureCount = 0;
  yield* Effect.forever(
    hasRunningSessions.pipe(
      Effect.flatMap((active) =>
        active
          ? pollSubprocessActivity().pipe(
              Effect.flatMap(({ snapshotSucceeded, queryElapsedMs }) => {
                subprocessSnapshotFailureCount = snapshotSucceeded
                  ? 0
                  : Math.min(subprocessSnapshotFailureCount + 1, 30);
                const delayMs = subprocessSnapshotPollDelayMs(
                  subprocessPollIntervalMs,
                  subprocessSnapshotFailureCount,
                  queryElapsedMs,
                );
                return Effect.sleep(delayMs);
              }),
            )
          : Effect.sync(() => {
              subprocessSnapshotFailureCount = 0;
            }).pipe(Effect.flatMap(() => Effect.sleep(subprocessPollIntervalMs))),
      ),
    ),
  ).pipe(Effect.forkIn(workerScope));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const sessions = yield* modifyManagerState(
        (state) =>
          [
            [...state.sessions.values()],
            {
              ...state,
              sessions: new Map(),
            },
          ] as const,
      );

      const cleanupSession = Effect.fn("terminal.cleanupSession")(function* (
        session: TerminalSessionState,
      ) {
        cleanupProcessHandles(session);
        if (!session.process) return;
        yield* clearKillFiber(session.process);
        yield* runKillEscalation(session.process, session.threadId, session.terminalId);
      });

      yield* Effect.forEach(sessions, cleanupSession, {
        concurrency: "unbounded",
        discard: true,
      });
    }).pipe(Effect.ignoreCause({ log: true })),
  );

  /** Runs under the checkout's lease; claims of other GOAT servers that cannot be read fail like an unreachable cwd. */
  const withTerminalLease = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    withWorkspaceLease(path.resolve(cwd), effect).pipe(
      Effect.catchIf(isWorkspaceLeaseUnavailableError, (error) =>
        Effect.fail(new TerminalCwdStatError({ cwd, cause: error })),
      ),
    );

  const openWithWorkspaceLease = Effect.fn("terminal.openLocked")(function* <
    E extends OrchestratorMcpFailure = never,
  >(
    requestedInput: TerminalOpenInput,
    owner: string | null = null,
    authorize: Effect.Effect<void, E> = Effect.void,
  ): Effect.fn.Return<TerminalSessionState, TerminalError | E> {
    const terminalId = requestedInput.terminalId;
    yield* assertValidCwd(requestedInput.cwd);

    const sessionKey = toSessionKey(requestedInput.threadId, terminalId);
    const input = withSharedGrid(sessionKey, requestedInput);
    const existing = yield* getSession(input.threadId, terminalId);
    if (Option.isNone(existing)) {
      yield* flushPersist(input.threadId, terminalId);
      const inherited = yield* readHistory(input.threadId, terminalId);
      const history = new BoundedTerminalHistory(
        historyLineLimit,
        neutralizeInheritedHistory(
          inherited.value(),
          historyLineLimit,
          Math.min(historyByteLimit, DEFAULT_MAX_TERMINAL_BUFFER_BYTES),
        ),
        historyByteLimit,
      );
      const cols = input.cols ?? DEFAULT_OPEN_COLS;
      const rows = input.rows ?? DEFAULT_OPEN_ROWS;
      const session: TerminalSessionState = {
        ...createAgentTerminalState(),
        agentOwner: owner,
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        worktreePath: input.worktreePath ?? null,
        status: "starting",
        pid: null,
        history,
        pendingHistoryControlSequence: "",
        pendingProcessEvents: [],
        pendingProcessEventIndex: 0,
        processEventDrainRunning: false,
        exitCode: null,
        exitSignal: null,
        updatedAt: yield* nowIso,
        eventSequence: 0,
        inputCount: 0,
        cols,
        rows,
        process: null,
        shell: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        hasRunningSubprocess: false,
        childCommandLabel: null,
        runtimeEnv: normalizedRuntimeEnv(input.env),
      };

      yield* authorize;
      const createdSession = session;
      yield* modifyManagerState((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(sessionKey, createdSession);
        closedSessionKeys.delete(sessionKey);
        return [undefined, { ...state, sessions }] as const;
      });

      yield* evictInactiveSessionsIfNeeded();
      yield* startSession(
        session,
        {
          threadId: input.threadId,
          terminalId,
          cwd: input.cwd,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
          cols,
          rows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
        authorize,
      );
      return session;
    }

    const liveSession = existing.value;
    yield* authorize;
    resetAgentTerminal(liveSession, owner);
    const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
    const currentRuntimeEnv = liveSession.runtimeEnv;
    const targetCols = input.cols ?? liveSession.cols;
    const targetRows = input.rows ?? liveSession.rows;
    const runtimeEnvChanged = !Equal.equals(currentRuntimeEnv, nextRuntimeEnv);
    const nextWorktreePath =
      input.worktreePath !== undefined ? (input.worktreePath ?? null) : liveSession.worktreePath;
    const launchContextChanged =
      liveSession.cwd !== input.cwd ||
      runtimeEnvChanged ||
      liveSession.worktreePath !== nextWorktreePath;

    if (launchContextChanged) {
      yield* stopProcess(liveSession, authorize);
      liveSession.cwd = input.cwd;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.history.clear();
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
    } else if (liveSession.status === "exited" || liveSession.status === "error") {
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.history.clear();
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
    }

    if (!liveSession.process) {
      yield* startSession(
        liveSession,
        {
          threadId: input.threadId,
          terminalId,
          cwd: input.cwd,
          worktreePath: liveSession.worktreePath,
          cols: targetCols,
          rows: targetRows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
        authorize,
      );
      return liveSession;
    }

    if (liveSession.cols !== targetCols || liveSession.rows !== targetRows) {
      yield* authorize;
      yield* resizeSession(liveSession, liveSession.process, targetCols, targetRows);
    }

    return liveSession;
  });

  const openLocked = (input: TerminalOpenInput) =>
    withTerminalLease(input.worktreePath ?? input.cwd, openWithWorkspaceLease(input)).pipe(
      Effect.map(snapshot),
    );

  const open: TerminalManager["Service"]["open"] = (input) =>
    withThreadLock(
      input.threadId,
      resolveLaunchInputEnvironment(input).pipe(Effect.flatMap(openLocked)),
    );

  const getShell = Effect.fn("terminal.getShell")(function* (input: TerminalObserveInput) {
    const session = yield* requireSession(input.threadId, input.terminalId);
    if (session.status !== "running" || session.shell === null) {
      return yield* new TerminalNotRunningError(input);
    }
    return session.shell;
  });

  const openOrAttachForStream = Effect.fnUntraced(function* (requestedInput: TerminalAttachInput) {
    const terminalId = requestedInput.terminalId;
    const input = withSharedGrid(toSessionKey(requestedInput.threadId, terminalId), requestedInput);
    const existing = yield* getSession(input.threadId, terminalId);

    if (Option.isNone(existing)) {
      if (input.resume && closedSessionKeys.has(toSessionKey(input.threadId, terminalId))) {
        return null;
      }
      if (!input.cwd) {
        return yield* new TerminalSessionLookupError({
          threadId: input.threadId,
          terminalId,
        });
      }

      const resolvedInput = yield* resolveLaunchInputEnvironment({
        ...input,
        terminalId,
        cwd: input.cwd,
      });
      return yield* Effect.uninterruptible(openLocked(resolvedInput));
    }

    const session = existing.value;
    const targetCols = input.cols ?? session.cols;
    const targetRows = input.rows ?? session.rows;

    if (!input.resume && !session.process && input.cwd && input.restartIfNotRunning === true) {
      const resolvedInput = yield* resolveLaunchInputEnvironment({
        ...input,
        terminalId,
        cwd: input.cwd,
      });
      return yield* Effect.uninterruptible(openLocked(resolvedInput));
    }

    if (
      session.process &&
      session.status === "running" &&
      (session.cols !== targetCols || session.rows !== targetRows)
    ) {
      yield* resizeSession(session, session.process, targetCols, targetRows);
    }

    return snapshot(session);
  });

  const readAllTerminalMetadata = () =>
    readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()]
          .map(summary)
          .sort(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) ||
              left.threadId.localeCompare(right.threadId) ||
              left.terminalId.localeCompare(right.terminalId),
          ),
      ),
    );

  const readTerminalMetadata = (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) =>
    getSession(input.threadId, input.terminalId).pipe(
      Effect.map((session) => (Option.isSome(session) ? summary(session.value) : null)),
    );

  const subscribe: TerminalManager["Service"]["subscribe"] = (listener, registerCleanup) =>
    Effect.sync(() => {
      terminalEventListeners.add(listener);
      const stop = () => {
        terminalEventListeners.delete(listener);
      };
      // Transfer ownership before an interrupt can discard the returned handle.
      registerCleanup?.(stop);
      return stop;
    });

  // Subscribe after taking the lock so contention cannot accumulate an unbounded replay.
  // Snapshot listeners run under that lock and must not block.
  const streamSession = (
    input: TerminalObserveInput,
    initial: Effect.Effect<TerminalSessionSnapshot | null, TerminalError>,
    listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
    registerCleanup?: (stop: () => void) => void,
  ) => {
    let unsubscribe: (() => void) | null = null;
    const stop = () => {
      unsubscribe?.();
      unsubscribe = null;
    };

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;
      let snapshotFloor: number | null = null;

      yield* subscribe(
        (event) => {
          if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
            return Effect.void;
          }

          if (!deliverLive) {
            bufferedEvents.push(event);
            return Effect.void;
          }

          // Fanout can finish after a snapshot that already includes the event.
          // Keep only its sequence, not its history, until the session changes.
          if (snapshotFloor !== null) {
            if (
              event.type === "started" ||
              event.type === "restarted" ||
              event.type === "error" ||
              event.type === "closed"
            ) {
              snapshotFloor = null;
            } else if (typeof event.sequence === "number" && event.sequence <= snapshotFloor) {
              return Effect.void;
            }
          }

          const attachEvent = terminalEventToAttachEvent(event);
          return attachEvent ? listener(attachEvent) : Effect.void;
        },
        (cleanup) => {
          unsubscribe = cleanup;
          registerCleanup?.(stop);
        },
      );

      const initialSnapshot = yield* initial;

      yield* listener(
        initialSnapshot === null
          ? { type: "closed", threadId: input.threadId, terminalId: input.terminalId }
          : { type: "snapshot", snapshot: initialSnapshot },
      );

      for (const event of bufferedEvents) {
        if (initialSnapshot !== null && isDuplicateAttachSnapshotEvent(event, initialSnapshot)) {
          continue;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        if (attachEvent) {
          yield* listener(attachEvent);
        }
      }
      // The live listener keeps this closure, so release replayed output.
      bufferedEvents.length = 0;

      snapshotFloor = initialSnapshot?.sequence ?? null;
      deliverLive = true;
      return stop;
    }).pipe(
      (effect) => withThreadLock(input.threadId, effect),
      Effect.onError(() => Effect.sync(stop)),
    );
  };

  /** Retains `viewer` and returns its release, which runs at most once. */
  const retainViewerOnce = (
    input: TerminalObserveInput,
    viewer: string,
    grid: TerminalGrid | null,
  ) => {
    const sessionKey = toSessionKey(input.threadId, input.terminalId);
    retainViewer(sessionKey, viewer, grid);
    let retained = true;
    return () => {
      if (!retained) return;
      retained = false;
      if (releaseViewer(sessionKey, viewer)) {
        runFork(withThreadLock(input.threadId, applySharedGrid(input.threadId, input.terminalId)));
      }
    };
  };

  const attachStream: TerminalManager["Service"]["attachStream"] = (
    input,
    listener,
    registerCleanup,
    viewerId,
  ) => {
    const viewer = viewerId ?? `stream:${++anonymousViewerCount}`;
    let detach = () => {};
    const initial = Effect.suspend(() => {
      detach = retainViewerOnce(
        input,
        viewer,
        input.cols !== undefined && input.rows !== undefined
          ? { cols: input.cols, rows: input.rows }
          : null,
      );
      return openOrAttachForStream(input);
    });
    return streamSession(
      input,
      initial,
      listener,
      registerCleanup &&
        ((stop) =>
          registerCleanup(() => {
            stop();
            detach();
          })),
    ).pipe(
      Effect.map((stop) => () => {
        stop();
        detach();
      }),
      Effect.onError(() => Effect.sync(detach)),
    );
  };

  const observeStream: TerminalManager["Service"]["observeStream"] = (
    input,
    listener,
    registerCleanup,
  ) =>
    streamSession(
      input,
      requireSession(input.threadId, input.terminalId).pipe(Effect.map(snapshot)),
      listener,
      registerCleanup,
    );

  const resyncStream: TerminalManager["Service"]["resyncStream"] = (
    input,
    listener,
    registerCleanup,
  ) =>
    streamSession(
      input,
      getSession(input.threadId, input.terminalId).pipe(
        Effect.map((session) => (Option.isSome(session) ? snapshot(session.value) : null)),
      ),
      listener,
      registerCleanup,
    );

  const attachOutputStream: TerminalManager["Service"]["attachOutputStream"] = (input, viewerId) =>
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.sync(() => retainViewerOnce(input, viewerId, null)),
        (release) => Effect.sync(release),
      ).pipe(
        Effect.as(
          terminalOutputStream(
            (listener, registerCleanup) => attachStream(input, listener, registerCleanup, viewerId),
            (listener, registerCleanup) => resyncStream(input, listener, registerCleanup),
          ),
        ),
      ),
    );

  const metadataEventFromTerminalEvent = (
    event: TerminalEvent,
  ): Effect.Effect<TerminalMetadataStreamEvent | null> => {
    if (!shouldPublishTerminalMetadataEvent(event)) {
      return Effect.succeed(null);
    }

    if (event.type === "closed") {
      return Effect.succeed({
        type: "remove" as const,
        threadId: event.threadId,
        terminalId: event.terminalId,
      });
    }

    return readTerminalMetadata({
      threadId: event.threadId,
      terminalId: event.terminalId,
    }).pipe(
      Effect.map((terminal) =>
        terminal
          ? {
              type: "upsert" as const,
              terminal,
            }
          : null,
      ),
    );
  };

  const offerMetadataEvent = (
    listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    event: TerminalEvent,
  ) =>
    metadataEventFromTerminalEvent(event).pipe(
      Effect.flatMap((metadataEvent) => (metadataEvent ? listener(metadataEvent) : Effect.void)),
    );

  const subscribeMetadata: TerminalManager["Service"]["subscribeMetadata"] = (listener) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      let dirty = false;
      let deliverLive = false;

      unsubscribe = yield* subscribe((event) => {
        if (!deliverLive) {
          // Metadata snapshots reconcile every session, including removals, without retaining output.
          if (shouldPublishTerminalMetadataEvent(event)) dirty = true;
          return Effect.void;
        }

        return offerMetadataEvent(listener, event);
      });

      do {
        dirty = false;
        const terminals = yield* readAllTerminalMetadata();
        yield* listener({ type: "snapshot", terminals });
      } while (dirty);

      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const writeLocked = Effect.fn("terminal.write")(function* <
    E extends OrchestratorMcpFailure = never,
  >(
    input: TerminalWriteInput,
    authorize: Effect.Effect<void, E> = Effect.void,
    requireRunning = false,
  ): Effect.fn.Return<void, TerminalError | E> {
    const terminalId = input.terminalId;
    const session = yield* requireSession(input.threadId, terminalId);
    const process = session.process;
    if (!process || session.status !== "running") {
      if (session.status === "exited" && !requireRunning) return;
      return yield* new TerminalNotRunningError({
        threadId: input.threadId,
        terminalId,
      });
    }
    yield* authorize;
    if (session.process !== process || session.status !== "running") {
      return yield* new TerminalNotRunningError({
        threadId: input.threadId,
        terminalId,
      });
    }
    session.inputCount += 1;
    yield* Effect.try({
      try: () => process.write(input.data),
      catch: (cause) =>
        new TerminalWriteError({
          threadId: input.threadId,
          terminalId,
          terminalPid: process.pid,
          cause,
        }),
    });
  });

  const write: TerminalManager["Service"]["write"] = (input) =>
    withThreadLock(input.threadId, writeLocked<never>(input, Effect.void));

  const resizeLocked = Effect.fn("terminal.resize")(function* (
    input: TerminalResizeInput,
    viewerId: string | undefined,
  ) {
    const sessionKey = toSessionKey(input.threadId, input.terminalId);
    const viewer =
      viewerId === undefined ? undefined : terminalViewers.get(sessionKey)?.get(viewerId);
    if (viewer) {
      viewer.grid = { cols: input.cols, rows: input.rows };
      return yield* applySharedGrid(input.threadId, input.terminalId);
    }
    // A caller that is not attached cannot override the viewers that are.
    if (sharedViewerGrid(sessionKey)) return;
    const session = yield* getSession(input.threadId, input.terminalId);
    if (Option.isNone(session)) {
      return;
    }
    const process = session.value.process;
    if (
      !process ||
      session.value.status !== "running" ||
      (session.value.cols === input.cols && session.value.rows === input.rows)
    ) {
      return;
    }
    yield* resizeSession(session.value, process, input.cols, input.rows);
  });

  const resize: TerminalManager["Service"]["resize"] = (input, viewerId) =>
    withThreadLock(input.threadId, resizeLocked(input, viewerId));

  const clearLocked = Effect.fn("terminal.clear")(function* <
    E extends OrchestratorMcpFailure = never,
  >(
    input: TerminalClearInput,
    owner: string | null = null,
    authorize: Effect.Effect<void, E> = Effect.void,
  ): Effect.fn.Return<void, TerminalError | E> {
    const terminalId = input.terminalId;
    const session = yield* requireSession(input.threadId, terminalId);
    yield* authorize;
    resetAgentTerminal(session, owner);
    session.history.clear();
    session.pendingHistoryControlSequence = "";
    session.pendingProcessEvents = [];
    session.pendingProcessEventIndex = 0;
    session.processEventDrainRunning = false;
    const eventStamp = advanceEventSequence(session);
    yield* persistHistory(input.threadId, terminalId, session.history);
    yield* publishEvent({
      type: "cleared",
      threadId: input.threadId,
      terminalId,
      sequence: eventStamp.sequence,
    });
  });

  const clear: TerminalManager["Service"]["clear"] = (input) =>
    withThreadLock(input.threadId, clearLocked<never>(input, null, Effect.void));

  const restartResolved = Effect.fn("Manager.restartResolved")(function* <
    E extends OrchestratorMcpFailure = never,
  >(
    input: TerminalRestartInput,
    owner: string | null = null,
    authorize: Effect.Effect<void, E> = Effect.void,
  ): Effect.fn.Return<TerminalSessionState, TerminalError | E> {
    yield* increment(terminalRestartsTotal, { scope: "thread" });
    const terminalId = input.terminalId;
    yield* assertValidCwd(input.cwd);

    const sessionKey = toSessionKey(input.threadId, terminalId);
    const existingSession = yield* getSession(input.threadId, terminalId);
    yield* authorize;
    let session: TerminalSessionState;
    if (Option.isNone(existingSession)) {
      const cols = input.cols ?? DEFAULT_OPEN_COLS;
      const rows = input.rows ?? DEFAULT_OPEN_ROWS;
      session = {
        ...createAgentTerminalState(),
        agentOwner: owner,
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        worktreePath: input.worktreePath ?? null,
        status: "starting",
        pid: null,
        history: new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit),
        pendingHistoryControlSequence: "",
        pendingProcessEvents: [],
        pendingProcessEventIndex: 0,
        processEventDrainRunning: false,
        exitCode: null,
        exitSignal: null,
        updatedAt: yield* nowIso,
        eventSequence: 0,
        inputCount: 0,
        cols,
        rows,
        process: null,
        shell: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        hasRunningSubprocess: false,
        childCommandLabel: null,
        runtimeEnv: normalizedRuntimeEnv(input.env),
      };
      const createdSession = session;
      yield* modifyManagerState((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(sessionKey, createdSession);
        closedSessionKeys.delete(sessionKey);
        return [undefined, { ...state, sessions }] as const;
      });
      yield* evictInactiveSessionsIfNeeded();
    } else {
      session = existingSession.value;
      yield* stopProcess(session, authorize);
      session.cwd = input.cwd;
      session.worktreePath = input.worktreePath ?? null;
      session.runtimeEnv = normalizedRuntimeEnv(input.env);
    }

    const cols = input.cols ?? session.cols;
    const rows = input.rows ?? session.rows;

    yield* authorize;
    resetAgentTerminal(session, owner);
    session.history.clear();
    session.pendingHistoryControlSequence = "";
    session.pendingProcessEvents = [];
    session.pendingProcessEventIndex = 0;
    session.processEventDrainRunning = false;
    yield* persistHistory(input.threadId, terminalId, session.history);
    yield* startSession(
      session,
      {
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
        cols,
        rows,
        ...(input.env ? { env: input.env } : {}),
      },
      "restarted",
      authorize,
    );
    return session;
  });

  const restart: TerminalManager["Service"]["restart"] = (input) =>
    withThreadLock(
      input.threadId,
      resolveLaunchInputEnvironment(input).pipe(
        Effect.flatMap((resolved) =>
          withTerminalLease(
            resolved.worktreePath ?? resolved.cwd,
            restartResolved(resolved).pipe(Effect.map(snapshot)),
          ),
        ),
      ),
    );

  const close: TerminalManager["Service"]["close"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.terminalId) {
          yield* closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
          return;
        }

        const threadSessions = yield* sessionsForThread(input.threadId);
        yield* Effect.forEach(
          threadSessions,
          (session) => closeSession(input.threadId, session.terminalId, false),
          { discard: true },
        );

        if (input.deleteHistory) {
          yield* deleteAllHistoryForThread(input.threadId);
        }
      }),
    );

  const closeIdle = Effect.fn("terminal.closeIdle")(
    function* (input: Parameters<TerminalManager["Service"]["closeIdle"]>[0]) {
      const candidates = yield* withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const sessions = yield* sessionsForThread(input.threadId);
          return sessions.flatMap((session) =>
            session.status === "running" &&
            typeof session.pid === "number" &&
            Number.isInteger(session.pid) &&
            (input.terminalId === undefined || session.terminalId === input.terminalId)
              ? [
                  {
                    session,
                    pid: session.pid,
                    process: session.process,
                    mark: terminalActivityMark(session),
                  },
                ]
              : [],
          );
        }),
      );
      if (candidates.length === 0) return;
      const { inspector: inspectorResult } = yield* acquireSubprocessInspector(
        platform === "win32" ? CLOSE_IDLE_QUERY_TIMEOUT.win32 : CLOSE_IDLE_QUERY_TIMEOUT.posix,
      );
      const inspector = yield* Effect.fromResult(inspectorResult);
      yield* Effect.forEach(
        candidates,
        (candidate) =>
          Effect.gen(function* () {
            const result = yield* inspector(candidate.pid);
            if (result.hasRunningSubprocess) return;
            yield* withThreadLock(
              input.threadId,
              Effect.gen(function* () {
                const live = yield* getSession(input.threadId, candidate.session.terminalId);
                if (
                  Option.isNone(live) ||
                  live.value !== candidate.session ||
                  live.value.status !== "running" ||
                  live.value.pid !== candidate.pid ||
                  live.value.process !== candidate.process ||
                  terminalActivityMark(live.value) !== candidate.mark
                )
                  return;
                yield* closeSession(input.threadId, candidate.session.terminalId, false);
              }),
            );
          }),
        { discard: true },
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to close idle terminals", {
            threadId: input.threadId,
            error: error.message,
          }),
        ),
      ),
  );

  const agentOperations = makeAgentTerminalOperations({
    withThreadLock,
    sessionsForThread,
    requireSession,
    open: (input) =>
      withTerminalLease(input.cwd, openWithWorkspaceLease(input, input.owner, input.authorize)),
    mutate: Effect.fn("terminal.agentMutateLocked")(function* (
      session: TerminalSessionState,
      input: AgentTerminalMutateInput,
    ) {
      switch (input.operation) {
        case "write":
          return yield* writeLocked(
            { threadId: input.threadId, terminalId: input.terminalId, data: input.data ?? "" },
            input.authorize,
            true,
          );
        case "clear":
          return yield* clearLocked(input, input.owner, input.authorize);
        case "restart":
          yield* withTerminalLease(
            session.worktreePath ?? session.cwd,
            restartResolved(
              {
                threadId: input.threadId,
                terminalId: input.terminalId,
                cwd: session.cwd,
                worktreePath: session.worktreePath,
                cols: session.cols,
                rows: session.rows,
                ...(session.runtimeEnv ? { env: session.runtimeEnv } : {}),
              },
              input.owner,
              input.authorize,
            ),
          );
          return;
        case "close":
          return yield* closeSession(input.threadId, input.terminalId, false, input.authorize);
      }
    }),
  });

  return TerminalManager.of({
    ...agentOperations,
    open,
    getShell,
    attachStream,
    attachOutputStream,
    observeStream,
    resyncStream,
    write,
    resize,
    clear,
    restart,
    close,
    closeIdle,
    subscribe,
    subscribeMetadata,
  });
});

export const layer = Layer.effect(TerminalManager, make()).pipe(Layer.provide(ProcessRunner.layer));
