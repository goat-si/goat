import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  layerResolver,
  makeAgent,
  makeRegistry,
  registryUrl,
  settings,
} from "./AcpRegistrySupport.testkit.ts";

describe("AcpRegistrySupport", () => {
  it.effect("keeps a prepared binary ready after the registry advances its version", () => {
    const makeBinaryAgent = (version: string) => ({
      ...makeAgent({
        binary: {
          "linux-x86_64": {
            archive: `https://registry.test/example-agent-${version}.bin`,
            cmd: "./bin/example-agent",
          },
        },
      }),
      version,
    });
    let agent = makeBinaryAgent("1.2.3");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-advance-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      yield* resolver.prepare({ agentId: agent.id });

      agent = makeBinaryAgent("1.2.4");
      yield* TestClock.adjust("6 minutes");
      yield* resolver.search({ query: "example" });

      expect(yield* resolver.inspect(settings())).toMatchObject({
        status: "ready",
        distribution: "binary",
      });
      const resolved = yield* resolver.resolve(settings(), "/workspace", {});
      expect(resolved.spawn.command).toContain(
        "/tools/example-agent/1.2.4/linux-x86_64/bin/example-agent",
      );
      expect(yield* fileSystem.readFileString(resolved.spawn.command)).toBe(
        "#!/bin/sh\necho 1.2.4\n",
      );

      expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toMatchObject({
        removed: true,
      });
      expect(yield* resolver.inspect(settings())).toMatchObject({ status: "unprepared" });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                request.url === registryUrl
                  ? makeRegistry(agent)
                  : `#!/bin/sh\necho ${agent.version}\n`,
              ),
            ),
          ),
        ),
      ),
    );
  });

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "leaves the mode of a file outside the install root when the command links to it",
    () => {
      const downloadUrl = "https://registry.test/agent.tar.gz";
      const agent = makeAgent({
        binary: { "linux-x86_64": { archive: downloadUrl, cmd: "./agent" } },
      });
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-outside-link-",
        });
        const outsideFile = `${cacheDir}/outside`;
        yield* fileSystem.writeFileString(outsideFile, "private\n");
        yield* fileSystem.chmod(outsideFile, 0o600);
        const source = `${cacheDir}/source`;
        yield* fileSystem.makeDirectory(source);
        yield* fileSystem.symlink(outsideFile, `${source}/agent`);
        const archivePath = `${cacheDir}/agent.tar.gz`;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const tar = yield* spawner.spawn(
          ChildProcess.make("tar", ["-czf", archivePath, "-C", source, "agent"]),
        );
        expect(yield* tar.exitCode).toBe(0);
        const archive = yield* fileSystem.readFile(archivePath);
        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  request.url === registryUrl
                    ? new Response(makeRegistry(agent))
                    : new Response(archive),
                ),
              ),
            ),
          ),
        );

        const error = yield* resolver.prepare({ agentId: agent.id }).pipe(Effect.flip);

        expect(error.reason).toBe("archive_invalid");
        expect((yield* fileSystem.stat(outsideFile)).mode & 0o777).toBe(0o600);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            TestProviderHost.layer().pipe(
              Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
        ),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Architecture, "x64"),
      );
    },
  );
});
