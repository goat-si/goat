import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
  issueRemoteWebSocketTicket,
  RemoteEnvironmentAuthUndeclaredStatusError,
  type RemoteEnvironmentAuthError,
} from "@goat/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@goat/client-runtime/environment";
import {
  EnvironmentAuthInvalidError,
  DesktopDiscoveredSshHostSchema,
  DesktopSshBearerBootstrapInputSchema,
  DesktopSshBearerRequestInputSchema,
  DesktopSshEnvironmentEnsureInputSchema,
  DesktopSshEnvironmentEnsureResultSchema,
  DesktopSshEnvironmentTargetSchema,
  DesktopSshHostStatusInputSchema,
  DesktopSshRuntimeUpdateInputSchema,
  SshHostResult,
  DesktopSshHttpBaseUrlInputSchema,
  DesktopSshPasswordPromptCancelledType,
  DesktopSshPasswordPromptResolutionInputSchema,
  ExecutionEnvironmentDescriptor,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  AuthAccessTokenResult,
  AuthSessionState,
  AuthWebSocketTicketResult,
  isCloudMachineAlias,
} from "@goat/contracts";
import { SshHostAnswered, targetConnectionKey } from "@goat/ssh/command";
import { SshHttpBridgeError, SshInvalidTargetError } from "@goat/ssh/errors";
import { resolveLoopbackSshHttpBaseUrl } from "@goat/ssh/tunnel";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../../ssh/DesktopSshPasswordPrompts.ts";

type DesktopSshEnvironmentRequestOperation =
  | "fetch-environment-descriptor"
  | "bootstrap-bearer-session"
  | "fetch-session-state"
  | "issue-websocket-ticket";

type DesktopSshEnvironmentRequestCause = RemoteEnvironmentAuthError | SshHttpBridgeError;

const isEnvironmentAuthInvalidError = Schema.is(EnvironmentAuthInvalidError);
const isEnvironmentInternalError = Schema.is(EnvironmentInternalError);
const isEnvironmentOperationForbiddenError = Schema.is(EnvironmentOperationForbiddenError);
const isEnvironmentRequestInvalidError = Schema.is(EnvironmentRequestInvalidError);
const isEnvironmentScopeRequiredError = Schema.is(EnvironmentScopeRequiredError);

function readSshHttpStatus(cause: DesktopSshEnvironmentRequestCause): number | null {
  if (
    cause instanceof RemoteEnvironmentAuthUndeclaredStatusError ||
    cause instanceof SshHttpBridgeError
  ) {
    return cause.status ?? null;
  }
  if (isEnvironmentRequestInvalidError(cause)) {
    return 400;
  }
  if (isEnvironmentAuthInvalidError(cause)) {
    return 401;
  }
  if (isEnvironmentScopeRequiredError(cause)) {
    return 403;
  }
  if (isEnvironmentOperationForbiddenError(cause)) {
    return 403;
  }
  if (isEnvironmentInternalError(cause)) {
    return 500;
  }
  return null;
}

export class DesktopSshEnvironmentRequestError extends Data.TaggedError(
  "DesktopSshEnvironmentRequestError",
)<{
  readonly operation: DesktopSshEnvironmentRequestOperation;
  readonly cause: DesktopSshEnvironmentRequestCause;
  readonly sshHttpStatus: number | null;
}> {
  // The web client matches "[ssh_http:500]" to explain version-skewed SSH pairing.
  override get message() {
    const prefix = this.sshHttpStatus === null ? "" : `[ssh_http:${this.sshHttpStatus}] `;
    return `${prefix}SSH remote API request failed during ${this.operation}.`;
  }
}

const withLoopbackSshApi =
  <A, R>(
    operation: DesktopSshEnvironmentRequestOperation,
    use: (httpBaseUrl: string) => Effect.Effect<A, RemoteEnvironmentAuthError, R>,
  ) =>
  (httpBaseUrl: string): Effect.Effect<A, DesktopSshEnvironmentRequestError, R> =>
    resolveLoopbackSshHttpBaseUrl(httpBaseUrl).pipe(
      Effect.flatMap(use),
      Effect.mapError(
        (cause) =>
          new DesktopSshEnvironmentRequestError({
            operation,
            cause,
            sshHttpStatus: readSshHttpStatus(cause),
          }),
      ),
    );

/** How recently the owning GOAT server must have confirmed a cloud machine's address and key. */
export const CLOUD_MACHINE_READY_WINDOW_MS = 10 * 60_000;

/**
 * A `boat-` alias is a cloud machine managed by a GOAT server, which rewrites its
 * ~/.ssh/goat-cloud/<alias>.conf each time it readies the machine. The renderer asks this
 * desktop's server to do that first; a missing file means another server owns the machine,
 * and an old one means nothing confirmed its current address. Picking a host stays unguarded.
 */
export const requireReadiedCloudMachine = Effect.fn("desktop.ipc.sshEnvironment.cloudMachine")(
  function* (alias: string) {
    if (!isCloudMachineAlias(alias)) return;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const conf = environment.path.join(
      environment.homeDirectory,
      ".ssh",
      "goat-cloud",
      `${alias}.conf`,
    );
    const info = yield* fileSystem.stat(conf).pipe(Effect.option);
    if (Option.isNone(info))
      return yield* new SshInvalidTargetError({
        message: "This cloud machine belongs to another GOAT server. Open it from that server.",
      });
    const modified = Option.match(info.value.mtime, {
      onNone: () => 0,
      onSome: (date) => date.getTime(),
    });
    if ((yield* Clock.currentTimeMillis) - modified > CLOUD_MACHINE_READY_WINDOW_MS)
      return yield* new SshInvalidTargetError({
        message: "Prepare this cloud machine from Settings → Connections → Cloud machines first.",
      });
  },
);

export const discoverSshHosts = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCOVER_SSH_HOSTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopDiscoveredSshHostSchema),
  handler: Effect.fn("desktop.ipc.sshEnvironment.discoverHosts")(function* () {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    return yield* sshEnvironment.discoverHosts();
  }),
});

export const resolveSshHost = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESOLVE_SSH_HOST_CHANNEL,
  payload: Schema.String,
  result: DesktopSshEnvironmentTargetSchema,
  handler: Effect.fn("desktop.ipc.sshEnvironment.resolveHost")(function* (alias) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    return yield* sshEnvironment.resolveHost(alias);
  }),
});

export const ensureSshEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL,
  payload: DesktopSshEnvironmentEnsureInputSchema,
  result: DesktopSshEnvironmentEnsureResultSchema,
  handler: Effect.fn("desktop.ipc.sshEnvironment.ensureEnvironment")(function* (
    { target, options, requestId, caller, attemptContext },
    event,
  ) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    yield* requireReadiedCloudMachine(target.alias);
    yield* Effect.annotateCurrentSpan({
      senderId: event?.sender.id,
      caller: caller ?? "unknown",
      requestId,
      requestedTargetKey: targetConnectionKey(target),
      ...attemptContext,
    });
    const span = yield* Effect.currentSpan.pipe(Effect.option);
    const annotate = (fields: Record<string, unknown>) => {
      if (Option.isSome(span)) {
        for (const [key, value] of Object.entries(fields)) span.value.attribute(key, value);
      }
    };
    let detached = false;
    const send = (channel: string, payload: unknown) => {
      if (detached || requestId === undefined || event?.sender.send === undefined) return;
      try {
        const sender = event.sender;
        if (
          "isDestroyed" in sender &&
          typeof sender.isDestroyed === "function" &&
          sender.isDestroyed()
        ) {
          detached = true;
          annotate({ observerDetached: true });
          return;
        }
        sender.send?.(channel, payload);
      } catch {
        detached = true;
        annotate({ observerDetached: true });
      }
    };
    let answered = false;
    return yield* sshEnvironment
      .ensureEnvironment(target, {
        ...options,
        onPreparationProgress: (progress) => {
          annotate({
            operationId: progress.operationId,
            ...(progress.outcome === undefined ? {} : { preparationOutcome: progress.outcome }),
          });
          send(IpcChannels.SSH_ENVIRONMENT_PROGRESS_CHANNEL, { requestId, ...progress });
        },
        onPreparationAdmission: (admission) => annotate({ ...admission }),
      })
      .pipe(
        Effect.provideService(SshHostAnswered, () => {
          if (answered || requestId === undefined) return;
          answered = true;
          send(IpcChannels.SSH_ENVIRONMENT_ANSWERED_CHANNEL, requestId);
        }),
        Effect.tap((result) =>
          Effect.annotateCurrentSpan({
            outcome: "type" in result ? "pending" : "ready",
            key: targetConnectionKey(result.target),
          }),
        ),
        Effect.tapError((error) =>
          Effect.annotateCurrentSpan({
            outcome: error._tag === "SshEnsureSupersededError" ? "superseded" : "failed",
          }),
        ),
        Effect.catchIf(DesktopSshEnvironment.isDesktopSshPasswordPromptCancellation, (error) =>
          Effect.succeed({
            type: DesktopSshPasswordPromptCancelledType,
            message: error.message,
          }),
        ),
      );
  }),
});

export const getSshHostStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SSH_HOST_STATUS_CHANNEL,
  payload: DesktopSshHostStatusInputSchema,
  result: SshHostResult,
  handler: Effect.fn("desktop.ipc.sshEnvironment.status")(function* ({ target }) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    return yield* sshEnvironment.status(target);
  }),
});

export const updateSshRuntime = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SSH_RUNTIME_UPDATE_CHANNEL,
  payload: DesktopSshRuntimeUpdateInputSchema,
  result: SshHostResult,
  handler: Effect.fn("desktop.ipc.sshEnvironment.update")(function* ({ target, mode }) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    yield* requireReadiedCloudMachine(target.alias);
    return yield* sshEnvironment.update(target, mode);
  }),
});

export const disconnectSshEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCONNECT_SSH_ENVIRONMENT_CHANNEL,
  payload: DesktopSshEnvironmentTargetSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sshEnvironment.disconnectEnvironment")(function* (target) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    yield* sshEnvironment.disconnectEnvironment(target);
  }),
});

export const fetchSshEnvironmentDescriptor = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL,
  payload: DesktopSshHttpBaseUrlInputSchema,
  result: ExecutionEnvironmentDescriptor,
  handler: Effect.fn("desktop.ipc.sshEnvironment.fetchDescriptor")(function* ({ httpBaseUrl }) {
    return yield* withLoopbackSshApi("fetch-environment-descriptor", (resolvedHttpBaseUrl) =>
      fetchRemoteEnvironmentDescriptor({ httpBaseUrl: resolvedHttpBaseUrl }),
    )(httpBaseUrl);
  }),
});

export const bootstrapSshBearerSession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL,
  payload: DesktopSshBearerBootstrapInputSchema,
  result: AuthAccessTokenResult,
  handler: Effect.fn("desktop.ipc.sshEnvironment.bootstrapBearerSession")(function* ({
    httpBaseUrl,
    credential,
  }) {
    return yield* withLoopbackSshApi("bootstrap-bearer-session", (resolvedHttpBaseUrl) =>
      bootstrapRemoteBearerSession({
        httpBaseUrl: resolvedHttpBaseUrl,
        credential,
      }),
    )(httpBaseUrl);
  }),
});

export const fetchSshSessionState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FETCH_SSH_SESSION_STATE_CHANNEL,
  payload: DesktopSshBearerRequestInputSchema,
  result: AuthSessionState,
  handler: Effect.fn("desktop.ipc.sshEnvironment.fetchSessionState")(function* ({
    httpBaseUrl,
    bearerToken,
  }) {
    return yield* withLoopbackSshApi("fetch-session-state", (resolvedHttpBaseUrl) =>
      fetchRemoteSessionState({
        httpBaseUrl: resolvedHttpBaseUrl,
        bearerToken,
      }),
    )(httpBaseUrl);
  }),
});

export const issueSshWebSocketTicket = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL,
  payload: DesktopSshBearerRequestInputSchema,
  result: AuthWebSocketTicketResult,
  handler: Effect.fn("desktop.ipc.sshEnvironment.issueWebSocketTicket")(function* ({
    httpBaseUrl,
    bearerToken,
  }) {
    return yield* withLoopbackSshApi("issue-websocket-ticket", (resolvedHttpBaseUrl) =>
      issueRemoteWebSocketTicket({
        httpBaseUrl: resolvedHttpBaseUrl,
        bearerToken,
      }),
    )(httpBaseUrl);
  }),
});

export const resolveSshPasswordPrompt = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL,
  payload: DesktopSshPasswordPromptResolutionInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sshEnvironment.resolvePasswordPrompt")(function* ({
    requestId,
    password,
  }) {
    const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
    yield* prompts.resolve({ requestId, password });
  }),
});
