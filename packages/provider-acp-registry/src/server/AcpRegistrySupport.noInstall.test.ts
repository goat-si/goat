import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  layerResolver,
  makeAgent,
  makeFakeNpmToolchain,
  makeFakeUvToolchain,
  makeRegistry,
  registryUrl,
  settings,
} from "./AcpRegistrySupport.testkit.ts";
const registry = makeRegistry(makeAgent({ npx: { package: "@example/acp@1.2.3" } }));
const layer = layerResolver((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response(registry))),
);

it.live("does not run uv or install an unprepared ACP package during a probe", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-acp-no-uv-install-" });
      const uvRegistry = makeRegistry(makeAgent({ uvx: { package: "example-acp==1.2.3" } }));
      yield* fs.makeDirectory(`${cacheDir}/acp-registry`, { recursive: true });
      yield* fs.writeFileString(`${cacheDir}/acp-registry/registry.json`, uvRegistry);
      const toolchain = yield* makeFakeUvToolchain(cacheDir);
      const catalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const error = yield* catalog
        .resolve(settings(), "/workspace", toolchain.environment, { allowInstall: false })
        .pipe(Effect.flip);
      expect(error.reason).toBe("runner_unavailable");
      expect(yield* fs.readFileString(toolchain.logPath)).toBe("");
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("does not download a missing binary when resolving it for a probe", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-acp-no-binary-install-" });
      const binaryRegistry = makeRegistry(
        makeAgent({
          binary: { "linux-x86_64": { archive: "https://registry.test/agent.bin", cmd: "agent" } },
        }),
      );
      yield* fs.makeDirectory(`${cacheDir}/acp-registry`, { recursive: true });
      yield* fs.writeFileString(`${cacheDir}/acp-registry/registry.json`, binaryRegistry);
      let networkCalls = 0;
      const testLayer = layerResolver((request) => {
        networkCalls++;
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(binaryRegistry)));
      });
      const result = yield* Effect.gen(function* () {
        const catalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        });
        return yield* catalog
          .resolve(settings(), "/workspace", {}, { allowInstall: false })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(testLayer));
      expect(result.reason).toBe("runner_unavailable");
      expect(networkCalls).toBe(0);
    }).pipe(Effect.provide(layer)),
  ),
);

it.live("resolves prepared ACP packages for probes without installing missing ones", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-acp-no-install-" });
      yield* fs.makeDirectory(`${cacheDir}/acp-registry`, { recursive: true });
      yield* fs.writeFileString(`${cacheDir}/acp-registry/registry.json`, registry);
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const catalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      expect((yield* catalog.inspect(settings(), toolchain.environment)).status).toBe("unprepared");
      const absent = yield* catalog
        .resolve(settings(), "/workspace", toolchain.environment, { allowInstall: false })
        .pipe(Effect.flip);
      expect(absent.reason).toBe("runner_unavailable");
      expect(yield* fs.readFileString(toolchain.logPath)).toBe("");
      const installed = yield* catalog.resolve(settings(), "/workspace", toolchain.environment);
      expect((yield* catalog.inspect(settings(), toolchain.environment)).status).toBe("ready");
      const log = yield* fs.readFileString(toolchain.logPath);
      expect(log).toContain("install");
      const probed = yield* catalog.resolve(settings(), "/workspace", toolchain.environment, {
        allowInstall: false,
      });
      expect(probed.spawn.command).toBe(installed.spawn.command);
      expect(yield* fs.readFileString(toolchain.logPath)).toBe(log);
    }).pipe(Effect.provide(layer)),
  ),
);
