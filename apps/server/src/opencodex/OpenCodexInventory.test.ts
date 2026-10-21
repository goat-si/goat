import { expect, it } from "@effect/vitest";
import { OpenCodexInventorySnapshot } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodePath from "@effect/platform-node/NodePath";
import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as Inventory from "./OpenCodexInventory.ts";
import parityFixture from "../hub/fixtures/parity.json" with { type: "json" };
import fleet from "./fixtures/fleet.json" with { type: "json" };

const decodeSnapshot = Schema.decodeUnknownEffect(OpenCodexInventorySnapshot);

// Sanitized projections of the approved 2026-10-21 fleet observations (§1.2), in the
// CLI shapes from OpenCodex src/link/status-projection.ts and src/cli/status.ts.
// The design records no /readyz capture: its legacy empty features are a fixture assumption.
const setup = Effect.fn("OpenCodexInventoryTest.setup")(function* (
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
    managed?: boolean;
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
              : (JSON.stringify(
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
      Layer.provide(NodeCrypto.layer),
      Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
      Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
      Layer.provide(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetcher))),
      ),
      Layer.provide(NodePath.layerPosix),
      Layer.provide(Layer.succeed(HostProcess.HomeDirectory, "/fixture")),
      Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/fixture")),
      Layer.provide(Layer.succeed(HostProcess.Platform, options.platform ?? "darwin")),
      Layer.provide(
        Layer.succeed(HostProcess.Environment, {
          PATH: "/shim:/usr/bin",
          ...(options.home ? { OPENCODEX_HOME: options.home } : {}),
        }),
      ),
      Layer.provide(Layer.succeed(Inventory.ManagedInstall, options.managed ?? false)),
    ),
  );
  return {
    inventory: Context.get(context, Inventory.OpenCodexInventory),
    commands,
    requests,
    reads,
  };
});

it.effect("Home 2.89.0 has no health role and reports all five Home-owned links", () =>
  Effect.gen(function* () {
    const { inventory, commands } = yield* setup({ fixture: fleet.home });
    const result = yield* inventory.read;
    expect(result.runtime).toMatchObject({
      version: "2.89.0",
      role: "standalone",
      healthy: true,
      ready: true,
    });
    expect(result.link).toMatchObject({ role: "home", childSettingsApplied: false });
    expect(result.link.links.map(({ id, alias, tunnelPort }) => [id, alias, tunnelPort])).toEqual([
      ["lnk_51d15fa48b90b40e", "macmini-ts", 54958],
      ["lnk_107d479405ab56be", "lidge-ts", 42255],
      ["lnk_781ccea3cdb84745", "mac-studio", 54365],
      ["lnk_ac30f40bb6167a49", "mini", 52889],
      ["lnk_9cd79877777a0603", "clisu-oracle", 40847],
    ]);
    expect(result.ownership).toBe("adopted");
    expect(result.service.available).toBe(false);
    expect(commands.map((call) => call.args.join(" "))).toEqual([
      "--version",
      "status --json",
      "link status --json",
      "connect status --json",
      "service status --json",
    ]);
    expect(yield* decodeSnapshot(result)).toEqual(result);
  }),
);

it.effect.each(["macmini-ts", "lidge-ts", "mac-studio"] as const)(
  "%s is a Child even without a local link directory",
  (name) =>
    Effect.gen(function* () {
      const { inventory, reads } = yield* setup({ fixture: fleet[name] });
      const result = yield* inventory.read;
      expect(result.link).toMatchObject({
        role: "child",
        links: [],
        childSettingsApplied: name === "mac-studio",
      });
      expect(result.runtime.version).toBe(name === "mac-studio" ? "2.86.0" : "2.83.0");
      expect(reads).toEqual(["/fixture/.opencodex/config.json"]);
    }),
);

it.effect("missing OpenCodex and a missing Windows binary report none", () =>
  Effect.gen(function* () {
    for (const platform of ["darwin", "win32"] as const) {
      const { inventory, commands } = yield* setup({ platform });
      expect(yield* inventory.read).toMatchObject({
        installed: false,
        binaries: [],
        ownership: "none",
        runtime: { healthy: false },
        link: { role: "none" },
      });
      expect(commands).toEqual([]);
    }
  }),
);

it.effect("Windows unsupported link status preserves a running Hub client", () =>
  Effect.gen(function* () {
    const { inventory } = yield* setup({
      fixture: fleet["mac-studio"],
      platform: "win32",
      config: { port: 10100, runtimeRole: "client", client: { transport: "https" } },
      connect: {
        state: "connected",
        apiKeyId: "fixture-key-id",
        protocolVersion: 1,
        token: "owned",
        secret: "fixture-secret",
      },
      command: (input) =>
        Effect.succeed(
          input.args[0] === "link"
            ? JSON.stringify({ error: "remote_platform_unsupported" })
            : input.args[0] === "connect"
              ? JSON.stringify({
                  state: "connected",
                  apiKeyId: "fixture-key-id",
                  protocolVersion: 1,
                  secret: "fixture-secret",
                })
              : "{}",
        ),
      commandExitCode: (input) => (input.args[0] === "link" ? 125 : 0),
    });
    const result = yield* inventory.read;
    expect(result).toMatchObject({
      installed: true,
      link: { role: "none", available: false, links: [] },
      hubClient: { state: "connected", apiKeyId: "fixture-key-id", protocolVersion: 1 },
    });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  }),
);

it.effect("Windows discovers an ocx command shim in the fallback binary directories", () =>
  Effect.gen(function* () {
    const { inventory, commands } = yield* setup({
      platform: "win32",
      binaries: [{ path: "/fixture/.bun/bin/ocx.cmd", output: "2.89.0" }],
    });
    expect((yield* inventory.read).binaries).toEqual([
      { path: "/fixture/.bun/bin/ocx.cmd", version: "2.89.0" },
    ]);
    expect(commands[0]?.args).toEqual(["--version"]);
  }),
);

it.effect("Desktop and system binaries precede PATH shims; broken candidates are skipped", () =>
  Effect.gen(function* () {
    const { inventory, commands } = yield* setup({
      fixture: fleet.home,
      binaries: [
        { path: "/fixture/.opencodex-desktop/bin/ocx", output: "", code: 1 },
        { path: "/Applications/OpenCodex.app/Contents/MacOS/ocx", output: "ocx 2.89.0" },
        { path: "/usr/bin/ocx", output: "2.83.0" },
        { path: "/shim/ocx", output: "2.50.0" },
      ],
    });
    const result = yield* inventory.read;
    expect(result.binaries.map((binary) => binary.version)).toEqual(["2.89.0", "2.83.0", "2.50.0"]);
    expect(
      commands
        .filter((call) => call.args[0] !== "--version")
        .every((call) => call.command === "/Applications/OpenCodex.app/Contents/MacOS/ocx"),
    ).toBe(true);
  }),
);

it.effect(
  "configured home and port never turn config hostnames or redirects into remote probes",
  () =>
    Effect.gen(function* () {
      const { inventory, requests, reads } = yield* setup({
        home: "/sandbox/ocx",
        config: { port: 11200, hostname: "outside.example" },
        response: () =>
          new Response("", {
            status: 302,
            headers: { location: "https://outside.example/secret" },
          }),
      });
      expect(yield* inventory.read).toMatchObject({
        installed: false,
        runtime: { port: 11200, healthy: false, ready: false },
      });
      expect(reads).toEqual(["/sandbox/ocx/config.json"]);
      expect(requests.map(({ url }) => url)).toEqual([
        "http://127.0.0.1:11200/healthz",
        "http://127.0.0.1:11200/readyz",
      ]);
      expect(
        requests.every(({ init }) => init?.redirect === "manual" && init.credentials === "omit"),
      ).toBe(true);
    }),
);

it.effect("foreign, malformed and oversized responses cannot identify an installation", () =>
  Effect.gen(function* () {
    for (const body of [
      '{"service":"other","version":"2.89.0"}',
      "not json",
      "x".repeat(256 * 1024 + 1),
    ]) {
      const { inventory } = yield* setup({ response: () => new Response(body) });
      expect((yield* inventory.read).installed).toBe(false);
    }
  }),
);

it.effect(
  "cache shares in-flight collection, expires under TestClock, and commands have bounded output/time",
  () =>
    Effect.gen(function* () {
      const { inventory, commands, requests } = yield* setup({
        fixture: fleet.home,
        managed: true,
      });
      const [first, second] = yield* Effect.all([inventory.read, inventory.read], {
        concurrency: 2,
      });
      expect(first).toEqual(second);
      expect(first.ownership).toBe("managed");
      expect(commands).toHaveLength(5);
      expect(requests).toHaveLength(2);
      expect(
        commands.every(
          (call) => call.timeout === "3 seconds" && call.maxOutputBytes === 256 * 1024,
        ),
      ).toBe(true);
      yield* TestClock.adjust("31 seconds");
      yield* inventory.read;
      expect(commands).toHaveLength(10);
    }),
);

it.effect("a stuck CLI is bounded without erasing directly observed runtime health", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const { inventory } = yield* setup({
      fixture: fleet.home,
      command: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const fiber = yield* inventory.read.pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("3 seconds");
    expect((yield* Fiber.join(fiber)).runtime.healthy).toBe(true);
  }),
);

it.effect("a hanging PATH shim cannot hide a verified Desktop binary", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const { inventory } = yield* setup({
      fixture: fleet.home,
      binaries: [
        { path: "/fixture/.opencodex-desktop/bin/ocx", output: "2.89.0" },
        { path: "/shim/ocx", output: "" },
      ],
      versionProbe: (input) =>
        input.command === "/shim/ocx"
          ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed("2.89.0"),
    });
    const fiber = yield* inventory.read.pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("3 seconds");
    const result = yield* Fiber.join(fiber);
    expect(result.binaries).toEqual([
      { path: "/fixture/.opencodex-desktop/bin/ocx", version: "2.89.0" },
    ]);
    expect(result.link.links).toHaveLength(5);
  }),
);

it.effect(
  "parity makes one non-billed models GET, hashes catalog and the actual P6 record, and observes health role/start",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(100_000);
      const home = yield* setup({
        fixture: fleet.home,
        response: (url) =>
          new Response(
            JSON.stringify(
              url.endsWith("/v1/models")
                ? { data: [{ id: "b" }, { id: "a" }] }
                : url.endsWith("/healthz")
                  ? { ...fleet.home.health, uptime: 10, instanceId: "fixture-home-instance" }
                  : fleet.home.ready,
            ),
          ),
      });
      const child = yield* setup({
        fixture: fleet["mac-studio"],
        config: {
          ...fleet["mac-studio"].config,
          client: { transport: "link", link: { linkId: parityFixture.settingsRecord.linkId } },
        },
        files: {
          "/fixture/.opencodex/link/home-codex-settings.json": JSON.stringify(
            parityFixture.settingsRecord,
          ),
        },
        response: (url) =>
          new Response(
            JSON.stringify(
              url.endsWith("/v1/models")
                ? { data: [{ id: "a" }, { id: "b" }], apiKey: "fixture-private" }
                : url.endsWith("/healthz")
                  ? { ...fleet["mac-studio"].health, uptime: 10 }
                  : fleet["mac-studio"].ready,
            ),
            {
              headers: { "x-opencodex-served-by": "fixture-home-instance" },
            },
          ),
      });
      const expected = yield* home.inventory.readParity;
      const result = yield* child.inventory.readParity;
      expect(result.parityEvidence).toMatchObject({
        healthRole: "client",
        observedAt: 100_000,
        startedAt: 90_000,
        childLinkId: parityFixture.settingsRecord.linkId,
        settingsLinkId: parityFixture.settingsRecord.linkId,
        modelsStatus: 200,
        servedBy: "fixture-home-instance",
        localProviderCount: 0,
      });
      expect(result.parityEvidence?.settingsDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.parityEvidence?.settingsDigest).toBe(expected.parityEvidence?.settingsDigest);
      expect(result.parityEvidence?.catalogDigest).toBe(expected.parityEvidence?.catalogDigest);
      expect(child.requests.filter(({ url }) => url.endsWith("/v1/models"))).toHaveLength(1);
      expect(child.reads).toContain("/fixture/.opencodex/link/home-codex-settings.json");
      expect(JSON.stringify(result)).not.toContain("fixture-private");
      expect(
        child.commands.every(({ args }) =>
          ["--version", "status", "link", "connect", "service", "provider"].includes(args[0]!),
        ),
      ).toBe(true);
      expect(yield* decodeSnapshot(result)).toEqual(result);
    }),
);

it.effect(
  "parity rejects wrong health role, malformed settings, redirects and foreign model bodies without inferring success",
  () =>
    Effect.gen(function* () {
      const { inventory, requests } = yield* setup({
        fixture: fleet["mac-studio"],
        response: (url) =>
          new Response(
            JSON.stringify(
              url.endsWith("/healthz")
                ? { service: "other", role: "client" }
                : url.endsWith("/v1/models")
                  ? { data: "not-models" }
                  : fleet["mac-studio"].ready,
            ),
          ),
      });
      const result = yield* inventory.readParity;
      expect(result.runtime.healthy).toBe(false);
      expect(result.parityEvidence?.healthRole).toBeUndefined();
      expect(result.parityEvidence?.settingsDigest).toBeUndefined();
      expect(result.parityEvidence?.catalogDigest).toBeUndefined();
      expect(requests.filter(({ url }) => url.endsWith("/v1/models"))).toHaveLength(1);
    }),
);

it.effect.each(["missing Home", "invalid timestamp", "unknown document field"])(
  "parity rejects a settings record with %s",
  (scenario) =>
    Effect.gen(function* () {
      const original = parityFixture.settingsRecord;
      const record =
        scenario === "missing Home"
          ? { ...original, document: { version: 1, settings: original.document.settings } }
          : scenario === "invalid timestamp"
            ? { ...original, fetchedAt: "not-a-time" }
            : { ...original, document: { ...original.document, unsupported: true } };
      const { inventory } = yield* setup({
        fixture: fleet["mac-studio"],
        files: { "/fixture/.opencodex/link/home-codex-settings.json": JSON.stringify(record) },
      });
      expect((yield* inventory.readParity).parityEvidence?.settingsDigest).toBeUndefined();
    }),
);

it.effect(
  "unknown optional uptime and apply metadata skip freshness without erasing core health/link evidence",
  () =>
    Effect.gen(function* () {
      const { inventory } = yield* setup({
        fixture: fleet.home,
        link: {
          ...fleet.home.link,
          links: fleet.home.link.links.map((link) => ({ ...link, lastApplyAt: "unknown" })),
        },
        response: (url) =>
          new Response(
            JSON.stringify(
              url.endsWith("/healthz") ? { ...fleet.home.health, uptime: null } : fleet.home.ready,
            ),
          ),
      });
      const snapshot = yield* inventory.readParity;
      expect(snapshot.runtime.healthy).toBe(true);
      expect(snapshot.link.links).toHaveLength(5);
      expect(snapshot.link.links.every(({ lastApplyAt }) => lastApplyAt === undefined)).toBe(true);
      expect(snapshot.parityEvidence?.startedAt).toBeUndefined();
    }),
);

it.effect.each(["configured", "active", "inactive"])(
  "P8 distinguishes %s providers from proven active leakage",
  (state) =>
    Effect.gen(function* () {
      const { inventory } = yield* setup({
        fixture: fleet["mac-studio"],
        command: (input) =>
          Effect.succeed(
            JSON.stringify(
              input.args[0] === "provider"
                ? {
                    configured: [
                      {
                        name: "fixture-provider",
                        ...(state === "configured" ? {} : { active: state === "active" }),
                      },
                    ],
                  }
                : input.args[0] === "link"
                  ? fleet["mac-studio"].link
                  : fleet["mac-studio"].status,
            ),
          ),
      });
      expect((yield* inventory.readParity).parityEvidence?.localProviderCount).toBe(
        state === "configured" ? undefined : state === "active" ? 1 : 0,
      );
    }),
);
