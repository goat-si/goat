import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import { AcpRegistrySettings } from "../settings.ts";
import type * as AcpRegistrySupport from "./AcpRegistrySupport.ts";

export const registryUrl = "https://registry.test/registry.json";

export const archiveUrl = "https://registry.test/example-agent.bin";

export const decodeAcpRegistrySettings = Schema.decodeSync(AcpRegistrySettings);

export const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export function makeAgent(
  distribution: AcpRegistrySupport.AcpRegistryAgent["distribution"],
): AcpRegistrySupport.AcpRegistryAgent {
  return {
    id: "example-agent",
    name: "Example Agent",
    version: "1.2.3",
    description: "ACP Registry test agent",
    distribution,
  };
}

export function makeRegistry(agent: AcpRegistrySupport.AcpRegistryAgent): string {
  return JSON.stringify({ version: "1.0.0", agents: [agent] });
}

export function settings(input: Partial<AcpRegistrySettings> = {}): AcpRegistrySettings {
  return decodeAcpRegistrySettings({
    agentId: "example-agent",
    ...input,
  });
}

export function layerResolver(
  execute: Parameters<typeof HttpClient.make>[0],
  environment: NodeJS.ProcessEnv = process.env,
) {
  return Layer.mergeAll(
    NodeServices.layer,
    TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
    Layer.succeed(HostProcess.Platform, "linux"),
    Layer.succeed(HostProcess.Architecture, "x64"),
    Layer.succeed(HostProcess.Environment, environment),
    Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute)),
  );
}

export const makeFakeNpmToolchain = Effect.fn("AcpRegistrySupport.test.makeFakeNpmToolchain")(
  function* (rootDirectory: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const toolchainBin = path.join(rootDirectory, "fake-node", "bin");
    const globalPrefix = path.join(rootDirectory, "tools", "example-agent", "1.2.3", "npm");
    const globalBin = path.join(globalPrefix, "bin");
    const executablePath = path.join(globalBin, "example-agent");
    const npmPath = path.join(toolchainBin, "npm");
    const logPath = path.join(rootDirectory, "npm.log");
    yield* fileSystem.makeDirectory(toolchainBin, { recursive: true });
    yield* fileSystem.makeDirectory(globalPrefix, { recursive: true });
    yield* fileSystem.writeFileString(logPath, "");
    yield* fileSystem.copyFile(
      yield* path.fromFileUrl(
        new URL("./testing/AcpRegistrySupport.npm.fixture.sh", import.meta.url),
      ),
      npmPath,
    );
    yield* fileSystem.chmod(npmPath, 0o755);
    return {
      environment: {
        ...process.env,
        PATH: `${toolchainBin}:${process.env.PATH ?? ""}`,
        FAKE_NPM_LOG: logPath,
        FAKE_NPM_PREFIX: path.join(rootDirectory, "external-npm-global"),
        FAKE_NPM_MANIFEST: encodeUnknownJson({
          name: "@example/acp",
          version: "1.2.3",
          bin: { "example-agent": "dist/cli.js" },
        }),
      } satisfies NodeJS.ProcessEnv,
      executablePath,
      globalBin,
      logPath,
      npmPath,
    };
  },
);

export const makeFakeUvToolchain = Effect.fn("AcpRegistrySupport.test.makeFakeUvToolchain")(
  function* (rootDirectory: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const toolchainBin = path.join(rootDirectory, "fake-uv", "bin");
    const globalBin = path.join(rootDirectory, "tools", "example-agent", "1.2.3", "python", "bin");
    const executablePath = path.join(globalBin, "fast-agent");
    const uvPath = path.join(toolchainBin, "uv");
    const logPath = path.join(rootDirectory, "uv.log");
    yield* fileSystem.makeDirectory(toolchainBin, { recursive: true });
    yield* fileSystem.writeFileString(logPath, "");
    yield* fileSystem.copyFile(
      yield* path.fromFileUrl(
        new URL("./testing/AcpRegistrySupport.uv.fixture.sh", import.meta.url),
      ),
      uvPath,
    );
    yield* fileSystem.chmod(uvPath, 0o755);
    return {
      environment: {
        ...process.env,
        PATH: `${toolchainBin}:${process.env.PATH ?? ""}`,
        FAKE_UV_LOG: logPath,
        FAKE_UV_BIN: path.join(rootDirectory, "external-uv-bin"),
        FAKE_UV_EXECUTABLE: executablePath,
      } satisfies NodeJS.ProcessEnv,
      executablePath,
      globalBin,
      logPath,
      uvPath,
    };
  },
);
