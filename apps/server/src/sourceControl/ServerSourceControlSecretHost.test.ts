import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as SourceControlHost from "@goat/source-control-core/server/SourceControlHost";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const read = vi.hoisted(() => vi.fn(async () => "fixture"));
vi.mock("../secrets/secretResolver.ts", () => ({ cachedResolveSecret: read }));
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

it.effect("trusts the operator's Bitbucket API host and denies a caller's different host", () =>
  Effect.gen(function* () {
    const host = yield* SourceControlHost.SourceControlHost;
    const allowed = yield* host.settings.getWithSecrets("bitbucket", "api.internal");
    expect(allowed.sourceControlHosts.bitbucket?.accessToken).toBe("fixture");
    const error = yield* Effect.flip(host.settings.getWithSecrets("bitbucket", "evil.example"));
    expect(error.reason).toContain("saved bitbucket credentials are only used for");
    expect(error.reason).toContain("evil.example");
    expect(read).toHaveBeenCalledTimes(1);
  }).pipe(
    Effect.provide(
      ServerSourceControlHost.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              ServerSettings.ServerSettingsService,
              ServerSettings.ServerSettingsService.of({
                getSettings: Effect.succeed({
                  ...DEFAULT_SERVER_SETTINGS,
                  sourceControlHosts: {
                    bitbucket: { accessToken: { provider: "vault", reference: "op://v/i/f" } },
                  },
                }),
              } as never),
            ),
            Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
            Layer.mock(VcsProcess.VcsProcess)({}),
            ServerConfig.layerTest(process.cwd(), { prefix: "goat-secret-host-" }),
          ).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
    Effect.provideService(HostProcess.Environment, {
      GOAT_BITBUCKET_API_BASE_URL: "https://api.internal/2.0",
    }),
  ),
);
