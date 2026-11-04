import * as SourceControlHost from "@goat/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsError } from "@goat/contracts";
import { cachedResolveSecret } from "../secrets/secretResolver.ts";
import { resolveHostSecrets } from "./sourceControlHostSecrets.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export const layer = Layer.effect(
  SourceControlHost.SourceControlHost,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const { settingsPath } = yield* ServerConfig.ServerConfig;
    const process = yield* VcsProcess.VcsProcess;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
    return SourceControlHost.SourceControlHost.of({
      settings: {
        get: serverSettings.getSettings,
        getWithSecrets: (kind, host) =>
          serverSettings.getSettings.pipe(
            Effect.flatMap((settings) =>
              Effect.tryPromise({
                try: () =>
                  resolveHostSecrets(settings, kind, host, (reference) =>
                    cachedResolveSecret(settings.secretProviders, reference),
                  ),
                catch: () => new ServerSettingsError({ settingsPath, operation: "read-secret" }),
              }),
            ),
          ),
      },
      process: { run: process.run },
      git: {
        execute: git.execute,
        resolveCommit: git.resolveCommit,
        remotes: (cwd) =>
          vcsRegistry.resolve({ cwd }).pipe(Effect.map((handle) => handle.driver.listRemotes(cwd))),
        readConfigValue: git.readConfigValue,
        resolvePrimaryRemoteName: git.resolvePrimaryRemoteName,
        ensureRemote: git.ensureRemote,
        listLocalBranchNames: git.listLocalBranchNames,
        fetchRemoteBranch: git.fetchRemoteBranch,
        fetchRemoteTrackingBranch: git.fetchRemoteTrackingBranch,
        setBranchUpstream: git.setBranchUpstream,
        createBranch: git.createBranch,
        writeConfigValue: git.writeConfigValue,
        switchRef: git.switchRef,
      },
    });
  }),
);
