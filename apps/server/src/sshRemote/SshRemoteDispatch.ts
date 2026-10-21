import {
  MEMORY_MCP_TOOLS,
  MEMORY_ADMINISTRATION_MCP_TOOLS,
  AttachmentCreateUploadUrlInput,
  AttachmentCreateUploadUrlResult,
  type AuthEnvironmentScope,
  ChatAttachmentId,
  ChatFileAttachment,
  ChatImageAttachment,
  type CloudMachineAlias,
  EnvironmentId,
  isCloudMachineAlias,
  ProjectId,
  ThreadId,
  OrchestratorMcpCapabilitiesResult,
  type ProjectScript,
  type DesktopSshEnvironmentTarget,
  type ModelSelection,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2ThreadLauncher,
  type ProviderInteractionMode,
  type RemoteReportBindingInput,
  type RuntimeMode,
  type SshLaunchWorkspace,
  type SshHostResult,
} from "@goat/contracts";
import * as Semaphore from "effect/Semaphore";
import * as NetService from "@goat/shared/Net";
import {
  isWindowsAbsolutePath,
  isWindowsShellOs,
  toWindowsHostPath,
  windowsHostPathKey,
} from "@goat/shared/path";
import { targetConnectionKey } from "@goat/ssh/command";
import * as SshAuth from "@goat/ssh/auth";
import { discoverSshHosts } from "@goat/ssh/config";
import { SshPairingError, SshPasswordPromptError } from "@goat/ssh/errors";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import packageJson from "../../package.json" with { type: "json" };
import { BUILD_COMMIT_TIME } from "../buildCommitTime.ts";
import * as CloudMachineService from "../cloudMachines/CloudMachineService.ts";
import { resolveAttachmentPath, resolveAttachmentPathById } from "../attachmentStore.ts";
import { ATTACHMENT_UPLOAD_ROUTE_PREFIX } from "../assets/AttachmentUpload.ts";
import * as Claims from "../orchestration-v2/AttachmentClaims.ts";
import * as ServerConfig from "../config.ts";
import * as LinkedHosts from "../linkedHosts/LinkedHosts.ts";
import { AcpMcpBridgeError, callAcpMcpTool, listAcpMcpTools } from "../mcp/AcpMcpStdioBridge.ts";
import { remoteDeadlineMessage, remoteUnavailableMessage } from "./remoteFailureCopy.ts";
import {
  buildRemoteBrowseScript,
  parseRemoteBrowseOutput,
  type RemoteDirectoryEntry,
  type RemoteWorktree,
} from "./remoteBrowse.ts";

/**
 * Lets an agent in this environment reach another machine over SSH: list the
 * hosts this machine's SSH config knows, browse folders on one, and start a
 * thread in that machine's own GOAT environment. The remote keeps owning its
 * projects, worktrees and threads; this process only launches or reuses the
 * remote server through the shared SSH manager and then calls the remote's
 * own `/mcp` tools as an outside agent with a short-lived session.
 *
 * A linked host (`LinkedHosts`) is reached the same way without SSH: its
 * name resolves to an HTTPS origin and the session saved when it was linked.
 */

export class SshRemoteDispatchError extends Data.TaggedError("SshRemoteDispatchError")<{
  /**
   * host_unavailable: SSH, the tunnel, or the remote server could not be
   * reached or did not answer in time. remote_refused: the remote answered
   * and refused; remoteCode carries its failure code when it sent one.
   * caller_changed: the caller's modes changed while the call was in flight.
   */
  readonly reason:
    | "invalid_request"
    | "host_unknown"
    | "ssh_failed"
    | "host_unavailable"
    | "remote_refused"
    | "caller_changed";
  readonly message: string;
  readonly remoteCode?: string | undefined;
  readonly launchMayHaveStarted?: boolean | undefined;
}> {}

/**
 * remoteCode on a refusal before any launch because the remote cannot verify or apply a task
 * memory ceiling (an older GOAT). Callers that must not run without the grant fail on it.
 */
export const MEMORY_CEILING_UNSUPPORTED = "memory_ceiling_unsupported";

const memoryRefusal = (message: string) =>
  new SshRemoteDispatchError({
    reason: "remote_refused",
    message,
    remoteCode: MEMORY_CEILING_UNSUPPORTED,
  });

export interface SshDispatchHost {
  readonly alias: string;
  readonly source: "ssh-config" | "known-hosts";
  readonly reachable?: boolean;
  readonly probeError?: string;
}

export interface SshBrowseResult {
  readonly host: string;
  readonly os: string | null;
  readonly home: string | null;
  readonly path: string;
  readonly realPath: string;
  readonly gitRoot: string | null;
  readonly branch: string | null;
  readonly worktrees: ReadonlyArray<RemoteWorktree>;
  readonly entries: ReadonlyArray<RemoteDirectoryEntry>;
  readonly truncated: boolean;
}

/**
 * How long a launch waits to learn which goat_thread_launch arguments the remote declares.
 * The probe is optional: a remote that does not answer in time gets the launch without
 * lineage, and with the report binding the coordinator retries without if refused.
 */
export const LAUNCH_LINEAGE_PROBE_TIMEOUT = "5 seconds";

/** How a remote that predates goat_thread_status refuses it; callers fall back to goat_thread_read. */
export const REMOTE_THREAD_STATUS_UNSUPPORTED = "does not have goat_thread_status";

/** Whether a JSON-RPC refusal says the remote has no such tool, as an older GOAT answers. */
const isUnknownToolRefusal = (error: AcpMcpBridgeError, tool: string) =>
  error.kind === "rpc" &&
  (error.message.includes(`Tool '${tool}' not found`) ||
    error.message.includes(`Unknown tool: ${tool}`));

/**
 * Names the build each side runs and the fix. Starts with "GOAT on <host> does
 * not have <tool>", which callers match to fall back for older remotes.
 */
function missingRemoteToolMessage(
  host: string,
  tool: string,
  remoteVersion: string | undefined,
): string {
  return `GOAT on ${host} does not have ${tool}; it runs ${remoteVersion ?? "an older build"} and this machine runs ${packageJson.version}. Update GOAT on ${host}; a runtime this machine installed there is refreshed once that host is idle.`;
}

type SshDispatchDestination =
  | { readonly host: string; readonly target?: undefined }
  | { readonly target: DesktopSshEnvironmentTarget; readonly host?: undefined };
export type SshLaunchInput = SshDispatchDestination & {
  readonly memoryGrantCeiling?: import("@goat/contracts").MemoryTaskGrantCeiling;
  readonly cwd: string;
  readonly workspace: SshLaunchWorkspace;
  readonly title: string;
  readonly message?: string | undefined;
  readonly projectTitle?: string | undefined;
  readonly scripts?: ReadonlyArray<ProjectScript> | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode: RuntimeMode;
  /**
   * The most the caller may grant. The remote session carries this ceiling so
   * it can register projects; the thread itself starts with runtimeMode.
   */
  readonly callerRuntimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly attachments?: ReadonlyArray<ChatImageAttachment | ChatFileAttachment> | undefined;
  readonly report?: RemoteReportBindingInput | undefined;
  /** Appended to message only when report is sent, telling the agent how to report back. */
  readonly reportNote?: string | undefined;
  /** Accept a folder that broadWorkspaceRoot rejects; only when the user asked for it. */
  readonly allowBroadWorkspaceRoot?: boolean | undefined;
  /**
   * The thread on this machine that asked for the launch. Forwarded only to a remote
   * whose goat_thread_launch declares launchedBy; older remotes refuse unknown arguments.
   */
  readonly launchedBy?: OrchestrationV2ThreadLauncher | undefined;
  /**
   * False asks the remote not to put its standing instructions in front of
   * message. Forwarded only to a remote whose goat_thread_launch declares it.
   */
  readonly standingInstructions?: boolean | undefined;
};

export interface SshLaunchResult {
  readonly host: string;
  readonly cwd: string;
  readonly projectId: string;
  readonly projectCreated: boolean;
  readonly threadId: string;
  readonly reportsSupported: boolean;
  /** The thread's first run, when a message started one. */
  readonly runId: string | null;
  readonly workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
  readonly runtimeMode: RuntimeMode;
  readonly remoteServerKind: "external" | "managed" | null;
  readonly notes: ReadonlyArray<string>;
}

/** One tool call on another machine's GOAT server. */
export interface SshHostToolCall {
  readonly host: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Deadline for the remote answer; past it the host counts as unavailable. */
  readonly timeoutMs: number;
  /** Writes need a remote that applies the session's runtime-mode ceiling. */
  readonly writes: boolean;
  /**
   * The caller holds `orchestration:approve`, so the remote session asks for
   * it too. If the remote cannot grant it, the call fails; it never falls back
   * to a session with fewer permissions.
   */
  readonly approvals?: boolean;
  /**
   * The caller holds a live `providers:manage`, so the remote session carries
   * it too and the remote can attribute a provider write to a person allowed
   * to make it. Like approvals, it never falls back to a narrower session.
   */
  readonly providersManage?: boolean;
  readonly requireReady?: true;
}

export class SshRemoteDispatch extends Context.Service<
  SshRemoteDispatch,
  {
    readonly runtimeStatus: (host: string) => Effect.Effect<SshHostResult, SshRemoteDispatchError>;
    readonly runtimeUpdate: (
      host: string,
      options: {
        readonly confirmReplacement: boolean;
        readonly onPhase?: SshTunnel.SshRuntimeProgressCallback;
        readonly operationId?: string;
        readonly generation?: number;
      },
    ) => Effect.Effect<SshHostResult, SshRemoteDispatchError>;
    readonly beginSetupOperation: (
      host: string,
      options: { readonly operationId: string },
    ) => Effect.Effect<import("@goat/contracts").SshHostSetupProgress, SshRemoteDispatchError>;
    readonly prepareRuntime: (
      host: string,
      options: {
        readonly operationId: string;
        readonly generation: number;
        readonly onPhase?: SshTunnel.SshRuntimeProgressCallback;
      },
    ) => Effect.Effect<SshHostResult, SshRemoteDispatchError>;
    readonly forgetRuntime: (
      host: string,
      options: { readonly stopRuntime: "if_idle" | "no" },
    ) => Effect.Effect<SshHostResult, SshRemoteDispatchError>;
    readonly publishSetupOutcome: (
      host: string,
      operation: Pick<import("@goat/contracts").SshHostSetupProgress, "operationId" | "generation">,
      outcome: SshTunnel.SshSetupOutcome,
    ) => Effect.Effect<boolean>;
    readonly publishProviderDiagnosis: (
      host: string,
      options: {
        readonly operationId: string;
        readonly generation: number;
        readonly providers: import("@goat/contracts").SshHostProviders;
      },
    ) => Effect.Effect<boolean, SshRemoteDispatchError>;
    readonly runRemoteScript: (input: {
      readonly target: DesktopSshEnvironmentTarget;
      readonly script: string;
      readonly timeoutMs: number;
    }) => Effect.Effect<
      { readonly stdout: string; readonly stderr: string },
      SshRemoteDispatchError
    >;
    /** Runs a POSIX sh script on a known SSH host alias, the way runRemoteScript does. */
    readonly runHostScript: (input: {
      readonly host: string;
      readonly script: string;
      readonly timeoutMs: number;
    }) => Effect.Effect<
      { readonly stdout: string; readonly stderr: string },
      SshRemoteDispatchError
    >;
    readonly identifyTarget: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<EnvironmentId | null, SshRemoteDispatchError>;
    readonly preflightTarget: (input: {
      readonly target: DesktopSshEnvironmentTarget;
      readonly runtimeMode: RuntimeMode;
      readonly modelSelection: ModelSelection;
    }) => Effect.Effect<{ readonly environmentId: EnvironmentId }, SshRemoteDispatchError>;
    readonly listHosts: (input: {
      readonly probe: boolean;
    }) => Effect.Effect<ReadonlyArray<SshDispatchHost>, SshRemoteDispatchError>;
    readonly browse: (input: {
      readonly host: string;
      readonly path?: string | undefined;
      readonly showHidden?: boolean | undefined;
      readonly limit?: number | undefined;
    }) => Effect.Effect<SshBrowseResult, SshRemoteDispatchError>;
    /** Local preflight before the coordinator records a dispatch; no remote side effects. */
    readonly validateLaunchAttachments: (
      requested: ReadonlyArray<ChatImageAttachment | ChatFileAttachment>,
    ) => Effect.Effect<
      ReadonlyArray<ChatImageAttachment | ChatFileAttachment>,
      SshRemoteDispatchError
    >;
    /** `beforeLaunch` re-checks the caller right before the remote thread starts. */
    readonly launchThread: <E, R>(
      input: SshLaunchInput,
      beforeLaunch: Effect.Effect<void, E, R>,
    ) => Effect.Effect<SshLaunchResult, SshRemoteDispatchError | E, R>;
    /**
     * Calls one of the remote's own MCP tools as an outside client whose
     * ceiling is the caller's runtime mode. `authorize` reloads the caller and
     * returns its current runtime mode; it runs before the session is chosen
     * and again right before the tool request, so a caller whose modes
     * changed meanwhile sends nothing.
     */
    readonly callHostTool: <E, R>(
      call: SshHostToolCall,
      authorize: Effect.Effect<RuntimeMode, E, R>,
    ) => Effect.Effect<unknown, SshRemoteDispatchError | E, R>;
    /** Hosts this process holds an SSH tunnel to, and every linked host, sorted. */
    readonly connectedHosts: Effect.Effect<ReadonlyArray<string>>;
    /**
     * Forwards a node's GOAT server to a local port for the hub proxy, starting the runtime when
     * needed. Takes the full target so a node's own user, host name and port win over the alias.
     * Never wakes a stopped cloud machine.
     */
    readonly proxyEndpoint: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<
      { readonly httpBaseUrl: string; readonly wsBaseUrl: string },
      SshRemoteDispatchError
    >;
    /** Issues a node client session holding exactly `scopes`, for the hub proxy's own use. */
    readonly issueProxySession: (
      target: DesktopSshEnvironmentTarget,
      scopes: ReadonlyArray<AuthEnvironmentScope>,
    ) => Effect.Effect<SshTunnel.RemoteClientSession, SshRemoteDispatchError>;
  }
>()("goat/sshRemote/SshRemoteDispatch") {}

const decodeIdentityFile = Schema.decodeEffect(EnvironmentId);

const decodeRemoteIdentity = Schema.decodeUnknownEffect(
  Schema.Struct({ environmentId: EnvironmentId }),
);

/** A launch note when the remote GOAT runs another build than this machine. A launch reaches
    here only after the tunnel accepted the remote's protocol ranges, so this is informational. */
function remoteVersionNote(
  host: string,
  remoteVersion: string | undefined,
  localVersion: string,
): string | null {
  if (remoteVersion === undefined || remoteVersion === localVersion) return null;
  return `GOAT on ${host} runs ${remoteVersion}; this machine runs ${localVersion}. Both speak the same protocols, but a tool or launch option added in the newer build can be missing on the older one.`;
}

const sessionKey = (
  target: DesktopSshEnvironmentTarget,
  ceiling: RuntimeMode,
  approvals: boolean,
  memoryGrantCeiling: import("@goat/contracts").MemoryTaskGrantCeiling = "none",
  providersManage = false,
) =>
  `${targetConnectionKey(target)}\u0000${ceiling}\u0000${memoryGrantCeiling}${approvals ? "\u0000approvals" : ""}${providersManage ? "\u0000providers" : ""}`;
const decodeRemoteCapabilities = Schema.decodeUnknownEffect(OrchestratorMcpCapabilitiesResult);

const decodeRemoteProject = Schema.decodeUnknownEffect(Schema.Struct({ id: ProjectId }));
const decodeRemoteThread = Schema.decodeUnknownEffect(
  Schema.Struct({ threadId: ThreadId, runId: Schema.optional(Schema.NullOr(Schema.String)) }),
);

type RuntimeServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService;

const SESSION_TTL = "12h";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_REFRESH_MARGIN_MS = 10 * 60 * 1000;
const BROWSE_TIMEOUT_MS = 20_000;
const ATTACHMENT_PREPARE_TIMEOUT_MS = 20_000;
const ATTACHMENT_UPLOAD_TIMEOUT_MS = 60_000;
const ATTACHMENT_DISCARD_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_BROWSE_LIMIT = 200;
const MAX_BROWSE_LIMIT = 1000;
const MAX_PROJECT_PAGES = 20;
/**
 * Agents connect on every tool call. A host whose runtime refresh was deferred
 * keeps serving on its current runtime until the manager's background retry.
 */
const AGENT_CONNECTION = { reuseWhileRefreshPending: true } as const;

/** An alias the SSH config or known_hosts names, with nothing ssh could read as an option. */
const SAFE_HOST_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9_.@:%+\-[\]]*$/u;

const failure = (reason: SshRemoteDispatchError["reason"], message: string) =>
  new SshRemoteDispatchError({ reason, message });

const describe = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String((error as { readonly message: unknown }).message).trim();
    if (message.length > 0) return message;
  }
  return String(error);
};

/**
 * Agents cannot answer an SSH password prompt. Saying the prompt is available
 * makes the manager run ssh with BatchMode=yes, and failing the prompt turns a
 * password-only host into a clear error instead of a hung command.
 */
const keyOnlyPasswordPrompt = SshAuth.SshPasswordPrompt.of({
  isAvailable: true,
  request: (request) =>
    Effect.fail(
      new SshPasswordPromptError({
        message: `${request.destination} asked for a password. GOAT agents connect only with SSH keys or a running ssh-agent; set up key authentication for this host first.`,
      }),
    ),
});

const normalizeRemotePath = (value: string) =>
  value.length > 1 ? value.replace(/\/+$/u, "") : value;

interface RemoteProject {
  readonly id: string;
  readonly workspaceRoot: string;
}

/**
 * Why a remote folder is too broad to be a thread's workspace, or null. The
 * filesystem root, the home directory, a folder above home, and other top-level
 * folders would give an agent a whole account or machine, and the folder
 * becomes a project on the remote. Case is folded, which can only over-reject.
 */
export function broadWorkspaceRoot(
  folder: Pick<SshBrowseResult, "path" | "realPath" | "home">,
): string | null {
  // A Windows drive letter is part of the root, not a folder below it.
  const segments = (value: string) =>
    value
      .split(/[\\/]+/)
      .filter((part) => part.length > 0 && !/^[A-Za-z]:$/.test(part))
      .map((part) => part.toLowerCase());
  const home = folder.home === null ? [] : segments(folder.home);
  for (const candidate of [folder.path, folder.realPath]) {
    const parts = segments(candidate);
    if (parts.length === 0) return "the filesystem root";
    if (
      home.length > 0 &&
      parts.length <= home.length &&
      parts.every((part, i) => part === home[i])
    ) {
      return parts.length === home.length
        ? "the home directory"
        : "a folder that contains the home directory";
    }
    if (parts.length === 1) return "a top-level folder";
  }
  return null;
}

/**
 * What launch knows about a folder on a linked host, which it cannot browse, or why the
 * folder is unusable. Launch then requires an existing project there, so a person on that
 * host chose the workspace; the path only needs to match project roots exactly.
 */
export function linkedHostFolder(alias: string, cwd: string): SshBrowseResult | string {
  const trimmed = cwd.trim();
  const windows = /^[A-Za-z]:[\\/]/u.test(trimmed);
  if (/^(?:\/\/|\\\\)/u.test(trimmed))
    return `${alias} is a linked host; network share paths are not supported there. Pass the local absolute path of one of its projects.`;
  if (!windows && !trimmed.startsWith("/"))
    return `${alias} is a linked host, so cwd must be an absolute path there, not ${trimmed}. goat_project_list with host "${alias}" shows its project folders.`;
  // Resolve . and .. so the path compares with the host's stored project roots.
  const [root, ...rest] = trimmed.split(/[\\/]+/u);
  const parts: Array<string> = [];
  for (const part of rest) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  const separator = windows ? "\\" : "/";
  const path = `${root}${separator}${parts.join(separator)}`;
  return {
    host: alias,
    os: null,
    home: null,
    path,
    realPath: path,
    gitRoot: null,
    branch: null,
    worktrees: [],
    entries: [],
    truncated: false,
  };
}

/**
 * Finds the project registered at the browsed folder, by either form of its path. A Windows
 * host compares either shell form, any slash, and any case, as NTFS does by default.
 * A linked host reports no OS, so its native `C:\…` project roots alone mark it as Windows.
 */
export function matchRemoteProject(
  projects: ReadonlyArray<RemoteProject>,
  folder: { readonly path: string; readonly realPath: string; readonly os: string | null },
): RemoteProject | undefined {
  if (isWindowsShellOs(folder.os)) {
    const keys = new Set([windowsHostPathKey(folder.path), windowsHostPathKey(folder.realPath)]);
    return projects.find((project) => keys.has(windowsHostPathKey(project.workspaceRoot)));
  }
  const candidates = new Set([
    normalizeRemotePath(folder.path),
    normalizeRemotePath(folder.realPath),
  ]);
  const exact = projects.find((project) =>
    candidates.has(normalizeRemotePath(project.workspaceRoot)),
  );
  if (exact === undefined && folder.os === null) {
    const keys = new Set([windowsHostPathKey(folder.path), windowsHostPathKey(folder.realPath)]);
    return projects.find(
      (project) =>
        isWindowsAbsolutePath(project.workspaceRoot) &&
        keys.has(windowsHostPathKey(project.workspaceRoot)),
    );
  }
  if (exact !== undefined || folder.os !== "Darwin") return exact;
  // macOS volumes are usually case-insensitive, so a project can be saved with other casing.
  const folded = new Set([...candidates].map((candidate) => candidate.toLowerCase()));
  return projects.find((project) =>
    folded.has(normalizeRemotePath(project.workspaceRoot).toLowerCase()),
  );
}

interface CallToolResult {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
}

/** Reads a remote `tools/call` result: its structured payload, or the refusal and code it returned. */
export function readRemoteToolResult(
  tool: string,
  raw: unknown,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string; readonly code?: string } {
  const result = (typeof raw === "object" && raw !== null ? raw : {}) as CallToolResult;
  const text = result.content?.find((item) => item.type === "text")?.text;
  let payload: unknown = result.structuredContent;
  if (payload === undefined && text !== undefined) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }
  if (result.isError === true) {
    const fields =
      typeof payload === "object" && payload !== null
        ? (payload as { readonly message?: unknown; readonly code?: unknown })
        : {};
    const message = "message" in fields ? String(fields.message) : (text ?? "no details");
    return {
      ok: false,
      message: `The remote ${tool} refused: ${message}`,
      ...(typeof fields.code === "string" ? { code: fields.code } : {}),
    };
  }
  return { ok: true, value: payload };
}

const SshLaunchAttachments = Schema.Array(
  Schema.Union([ChatImageAttachment, ChatFileAttachment]),
).check(Schema.isMaxLength(8));

const decodeLaunchAttachments = Schema.decodeUnknownEffect(SshLaunchAttachments);
const decodeUploadInput = Schema.decodeUnknownEffect(AttachmentCreateUploadUrlInput);
const decodePreparedIdentity = Schema.decodeUnknownEffect(
  Schema.Struct({ attachmentId: ChatAttachmentId }),
);
const decodePreparedUpload = Schema.decodeUnknownEffect(AttachmentCreateUploadUrlResult);

const validateSshLaunchAttachments = Effect.fn("SshRemoteDispatch.validateSshLaunchAttachments")(
  function* (requested: ReadonlyArray<ChatImageAttachment | ChatFileAttachment>) {
    const attachments = yield* decodeLaunchAttachments(requested).pipe(
      Effect.mapError(() => failure("invalid_request", "Invalid SSH attachment references.")),
    );
    // Match local goat_thread_launch: callers may supply any pending id they know.
    // Web uploads have no MCP owner entry; SSH does not add a separate ownership rule.
    if (attachments.some((attachment) => !Claims.attachmentIsPendingUpload(attachment))) {
      return yield* failure(
        "invalid_request",
        "A remote thread accepts only pending attachment uploads.",
      );
    }
    if (new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length) {
      return yield* failure("invalid_request", "Duplicate attachment ids are not allowed.");
    }
    yield* Claims.validateAttachmentLimits(attachments).pipe(
      Effect.mapError((error) => failure("invalid_request", error.message)),
    );
    return yield* Effect.forEach(attachments, (attachment) =>
      decodeUploadInput({
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType.toLowerCase(),
        sizeBytes: attachment.sizeBytes,
      }).pipe(
        Effect.mapError(() =>
          failure(
            "invalid_request",
            `Attachment '${attachment.name}' has invalid upload metadata.`,
          ),
        ),
        Effect.map((upload) => ({ ...attachment, mimeType: upload.mimeType })),
      ),
    );
  },
);

const make = Effect.gen(function* () {
  const manager = yield* SshTunnel.SshEnvironmentManager;
  const runtime = yield* Effect.context<RuntimeServices>();
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = Context.get(runtime, FileSystem.FileSystem);
  const httpClient = Context.get(runtime, HttpClient.HttpClient);
  const sessions = new Map<
    string,
    { readonly token: string; readonly expiresAt: number; readonly ceilingApplied: boolean }
  >();
  const sessionLocks = new Map<string, Semaphore.Semaphore>();
  // Cache only optional launch arguments; memory admission always uses a fresh catalog.
  const launchArguments = new Map<string, ReadonlySet<string>>();
  const connected = new Set<string>();
  // Retain only the target address so status can reach the manager's post-forget snapshot after the alias files are removed.
  const forgottenTargets = new Map<string, DesktopSshEnvironmentTarget>();

  const withRuntime = <A, E>(
    effect: Effect.Effect<A, E, RuntimeServices | SshAuth.SshPasswordPrompt>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(SshAuth.SshPasswordPrompt, keyOnlyPasswordPrompt),
      Effect.provide(runtime),
    );

  // Cloud machines this server manages get a fresh address and pinned host key before an SSH
  // operation. Optional so test layers without it dial every alias as plain SSH.
  const cloudMachines = yield* Effect.serviceOption(CloudMachineService.CloudMachineService);
  /** Forgets everything cached for an alias whose address or host key changed. */
  const invalidateAlias = (alias: string, disconnect = true) =>
    Effect.gen(function* () {
      const prefix = `${alias}\u0000`;
      for (const key of sessions.keys()) if (key.startsWith(prefix)) sessions.delete(key);
      for (const key of launchArguments.keys())
        if (key.startsWith(prefix)) launchArguments.delete(key);
      connected.delete(alias);
      if (disconnect)
        yield* withRuntime(
          manager.disconnectEnvironment({ alias, hostname: alias, username: null, port: null }),
        ).pipe(Effect.ignore({ log: true }));
    });
  if (Option.isSome(cloudMachines))
    yield* cloudMachines.value.onAliasInvalidated((alias) => invalidateAlias(alias));

  // Hosts linked over HTTPS. Optional so test layers without it dial every alias as plain SSH.
  const linkedHosts = yield* Effect.serviceOption(LinkedHosts.LinkedHosts);
  const linkedAliases = new Set<string>();
  const linkedFor = (host: string) =>
    Option.isNone(linkedHosts)
      ? Effect.succeed(Option.none<LinkedHosts.LinkedHostCredential>())
      : linkedHosts.value.find(host).pipe(
          Effect.tap((found) =>
            Effect.sync(() => {
              if (Option.isSome(found)) linkedAliases.add(found.value.host.name);
              else linkedAliases.delete(host.trim());
            }),
          ),
          Effect.mapError((error) => failure("host_unavailable", error.message)),
        );
  const linkExpired = (alias: string) =>
    failure(
      "remote_refused",
      `${alias} no longer accepts this machine's link; it expired or was revoked there. Create a pairing code on ${alias} with goat auth pairing create and call goat_host_link_create again.`,
    );
  /**
   * `wake` resumes a stopped machine; only explicit agent work passes it. Polling through
   * callHostTool (launch watches, reports, host status) must never start a billed machine.
   */
  const readyCloudTarget = (target: DesktopSshEnvironmentTarget, wake: boolean) =>
    Option.isNone(cloudMachines) || !isCloudMachineAlias(target.alias)
      ? Effect.void
      : cloudMachines.value.owns(target.alias).pipe(
          Effect.flatMap((owned) =>
            owned
              ? cloudMachines.value.ensureReady(target.alias as CloudMachineAlias, { wake })
              : Effect.void,
          ),
          Effect.asVoid,
          Effect.mapError((error) =>
            failure("host_unavailable", `${target.alias}: ${error.message}`),
          ),
        );

  const knownHosts = withRuntime(discoverSshHosts({})).pipe(
    Effect.mapError((error) => failure("ssh_failed", describe(error))),
  );

  const resolveHost = Effect.fn("SshRemoteDispatch.resolveHost")(function* (host: string) {
    const alias = host.trim();
    if (!SAFE_HOST_ALIAS.test(alias)) {
      return yield* failure("invalid_request", `"${host}" is not a usable SSH host alias.`);
    }
    if (Option.isSome(yield* linkedFor(alias))) {
      return yield* failure(
        "invalid_request",
        `${alias} is a linked GOAT host reached over HTTPS, so SSH tools cannot reach it. Use goat_project_list and the goat_thread_* tools with host "${alias}", or goat_ssh_thread_launch with a folder that exists there.`,
      );
    }
    const hosts = yield* knownHosts;
    // A managed cloud machine's SSH entry is written by its first use, so it may not exist yet.
    const ownedCloudMachine =
      Option.isSome(cloudMachines) &&
      isCloudMachineAlias(alias) &&
      (yield* cloudMachines.value.owns(alias));
    if (!ownedCloudMachine && !hosts.some((entry) => entry.alias === alias)) {
      return yield* failure(
        "host_unknown",
        `${alias} is not in this machine's SSH config or known_hosts. It is not a linked host either. Call goat_ssh_host_list or goat_host_link_list for the hosts it can reach.`,
      );
    }
    return {
      alias,
      hostname: alias,
      username: null,
      port: null,
    } satisfies DesktopSshEnvironmentTarget;
  });

  const sshFailed = (alias: string) =>
    Effect.mapError((error: unknown) =>
      error instanceof SshRemoteDispatchError
        ? error
        : failure("ssh_failed", `SSH to ${alias} failed: ${describe(error)}`),
    );

  const runtimeStatus = Effect.fn("SshRemoteDispatch.runtimeStatus")(function* (host: string) {
    const target = forgottenTargets.get(host) ?? (yield* resolveHost(host));
    return yield* withRuntime(manager.status(target)).pipe(sshFailed(target.alias));
  });

  const runtimeUpdate = Effect.fn("SshRemoteDispatch.runtimeUpdate")(function* (
    host: string,
    options: {
      readonly confirmReplacement: boolean;
      readonly onPhase?: SshTunnel.SshRuntimeProgressCallback;
      readonly operationId?: string;
      readonly generation?: number;
    },
  ) {
    const target = yield* resolveHost(host);
    if (options.operationId !== undefined) {
      const current = yield* withRuntime(manager.status(target)).pipe(sshFailed(host));
      if (
        current.status?.setup?.operationId !== options.operationId ||
        current.status.setup.generation !== options.generation
      )
        return yield* failure("caller_changed", "This SSH update was superseded. Ask again.");
    }
    // The manager records acquisition failures as status, including the archive and human fix.
    const ensured = yield* withRuntime(
      manager.ensureEnvironment(target, {
        keyOnly: true,
        issuePairingToken: false,
        refreshRuntime: true,
        confirmReplacement: options.confirmReplacement,
        ...(options.onPhase === undefined ? {} : { onPhase: options.onPhase }),
      }),
    ).pipe(Effect.result);
    const result = yield* withRuntime(manager.status(target)).pipe(sshFailed(target.alias));
    if (
      ensured._tag === "Failure" &&
      result.kind === "ok" &&
      (result.status.state === "ready" || result.status.state === "stopped")
    ) {
      return yield* failure(
        "ssh_failed",
        `SSH to ${target.alias} failed: ${describe(ensured.failure)}`,
      );
    }
    return result;
  });

  const beginSetupOperation: SshRemoteDispatch["Service"]["beginSetupOperation"] = (
    host,
    options,
  ) =>
    Effect.gen(function* () {
      const target = yield* resolveHost(host);
      const operation = yield* withRuntime(
        manager.beginSetupOperation(target, options.operationId),
      ).pipe(sshFailed(host));
      forgottenTargets.delete(host);
      return operation;
    });
  const prepareRuntime: SshRemoteDispatch["Service"]["prepareRuntime"] = (host, options) =>
    Effect.gen(function* () {
      const target = yield* resolveHost(host);
      const current = yield* withRuntime(manager.status(target)).pipe(sshFailed(host));
      if (
        current.status?.setup?.operationId !== options.operationId ||
        current.status.setup.generation !== options.generation
      )
        return yield* failure("caller_changed", "This SSH setup was superseded. Ask again.");
      const ensured = yield* withRuntime(
        manager.ensureEnvironment(target, {
          keyOnly: true,
          issuePairingToken: false,
          refreshRuntime: false,
          confirmReplacement: false,
          ...(options.onPhase === undefined ? {} : { onPhase: options.onPhase }),
        }),
      ).pipe(Effect.result);
      const result = yield* withRuntime(manager.status(target)).pipe(sshFailed(host));
      if (
        ensured._tag === "Failure" &&
        result.kind === "ok" &&
        (result.status.state === "ready" || result.status.state === "stopped")
      )
        return yield* failure("ssh_failed", `SSH to ${host} failed: ${describe(ensured.failure)}`);
      return result;
    });
  const forgetRuntime: SshRemoteDispatch["Service"]["forgetRuntime"] = (host, options) =>
    Effect.gen(function* () {
      const target = forgottenTargets.get(host) ?? (yield* resolveHost(host));
      forgottenTargets.set(host, target);
      // forgetEnvironment fences its generation before waiting for the installation lock.
      return yield* withRuntime(manager.forgetEnvironment(target, options)).pipe(
        Effect.ensuring(invalidateAlias(host, false)),
        sshFailed(host),
      );
    });
  const publishSetupOutcome: SshRemoteDispatch["Service"]["publishSetupOutcome"] = (
    host,
    operation,
    outcome,
  ) =>
    manager.publishSetupOutcome(
      { alias: host, hostname: host, username: null, port: null },
      operation,
      outcome,
    );
  const publishProviderDiagnosis: SshRemoteDispatch["Service"]["publishProviderDiagnosis"] = (
    host,
    options,
  ) =>
    Effect.gen(function* () {
      const target = yield* resolveHost(host);
      return yield* withRuntime(
        manager.publishProviderDiagnosis(target, options, options.providers),
      ).pipe(sshFailed(host));
    });

  const browseTarget = Effect.fn("SshRemoteDispatch.browseTarget")(function* (
    target: DesktopSshEnvironmentTarget,
    input: {
      readonly path?: string | undefined;
      readonly showHidden?: boolean | undefined;
      readonly limit?: number | undefined;
    },
  ) {
    yield* readyCloudTarget(target, true);
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_BROWSE_LIMIT, 0), MAX_BROWSE_LIMIT);
    const result = yield* withRuntime(
      manager.runRemoteScript(target, {
        script: buildRemoteBrowseScript({
          path: input.path ?? null,
          showHidden: input.showHidden === true,
          maxEntries: limit,
        }),
        timeoutMs: BROWSE_TIMEOUT_MS,
      }),
    ).pipe(sshFailed(target.alias));
    const parsed = parseRemoteBrowseOutput(result.stdout);
    if (parsed === null) {
      return yield* failure(
        "ssh_failed",
        `${target.alias} returned output the folder browser could not read. Its login shell may print text for non-interactive sessions.`,
      );
    }
    if (parsed._tag === "NotADirectory") {
      return yield* failure(
        "invalid_request",
        `${parsed.path || "(empty path)"} does not exist or is not a directory on ${target.alias}, so nothing was started there. Pick an existing folder with goat_ssh_browse, or clone the repository on ${target.alias} first.`,
      );
    }
    return {
      host: target.alias,
      os: parsed.os,
      home: parsed.home,
      path: parsed.path,
      realPath: parsed.realPath,
      gitRoot: parsed.gitRoot,
      branch: parsed.branch,
      worktrees: parsed.worktrees,
      entries: parsed.entries,
      truncated: parsed.truncated,
    } satisfies SshBrowseResult;
  });

  const sessionFor = Effect.fn("SshRemoteDispatch.sessionFor")(function* (
    target: DesktopSshEnvironmentTarget,
    ceiling: RuntimeMode,
    approvals = false,
    memoryGrantCeiling: import("@goat/contracts").MemoryTaskGrantCeiling = "none",
    requireReady?: true,
    providersManage = false,
  ) {
    const key = sessionKey(target, ceiling, approvals, memoryGrantCeiling, providersManage);
    const gate = sessionLocks.get(key) ?? Semaphore.makeUnsafe(1);
    sessionLocks.set(key, gate);
    const work = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = sessions.get(key);
      if (cached !== undefined && cached.expiresAt - SESSION_REFRESH_MARGIN_MS > now) return cached;
      // A session that may answer approvals is never swapped for a narrower one.
      const issued = yield* withRuntime(
        manager.issueMcpClientSession(target, {
          ...(requireReady === undefined ? {} : { requireReady }),
          label: `GOAT SSH dispatch (${ceiling}${approvals ? ", approvals" : ""}${providersManage ? ", providers" : ""})`,
          ttl: SESSION_TTL,
          runtimeModeCeiling: ceiling,
          ...(approvals ? { approvals: true } : {}),
          ...(providersManage ? { providersManage: true } : {}),
          memoryScopes:
            memoryGrantCeiling === "none"
              ? []
              : memoryGrantCeiling === "read"
                ? ["memory:read"]
                : ["memory:read", "memory:write"],
        }),
      ).pipe(
        // The remote answered and refused; its message names the runtime and what happens next.
        Effect.mapError((error) =>
          error instanceof SshPairingError && error.reason === "memory-scopes-unsupported"
            ? memoryRefusal(error.message)
            : error,
        ),
        approvals
          ? Effect.mapError((error) =>
              error instanceof SshRemoteDispatchError
                ? error
                : failure(
                    "remote_refused",
                    `${target.alias} could not issue a GOAT session that may answer approvals: ${describe(error)}. Update GOAT there, or let the user answer in that thread.`,
                  ),
            )
          : providersManage
            ? Effect.mapError((error) =>
                error instanceof SshRemoteDispatchError
                  ? error
                  : failure(
                      "remote_refused",
                      `${target.alias} could not issue a GOAT session that may manage providers: ${describe(error)}. Update GOAT there, or manage providers in Settings on ${target.alias}.`,
                    ),
              )
            : sshFailed(target.alias),
      );
      const parsedExpiry = issued.expiresAt === null ? Number.NaN : Date.parse(issued.expiresAt);
      const session = {
        token: issued.token,
        expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : now + SESSION_TTL_MS,
        ceilingApplied: issued.runtimeModeCeilingApplied,
      };
      sessions.set(key, session);
      launchArguments.delete(key);
      return session;
    });
    if (requireReady === true) {
      const result = yield* work.pipe(gate.withPermitsIfAvailable(1));
      if (Option.isNone(result))
        return yield* failure(
          "host_unavailable",
          `Call goat_ssh_host_prepare for ${target.alias}, then call goat_ssh_host_status until setup completes; retry goat_provider_diagnose.`,
        );
      return result.value;
    }
    return yield* work.pipe(gate.withPermit);
  });

  // A delayed rejection of an older bearer must not evict its replacement.
  const invalidateSession = (key: string, token: string) => {
    if (sessions.get(key)?.token === token) sessions.delete(key);
  };

  /**
   * Current launch capabilities, with optional declarations from cache if listing
   * failed. Only a listing that declares report and standingInstructions is cached; a
   * failure or an older remote is asked again on the next launch, so an upgrade takes
   * effect without a new session.
   */
  const remoteLaunchArguments = Effect.fn("SshRemoteDispatch.remoteLaunchArguments")(
    function* (remote: {
      readonly target: DesktopSshEnvironmentTarget;
      readonly httpBaseUrl: string;
      readonly ceiling: RuntimeMode;
      readonly memoryGrantCeiling?: import("@goat/contracts").MemoryTaskGrantCeiling;
      readonly token: string;
    }) {
      const key = sessionKey(remote.target, remote.ceiling, false, remote.memoryGrantCeiling);
      // Never use session-lifetime cache entries to decide memory admission.
      // Ordinary omitted-ceiling launches retain their optional-argument compatibility.
      const listed = yield* Effect.exit(
        listAcpMcpTools({
          endpoint: new URL("mcp", remote.httpBaseUrl).toString(),
          authorization: `Bearer ${remote.token}`,
          strict: true,
        }).pipe(Effect.timeout(LAUNCH_LINEAGE_PROBE_TIMEOUT)),
      );
      if (Exit.isFailure(listed)) return { capabilities: null, declared: launchArguments.get(key) };
      const declared = new Set(
        listed.value.find((tool) => tool.name === "goat_thread_launch")?.argumentNames ?? [],
      );
      const advertisesMemory = listed.value.some((tool) =>
        [...MEMORY_MCP_TOOLS, ...MEMORY_ADMINISTRATION_MCP_TOOLS].some(
          (name) => tool.name === name,
        ),
      );
      if (advertisesMemory && !declared.has("memoryGrantCeiling"))
        return yield* memoryRefusal("Remote memory tools require explicit task ceiling admission.");
      const capabilities = { declared, advertisesMemory };
      if (declared.has("report") && declared.has("standingInstructions"))
        launchArguments.set(key, declared);
      return { capabilities, declared };
    },
  );

  /**
   * Calls one remote tool with an already issued session. It never issues one
   * itself: issuance happens only right after the caller was re-checked.
   */
  const callRemote = Effect.fn("SshRemoteDispatch.callRemote")(function* <
    E = never,
    R = never,
  >(input: {
    readonly target: DesktopSshEnvironmentTarget;
    readonly httpBaseUrl: string;
    readonly ceiling: RuntimeMode;
    readonly memoryGrantCeiling?: import("@goat/contracts").MemoryTaskGrantCeiling;
    readonly token: string;
    readonly tool: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly beforeToolCall?: Effect.Effect<void, E, R> | undefined;
  }) {
    const raw = yield* callAcpMcpTool({
      endpoint: new URL("mcp", input.httpBaseUrl).toString(),
      authorization: `Bearer ${input.token}`,
      tool: input.tool,
      arguments: input.arguments,
      ...(input.beforeToolCall === undefined ? {} : { beforeToolCall: input.beforeToolCall }),
    }).pipe(
      Effect.mapError((error) => {
        if (!(error instanceof AcpMcpBridgeError)) return error;
        if (input.tool === "goat_attachment_prepare_upload" && error.kind === "rpc") {
          return failure(
            "remote_refused",
            `GOAT on ${input.target.alias} cannot prepare attachment uploads. Update it to a version with goat_attachment_prepare_upload; no thread was launched.`,
          );
        }
        if (input.tool === "goat_thread_status" && error.kind === "rpc") {
          return failure(
            "remote_refused",
            `GOAT on ${input.target.alias} ${REMOTE_THREAD_STATUS_UNSUPPORTED}.`,
          );
        }
        if (describe(error).includes("HTTP 401")) {
          if (linkedAliases.has(input.target.alias)) return linkExpired(input.target.alias);
          // Revoked or expired on the remote: forget it so the next call issues a fresh one.
          invalidateSession(
            sessionKey(input.target, input.ceiling, false, input.memoryGrantCeiling),
            input.token,
          );
          return failure(
            "remote_refused",
            `${input.target.alias} rejected this machine's GOAT session; call the tool again to sign in anew.`,
          );
        }
        return new SshRemoteDispatchError({
          // No SSH reaches a linked host: a transport failure there means it is unreachable.
          reason:
            linkedAliases.has(input.target.alias) && error.kind !== "rpc"
              ? "host_unavailable"
              : "ssh_failed",
          message: `Calling ${input.tool} on ${input.target.alias} failed: ${describe(error)}`,
          ...(input.tool === "goat_thread_launch" ? { launchMayHaveStarted: true } : {}),
        });
      }),
    );
    const result = readRemoteToolResult(input.tool, raw);
    if (!result.ok) return yield* failure("remote_refused", result.message);
    return result.value;
  });

  const resolveLaunchAttachmentSources = Effect.fn(
    "SshRemoteDispatch.resolveLaunchAttachmentSources",
  )(function* (requested: ReadonlyArray<ChatImageAttachment | ChatFileAttachment>) {
    const attachments = yield* validateSshLaunchAttachments(requested);
    return yield* Effect.forEach(
      attachments,
      (attachment) =>
        Effect.gen(function* () {
          const path = resolveAttachmentPathById({
            attachmentsDir: config.attachmentsDir,
            attachmentId: attachment.id,
          });
          const expected = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          });
          if (path === null || path !== expected) {
            return yield* failure(
              "invalid_request",
              `Attachment '${attachment.name}' is missing or does not match its pending upload.`,
            );
          }
          const info = yield* fileSystem
            .stat(path)
            .pipe(
              Effect.mapError(() =>
                failure("invalid_request", `Attachment '${attachment.name}' cannot be read.`),
              ),
            );
          if (info.type !== "File" || Number(info.size) !== attachment.sizeBytes) {
            return yield* failure(
              "invalid_request",
              `Attachment '${attachment.name}' has a stored size or file type mismatch.`,
            );
          }
          return { attachment, path };
        }),
      { concurrency: 1 },
    );
  });
  const validateLaunchAttachments = Effect.fn("SshRemoteDispatch.validateLaunchAttachments")(
    function* (requested: ReadonlyArray<ChatImageAttachment | ChatFileAttachment>) {
      const sources = yield* resolveLaunchAttachmentSources(requested);
      return sources.map(({ attachment }) => attachment);
    },
  );

  interface RemoteConnection {
    readonly target: DesktopSshEnvironmentTarget;
    readonly httpBaseUrl: string;
    readonly ceiling: RuntimeMode;
    readonly token: string;
  }

  const discardPreparedAttachments = Effect.fn("SshRemoteDispatch.discardPreparedAttachments")(
    function* (remote: RemoteConnection, ids: ReadonlyArray<string>) {
      yield* Effect.forEach(
        ids,
        (attachmentId) =>
          callRemote({
            ...remote,
            tool: "goat_attachment_discard",
            arguments: { attachmentId },
          }).pipe(Effect.timeoutOption(ATTACHMENT_DISCARD_TIMEOUT_MS), Effect.ignore),
        { concurrency: 1, discard: true },
      );
    },
  );

  const uploadPendingAttachments = Effect.fn("SshRemoteDispatch.uploadPendingAttachments")(
    function* <E, R>(
      remote: RemoteConnection,
      sources: ReadonlyArray<{
        readonly attachment: ChatImageAttachment | ChatFileAttachment;
        readonly path: string;
      }>,
      preparedIds: string[],
      beforeLaunch: Effect.Effect<void, E, R>,
    ) {
      const uploaded: Array<ChatImageAttachment | ChatFileAttachment> = [];
      for (const { attachment, path } of sources) {
        yield* beforeLaunch;
        const answer = yield* callRemote({
          ...remote,
          tool: "goat_attachment_prepare_upload",
          arguments: {
            upload: {
              type: attachment.type,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            },
          },
          beforeToolCall: beforeLaunch,
        }).pipe(Effect.timeoutOption(ATTACHMENT_PREPARE_TIMEOUT_MS));
        if (Option.isNone(answer)) {
          return yield* failure(
            "host_unavailable",
            `Preparing an attachment on ${remote.target.alias} timed out.`,
          );
        }
        // Track a valid id before decoding the URL, so malformed metadata still rolls it back.
        const identity = yield* decodePreparedIdentity(answer.value).pipe(
          Effect.mapError(() =>
            failure(
              "remote_refused",
              "The remote upload preparation returned no valid attachment id.",
            ),
          ),
        );
        if (!Claims.attachmentIsPendingUpload({ ...attachment, id: identity.attachmentId })) {
          return yield* failure(
            "remote_refused",
            "The remote upload preparation returned a non-pending id.",
          );
        }
        preparedIds.push(identity.attachmentId);
        const prepared = yield* decodePreparedUpload(answer.value).pipe(
          Effect.mapError(() =>
            failure(
              "remote_refused",
              "The remote upload preparation returned invalid URL metadata.",
            ),
          ),
        );
        const url = yield* Effect.try({
          try: () => new URL(prepared.relativeUrl, remote.httpBaseUrl),
          catch: () => failure("remote_refused", "The remote upload URL is malformed."),
        });
        if (
          !prepared.relativeUrl.startsWith(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`) ||
          url.origin !== new URL(remote.httpBaseUrl).origin ||
          !url.pathname.startsWith(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`) ||
          url.username !== "" ||
          url.password !== ""
        ) {
          return yield* failure(
            "remote_refused",
            "The remote upload URL is not on the forwarded attachment route.",
          );
        }
        yield* beforeLaunch;
        const remainingMs = prepared.expiresAt - (yield* Clock.currentTimeMillis);
        if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
          return yield* failure("remote_refused", "The remote attachment upload URL has expired.");
        }
        const request = HttpClientRequest.post(url.toString()).pipe(
          HttpClientRequest.bodyStream(fileSystem.stream(path), {
            contentType: attachment.mimeType,
            contentLength: attachment.sizeBytes,
          }),
        );
        // HttpClient's automatic span records url.full/url.path, which contain the
        // signed upload capability. Keep this request out of URL-bearing telemetry.
        const response = yield* Effect.scoped(httpClient.execute(request)).pipe(
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.mapError(() =>
            failure(
              "host_unavailable",
              `Uploading an attachment to ${remote.target.alias} failed.`,
            ),
          ),
          Effect.timeoutOption(Math.min(ATTACHMENT_UPLOAD_TIMEOUT_MS, remainingMs)),
        );
        if (Option.isNone(response)) {
          return yield* failure(
            "host_unavailable",
            `Uploading an attachment to ${remote.target.alias} timed out.`,
          );
        }
        if (response.value.status !== 204) {
          return yield* failure(
            "remote_refused",
            `The remote attachment upload returned HTTP ${response.value.status}; expected 204.`,
          );
        }
        uploaded.push({
          type: attachment.type,
          id: identity.attachmentId,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        });
      }
      return uploaded;
    },
  );

  const findProject = Effect.fn("SshRemoteDispatch.findProject")(function* (
    remote: {
      readonly target: DesktopSshEnvironmentTarget;
      readonly httpBaseUrl: string;
      readonly ceiling: RuntimeMode;
      readonly token: string;
    },
    folder: SshBrowseResult,
  ) {
    let cursor: number | null = 0;
    for (let page = 0; page < MAX_PROJECT_PAGES && cursor !== null; page += 1) {
      const listed = (yield* callRemote({
        ...remote,
        tool: "goat_project_list",
        arguments: { cursor, limit: 100 },
      })) as {
        readonly projects?: ReadonlyArray<RemoteProject>;
        readonly nextCursor?: number | null;
      };
      const match = matchRemoteProject(listed.projects ?? [], folder);
      if (match !== undefined) return match;
      cursor = listed.nextCursor ?? null;
    }
    return undefined;
  });

  const listHosts = Effect.fn("SshRemoteDispatch.listHosts")(function* (input: {
    readonly probe: boolean;
  }) {
    const hosts = (yield* knownHosts).filter((entry) => SAFE_HOST_ALIAS.test(entry.alias));
    if (!input.probe) {
      return hosts.map((entry) => ({ alias: entry.alias, source: entry.source }));
    }
    return yield* Effect.forEach(
      hosts,
      (entry) =>
        withRuntime(
          manager.runRemoteScript(
            { alias: entry.alias, hostname: entry.alias, username: null, port: null },
            { script: "true\n", timeoutMs: PROBE_TIMEOUT_MS },
          ),
        ).pipe(
          Effect.match({
            onSuccess: (): SshDispatchHost => ({
              alias: entry.alias,
              source: entry.source,
              reachable: true,
            }),
            onFailure: (error): SshDispatchHost => ({
              alias: entry.alias,
              source: entry.source,
              reachable: false,
              probeError: describe(error).slice(0, 300),
            }),
          }),
        ),
      { concurrency: 8 },
    );
  });

  const browse = Effect.fn("SshRemoteDispatch.browse")(function* (input: {
    readonly host: string;
    readonly path?: string | undefined;
    readonly showHidden?: boolean | undefined;
    readonly limit?: number | undefined;
  }) {
    const target = yield* resolveHost(input.host);
    return yield* browseTarget(target, input);
  });

  const runRemoteScript = Effect.fn("SshRemoteDispatch.runRemoteScript")(function* (input: {
    readonly target: DesktopSshEnvironmentTarget;
    readonly script: string;
    readonly timeoutMs: number;
  }) {
    yield* readyCloudTarget(input.target, true);
    return yield* withRuntime(
      manager.runRemoteScript(input.target, {
        script: input.script,
        timeoutMs: input.timeoutMs,
      }),
    ).pipe(sshFailed(input.target.alias));
  });
  const runHostScript = Effect.fn("SshRemoteDispatch.runHostScript")(function* (input: {
    readonly host: string;
    readonly script: string;
    readonly timeoutMs: number;
  }) {
    const target = yield* resolveHost(input.host);
    return yield* runRemoteScript({ target, script: input.script, timeoutMs: input.timeoutMs });
  });
  const identifyTarget = Effect.fn("SshRemoteDispatch.identifyTarget")(function* (
    target: DesktopSshEnvironmentTarget,
  ) {
    yield* readyCloudTarget(target, false);
    const result = yield* withRuntime(
      manager.runRemoteScript(target, {
        script:
          'if [ -f "$HOME/.goat/userdata/environment-id" ]; then cat "$HOME/.goat/userdata/environment-id"; fi',
        timeoutMs: 15_000,
      }),
    ).pipe(
      Effect.mapError(() =>
        failure("host_unavailable", `Could not read GOAT identity on ${target.alias}.`),
      ),
    );
    const value = result.stdout.trim();
    if (value === "") return null;
    return yield* decodeIdentityFile(value).pipe(
      Effect.mapError(() =>
        failure("host_unavailable", `GOAT identity on ${target.alias} is invalid.`),
      ),
    );
  });
  const preflightTarget = Effect.fn("SshRemoteDispatch.preflightTarget")(function* (input: {
    readonly target: DesktopSshEnvironmentTarget;
    readonly runtimeMode: RuntimeMode;
    readonly modelSelection: ModelSelection;
  }) {
    yield* readyCloudTarget(input.target, true);
    const bootstrap = yield* withRuntime(
      manager.ensureEnvironment(input.target, AGENT_CONNECTION),
    ).pipe(sshFailed(input.target.alias));
    if ("type" in bootstrap)
      return yield* failure(
        "host_unavailable",
        pendingRuntimeMessage(input.target.alias, bootstrap.pending),
      );
    const session = yield* sessionFor(input.target, input.runtimeMode);
    if (!session.ceilingApplied)
      return yield* failure("remote_refused", "Update the remote GOAT before sending a workspace.");
    const identity = yield* callRemote({
      target: input.target,
      httpBaseUrl: bootstrap.httpBaseUrl,
      ceiling: input.runtimeMode,
      token: session.token,
      tool: "goat_environment_read",
      arguments: {},
    });
    const environment = yield* decodeRemoteIdentity(identity).pipe(
      Effect.mapError(() =>
        failure("remote_refused", "The remote returned no valid environment identity."),
      ),
    );
    const rawCapabilities = yield* callRemote({
      target: input.target,
      httpBaseUrl: bootstrap.httpBaseUrl,
      ceiling: input.runtimeMode,
      token: session.token,
      tool: "orchestrator_capabilities",
      arguments: {},
    });
    const capabilities = yield* decodeRemoteCapabilities(rawCapabilities).pipe(
      Effect.mapError(() =>
        failure("remote_refused", "The remote cannot report model capabilities."),
      ),
    );
    const provider = capabilities.providers.find(
      (entry) => entry.providerInstanceId === input.modelSelection.instanceId,
    );
    if (
      provider === undefined ||
      !provider.models.some((model) => model.id === input.modelSelection.model)
    )
      return yield* new SshRemoteDispatchError({
        reason: "remote_refused",
        remoteCode: "model_unavailable",
        message: "The selected provider instance or model is unavailable on the remote GOAT.",
      });
    return environment;
  });

  /** A linked host's name in the shape the SSH helpers key their caches by. */
  const linkedTarget = (alias: string): DesktopSshEnvironmentTarget => ({
    alias,
    hostname: alias,
    username: null,
    port: null,
  });

  /**
   * The session saved with a link, when this caller may use it to change things there.
   * It was issued with the access chosen at link time and carries no memory scopes.
   */
  const linkedSession = (
    link: LinkedHosts.LinkedHostCredential,
    callerMode: RuntimeMode,
    memoryGrantCeiling: import("@goat/contracts").MemoryTaskGrantCeiling,
  ) => {
    const refusal = LinkedHosts.linkWriteRefusal(link.host, callerMode);
    if (refusal !== null) return Effect.fail(failure("remote_refused", refusal));
    if (memoryGrantCeiling !== "none")
      return Effect.fail(
        memoryRefusal(
          `The link to ${link.host.name} carries no memory access, so it cannot start a task with a memory ceiling.`,
        ),
      );
    return Effect.succeed({
      token: link.token,
      expiresAt: Date.parse(link.host.expiresAt),
      ceilingApplied: true,
    });
  };

  const launchThread = Effect.fn("SshRemoteDispatch.launchThread")(function* <E, R>(
    input: SshLaunchInput,
    beforeLaunch: Effect.Effect<void, E, R>,
  ) {
    const sources = yield* resolveLaunchAttachmentSources(input.attachments ?? []);
    const linked = input.target === undefined ? yield* linkedFor(input.host) : Option.none<never>();
    const target = Option.isSome(linked)
      ? linkedTarget(linked.value.host.name)
      : (input.target ?? (yield* resolveHost(input.host!)));
    // A linked host has no shell to browse with: its server checks the folder when the
    // project is created, and a worktree needs an explicit baseRef.
    const linkedPath = Option.isSome(linked) ? linkedHostFolder(target.alias, input.cwd) : null;
    if (typeof linkedPath === "string") return yield* failure("invalid_request", linkedPath);
    const folder = linkedPath ?? (yield* browseTarget(target, { path: input.cwd, limit: 0 }));
    const broad = input.allowBroadWorkspaceRoot === true ? null : broadWorkspaceRoot(folder);
    if (broad !== null) {
      return yield* failure(
        "invalid_request",
        `${folder.path} on ${target.alias} is ${broad}. A thread there gets everything below it as its workspace, and the folder becomes a project on ${target.alias}. Pick a project folder inside it with goat_ssh_browse, or pass allowBroadWorkspaceRoot:true only if the user explicitly asked to use this folder.`,
      );
    }
    // Re-check the caller before each remote change: SSH steps take seconds,
    // during which the caller's run can end or its modes can drop.
    yield* beforeLaunch;
    const notes: string[] = [];

    let workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
    switch (input.workspace.type) {
      case "cwd":
        workspaceStrategy = { type: "root" };
        break;
      case "worktree": {
        if (folder.gitRoot === null && Option.isNone(linked)) {
          return yield* failure(
            "invalid_request",
            `${folder.path} on ${target.alias} is not inside a Git repository, so it cannot get a worktree. Omit workspace to run in the folder itself, or pick a folder goat_ssh_browse marks isGitRepository.`,
          );
        }
        const baseRef = input.workspace.baseRef?.trim() || folder.branch;
        if (!baseRef) {
          return yield* failure(
            "invalid_request",
            `${folder.path} on ${target.alias} has no checked-out branch; pass baseRef.`,
          );
        }
        workspaceStrategy = {
          type: "worktree",
          baseRef,
          branch: input.workspace.branch,
          startFromOrigin: input.workspace.startFromOrigin ?? false,
        };
        break;
      }
      case "existing_worktree": {
        // The browse already gave native folder paths; an agent may still pass the shell form.
        const given = input.workspace.worktreePath.trim();
        const expanded =
          folder.home !== null && /^~(?:[\\/]|$)/u.test(given)
            ? folder.home + given.slice(1)
            : given;
        workspaceStrategy = {
          type: "existing_worktree",
          worktreePath: isWindowsShellOs(folder.os)
            ? toWindowsHostPath(expanded)
            : input.workspace.worktreePath,
          ...(input.workspace.branch ? { branch: input.workspace.branch } : {}),
        };
        break;
      }
    }

    const bootstrap = Option.isSome(linked)
      ? {
          httpBaseUrl: `${linked.value.host.baseUrl}/`,
          remoteServerVersion: linked.value.host.serverVersion,
          remoteServerKind: undefined,
        }
      : yield* withRuntime(manager.ensureEnvironment(target, AGENT_CONNECTION)).pipe(
          sshFailed(target.alias),
        );
    if ("type" in bootstrap)
      return yield* failure(
        "host_unavailable",
        pendingRuntimeMessage(target.alias, bootstrap.pending),
      );
    // A link is reached through its catalog entry, so unlinking it also ends fan-out to it.
    if (Option.isNone(linked)) connected.add(target.alias);
    const versionNote = remoteVersionNote(
      target.alias,
      bootstrap.remoteServerVersion,
      packageJson.version,
    );
    if (versionNote !== null) notes.push(versionNote);
    // Bootstrap may have taken a while; the session carries the caller's authority.
    yield* beforeLaunch;
    const memoryGrantCeiling = input.memoryGrantCeiling ?? "none";
    const session = Option.isSome(linked)
      ? yield* linkedSession(linked.value, input.callerRuntimeMode, memoryGrantCeiling)
      : yield* sessionFor(target, input.callerRuntimeMode, false, memoryGrantCeiling);
    const remote = {
      target,
      httpBaseUrl: bootstrap.httpBaseUrl,
      ceiling: input.callerRuntimeMode,
      memoryGrantCeiling,
      token: session.token,
    };
    if (!session.ceilingApplied && input.runtimeMode !== "approval-required") {
      return yield* failure(
        "remote_refused",
        `GOAT on ${target.alias} is too old to let an outside agent start ${input.runtimeMode} threads. Update GOAT there, or pass runtimeMode "approval-required" and approve its actions from a client connected to ${target.alias}.`,
      );
    }

    if (sources.length > 0 && !session.ceilingApplied) {
      return yield* failure(
        "remote_refused",
        `GOAT on ${target.alias} cannot apply the caller's ceiling to attachment writes. Update it before launching with attachments.`,
      );
    }

    yield* beforeLaunch;
    let project = yield* findProject(remote, folder);
    let projectCreated = false;
    if (project === undefined) {
      if (Option.isSome(linked)) {
        return yield* failure(
          "remote_refused",
          `${folder.path} is not a project on ${target.alias}. A linked host cannot be browsed, so it only runs threads in its existing projects: add the folder as a project on ${target.alias}, or pick one from goat_project_list with host "${target.alias}".`,
        );
      }
      if (!session.ceilingApplied) {
        return yield* failure(
          "remote_refused",
          `${folder.path} is not a project on ${target.alias}, and GOAT there is too old to let an outside agent register one. Add it as a project from a client connected to ${target.alias}, or update GOAT there.`,
        );
      }
      yield* beforeLaunch;
      const rawCreated = yield* callRemote({
        ...remote,
        tool: "goat_project_create",
        arguments: {
          title:
            input.projectTitle?.trim() ||
            folder.path
              .split(/[\\/]/u)
              .findLast((part) => part.length > 0 && !part.endsWith(":")) ||
            folder.path,
          workspaceRoot: folder.path,
          ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
        },
      });
      const created = yield* decodeRemoteProject(rawCreated).pipe(
        Effect.mapError(() =>
          failure("remote_refused", "The remote goat_project_create returned no valid project id."),
        ),
      );
      project = { id: created.id, workspaceRoot: folder.path };
      projectCreated = true;
      notes.push(`Registered ${folder.path} as a new project on ${target.alias}.`);
    }

    // Each attempt admits memory from its current catalog; cached declarations are
    // only for optional lineage/UI arguments when an ordinary launch cannot list.
    const launchAdmission = Effect.fn("SshRemoteDispatch.launchAdmission")(function* () {
      const { capabilities, declared } = yield* remoteLaunchArguments(remote);
      if (capabilities === null && input.memoryGrantCeiling !== undefined)
        return yield* memoryRefusal("Remote task memory admission could not be verified.");
      if (
        memoryGrantCeiling !== "none" &&
        capabilities?.declared.has("memoryGrantCeiling") !== true
      )
        return yield* memoryRefusal("Remote GOAT does not accept task memory ceilings.");
      return {
        declared,
        memoryArguments:
          capabilities?.declared.has("memoryGrantCeiling") === true &&
          (memoryGrantCeiling !== "none" || capabilities.advertisesMemory)
            ? { memoryGrantCeiling }
            : {},
      };
    });
    const admission = yield* launchAdmission();
    const declared = admission.declared;
    const forwardLaunchedBy =
      input.launchedBy !== undefined && declared?.has("launchedBy") === true;
    // This machine owns any watch of a launch it forwards. Without this, a remote that
    // watches outside launches would report an unmarked one too, even after the
    // origin opted out.
    const forwardWatchOptOut = declared?.has("notifyOnCompletion") === true;
    const forwardStandingOptOut =
      input.standingInstructions === false && declared?.has("standingInstructions") === true;
    if (input.standingInstructions === false && !forwardStandingOptOut)
      notes.push(
        `GOAT on ${target.alias} could not be asked to skip its standing instructions; if it has any, they were put in front of message.`,
      );
    // A remote whose goat_thread_launch declares arguments but not report would drop the
    // binding and leave its agent told to report. An unknown or schemaless listing still
    // sends it, and a remote that refuses it is relaunched without it by the coordinator.
    const forwardReport =
      input.report !== undefined &&
      (declared === undefined || declared.size === 0 || declared.has("report"));
    const message =
      forwardReport && input.reportNote !== undefined && input.message?.trim()
        ? `${input.message}\n\n${input.reportNote}`
        : input.message;
    const projectId = project.id;
    const preparedIds: string[] = [];
    return yield* Effect.gen(function* () {
      yield* beforeLaunch;
      const attachments = yield* uploadPendingAttachments(
        remote,
        sources,
        preparedIds,
        beforeLaunch,
      );
      // Authority may have changed while the last upload completed.
      yield* beforeLaunch;
      const launch = (withLaunchedBy: boolean, memoryArguments: typeof admission.memoryArguments) =>
        callRemote({
          ...remote,
          tool: "goat_thread_launch",
          beforeToolCall: beforeLaunch,
          arguments: {
            projectId,
            title: input.title,
            workspaceStrategy,
            runtimeMode: input.runtimeMode,
            ...memoryArguments,
            ...(input.interactionMode === undefined
              ? {}
              : { interactionMode: input.interactionMode }),
            ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
            ...(message === undefined ? {} : { message }),
            ...(withLaunchedBy
              ? {
                  launchedBy: {
                    ...input.launchedBy,
                    via: input.launchedBy?.via ?? "ssh_thread_launch",
                  },
                }
              : {}),
            ...(attachments.length === 0 ? {} : { attachments }),
            ...(forwardReport ? { report: input.report } : {}),
            ...(forwardStandingOptOut ? { standingInstructions: false } : {}),
            ...(forwardWatchOptOut ? { notifyOnCompletion: false } : {}),
          },
        });
      const rawLaunched = yield* launch(forwardLaunchedBy, admission.memoryArguments).pipe(
        Effect.catch((error) =>
          error instanceof SshRemoteDispatchError &&
          forwardLaunchedBy &&
          (error.reason === "remote_refused" || error.reason === "ssh_failed") &&
          error.message.includes("goat_thread_launch does not take launchedBy, so nothing ran")
            ? Effect.gen(function* () {
                const retryAdmission = yield* launchAdmission();
                const result = yield* launch(false, retryAdmission.memoryArguments);
                notes.push(
                  'This remote does not record its launcher, so scope:"launched" cannot find its questions; use host and threadId.',
                );
                return result;
              })
            : Effect.fail(error),
        ),
      );
      const launched = yield* decodeRemoteThread(rawLaunched).pipe(
        Effect.mapError(
          () =>
            new SshRemoteDispatchError({
              reason: "remote_refused",
              launchMayHaveStarted: true,
              message:
                "The remote launch returned no thread acknowledgement; inspect its threads before retrying.",
            }),
        ),
      );
      const launchedReport = (rawLaunched as { readonly report?: unknown } | null)?.report as
        | { readonly correlationId?: string }
        | null
        | undefined;
      notes.push(
        `The thread lives in the GOAT environment on ${target.alias}. Read it with goat_thread_read and send to it with goat_thread_send, passing host "${target.alias}" and this threadId. The user can watch it by connecting to ${target.alias} (${Option.isSome(linked) ? "Settings → Connections, with a pairing URL from that host" : "Settings → Connections → SSH"}).`,
      );
      return {
        host: target.alias,
        cwd: folder.path,
        projectId,
        projectCreated,
        threadId: launched.threadId,
        runId: launched.runId ?? null,
        reportsSupported:
          forwardReport && launchedReport?.correlationId === input.report?.correlationId,
        workspaceStrategy,
        runtimeMode: input.runtimeMode,
        remoteServerKind: bootstrap.remoteServerKind ?? null,
        notes,
      } satisfies SshLaunchResult;
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? discardPreparedAttachments(remote, preparedIds) : Effect.void,
      ),
    );
  });

  const unavailable = (alias: string) =>
    Effect.mapError((error: unknown) =>
      error instanceof SshRemoteDispatchError && error.reason !== "ssh_failed"
        ? error
        : failure(
            "host_unavailable",
            `${alias} is unavailable: ${error instanceof SshRemoteDispatchError ? error.message : describe(error)}`,
          ),
    );

  const proxyEndpoint: SshRemoteDispatch["Service"]["proxyEndpoint"] = (target) =>
    Effect.gen(function* () {
      yield* readyCloudTarget(target, false);
      const bootstrap = yield* withRuntime(
        manager.ensureEnvironment(target, { ...AGENT_CONNECTION, keyOnly: true }),
      ).pipe(unavailable(target.alias));
      if ("type" in bootstrap)
        return yield* failure(
          "host_unavailable",
          pendingRuntimeMessage(target.alias, bootstrap.pending),
        );
      connected.add(target.alias);
      return { httpBaseUrl: bootstrap.httpBaseUrl, wsBaseUrl: bootstrap.wsBaseUrl };
    });

  const issueProxySession: SshRemoteDispatch["Service"]["issueProxySession"] = (target, scopes) =>
    Effect.gen(function* () {
      yield* readyCloudTarget(target, false);
      return yield* withRuntime(
        manager.issueClientSession(target, {
          subject: "hub-proxy",
          label: "GOAT hub proxy",
          ttl: SESSION_TTL,
          scopes,
        }),
      ).pipe(unavailable(target.alias));
    });

  /**
   * callHostTool for a linked host: the saved session instead of one issued
   * over SSH. It cannot narrow that session to the caller, so a write needs a
   * caller whose ceiling covers the link's access, and approvals are refused.
   */
  const callLinkedHostTool = <E, R>(
    link: LinkedHosts.LinkedHostCredential,
    call: SshHostToolCall,
    authorize: Effect.Effect<RuntimeMode, E, R>,
  ): Effect.Effect<unknown, SshRemoteDispatchError | E, R> =>
    Effect.gen(function* () {
      const alias = link.host.name;
      const ceiling = yield* authorize;
      if (call.approvals === true)
        return yield* failure(
          "remote_refused",
          `A link cannot answer approvals on ${alias}; answer them in that thread from a client connected to ${alias}.`,
        );
      const refusal = call.writes ? LinkedHosts.linkWriteRefusal(link.host, ceiling) : null;
      if (refusal !== null) return yield* failure("remote_refused", refusal);
      const stillAuthorized = authorize.pipe(
        Effect.flatMap((current) =>
          current === ceiling
            ? Effect.void
            : Effect.fail(
                failure(
                  "caller_changed",
                  `The caller's runtime mode changed from ${ceiling} to ${current} during the call; nothing was sent to ${alias}.`,
                ),
              ),
        ),
      );
      const answer = yield* callAcpMcpTool({
        endpoint: new URL("/mcp", link.host.baseUrl).toString(),
        authorization: `Bearer ${link.token}`,
        tool: call.tool,
        arguments: call.arguments,
        beforeToolCall: stillAuthorized,
      }).pipe(
        Effect.timeoutOption(call.timeoutMs),
        Effect.catch((error) => {
          if (!(error instanceof AcpMcpBridgeError)) return Effect.fail(error);
          if (error.kind === "http" && error.status === 401) return Effect.fail(linkExpired(alias));
          if (isUnknownToolRefusal(error, call.tool))
            return Effect.fail(
              failure(
                "remote_refused",
                missingRemoteToolMessage(alias, call.tool, link.host.serverVersion),
              ),
            );
          return Effect.fail(
            error.kind === "transport" || error.kind === "http"
              ? failure("host_unavailable", remoteUnavailableMessage(alias, error))
              : failure(
                  "remote_refused",
                  `GOAT on ${alias} could not run ${call.tool}: ${describe(error)}`,
                ),
          );
        }),
      );
      if (Option.isNone(answer))
        return yield* failure(
          "host_unavailable",
          remoteDeadlineMessage(alias, call.tool, call.timeoutMs),
        );
      const result = readRemoteToolResult(call.tool, answer.value);
      if (!result.ok)
        return yield* new SshRemoteDispatchError({
          reason: "remote_refused",
          message: result.message,
          remoteCode: result.code,
        });
      return result.value;
    });

  const callHostTool = Effect.fn("SshRemoteDispatch.callHostTool")(function* <E, R>(
    call: SshHostToolCall,
    authorize: Effect.Effect<RuntimeMode, E, R>,
  ) {
    const linked = yield* linkedFor(call.host);
    if (Option.isSome(linked)) return yield* callLinkedHostTool(linked.value, call, authorize);
    const target = yield* resolveHost(call.host);
    const ceiling = yield* authorize;
    if (call.requireReady !== true) yield* readyCloudTarget(target, false);
    const bootstrap = yield* withRuntime(
      call.requireReady
        ? manager.readyEnvironment(target)
        : manager.ensureEnvironment(target, AGENT_CONNECTION),
    ).pipe(
      call.requireReady === true
        ? Effect.mapError(() =>
            failure(
              "host_unavailable",
              `Call goat_ssh_host_prepare for ${target.alias}, then call goat_ssh_host_status until setup completes; retry ${call.tool}.`,
            ),
          )
        : unavailable(target.alias),
    );
    if ("type" in bootstrap)
      return yield* failure(
        "host_unavailable",
        pendingRuntimeMessage(target.alias, bootstrap.pending),
      );
    connected.add(target.alias);
    // Right before the request: the caller may have lost authority during SSH.
    const stillAuthorized = authorize.pipe(
      Effect.flatMap((current) =>
        current === ceiling
          ? Effect.void
          : Effect.fail(
              failure(
                "caller_changed",
                `The caller's runtime mode changed from ${ceiling} to ${current} during the call; nothing was sent to ${target.alias}.`,
              ),
            ),
      ),
    );

    let attemptedToken: string | undefined;
    const attempt = (retried: boolean): Effect.Effect<unknown, SshRemoteDispatchError | E, R> =>
      Effect.gen(function* () {
        yield* stillAuthorized;
        const session = yield* sessionFor(
          target,
          ceiling,
          call.approvals === true,
          "none",
          call.requireReady,
          call.providersManage === true,
        ).pipe(unavailable(target.alias));
        attemptedToken = session.token;
        if (call.writes && !session.ceilingApplied) {
          return yield* failure(
            "remote_refused",
            `GOAT on ${target.alias} is too old to limit what an outside agent may change. Update GOAT there before calling ${call.tool} on it.`,
          );
        }
        const answer = yield* callAcpMcpTool({
          endpoint: new URL("mcp", bootstrap.httpBaseUrl).toString(),
          authorization: `Bearer ${session.token}`,
          tool: call.tool,
          arguments: call.arguments,
          beforeToolCall: stillAuthorized,
        }).pipe(Effect.timeoutOption(call.timeoutMs));
        if (Option.isNone(answer)) {
          return yield* failure(
            "host_unavailable",
            remoteDeadlineMessage(target.alias, call.tool, call.timeoutMs),
          );
        }
        const result = readRemoteToolResult(call.tool, answer.value);
        if (!result.ok) {
          return yield* new SshRemoteDispatchError({
            reason: "remote_refused",
            message: result.message,
            remoteCode: result.code,
          });
        }
        return result.value;
      }).pipe(
        Effect.catch((error) => {
          if (!(error instanceof AcpMcpBridgeError)) return Effect.fail(error);
          if (error.kind === "http" && error.status === 401) {
            // Revoked or expired on the remote: issue a fresh session once.
            if (attemptedToken !== undefined) {
              invalidateSession(
                sessionKey(
                  target,
                  ceiling,
                  call.approvals === true,
                  "none",
                  call.providersManage === true,
                ),
                attemptedToken,
              );
            }
            return retried
              ? Effect.fail(
                  failure(
                    "remote_refused",
                    `${target.alias} rejected this machine's GOAT session twice.`,
                  ),
                )
              : attempt(true);
          }
          if (isUnknownToolRefusal(error, call.tool)) {
            return Effect.fail(
              failure(
                "remote_refused",
                missingRemoteToolMessage(target.alias, call.tool, bootstrap.remoteServerVersion),
              ),
            );
          }
          return Effect.fail(
            error.kind === "transport" || error.kind === "http"
              ? failure("host_unavailable", remoteUnavailableMessage(target.alias, error))
              : failure(
                  "remote_refused",
                  `GOAT on ${target.alias} could not run ${call.tool}: ${describe(error)}`,
                ),
          );
        }),
      );
    if (call.requireReady !== true) return yield* attempt(false);
    return yield* attempt(false).pipe(
      Effect.timeoutOption(call.timeoutMs),
      Effect.flatMap((answer) =>
        Option.isSome(answer)
          ? Effect.succeed(answer.value)
          : Effect.fail(
              failure(
                "host_unavailable",
                `Call goat_ssh_host_prepare for ${target.alias}, then call goat_ssh_host_status until setup completes; retry ${call.tool}.`,
              ),
            ),
      ),
    );
  });

  const connectedHosts = Effect.gen(function* () {
    const linked = Option.isNone(linkedHosts) ? [] : yield* linkedHosts.value.names;
    return [...new Set([...connected, ...linked])].toSorted();
  });

  return SshRemoteDispatch.of({
    runtimeStatus,
    runtimeUpdate,
    beginSetupOperation,
    prepareRuntime,
    forgetRuntime,
    publishProviderDiagnosis,
    publishSetupOutcome,
    listHosts,
    browse,
    validateLaunchAttachments,
    launchThread,
    callHostTool,
    connectedHosts,
    runRemoteScript,
    runHostScript,
    preflightTarget,
    identifyTarget,
    proxyEndpoint,
    issueProxySession,
  });
});

/**
 * Resolve local archive/mirror configuration before building the remote runner.
 * The server owns the host's runtime like the desktop does: it installs its own
 * release on a stopped host and refreshes an older compatible server once it
 * answers idle. Replacement only happens through the server's own drain, so
 * another client attached to it is never cut off mid-turn.
 */
export const resolveSshCliRunner = (baseDir: string) =>
  Effect.gen(function* () {
    const archiveDirectory = yield* Config.String("GOAT_SSH_RUNTIME_ARCHIVE_DIR").pipe(
      Config.withDefault(baseDir + "/runtime/archives"),
    );
    const bundledArchiveDirectory = yield* Config.String(
      "GOAT_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR",
    ).pipe(
      Config.withDefault(""),
      Effect.map((value) => value.trim() || undefined),
    );
    const releaseBaseUrl = yield* Config.String("GOAT_RELEASE_BASE_URL").pipe(
      Config.withDefault(""),
      Effect.map((value) => value.trim() || undefined),
    );
    const nodeScriptPath = yield* Config.String("GOAT_DEV_REMOTE_SERVER_ENTRY_PATH").pipe(
      Config.withDefault(""),
    );
    return {
      ...(nodeScriptPath.trim()
        ? { nodeScriptPath: nodeScriptPath.trim(), nodeEngineRange: packageJson.engines.node }
        : {}),
      archiveVersion: packageJson.version,
      ...(BUILD_COMMIT_TIME === undefined ? {} : { archiveCommitTime: BUILD_COMMIT_TIME }),
      archiveDirectory,
      ...(bundledArchiveDirectory === undefined ? {} : { bundledArchiveDirectory }),
      ...(releaseBaseUrl === undefined ? {} : { releaseBaseUrl }),
      hostDownload: true,
      publishedFallback: true,
      refreshOwnedRuntimeOnFirstConnection: true,
    } satisfies SshTunnel.RemoteGoatRunnerOptions;
  });

const layerManager = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const runner = yield* resolveSshCliRunner(config.baseDir);
    return SshTunnel.SshEnvironmentManager.layer({
      // Share only the GOAT runner under the tunnel's ~/.goat/ssh-launch. Do not
      // import/reuse an upstream ~/.t3 runner or server home. Local
      // archiveDirectory still belongs to this local config.baseDir.
      resolveCliRunner: Effect.succeed(runner),
      leaveRemoteServerRunning: true,
    });
  }),
);

export const layer = Layer.effect(SshRemoteDispatch, make).pipe(
  Layer.provide(layerManager),
  Layer.provide(NetService.layer),
);

function pendingRuntimeMessage(
  alias: string,
  pending: import("@goat/contracts").SshRuntimePendingReplacement,
) {
  if (pending.detail === "recovery-stale")
    return `${alias}'s recovery is locked. Remove ~/.goat/ssh-launch/replacement.recovery on the remote host after checking that no GOAT client is replacing this runtime.`;
  if (pending.reason === "contended")
    return `Another client is replacing ${alias}'s GOAT runtime; retry later`;
  const why =
    pending.replacement === "capability"
      ? `GOAT ${pending.liveVersion} cannot grant memory access to tasks, so `
      : "";
  return pending.reason === "unknown"
    ? `${why}${alias}'s GOAT runtime is waiting for a verified idle response before replacement; retry later`
    : `${why}${alias}'s GOAT runtime is being replaced when its current work finishes; retry later`;
}
