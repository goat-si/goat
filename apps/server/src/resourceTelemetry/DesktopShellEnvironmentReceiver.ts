// @effect-diagnostics nodeBuiltinImport:off
import * as NodeTls from "node:tls";
import type { DesktopShellEnvironmentSnapshot } from "@goat/contracts";
import { loginShellPathUnread } from "@goat/shared/cliPath";
import { applyShellEnvironment } from "@goat/shared/shell";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

class DesktopShellCertificatesUpdateFailed extends Schema.TaggedError<DesktopShellCertificatesUpdateFailed>()(
  "DesktopShellCertificatesUpdateFailed",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to update desktop shell TLS certificates.";
  }
}

export function makeApplyDesktopShellEnvironmentSnapshot(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  /** Runs when a snapshot changes PATH or ends login-shell discovery, not on every snapshot. */
  onPathChanged: Effect.Effect<void> = Effect.void,
) {
  let baseCertificates: Array<string> | undefined;
  return Effect.fn("resourceTelemetry.desktopTelemetryReceiver.applyShellEnvironment")(function* (
    message: DesktopShellEnvironmentSnapshot,
  ) {
    if (message.platform !== platform) return;
    // Node's first default-CA enumeration consults process.env, so capture it before the patch.
    if (message.environment.NODE_EXTRA_CA_CERTS !== undefined && baseCertificates === undefined) {
      // Remove only the startup extras, preserving duplicates from bundled or system trust.
      const extras = [...NodeTls.getCACertificates("extra")];
      baseCertificates = NodeTls.getCACertificates("default").filter((certificate) => {
        const index = extras.indexOf(certificate);
        if (index === -1) return true;
        extras.splice(index, 1);
        return false;
      });
    }
    const pathBefore = environment.PATH;
    const unreadBefore = loginShellPathUnread(environment);
    applyShellEnvironment(environment, message.environment, platform);
    if (message.environment.NODE_EXTRA_CA_CERTS !== undefined) {
      yield* Effect.gen(function* () {
        const certificates = baseCertificates;
        // --use-openssl-ca roots are not enumerable; replacing the list would discard them.
        if (certificates === undefined || certificates.length === 0) {
          yield* Effect.logWarning(
            "Preserving non-enumerable TLS trust. Restart to apply updated desktop shell certificates.",
          );
          return;
        }
        const fs = yield* FileSystem.FileSystem;
        const file = message.environment.NODE_EXTRA_CA_CERTS;
        const bundle = file
          ? yield* Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* fs.open(file, { flag: "r" });
                const bytes = Option.getOrElse(
                  yield* handle.readAlloc(1024 * 1024 + 1),
                  () => new Uint8Array(),
                );
                if (bytes.length > 1024 * 1024)
                  return yield* new DesktopShellCertificatesUpdateFailed({
                    cause: new Error("Certificate bundle exceeds 1 MiB"),
                  });
                return new TextDecoder().decode(bytes);
              }),
            )
          : undefined;
        yield* Effect.try({
          try: () => {
            const extras =
              bundle?.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
            if (bundle?.trim() && extras.length === 0) {
              throw new Error("No PEM certificates found.");
            }
            NodeTls.setDefaultCACertificates([...certificates, ...extras]);
          },
          catch: (cause) => new DesktopShellCertificatesUpdateFailed({ cause }),
        });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to update desktop shell TLS certificates.", Cause.fail(cause)),
        ),
      );
    }
    if (message.discovered) delete environment.GOAT_DESKTOP_SHELL_DISCOVERY_PENDING;
    // Windows keeps its existing behavior: statuses follow the periodic health check there.
    if (
      platform !== "win32" &&
      (environment.PATH !== pathBefore || loginShellPathUnread(environment) !== unreadBefore)
    )
      yield* onPathChanged;
  });
}
