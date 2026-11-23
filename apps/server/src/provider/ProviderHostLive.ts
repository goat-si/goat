import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { ProviderCredentialError } from "@goat/provider-core/server/errors";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DocumentText from "./DocumentText.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { resolveProviderCompatibility } from "./providerCompatibility.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";

export const layer = Layer.effect(
  ProviderHost.ProviderHost,
  Effect.gen(function* () {
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const environmentId = yield* identity.getEnvironmentId;
    const config = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const digest = yield* Digest.Digest;
    const fileSystem = yield* FileSystem.FileSystem;
    const awaitServerReady = yield* ServerActivation;
    const manifest = yield* Effect.serviceOption(ModelManifest.ModelManifest);
    const portDiscovery = yield* Effect.serviceOption(PortScanner.PortDiscovery);
    return ProviderHost.ProviderHost.of({
      ...(awaitServerReady === undefined ? {} : { awaitServerReady }),
      ...(Option.isSome(portDiscovery)
        ? { retainAgentPortDiscovery: portDiscovery.value.retainAgent }
        : {}),
      environmentId,
      compatibility: Effect.fn("ProviderHost.compatibility")((driver, version) =>
        (Option.isSome(manifest)
          ? manifest.value.current
          : Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST)
        ).pipe(
          Effect.map(
            (current) =>
              resolveProviderCompatibility(current.compatibility, driver, version) ??
              resolveProviderCompatibility(
                ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
                driver,
                version,
              ),
          ),
        ),
      ),
      paths: {
        cwd: config.cwd,
        baseDir: config.baseDir,
        stateDir: config.stateDir,
        providerStatusCacheDir: config.providerStatusCacheDir,
        attachmentsDir: config.attachmentsDir,
      },
      settings: {
        get: serverSettings.getSettings,
        withSnapshot: serverSettings.withSettingsSnapshot,
        changes: serverSettings.streamChanges,
        subscribe: serverSettings.subscribeChanges,
      },
      shouldRunBackgroundWork: backgroundPolicy.shouldRunScopeWork,
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
      // DocumentText owns the path-resolution span.
      resolveExtractedTextPath: Effect.fnUntraced(
        function* (path) {
          return yield* DocumentText.resolveExtractedTextPath(path);
        },
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      ),
      credentials: Effect.fn("ProviderHost.credentials")(function (namespace, bindingId) {
        return ProviderCredentialStore.make(namespace, bindingId).pipe(
          Effect.map((store) => ({
            binding: store.binding,
            get: store.get.pipe(
              Effect.mapError((cause) => new ProviderCredentialError({ operation: "get", cause })),
            ),
            set: (credentials: Uint8Array) =>
              store
                .set(credentials)
                .pipe(
                  Effect.mapError(
                    (cause) => new ProviderCredentialError({ operation: "set", cause }),
                  ),
                ),
            remove: store.remove.pipe(
              Effect.mapError(
                (cause) => new ProviderCredentialError({ operation: "remove", cause }),
              ),
            ),
          })),
          Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
          Effect.provideService(Digest.Digest, digest),
        );
      }),
    });
  }),
);
