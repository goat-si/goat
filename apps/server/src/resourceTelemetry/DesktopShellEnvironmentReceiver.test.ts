// @effect-diagnostics nodeBuiltinImport:off
import * as NodeTls from "node:tls";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";
import { makeApplyDesktopShellEnvironmentSnapshot } from "./DesktopShellEnvironmentReceiver.ts";

describe("desktop shell environment", () => {
  it.effect("reports a changed PATH or a finished discovery once, not on every snapshot", () =>
    Effect.gen(function* () {
      const environment: NodeJS.ProcessEnv = {
        PATH: "/old/bin",
        GOAT_DESKTOP_SHELL_DISCOVERY_PENDING: "1",
      };
      let reported = 0;
      const applySnapshot = makeApplyDesktopShellEnvironmentSnapshot(
        environment,
        "darwin",
        Effect.sync(() => {
          reported++;
        }),
      );
      const snapshot = (PATH: string, discovered: boolean) =>
        ({
          version: 1,
          type: "shellEnvironment",
          platform: "darwin",
          discovered,
          environment: { PATH },
        }) as const;
      yield* applySnapshot(snapshot("/old/bin", false));
      expect(reported).toBe(0);
      yield* applySnapshot(snapshot("/recovered/bin", false));
      yield* applySnapshot(snapshot("/recovered/bin", false));
      expect(reported).toBe(1);
      yield* applySnapshot(snapshot("/recovered/bin", true));
      yield* applySnapshot(snapshot("/recovered/bin", true));
      expect(reported).toBe(2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("updates live TLS trust when shell certificates arrive after startup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const certificatePath = path.join(directory, "extra-ca.pem");
      const original = NodeTls.getCACertificates("default");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeTls.setDefaultCACertificates(original)),
      );
      const baseline = NodeTls.rootCertificates[0]!;
      const extra = NodeTls.rootCertificates[1]!;
      const replacement = NodeTls.rootCertificates[2]!;
      NodeTls.setDefaultCACertificates([baseline]);
      yield* fs.writeFileString(certificatePath, `${extra}\n${replacement}`);
      const environment: NodeJS.ProcessEnv = { GOAT_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
      const applySnapshot = makeApplyDesktopShellEnvironmentSnapshot(environment, "darwin");
      const message = {
        version: 1,
        type: "shellEnvironment",
        platform: "darwin",
        discovered: true,
        environment: { NODE_EXTRA_CA_CERTS: certificatePath },
      } as const;
      const fingerprints = (certificates: ReadonlyArray<string>) =>
        certificates.map((pem) => new NodeCrypto.X509Certificate(pem).fingerprint256).sort();
      yield* applySnapshot({ ...message, platform: "win32" });
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(fingerprints([baseline]));
      expect(environment.GOAT_DESKTOP_SHELL_DISCOVERY_PENDING).toBe("1");
      yield* applySnapshot(message);
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(
        fingerprints([baseline, extra, replacement]),
      );
      expect(environment.NODE_EXTRA_CA_CERTS).toBe(certificatePath);
      expect(environment.GOAT_DESKTOP_SHELL_DISCOVERY_PENDING).toBeUndefined();

      yield* fs.writeFileString(certificatePath, replacement);
      yield* applySnapshot(message);
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(
        fingerprints([baseline, replacement]),
      );

      yield* fs.writeFileString(
        certificatePath,
        "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----",
      );
      yield* applySnapshot(message);
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(
        fingerprints([baseline, replacement]),
      );
      yield* fs.remove(certificatePath);
      const warnings: Array<Logger.Options<unknown>> = [];
      yield* applySnapshot(message).pipe(
        Effect.provide(
          Logger.layer([Logger.make((entry) => warnings.push(entry))], {
            mergeWithExisting: false,
          }),
        ),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toEqual(["Failed to update desktop shell TLS certificates."]);
      expect(Cause.squash(warnings[0]!.cause)).toMatchObject({ _tag: "PlatformError" });
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(
        fingerprints([baseline, replacement]),
      );

      yield* applySnapshot({ ...message, environment: { NODE_EXTRA_CA_CERTS: null } });
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(fingerprints([baseline]));
      expect(environment.NODE_EXTRA_CA_CERTS).toBeUndefined();

      NodeTls.setDefaultCACertificates([]);
      yield* fs.writeFileString(certificatePath, extra);
      const applyOpaqueTrust = makeApplyDesktopShellEnvironmentSnapshot(environment, "darwin");
      yield* applyOpaqueTrust(message);
      expect(NodeTls.getCACertificates("default")).toEqual([]);
      expect(environment.NODE_EXTRA_CA_CERTS).toBe(certificatePath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { platform: "darwin", discovered: true, applied: true, pending: false },
    { platform: "win32", discovered: true, applied: false, pending: true },
    { platform: "darwin", discovered: false, applied: true, pending: true },
  ])(
    "applies platform=$platform discovered=$discovered with pending=$pending",
    ({ platform, discovered, applied, pending }) =>
      Effect.gen(function* () {
        const environment: NodeJS.ProcessEnv = {
          PATH: "/old/bin",
          JAVA_HOME: "/old/java",
          UNRELATED: "keep",
          GOAT_DESKTOP_SHELL_DISCOVERY_PENDING: "1",
        };
        yield* makeApplyDesktopShellEnvironmentSnapshot(
          environment,
          "darwin",
        )({
          version: 1,
          type: "shellEnvironment",
          platform,
          discovered,
          environment: { PATH: "/fresh/bin", JAVA_HOME: null },
        });
        expect(environment).toEqual({
          PATH: applied ? "/fresh/bin" : "/old/bin",
          ...(applied ? {} : { JAVA_HOME: "/old/java" }),
          UNRELATED: "keep",
          ...(pending ? { GOAT_DESKTOP_SHELL_DISCOVERY_PENDING: "1" } : {}),
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
