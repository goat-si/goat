import { isGoatConnectEnabled } from "@goat/shared/goatConnect";
import type { RelayManagedEndpointRuntimeConfig } from "@goat/contracts/relay";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/http/HttpServer";
import * as CloudLink from "./CloudLink.ts";
import * as CloudManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import * as CloudCliState from "./CliState.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as AutomationHold from "../automationHold.ts";
import { pendingServiceUpdateExists } from "./updateHandoff.ts";
import { hasCloudPublicConfig } from "./publicConfig.ts";
import {
  MANAGED_TUNNEL_FIRST_REGISTRATION_JITTER,
  makeManagedTunnelRecovery,
  managedTunnelStartupAction,
  retryDesiredLinkReconcile,
  retryManagedTunnelRegistration,
} from "./managedTunnelStartup.ts";

const layerDesiredLinkReconcile = (cloudLinkParked: Deferred.Deferred<void>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const cloudLink = yield* CloudLink.CloudLink;
      const hold = yield* AutomationHold.AutomationHold;
      const activation = yield* ServerActivation.ServerActivation;
      const releaseManagedTunnel = cloudLink.releaseManagedTunnelOnShutdown().pipe(
        Effect.timeout("10 seconds"),
        Effect.tap((released) =>
          released ? Effect.logInfo("Released the managed tunnel on shutdown") : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "Failed to release the managed tunnel on shutdown; the next link reuses it",
            { errors: Cause.prettyErrors(cause).map((error) => error.message) },
          ),
        ),
        Effect.asVoid,
      );
      // After the hold releases, the trial owns cleanup before activation because the
      // previous server is already gone. The pending-state check keeps the tunnel for normal
      // commit or rollback, while the launcher's explicit-stop marker allows
      // it to be released. Other runtimes wait for activation so a failed
      // standby cannot tear down the active runtime's tunnel.
      const cleanupBeforeActivation = yield* pendingServiceUpdateExists;
      yield* ServerActivation.forkParked(
        Effect.gen(function* () {
          yield* hold.awaitRelease;
          if (cleanupBeforeActivation) {
            yield* Effect.addFinalizer(() => releaseManagedTunnel);
          }
          if (activation !== undefined) yield* activation;
          if (!cleanupBeforeActivation) {
            yield* Effect.addFinalizer(() => releaseManagedTunnel);
          }
          const server = yield* HttpServer.HttpServer;
          const address = server.address;
          if (typeof address === "string" || !("port" in address)) return;
          const localOrigin = `http://127.0.0.1:${address.port}`;
          const endpointRuntime = yield* CloudManagedEndpointRuntime.CloudManagedEndpointRuntime;
          const runManagedTunnelRecovery = yield* makeManagedTunnelRecovery({
            recover: (config: RelayManagedEndpointRuntimeConfig) =>
              cloudLink.recoverManagedTunnel(localOrigin, config, {
                retryRuntimeFailures: true,
              }),
            isRetryable: (error) =>
              CloudLink.shouldRetryCloudLink(error) &&
              error._tag !== "CloudLinkEndpointUnavailableError",
          });
          const recoverManagedTunnel = (config: RelayManagedEndpointRuntimeConfig) =>
            runManagedTunnelRecovery(config).pipe(
              Effect.tap((recovered) =>
                recovered ? Effect.logInfo("GOAT Connect managed tunnel recovered") : Effect.void,
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("Failed to recover the GOAT Connect managed tunnel", {
                      cause,
                    }),
              ),
            );
          yield* endpointRuntime.recoveryRequests.pipe(
            Stream.runForEach(recoverManagedTunnel),
            Effect.forkScoped,
          );
          const wantsCliLink = hasCloudPublicConfig
            ? yield* CloudCliState.readCliDesiredCloudLink.pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to read the desired GOAT Connect link", { cause }).pipe(
                    Effect.as(false),
                  ),
                ),
              )
            : false;
          // A failed read must not end this fiber before it registers
          // recovery and starts consuming recovery requests.
          const desiredCliLinkMode = wantsCliLink
            ? yield* CloudCliState.readCliDesiredLinkMode.pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to read the desired GOAT Connect link mode", {
                    cause,
                  }).pipe(Effect.as("managed" as const)),
                ),
              )
            : null;
          // A publish-only link must not expose the host, even if a managed
          // config from an earlier link is still stored.
          const startedConfirmed =
            desiredCliLinkMode === "publish_only"
              ? false
              : yield* cloudLink.startManagedTunnelIfOriginConfirmed(localOrigin).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to start the confirmed GOAT Connect tunnel", {
                      cause,
                    }).pipe(Effect.as(false)),
                  ),
                );
          const startStoredManagedTunnel = cloudLink
            .startManagedTunnelIfOriginConfirmed(localOrigin, {
              requireConfirmedOrigin: false,
            })
            .pipe(
              Effect.tap((started) =>
                started
                  ? Effect.logWarning(
                      "GOAT Connect started the stored tunnel without relay confirmation",
                    )
                  : Effect.void,
              ),
              Effect.catch((cause) =>
                Effect.logWarning("Failed to start the stored GOAT Connect tunnel", { cause }),
              ),
              Effect.asVoid,
            );
          const registerManagedTunnel = retryManagedTunnelRegistration(
            cloudLink.registerManagedTunnelRecovery(localOrigin, {
              retryRuntimeFailures: true,
            }),
            (error) =>
              CloudLink.shouldRetryCloudLink(error) &&
              error._tag !== "CloudLinkEndpointUnavailableError",
            startedConfirmed ? Effect.void : startStoredManagedTunnel,
          ).pipe(
            Effect.tap((result) =>
              result.status === "ready"
                ? Effect.logInfo("GOAT Connect managed tunnel recovery registered")
                : Effect.void,
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logWarning("Failed to register GOAT Connect managed tunnel recovery", {
                    cause,
                  }).pipe(Effect.as({ status: "unavailable" as const })),
            ),
          );
          // Spread those registrations so an auto-update wave does not hit
          // the relay all at once.
          if (!startedConfirmed && desiredCliLinkMode !== "publish_only") {
            const jitter = yield* Random.nextIntBetween(
              0,
              Duration.toMillis(MANAGED_TUNNEL_FIRST_REGISTRATION_JITTER),
            );
            yield* Effect.sleep(Duration.millis(jitter));
          }
          const registration =
            desiredCliLinkMode === "publish_only"
              ? { status: "not_linked" as const }
              : yield* registerManagedTunnel;
          if (registration.status === "unavailable" && !startedConfirmed) {
            yield* startStoredManagedTunnel;
          }
          const startupAction = managedTunnelStartupAction({ wantsCliLink, registration });
          if (startupAction.action === "request_recovery") {
            yield* endpointRuntime.requestRecovery(startupAction.config);
          }
          if (startupAction.action === "reconcile_link") {
            const reconciledMode = yield* cloudLink
              .reconcileDesiredLinkIfStillDesired(localOrigin)
              .pipe(
                (reconcile) =>
                  retryDesiredLinkReconcile(reconcile, CloudLink.shouldRetryCloudLink, (cause) =>
                    Effect.logWarning(
                      "GOAT Connect relay is still unavailable; retrying the desired link in the background",
                      { cause },
                    ),
                  ),
                Effect.tap((mode) =>
                  mode === null
                    ? Effect.void
                    : Effect.logInfo("GOAT Connect desired link reconciled on startup"),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to reconcile GOAT Connect desired link on startup", {
                    cause,
                  }).pipe(Effect.as(null)),
                ),
              );
            if (reconciledMode === "managed") {
              const afterReconcile = yield* registerManagedTunnel;
              if (afterReconcile.status === "recovery_required") {
                yield* endpointRuntime.requestRecovery(afterReconcile.config);
              }
            }
          }
        }),
      ).pipe(
        // Cleanup ownership must wait for the hold, but pending-update cleanup precedes activation.
        Effect.provideService(ServerActivation.ServerActivation, Effect.void),
      );
      yield* Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie);
    }),
  );

/**
 * Like Tailscale Serve, the reconcile fiber exists only when its feature is on, and
 * startup awaits its parked signal only then. With GOAT Connect off a previously
 * linked server never restores its stored tunnel or calls the relay.
 */
export const desiredLinkReconcileStartup = (cloudLinkParked: Deferred.Deferred<void>) =>
  isGoatConnectEnabled()
    ? {
        layer: layerDesiredLinkReconcile(cloudLinkParked),
        awaitParked: [Deferred.await(cloudLinkParked)],
      }
    : { layer: Layer.empty, awaitParked: [] };
