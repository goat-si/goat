import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { AcpRegistrySettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";

const decodeAcpRegistrySettings = Schema.decodeSync(AcpRegistrySettings);
const registryUrl = "https://registry.example.test/registry.json";

const settings = (overrides?: Partial<AcpRegistrySettings>) =>
  decodeAcpRegistrySettings({ agentId: "example-agent", ...overrides });

const makeAgent = (distribution: Record<string, unknown>) => ({
  id: "example-agent",
  name: "Example Agent",
  version: "1.2.3",
  description: "Example ACP agent",
  distribution,
});

const makeRegistry = (...agents: ReadonlyArray<Record<string, unknown>>) =>
  JSON.stringify({ version: "1.0.0", agents });

const layerResolver = (
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) =>
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    Layer.succeed(HttpClient.HttpClient, HttpClient.make(handler)),
    Layer.succeed(HostProcess.Platform, "linux"),
    Layer.succeed(HostProcess.Architecture, "x64"),
    Layer.succeed(HostProcess.Environment, { PATH: "/usr/bin" }),
    Layer.succeed(ProviderHost.ProviderHost, {
      compatibility: { minimumVersion: () => undefined },
      paths: {
        baseDir: "/tmp/goat-acp-test",
        stateDir: "/tmp/goat-acp-test/state",
        attachmentsDir: "/tmp/goat-acp-test/attachments",
        providerStatusCacheDir: "/tmp/goat-acp-test/cache",
        cwd: "/workspace",
      },
      settings: {
        get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
        changes: undefined as never,
        subscribe: undefined as never,
      },
      shouldRunBackgroundWork: () => Effect.succeed(false),
      resolveAttachmentPath: () => null,
      resolveExtractedTextPath: () => null,
    }),
  );

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
        status: "ready",
        version: "1.2.3",
      });
      expect(requests).toBe(0);

      // Cold disk cache has no network timestamp, so refreshIndex fetches v2.
      expect(yield* resolver.refreshIndex({ maxAgeMs: 60_000, failureBackoffMs: 10_000 })).toBe(
        true,
      );
      expect(requests).toBe(1);
      expect(yield* resolver.inspect(settings())).toMatchObject({
        status: "ready",
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
        status: "ready",
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
