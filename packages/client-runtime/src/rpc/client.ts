import {
  EnvironmentAuthorizationError,
  clientRpcRequiredScopes,
  hubProxyHidesClientCall,
  AuthHubProxyScope,
  authScopeRequiredResponse,
  type EnvironmentId,
  type MemoryHistoryInput,
  type ClientGuardedRpcTag,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  SLACK_CHANNEL_WS_METHODS,
  WsMemoryRpcGroup,
  supportsMemoryProtocol,
  MemoryRpcError,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError, type RpcClient } from "effect/rpc";
import type { Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "../state/commandPermissions.ts";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { isHubNodesUnsupportedError } from "../hubNodes.ts";
import type { RpcSession } from "../rpc/session.ts";

export class EnvironmentRpcUnavailableError extends Schema.TaggedError<EnvironmentRpcUnavailableError>()(
  "EnvironmentRpcUnavailableError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

export interface EnvironmentRpcRequestObservation {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly method: string;
}

export class EnvironmentRpcRequestObserver extends Context.Reference<{
  readonly observe: (
    request: EnvironmentRpcRequestObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@goat/client-runtime/rpc/EnvironmentRpcRequestObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

// Memory routes are staged separately until server integration. Missing routes
// remain unavailable; the selected environment is never replaced by the primary.
type EnvironmentProtocolClient = WsRpcProtocolClient &
  RpcClient.FromGroup<typeof WsMemoryRpcGroup, RpcClientError.RpcClientError>;
export type EnvironmentRpcTag = keyof EnvironmentProtocolClient & string;
type RpcMethod<TTag extends EnvironmentRpcTag> = EnvironmentProtocolClient[TTag];

export type EnvironmentSubscriptionRpcTag =
  | typeof WS_METHODS.notesSubscribe
  | typeof WS_METHODS.memoryChanges
  | typeof WS_METHODS.connectionCatalogServe
  | typeof WS_METHODS.codexAuthCallbackSubscribe
  | typeof WS_METHODS.providerAuthSubscribe
  | typeof WS_METHODS.providerInstallSubscribe
  | typeof ORCHESTRATION_V2_WS_METHODS.subscribeShell
  | typeof ORCHESTRATION_V2_WS_METHODS.subscribeThread
  | typeof ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput
  | typeof ORCHESTRATION_V2_WS_METHODS.searchThreadStream
  | typeof WS_METHODS.subscribeAuthAccess
  | typeof WS_METHODS.subscribeServerConfig
  | typeof WS_METHODS.subscribeServerLifecycle
  | typeof WS_METHODS.hubNodesSubscribe
  | typeof WS_METHODS.scheduledTasksSubscribe
  | typeof WS_METHODS.serverGetStorageCleanupReport
  | typeof WS_METHODS.serverGetDatabaseStorage
  | typeof WS_METHODS.subscribeTerminalEvents
  | typeof WS_METHODS.subscribeTerminalMetadata
  | typeof WS_METHODS.subscribePreviewEvents
  | typeof WS_METHODS.subscribeDiscoveredLocalServers
  | typeof WS_METHODS.subscribeDeviceState
  | typeof WS_METHODS.subscribeResourceTelemetry
  | typeof WS_METHODS.pullRequestsSubscribeRefreshes
  | typeof WS_METHODS.subscribeVcsStatus
  | typeof WS_METHODS.subscribeWorktreeSetup
  | typeof WS_METHODS.subscribeProjectClones
  | typeof WS_METHODS.terminalAttach
  | typeof WS_METHODS.terminalObserve
  | typeof SLACK_CHANNEL_WS_METHODS.subscribeStatus;

export type EnvironmentStreamCommandRpcTag =
  | typeof WS_METHODS.chatGptHandoffSubscribe
  | typeof WS_METHODS.cloudInstallRelayClient
  | typeof WS_METHODS.serverUpdateServerWithProgress
  | typeof WS_METHODS.gitRunStackedAction;

export type EnvironmentStreamRpcTag =
  | EnvironmentSubscriptionRpcTag
  | EnvironmentStreamCommandRpcTag;

export type EnvironmentUnaryRpcTag = Exclude<EnvironmentRpcTag, EnvironmentStreamRpcTag>;

export interface EnvironmentRpcSubscriptionObservation {
  readonly environmentId: string;
  readonly method: EnvironmentSubscriptionRpcTag;
  readonly input: unknown;
}

export class EnvironmentRpcSubscriptionObserver extends Context.Reference<{
  readonly observe: (
    subscription: EnvironmentRpcSubscriptionObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@goat/client-runtime/rpc/EnvironmentRpcSubscriptionObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export const isRpcClientError = Schema.is(RpcClientError.RpcClientError);
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

const MAX_EXPECTED_FAILURE_RETRY_DELAY_MS = 30_000;

export type EnvironmentRpcInput<TTag extends EnvironmentRpcTag> = Parameters<RpcMethod<TTag>>[0];

export type EnvironmentRpcSuccess<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcFailure<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<any, infer E, any>
    ? E
    : never;

export type EnvironmentRpcStreamValue<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcStreamFailure<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<any, infer E, any>
    ? E
    : never;

const currentSession = Effect.fn("EnvironmentRpc.currentSession")(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  return yield* SubscriptionRef.get(supervisor.session).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new EnvironmentRpcUnavailableError({
              environmentId: supervisor.target.environmentId,
              message: `${supervisor.target.label} is not connected.`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
});

export const getInitialServerConfig = Effect.fn("EnvironmentRpc.getInitialServerConfig")(
  function* () {
    const session = yield* currentSession();
    return yield* session.initialConfig;
  },
);

/** Installed by the shared command boundary. A missing boundary denies protected writes. */
export class RpcPermissionGuard extends Context.Reference<{
  readonly authorize: (
    environmentId: EnvironmentId,
    method: string,
    input: unknown,
  ) => Effect.Effect<void, EnvironmentAuthorizationError>;
}>("@goat/client-runtime/rpc/RpcPermissionGuard", {
  defaultValue: () => ({
    authorize: (_environmentId, method, input) => {
      const scope = clientRpcRequiredScopes(method, input)[0];
      return scope === undefined
        ? Effect.void
        : Effect.fail(
            new EnvironmentAuthorizationError({
              ...authScopeRequiredResponse(scope),
              message: `This connection requires ${scope}.`,
            }),
          );
    },
  }),
}) {}

const authorizeRequest = Effect.fn("EnvironmentRpc.authorize")(function* (
  method: string,
  input: unknown,
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const required = clientRpcRequiredScopes(method, input);
  // On a node reached through a hub, fail at once with the reason instead of after the hub refuses.
  // The route decides, not cached session state, so a stale answer cannot mislead; a node whose
  // preferred route is direct still meets the hub's own refusal if it falls back to the hub.
  if (
    supervisor.target._tag === "HubProxyConnectionTarget" &&
    hubProxyHidesClientCall(method, input, required)
  )
    return yield* new EnvironmentAuthorizationError({
      ...authScopeRequiredResponse(AuthHubProxyScope),
      message: "This action is not available through the hub.",
    });
  if (required.length === 0) return;
  const guard = yield* RpcPermissionGuard;
  yield* guard.authorize(supervisor.target.environmentId, method, input);
});

/** Strip history extensions against the session that will actually dispatch the request. */
function memoryHistoryDispatchInput(input: MemoryHistoryInput, refusedReverts: boolean) {
  if (refusedReverts) return input;
  const { includeRefusedReverts: _refused, ...legacyInput } = input;
  return legacyInput;
}

export const requestGuarded = Effect.fn("EnvironmentRpc.request")(function* <
  TTag extends EnvironmentUnaryRpcTag,
>(tag: TTag, input: EnvironmentRpcInput<TTag>) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  yield* Effect.annotateCurrentSpan({
    "environment.id": supervisor.target.environmentId,
    "rpc.method": tag,
  });
  const session = yield* currentSession();
  yield* authorizeRequest(tag, input);
  let dispatchInput = input;
  if (tag.startsWith("memory.")) {
    const config = yield* session.initialConfig.pipe(
      Effect.mapError(
        () =>
          new EnvironmentRpcUnavailableError({
            environmentId: supervisor.target.environmentId,
            message: "Memory configuration is unavailable.",
          }),
      ),
    );
    if (tag === WS_METHODS.memorySyncStatus) {
      // Only an opted-in response may add fields unknown to a strict legacy decoder.
      const {
        includeRetainedLocalSpaceId: _retained,
        includeGenerationHold: _hold,
        ...legacyInput
      } = input as {
        readonly includeRetainedLocalSpaceId?: true;
        readonly includeGenerationHold?: true;
      };
      const memory = config.environment.capabilities.memory;
      dispatchInput = {
        ...legacyInput,
        ...(memory?.retainedLocalSpace === true
          ? { includeRetainedLocalSpaceId: true as const }
          : {}),
        ...(memory?.generationHold === true ? { includeGenerationHold: true as const } : {}),
      } as EnvironmentRpcInput<TTag>;
    }
    if (
      tag === WS_METHODS.memoryImportProvider &&
      (input as { action?: string }).action === "preview"
    ) {
      const { includeTurnStartFit: _hint, ...legacyInput } = input as {
        readonly includeTurnStartFit?: true;
      };
      dispatchInput = {
        ...legacyInput,
        ...(config.environment.capabilities.memory?.importTurnStartFit === true
          ? { includeTurnStartFit: true as const }
          : {}),
      } as EnvironmentRpcInput<TTag>;
    }
    if (tag === WS_METHODS.memoryHistory) {
      dispatchInput = memoryHistoryDispatchInput(
        input as MemoryHistoryInput,
        config.environment.capabilities.memory?.refusedReverts === true,
      ) as EnvironmentRpcInput<TTag>;
    }
    if (
      !supportsMemoryProtocol(config.environment.capabilities) ||
      (tag === WS_METHODS.memoryHistory &&
        (input as MemoryHistoryInput).resolutionInputsFor !== undefined &&
        config.environment.capabilities.memory?.resolutionInputs !== true) ||
      ((tag === WS_METHODS.memoryHubDiagnostics || tag === WS_METHODS.memoryHubReconcile) &&
        config.environment.capabilities.memory?.hubDiagnostics !== true) ||
      (tag === WS_METHODS.memoryImportProvider &&
        config.environment.capabilities.memory?.importProvider !== true) ||
      typeof (session.client as Partial<EnvironmentProtocolClient>)[tag] !== "function"
    ) {
      return yield* new EnvironmentRpcUnavailableError({
        environmentId: supervisor.target.environmentId,
        message: "Memory is unavailable on this environment.",
      });
    }
  }
  const observer = yield* EnvironmentRpcRequestObserver;
  const method = (session.client as EnvironmentProtocolClient)[tag] as (
    input: EnvironmentRpcInput<TTag>,
  ) => Effect.Effect<EnvironmentRpcSuccess<TTag>, EnvironmentRpcFailure<TTag>>;
  const completeObservation = yield* observer.observe({
    environmentId: supervisor.target.environmentId,
    environmentLabel: supervisor.target.label,
    method: tag,
  });
  return yield* method(dispatchInput).pipe(
    // Older hubs encode a missing RPC as a defect rather than a typed failure.
    Effect.catchCauseIf(
      (cause) => tag.startsWith("hub.nodes.") && isHubNodesUnsupportedError(cause),
      () =>
        Effect.fail(
          new EnvironmentRpcUnavailableError({
            environmentId: supervisor.target.environmentId,
            message: `Unknown request tag: ${tag}`,
          }),
        ),
    ),
    Effect.ensuring(completeObservation),
  );
});

export function runStreamGuarded<TTag extends EnvironmentStreamCommandRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  | EnvironmentRpcStreamFailure<TTag>
  | EnvironmentRpcUnavailableError
  | EnvironmentAuthorizationError,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return Stream.unwrap(
    authorizeRequest(tag, input).pipe(
      Effect.andThen(currentSession()),
      Effect.map((session) => {
        const method = (session.client as EnvironmentProtocolClient)[tag] as (
          input: EnvironmentRpcInput<TTag>,
        ) => Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>;
        return method(input);
      }),
    ),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.runStream", {
      attributes: { "rpc.method": tag },
    }),
  );
}

interface SubscriptionOptions<TTag extends EnvironmentSubscriptionRpcTag> {
  readonly onDefect?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly onExpectedFailure?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly retryExpectedFailureAfter?: Duration.Input;
  readonly resubscribe?: Stream.Stream<unknown, never, never>;
}

function subscribeDynamicMapped<TTag extends EnvironmentSubscriptionRpcTag, A>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  mapStream: (
    session: RpcSession,
    stream: Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>,
  ) => Stream.Stream<A, EnvironmentRpcStreamFailure<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  A,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const observer = yield* EnvironmentRpcSubscriptionObserver;
      const sessionChanges = SubscriptionRef.changes(supervisor.session);
      const sessions =
        options?.resubscribe === undefined
          ? sessionChanges
          : Stream.merge(
              sessionChanges,
              options.resubscribe.pipe(
                Stream.mapEffect(() => SubscriptionRef.get(supervisor.session)),
              ),
            );
      return sessions.pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) => {
              const method = (
                tag === WS_METHODS.subscribeServerConfig
                  ? session.subscribeServerConfig
                  : (session.client as EnvironmentProtocolClient)[tag]
              ) as (
                input: EnvironmentRpcInput<TTag>,
              ) => Stream.Stream<
                EnvironmentRpcStreamValue<TTag>,
                EnvironmentRpcStreamFailure<TTag>
              >;
              let expectedFailureRetries = 0;
              const subscribeToSession = (): Stream.Stream<A, EnvironmentRpcStreamFailure<TTag>> =>
                Stream.suspend(() =>
                  Stream.unwrap(
                    Effect.gen(function* () {
                      const input = yield* makeInput(session);
                      if (tag === WS_METHODS.memoryChanges) {
                        const config = yield* session.initialConfig.pipe(
                          Effect.mapError(
                            () =>
                              new MemoryRpcError({
                                code: "unsupported_operation",
                              }) as EnvironmentRpcStreamFailure<TTag>,
                          ),
                        );
                        if (
                          !supportsMemoryProtocol(config.environment.capabilities) ||
                          typeof method !== "function"
                        ) {
                          return Stream.fail(
                            new MemoryRpcError({
                              code: "unsupported_operation",
                            }) as EnvironmentRpcStreamFailure<TTag>,
                          );
                        }
                        yield* authorizeRequest(tag, input).pipe(
                          Effect.mapError((error) => error as EnvironmentRpcStreamFailure<TTag>),
                          Effect.provideService(
                            EnvironmentSupervisor.EnvironmentSupervisor,
                            supervisor,
                          ),
                        );
                      }
                      const completeObservation = yield* observer.observe({
                        environmentId: supervisor.target.environmentId,
                        method: tag,
                        input,
                      });
                      const stream = mapStream(session, method(input)).pipe(
                        Stream.onFirst(() =>
                          Effect.sync(() => {
                            expectedFailureRetries = 0;
                          }),
                        ),
                      );
                      return stream.pipe(Stream.ensuring(completeObservation));
                    }),
                  ).pipe(
                    Stream.tapCause((cause) =>
                      options?.onDefect !== undefined &&
                      cause.reasons.some(
                        (reason) =>
                          reason._tag === "Die" ||
                          (reason._tag === "Fail" &&
                            isRpcClientError(reason.error) &&
                            reason.error.reason._tag === "RpcClientDefect"),
                      )
                        ? options.onDefect(cause)
                        : Effect.void,
                    ),
                    Stream.catchCause((cause) => {
                      if (
                        tag === WS_METHODS.hubNodesSubscribe &&
                        isHubNodesUnsupportedError(cause)
                      ) {
                        return Stream.failCause(cause);
                      }
                      const hasOnlyExpectedFailures =
                        cause.reasons.length > 0 &&
                        cause.reasons.every((reason) => reason._tag === "Fail");
                      const isTransportFailure =
                        hasOnlyExpectedFailures &&
                        cause.reasons.every(
                          (reason) => reason._tag === "Fail" && isRpcClientError(reason.error),
                        );
                      if (isTransportFailure) {
                        return Stream.fromEffect(
                          Effect.logWarning(
                            "Durable RPC subscription lost its transport; waiting for the next session.",
                            {
                              cause: Cause.pretty(cause),
                              method: tag,
                              environmentId: supervisor.target.environmentId,
                            },
                          ),
                        ).pipe(Stream.drain);
                      }
                      if (hasOnlyExpectedFailures && options?.onExpectedFailure !== undefined) {
                        const handled = Stream.fromEffect(options.onExpectedFailure(cause)).pipe(
                          Stream.drain,
                        );
                        const isAuthorizationFailure = cause.reasons.some(
                          (reason) =>
                            reason._tag === "Fail" && isEnvironmentAuthorizationError(reason.error),
                        );
                        if (
                          options.retryExpectedFailureAfter === undefined ||
                          isAuthorizationFailure
                        ) {
                          return handled;
                        }
                        const retryDelay = Duration.millis(
                          Math.min(
                            Duration.toMillis(options.retryExpectedFailureAfter) *
                              2 ** expectedFailureRetries,
                            MAX_EXPECTED_FAILURE_RETRY_DELAY_MS,
                          ),
                        );
                        expectedFailureRetries += 1;
                        return handled.pipe(
                          Stream.concat(
                            Stream.fromEffect(Effect.sleep(retryDelay)).pipe(Stream.drain),
                          ),
                          Stream.concat(subscribeToSession()),
                        );
                      }
                      return Stream.failCause(cause);
                    }),
                  ),
                );
              return subscribeToSession();
            },
          }),
        ),
      );
    }),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.subscribe", {
      attributes: { "rpc.method": tag },
    }),
  );
}

export function subscribeDynamic<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return subscribeDynamicMapped(tag, makeInput, (_session, stream) => stream, options);
}

/** Tags each value before `switchMap` can buffer it across a session change. */
export function subscribeDynamicWithSession<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  readonly [session: RpcSession, value: EnvironmentRpcStreamValue<TTag>],
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return subscribeDynamicMapped(
    tag,
    makeInput,
    (session, stream) => stream.pipe(Stream.map((value) => [session, value] as const)),
    options,
  );
}

export function subscribe<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return subscribeDynamic(tag, () => Effect.succeed(input), options);
}

export const request = <TTag extends Exclude<EnvironmentUnaryRpcTag, ClientGuardedRpcTag>>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
) => requestGuarded(tag, input);

export const runStream = <
  TTag extends Exclude<EnvironmentStreamCommandRpcTag, ClientGuardedRpcTag>,
>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
) => runStreamGuarded(tag, input);

export type MemoryBodyRpcTag =
  | typeof WS_METHODS.memoryList
  | typeof WS_METHODS.memorySearch
  | typeof WS_METHODS.memoryRead
  | typeof WS_METHODS.memoryHistory
  | typeof WS_METHODS.memoryReadSource;

/** Runs an ephemeral body read in the caller's interruptible atom scope. */
export function requestMemoryQuery<R, E, T extends MemoryBodyRpcTag>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  atoms: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  tag: T,
  input: EnvironmentRpcInput<T>,
) {
  const permissions = createCommandPermissions(runtime, tag);
  return permissions.authorize(atoms, environmentId, input).pipe(
    Effect.andThen(EnvironmentRegistry),
    Effect.flatMap((environments) =>
      environments.run(
        environmentId,
        requestGuarded(tag, input).pipe(
          Effect.provideService(RpcPermissionGuard, {
            authorize: (id, method, payload) =>
              createCommandPermissions(runtime, method).authorize(atoms, id, payload),
          }),
        ),
      ),
    ),
  );
}

/** One-session memory stream. Its owner closes exposure and handles session replacement. */
export function subscribeMemoryChanges<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  atoms: AtomRegistry.AtomRegistry,
  session: RpcSession,
  input: EnvironmentRpcInput<typeof WS_METHODS.memoryChanges>,
) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const config = yield* session.initialConfig.pipe(
        Effect.mapError(() => new MemoryRpcError({ code: "unsupported_operation" })),
      );
      const method = (session.client as Partial<EnvironmentProtocolClient>)[
        WS_METHODS.memoryChanges
      ];
      if (!supportsMemoryProtocol(config.environment.capabilities) || method === undefined) {
        return Stream.fail(new MemoryRpcError({ code: "unsupported_operation" }));
      }
      yield* createCommandPermissions(runtime, WS_METHODS.memoryChanges).authorize(
        atoms,
        supervisor.target.environmentId,
        input,
      );
      const observer = yield* EnvironmentRpcSubscriptionObserver;
      const complete = yield* observer.observe({
        environmentId: supervisor.target.environmentId,
        method: WS_METHODS.memoryChanges,
        input,
      });
      return method(input).pipe(Stream.ensuring(complete));
    }),
  );
}
