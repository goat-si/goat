/**
 * Keeps each configured Slack connection's socket alive and reports its status.
 *
 * One supervisor fiber per connection runs attempts in a loop: authenticate the bot token,
 * open a Socket Mode session, and wait until it drops. Each attempt has its own scope, so its
 * socket, listeners and in-flight event handlers are released before the next attempt starts.
 * The SDK's own reconnect is off (see SlackSdk.ts); token revocation and a workspace
 * mismatch stop the loop until the connection is configured again.
 *
 * @module SlackChannelRuntime
 */
import type {
  SlackChannelConnectionStatus,
  SlackChannelDeliveryError,
  SlackChannelStatusEvent,
  SlackChannelSettingsError,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as AutomationHold from "../../automationHold.ts";
import * as ChannelGateway from "../ChannelGateway.ts";
import type { ChannelConnectionOwner } from "../ChannelIngressContext.ts";
import * as ChannelTransport from "../ChannelTransport.ts";
import {
  handleSlackEnvelope,
  makeSlackChannelTransport,
  type SlackActiveSession,
  type SlackDeliveryFailureReport,
} from "./SlackChannelAdapter.ts";
import type { SlackRevocationEvent } from "./slackEventMapping.ts";
import * as SlackSdk from "./SlackSdk.ts";

export interface SlackRuntimeConnection {
  readonly connectionId: string;
  readonly enabled: boolean;
  readonly allowedChannelIds: ReadonlyArray<string>;
  readonly appToken: string | undefined;
  readonly botToken: string | undefined;
  /** The workspace saved when the tokens were validated. */
  readonly expectedTeamId: string | undefined;
  readonly owner: ChannelConnectionOwner | undefined;
  readonly botUserId?: string;
  readonly revoked?: "bot_revoked" | "app_uninstalled";
  readonly onRevoked?: (
    event: SlackRevocationEvent,
    generation: number,
  ) => Effect.Effect<
    "active" | "blocked" | "uninstalled" | "ignored" | "stale",
    SlackChannelSettingsError
  >;
}

export interface SlackRuntimeStatus {
  readonly status: SlackChannelConnectionStatus;
  /** A fixed reason such as `token_revoked`; never a raw Slack message. */
  readonly lastError?: string;
  readonly lastDeliveryError?: SlackChannelDeliveryError;
  readonly teamId?: string;
  readonly botUserId?: string;
}

const DISABLED: SlackRuntimeStatus = { status: "disabled" };
const START_TIMEOUT = Duration.seconds(30);
const DISCONNECT_TIMEOUT = Duration.seconds(5);
const MAX_BACKOFF_SECONDS = 60;

export class SlackChannelRuntime extends Context.Service<
  SlackChannelRuntime,
  {
    /** Replaces the connection's session with one for this configuration. */
    readonly apply: (connection: SlackRuntimeConnection) => Effect.Effect<void>;
    readonly isCurrent: (connectionId: string, generation: number) => Effect.Effect<boolean>;
    readonly remove: (connectionId: string) => Effect.Effect<void>;
    readonly status: (connectionId: string) => Effect.Effect<SlackRuntimeStatus>;
    /** Every connection's current status once, then only changes. */
    readonly streamStatus: Stream.Stream<SlackChannelStatusEvent>;
  }
>()("goat/channels/slack/SlackChannelRuntime") {}

/** How one attempt ended without failing. */
type AttemptEnd =
  | { readonly _tag: "disconnected"; readonly connected: boolean }
  | { readonly _tag: "stopped"; readonly lastError: string };

interface Supervisor {
  readonly generation: number;
  readonly fiber: Fiber.Fiber<void>;
}

interface StatusState {
  readonly revision: number;
  readonly statuses: ReadonlyMap<string, SlackRuntimeStatus>;
}

interface StatusChange {
  readonly revision: number;
  readonly event: SlackChannelStatusEvent;
}

const toEvent = (connectionId: string, status: SlackRuntimeStatus): SlackChannelStatusEvent => ({
  connectionId: connectionId as SlackChannelStatusEvent["connectionId"],
  status: status.status,
  ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
  ...(status.lastDeliveryError === undefined
    ? {}
    : { lastDeliveryError: status.lastDeliveryError }),
});

/**
 * The snapshot's statuses, then the changes made after it. Changes buffered while the snapshot
 * was taken carry revisions the snapshot already covers and are dropped, so a subscriber never
 * sees an older state after a newer one.
 */
export function statusEventsAfter(
  snapshot: StatusState,
  changes: Stream.Stream<StatusChange>,
): Stream.Stream<SlackChannelStatusEvent> {
  return Stream.concat(
    Stream.fromIterable(
      Array.from(snapshot.statuses, ([connectionId, status]) => toEvent(connectionId, status)),
    ),
    changes.pipe(
      Stream.filter((change) => change.revision > snapshot.revision),
      Stream.map((change) => change.event),
    ),
  );
}

const backoffSeconds = (failures: number) =>
  Math.min(MAX_BACKOFF_SECONDS, 2 ** Math.max(0, failures - 1));

const make = Effect.gen(function* () {
  const hold = yield* AutomationHold.AutomationHold;
  const sdk = yield* SlackSdk.SlackSdk;
  const registry = yield* ChannelTransport.ChannelTransportRegistry;
  const gatewayContext = yield* Effect.context<ChannelGateway.ChannelGateway>();
  const layerScope = yield* Effect.scope;

  const applyLock = yield* Semaphore.make(1);
  const statusLock = yield* Semaphore.make(1);
  const generations = yield* Ref.make(0);
  const supervisors = yield* Ref.make<ReadonlyMap<string, Supervisor>>(new Map());
  const currentGenerations = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const activeSessions = yield* Ref.make<ReadonlyMap<string, SlackActiveSession>>(new Map());
  const stopSignals = yield* Ref.make<
    ReadonlyMap<
      string,
      { readonly generation: number; readonly end: Deferred.Deferred<AttemptEnd> }
    >
  >(new Map());
  const statusState = yield* Ref.make<StatusState>({ revision: 0, statuses: new Map() });
  const statusChanges = yield* PubSub.unbounded<StatusChange>();

  const updateStatus = (
    connectionId: string,
    update: (previous: SlackRuntimeStatus) => SlackRuntimeStatus,
  ) =>
    statusLock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* Ref.get(statusState);
        const next = update(state.statuses.get(connectionId) ?? DISABLED);
        const statuses = new Map(state.statuses).set(connectionId, next);
        const revision = state.revision + 1;
        yield* Ref.set(statusState, { revision, statuses });
        const event = toEvent(connectionId, next);
        const previous = state.statuses.get(connectionId);
        if (
          previous === undefined ||
          !(
            previous.status === next.status &&
            previous.lastError === next.lastError &&
            previous.lastDeliveryError?.code === next.lastDeliveryError?.code &&
            previous.lastDeliveryError?.at === next.lastDeliveryError?.at &&
            previous.lastDeliveryError?.channelId === next.lastDeliveryError?.channelId
          )
        ) {
          yield* PubSub.publish(statusChanges, { revision, event });
        }
      }),
    );

  /** Keeps the delivery error and workspace across transitions within one configuration. */
  const setPhase = (
    connectionId: string,
    status: SlackChannelConnectionStatus,
    lastError?: string,
  ) =>
    updateStatus(connectionId, (previous) => ({
      status,
      ...(lastError === undefined ? {} : { lastError }),
      ...(previous.lastDeliveryError === undefined
        ? {}
        : { lastDeliveryError: previous.lastDeliveryError }),
      ...(previous.teamId === undefined ? {} : { teamId: previous.teamId }),
      ...(previous.botUserId === undefined ? {} : { botUserId: previous.botUserId }),
    }));

  const forgetSession = (connectionId: string, generation: number) =>
    Effect.all([
      Ref.update(activeSessions, (sessions) => {
        if (sessions.get(connectionId)?.generation !== generation) return sessions;
        const next = new Map(sessions);
        next.delete(connectionId);
        return next;
      }),
      Ref.update(stopSignals, (signals) => {
        if (signals.get(connectionId)?.generation !== generation) return signals;
        const next = new Map(signals);
        next.delete(connectionId);
        return next;
      }),
    ]);

  const isCurrent = (connectionId: string, generation: number) =>
    Effect.map(Ref.get(currentGenerations), (all) => all.get(connectionId) === generation);

  const dropDelivery = (connectionId: string, generation: number) =>
    Ref.update(activeSessions, (sessions) => {
      if (sessions.get(connectionId)?.generation !== generation) return sessions;
      const next = new Map(sessions);
      next.delete(connectionId);
      return next;
    });

  const attempt = (
    connection: SlackRuntimeConnection & { appToken: string },
    owner: ChannelConnectionOwner,
    generation: number,
    blocked: Ref.Ref<string | undefined>,
    savedIdentity: Ref.Ref<SlackSdk.SlackAuthIdentity | undefined>,
  ) =>
    Effect.gen(function* () {
      const botApi =
        connection.botToken === undefined
          ? undefined
          : sdk.botApi({ botToken: connection.botToken });
      const receiveOnly = (yield* Ref.get(blocked)) !== undefined;
      const remembered = yield* Ref.get(savedIdentity);
      if (receiveOnly && remembered === undefined)
        return { _tag: "stopped", lastError: "missing_identity" } satisfies AttemptEnd;
      if (!receiveOnly && botApi === undefined)
        return { _tag: "stopped", lastError: "missing_token" } satisfies AttemptEnd;
      const identity =
        receiveOnly && remembered !== undefined
          ? remembered
          : botApi === undefined
            ? yield* Effect.fail(
                new SlackSdk.SlackSdkFailure({ operation: "auth.test", category: "auth_invalid" }),
              )
            : yield* SlackSdk.slackCall("auth.test", botApi.authTest);
      yield* Ref.set(savedIdentity, identity);
      if (
        connection.expectedTeamId !== undefined &&
        identity.teamId !== connection.expectedTeamId
      ) {
        return { _tag: "stopped", lastError: "workspace_mismatch" } satisfies AttemptEnd;
      }
      yield* updateStatus(connection.connectionId, (previous) => ({
        ...previous,
        teamId: identity.teamId,
        botUserId: identity.botUserId,
      }));

      const end = yield* Deferred.make<AttemptEnd>();
      const connected = yield* Ref.make(false);
      yield* Ref.update(stopSignals, (signals) =>
        new Map(signals).set(connection.connectionId, { generation, end }),
      );
      const activate = Ref.update(activeSessions, (sessions) =>
        botApi === undefined
          ? sessions
          : new Map(sessions).set(connection.connectionId, {
              generation,
              teamId: identity.teamId,
              botUserId: identity.botUserId,
              botApi,
            }),
      );
      const envelopeLock = yield* Semaphore.make(1);
      const terminateAfterAck = yield* Ref.make(false);
      const onRevocation = (event: SlackRevocationEvent) =>
        Effect.gen(function* () {
          // A replaced session leaves the event unacknowledged so Slack redelivers it to the new one.
          if (!(yield* isCurrent(connection.connectionId, generation))) return false;
          yield* Ref.set(terminateAfterAck, false);
          const previous = yield* Ref.get(blocked);
          const reason =
            previous === "app_uninstalled" || event.kind === "app_uninstalled"
              ? "app_uninstalled"
              : "token_revoked";
          yield* Ref.set(blocked, reason);
          yield* dropDelivery(connection.connectionId, generation);
          yield* setPhase(connection.connectionId, "error", reason);
          if (connection.onRevoked === undefined) return false;
          const result = yield* Effect.exit(connection.onRevoked(event, generation));
          if (Exit.isFailure(result)) {
            yield* Effect.logWarning(
              "Slack revocation cleanup failed; leaving the event unacknowledged.",
            );
            return false;
          }
          if (result.value === "ignored") return false;
          if (result.value === "stale" && previous !== undefined) {
            yield* Ref.set(blocked, previous);
            yield* setPhase(connection.connectionId, "error", previous);
          } else if (result.value === "active" || result.value === "stale") {
            yield* Ref.set(blocked, undefined);
            yield* activate;
            yield* setPhase(connection.connectionId, "connected");
          } else if (result.value === "uninstalled") {
            yield* Ref.set(terminateAfterAck, true);
            yield* Ref.set(blocked, "app_uninstalled");
            yield* setPhase(connection.connectionId, "error", "app_uninstalled");
          }
          return true;
        });

      // Event handlers live in this attempt's scope and stop with it.
      const runFork = yield* FiberSet.makeRuntime();
      const classifier = {
        teamId: identity.teamId,
        botUserId: identity.botUserId,
        allowedChannelIds: new Set(connection.allowedChannelIds),
      };
      const handleEnvelope = (envelope: SlackSdk.SlackSocketEnvelope) =>
        envelopeLock.withPermits(1)(
          handleSlackEnvelope(envelope, {
            connectionId: connection.connectionId,
            classifier,
            owner,
            onRevocation,
            receiveOnly: Effect.map(Ref.get(blocked), (reason) => reason !== undefined),
          }).pipe(
            Effect.flatMap((outcome) =>
              Effect.gen(function* () {
                if (outcome.handling === "team_mismatch") {
                  yield* dropDelivery(connection.connectionId, generation);
                  yield* setPhase(connection.connectionId, "error", "workspace_mismatch");
                  yield* Deferred.succeed(end, {
                    _tag: "stopped",
                    lastError: "workspace_mismatch",
                  });
                } else if (
                  outcome.handling === "revocation" &&
                  outcome.acked &&
                  (yield* Ref.get(terminateAfterAck))
                ) {
                  yield* Deferred.succeed(end, { _tag: "stopped", lastError: "app_uninstalled" });
                }
              }),
            ),
          ),
        );

      const session = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const opened = sdk.openSession(connection.appToken);
          const removeEnvelopeListener = opened.onEnvelope((envelope) => {
            runFork(Effect.provide(handleEnvelope(envelope), gatewayContext));
          });
          const removeLifecycleListener = opened.onLifecycle((event) => {
            if (event._tag === "disconnected") {
              runFork(
                Effect.flatMap(Ref.get(connected), (wasConnected) =>
                  Deferred.succeed(end, { _tag: "disconnected", connected: wasConnected }),
                ),
              );
            }
          });
          return { opened, removeEnvelopeListener, removeLifecycleListener };
        }),
        ({ opened, removeEnvelopeListener, removeLifecycleListener }) =>
          Effect.sync(() => {
            removeEnvelopeListener();
            removeLifecycleListener();
          }).pipe(
            // Bounded: never wait on start(), which may be waiting for a hello that never comes.
            Effect.andThen(
              Effect.promise(() => opened.disconnect().catch(() => undefined)).pipe(
                Effect.timeout(DISCONNECT_TIMEOUT),
                Effect.ignore,
              ),
            ),
          ),
      );

      yield* SlackSdk.slackCall("socket.start", session.opened.start).pipe(
        Effect.timeoutOrElse({
          duration: START_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new SlackSdk.SlackSdkFailure({ operation: "socket.start", category: "network" }),
            ),
        }),
      );
      yield* Ref.set(connected, true);
      const reason = yield* Ref.get(blocked);
      if (reason === undefined) {
        yield* activate;
        yield* setPhase(connection.connectionId, "connected");
      } else yield* setPhase(connection.connectionId, "error", reason);
      return yield* Deferred.await(end);
    }).pipe(Effect.scoped);

  /** The reconnect loop for a connection that has passed {@link prepare}. */
  const supervise = (
    connection: SlackRuntimeConnection & { appToken: string },
    owner: ChannelConnectionOwner,
    generation: number,
  ) =>
    Effect.gen(function* () {
      const { connectionId } = connection;
      let failures = 0;
      const blocked = yield* Ref.make<string | undefined>(
        connection.revoked === "bot_revoked" ? "token_revoked" : undefined,
      );
      const savedIdentity = yield* Ref.make<SlackSdk.SlackAuthIdentity | undefined>(
        connection.expectedTeamId !== undefined && connection.botUserId !== undefined
          ? { teamId: connection.expectedTeamId, botUserId: connection.botUserId, botId: undefined }
          : undefined,
      );
      while (true) {
        yield* hold.awaitRelease;
        const exit = yield* Effect.exit(
          attempt(connection, owner, generation, blocked, savedIdentity),
        );
        yield* forgetSession(connectionId, generation);
        let waitSeconds: number;
        if (Exit.isSuccess(exit)) {
          const end = exit.value;
          if (end._tag === "stopped") {
            yield* setPhase(connectionId, "error", end.lastError);
            return;
          }
          failures = end.connected ? 1 : failures + 1;
          waitSeconds = backoffSeconds(failures);
        } else {
          // A defect in an attempt is unexpected; retry it like an unknown failure.
          const failure = Exit.findErrorOption(exit);
          const category = Option.isSome(failure) ? failure.value.category : "unknown";
          if (category === "auth_revoked" || category === "auth_invalid") {
            yield* setPhase(
              connectionId,
              "error",
              category === "auth_revoked" ? "token_revoked" : "invalid_token",
            );
            return;
          }
          failures += 1;
          const retryAfterSeconds = Option.isSome(failure)
            ? failure.value.retryAfterSeconds
            : undefined;
          waitSeconds =
            category === "rate_limited"
              ? Math.max(1, retryAfterSeconds ?? 1)
              : backoffSeconds(failures);
          yield* Effect.logWarning("Slack connection attempt failed.").pipe(
            Effect.annotateLogs({ category }),
          );
        }
        const reason = yield* Ref.get(blocked);
        yield* setPhase(connectionId, reason === undefined ? "reconnecting" : "error", reason);
        yield* Effect.sleep(Duration.seconds(waitSeconds));
      }
    }).pipe(
      Effect.ensuring(forgetSession(connection.connectionId, generation)),
      Effect.annotateLogs({ connectionId: connection.connectionId }),
    );

  /**
   * Settles the status a configuration starts in, so it is current when apply returns.
   * Returns the inputs the reconnect loop needs, or none when the connection cannot start.
   */
  const prepare = (connection: SlackRuntimeConnection) =>
    Effect.gen(function* () {
      const { connectionId, appToken, botToken, owner } = connection;
      if (!connection.enabled) {
        yield* updateStatus(connectionId, () => DISABLED);
        return Option.none();
      }
      if (connection.revoked === "app_uninstalled") {
        yield* setPhase(connectionId, "error", "app_uninstalled");
        return Option.none();
      }
      const receiveOnly =
        connection.revoked === "bot_revoked" &&
        connection.expectedTeamId !== undefined &&
        connection.botUserId !== undefined;
      if (appToken === undefined || (!receiveOnly && botToken === undefined)) {
        yield* setPhase(connectionId, "error", "missing_token");
        return Option.none();
      }
      if (owner === undefined) {
        yield* setPhase(connectionId, "error", "owner_missing");
        return Option.none();
      }
      yield* setPhase(
        connectionId,
        receiveOnly ? "error" : "connecting",
        receiveOnly ? "token_revoked" : undefined,
      );
      return Option.some({ connection: { ...connection, appToken, botToken }, owner });
    });

  /** Stops the current supervisor and waits for its socket to be released. */
  const retire = (connectionId: string) =>
    Effect.gen(function* () {
      yield* Ref.update(currentGenerations, (all) => {
        const next = new Map(all);
        next.delete(connectionId);
        return next;
      });
      const current = (yield* Ref.get(supervisors)).get(connectionId);
      if (current === undefined) return;
      yield* Fiber.interrupt(current.fiber);
      yield* forgetSession(connectionId, current.generation);
      yield* Ref.update(supervisors, (all) => {
        const next = new Map(all);
        next.delete(connectionId);
        return next;
      });
    });

  const apply: SlackChannelRuntime["Service"]["apply"] = (connection) =>
    applyLock.withPermits(1)(
      Effect.gen(function* () {
        yield* retire(connection.connectionId);
        const ready = yield* prepare(connection);
        if (Option.isNone(ready)) return;
        const generation = yield* Ref.updateAndGet(generations, (value) => value + 1);
        yield* Ref.update(currentGenerations, (all) =>
          new Map(all).set(connection.connectionId, generation),
        );
        const fiber = yield* Effect.forkIn(
          supervise(ready.value.connection, ready.value.owner, generation),
          layerScope,
        );
        yield* Ref.update(supervisors, (all) =>
          new Map(all).set(connection.connectionId, { generation, fiber }),
        );
      }),
    );

  const remove: SlackChannelRuntime["Service"]["remove"] = (connectionId) =>
    applyLock.withPermits(1)(
      retire(connectionId).pipe(Effect.andThen(updateStatus(connectionId, () => DISABLED))),
    );

  const reportFailure = (
    connectionId: string,
    generation: number,
    report: SlackDeliveryFailureReport,
  ) =>
    Effect.gen(function* () {
      const signal = (yield* Ref.get(stopSignals)).get(connectionId);
      if (signal === undefined || signal.generation !== generation) return;
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* updateStatus(connectionId, (previous) => ({
        ...previous,
        lastDeliveryError: { code: report.code, at, channelId: report.channelId },
      }));
      if (report.code === "token_revoked" || report.code === "invalid_auth") {
        const lastError = report.code === "token_revoked" ? "token_revoked" : "invalid_token";
        yield* dropDelivery(connectionId, generation);
        yield* setPhase(connectionId, "error", lastError);
        yield* Deferred.succeed(signal.end, { _tag: "stopped", lastError });
      }
    });

  yield* registry.register(
    makeSlackChannelTransport({
      activeSession: (connectionId) =>
        Effect.map(Ref.get(activeSessions), (sessions) =>
          Option.fromNullishOr(sessions.get(connectionId)),
        ),
      reportFailure,
      status: (connectionId) =>
        Effect.map(Ref.get(statusState), (state) => state.statuses.get(connectionId) ?? DISABLED),
    }),
  );

  const streamStatus: SlackChannelRuntime["Service"]["streamStatus"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before reading the snapshot so no change is lost, then drop the changes the
      // snapshot already contains.
      const subscription = yield* PubSub.subscribe(statusChanges);
      const snapshot = yield* Ref.get(statusState);
      return statusEventsAfter(snapshot, Stream.fromSubscription(subscription));
    }),
  );

  return SlackChannelRuntime.of({
    apply,
    isCurrent,
    remove,
    status: (connectionId) =>
      Effect.map(Ref.get(statusState), (state) => state.statuses.get(connectionId) ?? DISABLED),
    streamStatus,
  });
});

export const layer = Layer.effect(SlackChannelRuntime, make);
