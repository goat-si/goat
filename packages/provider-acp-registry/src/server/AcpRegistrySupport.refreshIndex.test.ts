import { describe, expect, it } from "@effect/vitest";
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

describe("AcpRegistrySupport index refresh", () => {
  it.effect("refreshes stale disk indexes with max-age, offline backoff, and invalidation", () => {
    const v1 = makeAgent({ npx: { package: "example-agent@1.0.0" } });
    const v2 = {
      ...makeAgent({ npx: { package: "example-agent@2.0.0" } }),
      version: "2.0.0",
    };
    let currentAgent = v2;
    let failNetwork = false;
    let requests = 0;

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-acp-registry-refresh-index-",
      });
      yield* fileSystem.makeDirectory(`${cacheDir}/acp-registry`, { recursive: true });
      yield* fileSystem.writeFileString(`${cacheDir}/acp-registry/registry.json`, makeRegistry(v1));

      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });

      expect(yield* resolver.inspect(settings())).toMatchObject({
        status: "unprepared",
        version: "1.2.3",
      });
      expect(requests).toBe(0);

      // Cold disk cache has no network timestamp, so refreshIndex fetches v2.
      expect(yield* resolver.refreshIndex({ maxAgeMs: 60_000, failureBackoffMs: 10_000 })).toBe(
        true,
      );
      expect(requests).toBe(1);
      expect(yield* resolver.inspect(settings())).toMatchObject({
        status: "unprepared",
        version: "2.0.0",
      });

      // Within maxAgeMs, no network call happens.
      expect(yield* resolver.refreshIndex({ maxAgeMs: 60_000, failureBackoffMs: 10_000 })).toBe(
        false,
      );
      expect(requests).toBe(1);

      // After invalidateIndex, an offline failure preserves in-memory v2 and backs off.
      yield* resolver.invalidateIndex();
      failNetwork = true;
      expect(yield* resolver.refreshIndex({ maxAgeMs: 60_000, failureBackoffMs: 10_000 })).toBe(
        false,
      );
      expect(requests).toBe(2);
      expect(yield* resolver.inspect(settings())).toMatchObject({
        status: "unprepared",
        version: "2.0.0",
      });

      // Within failureBackoffMs, repeated background refreshes do not hammer the network.
      expect(yield* resolver.refreshIndex({ maxAgeMs: 60_000, failureBackoffMs: 10_000 })).toBe(
        false,
      );
      expect(requests).toBe(2);

      // Explicit invalidateIndex clears backoff so the next refresh retries immediately.
      failNetwork = false;
      currentAgent = {
        ...makeAgent({ npx: { package: "example-agent@2.0.0", args: ["--flag"] } }),
        version: "2.0.0",
      };
      yield* resolver.invalidateIndex();
      expect(yield* resolver.refreshIndex({ maxAgeMs: 60_000, failureBackoffMs: 10_000 })).toBe(
        true,
      );
      expect(requests).toBe(3);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          if (failNetwork) {
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(makeRegistry(currentAgent))),
          );
        }),
      ),
    );
  });
});
