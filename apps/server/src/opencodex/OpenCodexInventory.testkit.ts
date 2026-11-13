import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodePath from "@effect/platform-node/NodePath";
import * as HostProcess from "@goat/shared/HostProcess";
import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as HubLinkTraffic from "../hub/HubLinkTraffic.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Settings from "../serverSettings.ts";
import fleet from "./fixtures/fleet.json" with { type: "json" };
import * as Installation from "./OpenCodexInstallation.ts";
import * as Inventory from "./OpenCodexInventory.ts";

// Sanitized projections of the approved 2026-10-21 fleet observations (§1.2), in the
// CLI shapes from OpenCodex src/link/status-projection.ts and src/cli/status.ts.
// The design records no /readyz capture: its legacy empty features are a fixture assumption.
export const setup = Effect.fn("OpenCodexInventoryTest.setup")(function* (
  options: {
    fixture?: typeof fleet.home | undefined;
    files?: Record<string, string>;
    platform?: NodeJS.Platform;
    config?: unknown;
    binaries?: ReadonlyArray<{ path: string; output: string; code?: number }>;
    response?: ((url: string) => Response) | undefined;
    command?: ((input: ProcessRunner.ProcessRunInput) => Effect.Effect<string>) | undefined;
    versionProbe?: (input: ProcessRunner.ProcessRunInput) => Effect.Effect<string>;
    commandExitCode?: (input: ProcessRunner.ProcessRunInput) => number;
    home?: string;
    connect?: unknown;
    link?: unknown;
    service?: unknown;
    /** The one path the installer's marker vouches for; `managed` means the first candidate. */
    managedPath?: string;
    managed?: boolean;
    hostname?: string;
    crypto?: Crypto.Crypto;
    linkTraffic?: HubLinkTraffic.HubLinkTraffic["Service"];
  } = {},
) {
  const fixture = options.fixture;
  const root = options.home ?? "/fixture/.opencodex";
  const candidates =
    options.binaries ??
    (fixture ? [{ path: "/fixture/.opencodex-desktop/bin/ocx", output: fixture.version }] : []);
  const commands: Array<ProcessRunner.ProcessRunInput> = [];
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const reads: Array<string> = [];
  // @effect-diagnostics-next-line preferSchemaOverJson:off -- fixtures are printed as ocx prints them.
  const config = JSON.stringify(options.config ?? fixture?.config ?? {});
  const fs = FileSystem.makeNoop({
    stat: () =>
      Effect.succeed({
        type: "File",
        size: ByteSize.bytes(config.length),
        dev: 0n,
        mode: 0,
        mtime: Option.none(),
        atime: Option.none(),
        birthtime: Option.none(),
        ino: Option.none(),
        nlink: Option.none(),
        uid: Option.none(),
        gid: Option.none(),
        rdev: Option.none(),
        blksize: Option.none(),
        blocks: Option.none(),
      }),
    readFileString: (file) => {
      reads.push(file);
      return Effect.succeed(options.files?.[file] ?? config);
    },
    exists: (file) =>
      Effect.succeed(
        candidates.some((binary) => binary.path === file) ||
          (file === `${root}/link/home-codex-settings.json` &&
            fixture?.childSettingsApplied === true),
      ),
  });
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        commands.push(input);
        const binary = candidates.find((candidate) => candidate.path === input.command);
        const stdout =
          input.args[0] === "--version"
            ? options.versionProbe
              ? yield* options.versionProbe(input)
              : (binary?.output ?? "")
            : options.command
              ? yield* options.command(input)
              : // @effect-diagnostics-next-line preferSchemaOverJson:off -- as ocx prints it.
                (JSON.stringify(
                  input.args[0] === "provider"
                    ? { configured: [] }
                    : input.args[0] === "link"
                      ? (options.link ?? fixture?.link)
                      : input.args[0] === "connect"
                        ? (options.connect ?? fixture?.connect)
                        : input.args[0] === "service"
                          ? (options.service ?? fixture?.service)
                          : fixture?.status,
                ) ?? "");
        return {
          stdout,
          stderr: "",
          code: ChildProcessSpawner.ExitCode(
            input.args[0] === "--version"
              ? (binary?.code ?? 0)
              : (options.commandExitCode?.(input) ?? 0),
          ),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const fetcher: typeof fetch = (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    return Promise.resolve(
      options.response?.(url) ??
        new Response(JSON.stringify(url.endsWith("/healthz") ? fixture?.health : fixture?.ready), {
          status: fixture ? 200 : 404,
        }),
    );
  };
  const context = yield* Layer.build(
    Inventory.layer.pipe(
      Layer.provide(
        options.crypto ? Layer.succeed(Crypto.Crypto, options.crypto) : NodeCrypto.layer,
      ),
      Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
      Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
      Layer.provide(
        options.linkTraffic
          ? Layer.succeed(HubLinkTraffic.HubLinkTraffic, options.linkTraffic)
          : Layer.effect(
              HubLinkTraffic.HubLinkTraffic,
              HubLinkTraffic.make(Effect.sync((): ReadonlySet<string> | undefined => undefined)),
            ).pipe(Layer.provide(Settings.ServerSettingsService.layerTest())),
      ),
      Layer.provide(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetcher))),
      ),
      Layer.provide(NodePath.layerPosix),
      Layer.provide(Layer.succeed(HostProcess.HomeDirectory, "/fixture")),
      Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/fixture")),
      Layer.provide(Layer.succeed(HostProcess.Platform, options.platform ?? "darwin")),
      Layer.provide(Layer.succeed(HostProcess.Hostname, options.hostname ?? "fixture-home")),
      Layer.provide(
        Layer.succeed(HostProcess.Environment, {
          PATH: "/shim:/usr/bin",
          ...(options.home ? { OPENCODEX_HOME: options.home } : {}),
        }),
      ),
      Layer.provide(
        Layer.mock(Installation.OpenCodexInstallation)({
          inspect: (binary) =>
            Effect.succeed(
              binary === (options.managedPath ?? (options.managed ? candidates[0]?.path : "")),
            ),
        }),
      ),
    ),
  );
  return {
    inventory: Context.get(context, Inventory.OpenCodexInventory),
    commands,
    requests,
    reads,
  };
});
