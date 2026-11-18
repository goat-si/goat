import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  normalizeCommandPath,
  type PackageManagedProviderMaintenanceDefinition,
  resolvePackageManagedProviderMaintenance,
} from "./maintenanceResolver.ts";

const driver = (value: string) => ProviderDriverKind.make(value);
const isNativeTestCommandPath =
  (expectedPathSegment: string) =>
  (commandPath: string): boolean =>
    normalizeCommandPath(commandPath).includes(expectedPathSegment);
const noSpawn = lazyChildProcessSpawner(() =>
  Effect.die(new Error("Nix store installs resolve without spawning a probe")),
);
const claudeUpdate = {
  provider: driver("claudeAgent"),
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isNativeTestCommandPath("/.local/bin/claude"),
  },
};
const otherProviderUpdate = {
  provider: driver("nativePackageTool"),
  npmPackageName: "@example/native-package-tool",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
  },
};
const resolveInstall = (input: {
  readonly definition: PackageManagedProviderMaintenanceDefinition;
  readonly resolved: string;
  readonly real: string;
}) =>
  resolvePackageManagedProviderMaintenance(input.definition, {
    binaryPath: "claude",
    resolvedCommandPath: input.resolved,
    realCommandPath: input.real,
    env: {},
    platform: "linux",
  }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
  );

it.layer(
  NodeServices.layer.pipe(Layer.merge(Layer.succeed(HostProcess.Environment, { PATH: "" }))),
)("providerMaintenance on Nix", (it) => {
  it.effect.each([
    {
      name: "a home-manager link in the native location",
      definition: claudeUpdate,
      resolved: "/home/me/.local/bin/claude",
      real: "/nix/store/0c2kbzqz3m0m4hcx2g7hq1n5wfs9a6xd-claude-code-with-bun/bin/claude",
    },
    {
      name: "another provider's profile link",
      definition: otherProviderUpdate,
      resolved: "/etc/profiles/per-user/me/bin/native-package-tool",
      real: "/nix/store/0c2kbzqz3m0m4hcx2g7hq1n5wfs9a6xd-native-package-tool-1.0.0/bin/native-package-tool",
    },
  ] as const)("keeps a Nix store install manual-only through $name", (fixture) =>
    Effect.gen(function* () {
      const capabilities = yield* resolveInstall(fixture);

      expect(capabilities.update).toBeNull();
    }),
  );
});
