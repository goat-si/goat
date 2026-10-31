import { DesktopCuaManifestRequest } from "@goat/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Union } from "../preview/BrowserOriginGrants.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

class DesktopBrowserManifestError extends Schema.TaggedError<DesktopBrowserManifestError>()(
  "DesktopBrowserManifestError",
  { cause: Schema.Defect() },
) {}

const decodeRequest = Schema.decodeUnknownEffect(DesktopCuaManifestRequest);

export const makeDesktopBrowserManifest = Effect.fn("CuaDriver.makeDesktopBrowserManifest")(
  function* () {
    const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
    const crypto = yield* Crypto.Crypto;
    return (union: Union) =>
      Effect.gen(function* () {
        if (!receiver.cuaManifestReports || !receiver.requestCuaManifest)
          return yield* new DesktopBrowserManifestError({
            cause: "Desktop manifest channel unavailable.",
          });
        const requestId = yield* crypto.randomUUIDv4();
        const request = yield* decodeRequest({
          version: 1,
          type: "cuaManifestRequest",
          requestId,
          union,
        });
        const result = yield* Deferred.make<string, DesktopBrowserManifestError>();
        yield* receiver.cuaManifestReports.pipe(
          Stream.runForEach((report) =>
            report.requestId !== requestId
              ? Effect.void
              : report.status === "written"
                ? Deferred.succeed(result, report.sha256).pipe(Effect.asVoid)
                : Deferred.fail(
                    result,
                    new DesktopBrowserManifestError({
                      cause: "Desktop could not write the manifest.",
                    }),
                  ).pipe(Effect.asVoid),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* receiver.requestCuaManifest(request);
        return yield* Deferred.await(result);
      }).pipe(
        Effect.scoped,
        Effect.timeout("15 seconds"),
        Effect.mapError((cause) => new DesktopBrowserManifestError({ cause })),
      );
  },
);
