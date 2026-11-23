import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  layerResolver,
  makeAgent,
  makeRegistry,
  registryUrl,
  settings,
} from "./AcpRegistrySupport.testkit.ts";

it.effect(
  "keeps no-install resolution stable and allocates temp only for an Antigravity launch",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-acp-catalog-temp-" });
      const registry = makeRegistry({
        ...makeAgent({
          binary: { "linux-x86_64": { archive: "https://registry.test/agent", cmd: "agent" } },
        }),
        id: "antigravity-acp",
      });
      yield* fs.makeDirectory(`${root}/acp-registry`, { recursive: true });
      yield* fs.writeFileString(`${root}/acp-registry/registry.json`, registry);
      const catalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: root,
        toolsDir: `${root}/tools`,
        runtimeTempDir: `${root}/runtime`,
        registryUrl,
      });
      const config = settings({ agentId: "antigravity-acp", commandPath: "/bin/sh" });
      const resolved = yield* catalog.resolve(
        config,
        "/workspace",
        { TMPDIR: "/tmp" },
        { allowInstall: false },
      );
      expect(resolved.spawn.env?.TMPDIR).toBe("/tmp");
      expect(yield* fs.exists(`${root}/runtime`)).toBe(false);
      const directory = yield* Effect.scoped(
        Effect.gen(function* () {
          const spawn = yield* catalog.prepareRuntimeSpawn(resolved);
          const directory = spawn.env?.TMPDIR ?? "";
          expect(directory.startsWith(`${root}/runtime/run-`)).toBe(true);
          expect(yield* fs.exists(directory)).toBe(true);
          return directory;
        }),
      );
      expect(yield* fs.exists(directory)).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("unexpected network request", { status: 500 }),
            ),
          ),
        ),
      ),
    ),
);
