/**
 * Nothing is recorded or sent until the person grants `telemetryConsent` or the server's environment
 * sets GOAT_TELEMETRY_ENABLED; the environment wins either way. Events go to GOAT's ingest (infra/ingest at ingest.trygoat.ai), which stores
 * allowlisted events for at most 180 days and forwards nothing. GOAT_POSTHOG_HOST
 * and GOAT_POSTHOG_KEY point delivery at any other PostHog-compatible `/batch/`
 * endpoint instead. Each event carries a uuid, so a retried copy can be told
 * from a new event.
 */
import { timedShutdownPhase } from "@goat/shared/timedShutdownPhase";
import * as HostProcess from "@goat/shared/HostProcess";
import type { ClientOs, TelemetryConsent } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { DesktopShellDiscovery } from "../resourceTelemetry/DesktopShellDiscovery.ts";
import {
  getTelemetryIdentity,
  resetTelemetryIdentity,
  type TelemetryIdentity,
  type TelemetryOwner,
} from "./Identify.ts";

interface BufferedAnalyticsEvent {
  readonly uuid: string;
  readonly event: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly capturedAt: string;
}

interface DeliveryState {
  readonly failedBatch: ReadonlyArray<BufferedAnalyticsEvent>;
  readonly batchAttempts: number;
  readonly firstFailedAt: number;
  readonly failures: number;
  readonly retryAt: number;
}

// Retry delays shorter than this still wait for the next background check.
const FLUSH_INTERVAL_MS = 10_000;
// A hung send would hold the flush lock, and with it the shutdown flush.
const SEND_TIMEOUT = "10 seconds";
// A failed batch is tried again until it has failed for this long. Ingest answers 503 when it
// cannot store a batch, and a broken Cloudflare location can take about 5 minutes to fail over.
// The waiting batch holds newer events back; `maxBufferedEvents` bounds them meanwhile.
const MAX_BATCH_RETRY_MS = 30 * 60_000;
const RETRY_BASE_DELAY_MS = 2_000;
// Clients can report any number of owner ids; past this many per observer, new ones
// are not sent. Each observer has its own cap, so client reports never crowd out the
// server's own.
const MAX_RECORDED_OWNERS = 1_000;
const RETRY_MAX_DELAY_MS = 300_000;
// These statuses reject the batch itself; unlike 408/429, retrying cannot help.
const REJECTED_BATCH_STATUSES = new Set([400, 401, 413]);

/** `random` is in [0, 1). */
function retryDelayMs(failures: number, random: number): number {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failures - 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

const TelemetryEnvConfig = Config.all({
  // A public project key, not a secret: the ingest uses it to refuse stray traffic.
  posthogKey: Config.String("GOAT_POSTHOG_KEY").pipe(Config.withDefault("goat_public_ingest_v1")),
  posthogHost: Config.String("GOAT_POSTHOG_HOST").pipe(
    Config.withDefault("https://ingest.trygoat.ai"),
  ),
  enabled: Config.String("GOAT_TELEMETRY_ENABLED").pipe(Config.option),
  flushBatchSize: Config.Number("GOAT_TELEMETRY_FLUSH_BATCH_SIZE").pipe(Config.withDefault(20)),
  maxBufferedEvents: Config.Number("GOAT_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
    Config.withDefault(1_000),
  ),
  wslDistroName: Config.String("WSL_DISTRO_NAME").pipe(Config.option),
});

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    readonly flush: Effect.Effect<void>;

    /** GOAT_TELEMETRY_ENABLED's decision, which outranks the person's setting; doubles may leave it out. */
    readonly telemetryOverride?: Effect.Effect<"enabled" | "disabled" | undefined>;
    readonly telemetryOverrideResolved?: Effect.Effect<"enabled" | "disabled" | undefined>;

    /**
     * Records `install.owner_observed` for each owner of this install that the
     * server read itself or a connecting client reported. Each owner is sent once
     * per server process, so reconnects and repeated reads are free.
     */
    readonly recordOwners: (
      owners: ReadonlyArray<TelemetryOwner>,
      observedBy: "server" | "client",
    ) => Effect.Effect<void>;
  }
>()("goat/telemetry/AnalyticsService") {
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: Effect.fn("AnalyticsService.record")(function () {
        return Effect.void;
      }),
      flush: Effect.void,
      recordOwners: Effect.fn("AnalyticsService.recordOwners")(function () {
        return Effect.void;
      }),
    }),
  );
}

function serverOsFromNodePlatform(platform: string): ClientOs {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "android":
      return "Android";
    default:
      return "other";
  }
}

const IDLE_DELIVERY: DeliveryState = {
  failedBatch: [],
  batchAttempts: 0,
  firstFailedAt: 0,
  failures: 0,
  retryAt: 0,
};

/** An unrecognized value turns telemetry off; blank leaves the choice to the person. */
function parseTelemetryOverride(value: string | undefined): "enabled" | "disabled" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return ["true", "1", "yes", "on"].includes(normalized) ? "enabled" : "disabled";
}

/** @public */
export const make = Effect.gen(function* () {
  const telemetryConfig = yield* TelemetryEnvConfig;
  const hostEnvironment = yield* HostProcess.Environment;
  const awaitingShellConsent = hostEnvironment.GOAT_DESKTOP_SHELL_DISCOVERY_PENDING === "1";
  // The upstream variable can still turn sharing off, never on; its "off" outranks ours.
  const readOverride = (goatValue: string | undefined) =>
    parseTelemetryOverride(hostEnvironment.T3CODE_TELEMETRY_ENABLED) === "disabled" // goat-rename: legacy
      ? ("disabled" as const)
      : parseTelemetryOverride(goatValue);
  const startupOverride = readOverride(Option.getOrUndefined(telemetryConfig.enabled));
  // A cached PATH does not establish the login shell's choice; wait for the shell before deciding.
  const environmentOverride = Effect.sync(() => {
    if (startupOverride === "disabled" || !awaitingShellConsent) return startupOverride;
    if (hostEnvironment.GOAT_DESKTOP_SHELL_DISCOVERY_PENDING === "1") return "pending" as const;
    return readOverride(hostEnvironment.GOAT_TELEMETRY_ENABLED);
  });
  const settings = yield* ServerSettings.ServerSettingsService;
  const consent = settings.getSettings.pipe(
    Effect.map((current) => current.telemetryConsent),
    Effect.orElseSucceed(() => "undecided" as const),
  );
  const telemetryEnabled = Effect.flatMap(environmentOverride, (override) =>
    override === undefined
      ? Effect.map(consent, (answer) => answer === "granted")
      : Effect.succeed(override === "enabled"),
  );
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  // Created on the first event after consent, so an install that never shares never gets an id.
  const identityContext = yield* Effect.context<
    ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom
  >();
  const identityRef = yield* Ref.make<Option.Option<TelemetryIdentity>>(Option.none());
  const identityResetRef = yield* Ref.make(false);
  // Held while the id file is deleted, so a new id is never read from a file that is going away.
  const identityLock = yield* Semaphore.make(1);
  // A deletion that failed: no id is used until the file is gone.
  const resetPendingRef = yield* Ref.make(
    (yield* consent) === "declined" && (yield* environmentOverride) !== "enabled",
  );
  const resetIdentity = Effect.gen(function* () {
    yield* Ref.set(identityRef, Option.none());
    const removed = yield* resetTelemetryIdentity.pipe(Effect.provide(identityContext));
    yield* Ref.set(resetPendingRef, !removed);
    return removed;
  });
  const identity = identityLock.withPermit(
    Effect.gen(function* () {
      const known = yield* Ref.get(identityRef);
      if (Option.isSome(known)) return known.value;
      if ((yield* Ref.get(resetPendingRef)) && !(yield* resetIdentity)) {
        return { distinctId: null, installId: null } satisfies TelemetryIdentity;
      }
      const created = yield* getTelemetryIdentity.pipe(Effect.provide(identityContext));
      yield* Ref.set(identityRef, Option.some(created));
      return created;
    }),
  );
  const crypto = yield* SecureRandom.SecureRandom;
  const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
  const inFlightRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
  const deliveryRef = yield* Ref.make<DeliveryState>(IDLE_DELIVERY);
  // Bumped whenever queued events are dropped, so work begun before cannot put events back.
  const generationRef = yield* Ref.make(0);
  const dropQueued = Effect.gen(function* () {
    yield* Ref.update(generationRef, (generation) => generation + 1);
    yield* Ref.set(bufferRef, []);
    yield* Ref.set(deliveryRef, IDLE_DELIVERY);
  });
  const recordedOwnersRef = yield* Ref.make<
    Readonly<Record<"server" | "client", ReadonlySet<string>>>
  >({ server: new Set(), client: new Set() });
  // The background flush and the shutdown flush must not send the same batch at once.
  const flushLock = yield* Semaphore.make(1);
  const clientType = serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client";
  const hostPlatform = yield* HostProcess.Platform;
  const hostArchitecture = yield* HostProcess.Architecture;

  const enqueueBufferedEvent = (
    uuid: string,
    event: string,
    properties?: Readonly<Record<string, unknown>>,
  ) =>
    Effect.flatMap(DateTime.now, (now) =>
      Ref.modify(bufferRef, (current) => {
        const appended = [
          ...current,
          {
            uuid,
            event,
            ...(properties ? { properties } : {}),
            capturedAt: DateTime.formatIso(now),
          } satisfies BufferedAnalyticsEvent,
        ];

        const next =
          appended.length > telemetryConfig.maxBufferedEvents
            ? appended.slice(appended.length - telemetryConfig.maxBufferedEvents)
            : appended;

        return [
          {
            size: next.length,
            dropped: next.length !== appended.length,
          } as const,
          next,
        ] as const;
      }),
    );

  const sendBatch = Effect.fn("AnalyticsService.sendBatch")(function* (
    events: ReadonlyArray<BufferedAnalyticsEvent>,
    generation: number,
  ) {
    if (!(yield* telemetryEnabled)) return;
    const { distinctId, installId } = yield* identity;
    if (!distinctId || (yield* Ref.get(generationRef)) !== generation) return;

    const payload = {
      api_key: telemetryConfig.posthogKey,
      batch: events.map((event) => ({
        uuid: event.uuid,
        event: event.event,
        distinct_id: distinctId,
        properties: {
          ...event.properties,
          ...(installId === null ? {} : { installId }),
          $process_person_profile: false,
          platform: hostPlatform,
          wsl: Option.getOrUndefined(telemetryConfig.wslDistroName),
          arch: hostArchitecture,
          t3CodeVersion: packageJson.version,
          telemetryChannel: ServerConfig.telemetryChannel,
          clientType,
          serverOs: serverOsFromNodePlatform(hostPlatform),
          serverArch: hostArchitecture,
          serverWslDistro: Option.getOrUndefined(telemetryConfig.wslDistroName),
          serverAppVersion: packageJson.version,
          serverMode: serverConfig.mode,
        },
        timestamp: event.capturedAt,
      })),
    };

    yield* HttpClientRequest.post(`${telemetryConfig.posthogHost}/batch/`).pipe(
      HttpClientRequest.bodyJson(payload),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeout(SEND_TIMEOUT),
    );
  });

  const takeBatch = Ref.modify(bufferRef, (current) => {
    const nextBatch = current.slice(0, telemetryConfig.flushBatchSize);
    return [nextBatch, current.slice(nextBatch.length)] as const;
  });

  // Queued events never outlive consent. A person who declines also loses the install id, so
  // sharing again starts a new one; an environment override leaves the id alone.
  const discardUnlessEnabled = Effect.gen(function* () {
    if (yield* telemetryEnabled) {
      yield* Ref.set(identityResetRef, false);
      return true;
    }
    yield* dropQueued;
    if ((yield* consent) === "declined" && !(yield* Ref.get(identityResetRef))) {
      yield* identityLock.withPermit(resetIdentity);
      yield* Ref.set(identityResetRef, true);
    }
    return false;
  });

  // A saved answer other than granted withdraws the prior queue and identity.
  const withdraw = Effect.fn("AnalyticsService.withdraw")(function* (answer: TelemetryConsent) {
    if (answer === "granted" || (yield* environmentOverride) === "enabled") return;
    yield* dropQueued;
    if (answer !== "declined") return;
    yield* identityLock.withPermit(resetIdentity);
    yield* Ref.set(identityResetRef, true);
  });
  const revision = settings.changesRevision ?? Effect.succeed(0);
  const baseline = yield* settings.withSettingsSnapshot((current) =>
    Effect.gen(function* () {
      const changes = yield* settings.subscribeChanges;
      return { changes, revision: yield* revision, consent: current.telemetryConsent };
    }),
  );
  const consentChanges = baseline.changes;
  const processed = yield* SubscriptionRef.make(baseline.revision);
  let lastConsent = baseline.consent;
  const caughtUp = Effect.gen(function* () {
    const current = yield* revision;
    return (yield* SubscriptionRef.get(processed)) >= current;
  });
  const awaitCaughtUp = SubscriptionRef.changes(processed).pipe(
    Stream.filterEffect((count) => Effect.map(revision, (current) => count >= current)),
    Stream.runHead,
  );
  yield* Stream.runForEach(consentChanges, (current) =>
    Effect.gen(function* () {
      if (current.telemetryConsent !== lastConsent) {
        lastConsent = current.telemetryConsent;
        yield* withdraw(current.telemetryConsent);
      }
      yield* SubscriptionRef.update(processed, (count) => count + 1);
    }),
  ).pipe(Effect.forkScoped);

  // Back off even after dropping rejected batches so bad API keys cannot drain the queue in a tight loop.
  const flush: AnalyticsService["Service"]["flush"] = Effect.gen(function* () {
    if (Option.isNone(yield* awaitCaughtUp.pipe(Effect.timeoutOption("5 seconds")))) return;
    if (!(yield* discardUnlessEnabled)) return;
    while (true) {
      if (!(yield* caughtUp)) return;
      const generation = yield* Ref.get(generationRef);
      const delivery = yield* Ref.get(deliveryRef);
      const batch = delivery.failedBatch.length > 0 ? delivery.failedBatch : yield* takeBatch;
      if (batch.length === 0) {
        return;
      }

      yield* Ref.set(inFlightRef, batch);
      const sent = yield* Effect.result(sendBatch(batch, generation));
      yield* Ref.set(inFlightRef, []);
      // Withdrawn while sending: this batch must not be retried.
      if ((yield* Ref.get(generationRef)) !== generation) return;
      if (Result.isSuccess(sent)) {
        yield* Ref.set(deliveryRef, IDLE_DELIVERY);
        continue;
      }

      const now = yield* Clock.currentTimeMillis;
      const failures = delivery.failures + 1;
      const batchAttempts = delivery.batchAttempts + 1;
      const firstFailedAt = delivery.batchAttempts === 0 ? now : delivery.firstFailedAt;
      const retryAt = now + retryDelayMs(failures, yield* Random.next);
      const error = sent.failure;
      const rejected =
        error._tag === "HttpClientError" &&
        error.reason._tag === "StatusCodeError" &&
        REJECTED_BATCH_STATUSES.has(error.reason.response.status);
      if (!rejected && now - firstFailedAt < MAX_BATCH_RETRY_MS) {
        yield* Ref.set(deliveryRef, {
          failedBatch: batch,
          batchAttempts,
          firstFailedAt,
          failures,
          retryAt,
        });
        yield* Effect.logDebug("Failed to send telemetry batch; will retry", {
          attempt: batchAttempts,
          cause: error,
        });
        return;
      }
      yield* Ref.set(deliveryRef, {
        failedBatch: [],
        batchAttempts: 0,
        firstFailedAt: 0,
        failures,
        retryAt,
      });
      yield* Effect.logWarning(
        rejected
          ? "Dropped telemetry batch the endpoint rejected"
          : "Dropped telemetry batch after repeated send failures",
        { events: batch.length, attempts: batchAttempts, cause: error },
      );
      return;
    }
  }).pipe(flushLock.withPermit);

  const flushWhenDue = Effect.gen(function* () {
    if (!(yield* caughtUp) || !(yield* discardUnlessEnabled)) return;
    const { retryAt } = yield* Ref.get(deliveryRef);
    if ((yield* Clock.currentTimeMillis) >= retryAt) {
      yield* flush;
    }
  });

  const record: AnalyticsService["Service"]["record"] = Effect.fn("AnalyticsService.record")(
    function* (event, properties) {
      const generation = yield* Ref.get(generationRef);
      if (!(yield* caughtUp) || !(yield* telemetryEnabled) || !(yield* identity).distinctId) return;

      // Catch Node UUID defects too; best-effort telemetry drops events without UUIDs.
      const uuid = yield* Effect.exit(crypto.uuidV7());
      if (
        Exit.isFailure(uuid) ||
        !(yield* caughtUp) ||
        (yield* Ref.get(generationRef)) !== generation
      )
        return;

      const enqueueResult = yield* enqueueBufferedEvent(uuid.value, event, properties);
      if (enqueueResult.dropped) {
        yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
          size: enqueueResult.size,
          event,
        });
      }
    },
  );

  const recordOwners: AnalyticsService["Service"]["recordOwners"] = Effect.fn(
    "AnalyticsService.recordOwners",
  )(function* (owners, observedBy) {
    // Owners are not marked seen while disabled, so one seen again after consent is reported.
    if (!(yield* telemetryEnabled)) return;
    for (const { source, ownerId } of owners) {
      const isNew = yield* Ref.modify(recordedOwnersRef, (recorded) => {
        const key = `${source}:${ownerId}`;
        const seen = recorded[observedBy];
        return seen.has(key) || seen.size >= MAX_RECORDED_OWNERS
          ? [false, recorded]
          : [true, { ...recorded, [observedBy]: new Set(seen).add(key) }];
      });
      if (isNew)
        yield* record("install.owner_observed", { ownerSource: source, ownerId, observedBy });
    }
  });

  yield* Effect.forever(Effect.sleep(FLUSH_INTERVAL_MS).pipe(Effect.andThen(flushWhenDue)), {
    disableYield: true,
  }).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() =>
    timedShutdownPhase(
      "analyticsFlush",
      Effect.gen(function* () {
        const result = yield* flush.pipe(Effect.timeoutOption("1 second"));
        const buffered = yield* Ref.get(bufferRef);
        const delivery = yield* Ref.get(deliveryRef);
        const inFlight = yield* Ref.get(inFlightRef);
        const dropped = buffered.length + Math.max(delivery.failedBatch.length, inFlight.length);
        if (dropped > 0 || Option.isNone(result)) {
          yield* Effect.logWarning("Dropped telemetry events at shutdown deadline", {
            events: dropped,
          });
        }
      }),
    ),
  );

  const telemetryOverride = Effect.map(environmentOverride, (override) =>
    override === "pending" ? undefined : override,
  );

  const discovery = yield* DesktopShellDiscovery;
  const telemetryOverrideResolved = Effect.gen(function* () {
    if (hostEnvironment.GOAT_DESKTOP_SHELL_DISCOVERY_PENDING === "1") yield* discovery.await;
    return yield* telemetryOverride;
  });
  return AnalyticsService.of({
    record,
    flush,
    telemetryOverride,
    telemetryOverrideResolved,
    recordOwners,
  });
});

export const layer = Layer.effect(AnalyticsService, make);
