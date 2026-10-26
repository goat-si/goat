/**
 * Asks this host's desktop for the apps computer use can reach (#1567): the ids approvals check
 * against, and the same apps named, with icons, for people.
 *
 * @module DesktopAppsListing
 */
import type { ComputerUseApp } from "@goat/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

/** What a desktop listing answers: approval ids, and the same apps named for people. */
export interface DesktopAppsListed {
  readonly apps: ReadonlyArray<string>;
  readonly catalog: ReadonlyArray<ComputerUseApp>;
}

/**
 * Asks this host's desktop for a fresh list of the apps computer use can reach. `apps` is what
 * approvals check against; `catalog` names them (with icons) for people, and is empty from a
 * desktop that sends no names.
 */
export const makeDesktopAppsRequest = Effect.fn("CuaDriver.makeDesktopAppsRequest")(function* () {
  const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const crypto = yield* Crypto.Crypto;
  const ask: Effect.Effect<Option.Option<DesktopAppsListed>> = Effect.gen(function* () {
    // An older desktop ignores the request, which would hold the approval card for the whole
    // deadline; only a desktop that says it answers is asked (#1567).
    const readiness = yield* receiver.cuaReadiness;
    if (Option.isNone(readiness) || readiness.value.appsListing !== true)
      return Option.none<DesktopAppsListed>();
    const requestId = yield* crypto.randomUUIDv4();
    const ready = yield* Deferred.make<Option.Option<DesktopAppsListed>>();
    // Subscribe before sending: a desktop can answer during the write itself.
    yield* receiver.cuaApps.pipe(
      Stream.runForEach((report) =>
        report.requestId === requestId
          ? Deferred.succeed(
              ready,
              report.status === "listed"
                ? Option.some({ apps: report.apps, catalog: report.catalog ?? [] })
                : Option.none(),
            )
          : Effect.void,
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* receiver.requestCuaApps(requestId);
    return yield* Deferred.await(ready);
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeedNone }),
    Effect.orElseSucceed(() => Option.none<DesktopAppsListed>()),
  );
  return ask;
});
