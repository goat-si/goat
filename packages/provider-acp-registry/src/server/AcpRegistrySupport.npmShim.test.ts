import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  layerResolver,
  makeAgent,
  makeFakeNpmToolchain,
  makeRegistry,
  registryUrl,
  settings,
} from "./AcpRegistrySupport.testkit.ts";

describe("AcpRegistrySupport npm shim handling", () => {
  it.effect("installs into its managed prefix with an npm that ignores npm_config_prefix", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-acp-registry-npm-shim-prefix-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const environment = { ...toolchain.environment, FAKE_NPM_IGNORE_PREFIX_ENV: "1" };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, environment));

      const resolved = yield* resolver.resolve(settings(), "/workspace", environment);

      expect(resolved.spawn.command).toBe(toolchain.executablePath);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("names the npm shim when npm cannot install into the managed prefix", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-acp-registry-npm-shim-no-prefix-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const environment = { ...toolchain.environment, FAKE_NPM_IGNORE_PREFIX: "1" };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, environment));

      const error = yield* resolver
        .resolve(settings(), "/workspace", environment)
        .pipe(Effect.flip);

      expect(error.message).toContain("shim");
      const npmCommands = yield* fileSystem.readFileString(toolchain.logPath);
      expect(npmCommands).not.toMatch(/^install /mu);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });
});
