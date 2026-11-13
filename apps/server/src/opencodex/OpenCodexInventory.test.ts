import { expect, it } from "@effect/vitest";
import { GoatHostStatusResult, OpenCodexInventorySnapshot } from "@goat/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as HubLinkTraffic from "../hub/HubLinkTraffic.ts";
import * as Settings from "../serverSettings.ts";
import parityFixture from "../hub/fixtures/parity.json" with { type: "json" };
import fleet from "./fixtures/fleet.json" with { type: "json" };
import { setup } from "./OpenCodexInventory.testkit.ts";

const decodeSnapshot = Schema.decodeUnknownEffect(OpenCodexInventorySnapshot);
const encodeHostStatus = Schema.encodeUnknownEffect(GoatHostStatusResult);
const isJson = Schema.is(Schema.Json);
const failingCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: () => Effect.fail(PlatformError.badArgument({ module: "Crypto", method: "digest" })),
});

it.effect("probes OpenCodex shims offline without mistaking a missing CLI for installed", () =>
  Effect.gen(function* () {
    let installAttempted = false;
    const { inventory, commands } = yield* setup({
      binaries: [{ path: "/shim/ocx", output: "mise ERROR not installed", code: 1 }],
      versionProbe: (input) =>
        Effect.sync(() => {
          if (input.env?.MISE_OFFLINE !== "1") installAttempted = true;
          return "mise ERROR not installed";
        }),
    });
    expect((yield* inventory.read).installed).toBe(false);
    expect(installAttempted).toBe(false);
    expect(commands[0]?.env?.MISE_OFFLINE).toBe("1");
  }),
);

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
      expect(reads).toEqual([
        "/fixture/.opencodex/config.json",
        "/fixture/.opencodex/link/home-codex-settings.json",
      ]);
    }),
);

it.effect("the Home names itself and a Child names its Home only from its own link's record", () =>
  Effect.gen(function* () {
    const home = yield* setup({ fixture: fleet.home, hostname: " jun-mbp\u0007 " });
    expect((yield* home.inventory.read).link.homeName).toBe("jun-mbp");

    const record = JSON.stringify(parityFixture.settingsRecord);
    const child = (linkId: string) =>
      setup({
        fixture: fleet["mac-studio"],
        config: { ...fleet["mac-studio"].config, client: { transport: "link", link: { linkId } } },
        files: { "/fixture/.opencodex/link/home-codex-settings.json": record },
      }).pipe(Effect.flatMap(({ inventory }) => inventory.read));
    const own = yield* child(parityFixture.settingsRecord.linkId);
    expect(own.link.homeName).toBe("fixture-home");
    expect(yield* decodeSnapshot(own)).toEqual(own);
    expect((yield* child("lnk_other")).link.homeName).toBeUndefined();
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
      binaries: [
        { path: "/fixture/.opencodex-desktop/bin/ocx.exe", output: fleet["mac-studio"].version },
      ],
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

it.effect("Windows discovers only ocx.exe, where OpenCodex's Remote Link looks for it", () =>
  Effect.gen(function* () {
    const { inventory, commands } = yield* setup({
      platform: "win32",
      binaries: [
        { path: "/fixture/.bun/bin/ocx.cmd", output: "2.88.0" },
        { path: "/fixture/.local/bin/ocx.exe", output: "2.89.0" },
      ],
    });
    expect((yield* inventory.read).binaries).toEqual([
      { path: "/fixture/.local/bin/ocx.exe", version: "2.89.0" },
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
          (call) => call.timeout === "10 seconds" && call.maxOutputBytes === 256 * 1024,
        ),
      ).toBe(true);
      yield* TestClock.adjust("31 seconds");
      yield* inventory.read;
      expect(commands).toHaveLength(10);
    }),
);

it.effect(
  "managed ownership follows the selected executable when another installation shadows it",
  () =>
    Effect.gen(function* () {
      const managedPath = "/fixture/.local/bin/ocx";
      const managed = { path: managedPath, output: "opencodex 2.92.0" };
      const alone = yield* setup({ fixture: fleet.home, binaries: [managed], managedPath });
      expect((yield* alone.inventory.read).ownership).toBe("managed");
      // A Desktop install wins the selection, so the install GOAT made is not the one in use.
      const shadowed = yield* setup({
        fixture: fleet.home,
        binaries: [{ path: "/fixture/.opencodex-desktop/bin/ocx", output: "2.91.0" }, managed],
        managedPath,
      });
      const snapshot = yield* shadowed.inventory.read;
      expect(snapshot.binaries.map((binary) => binary.path)).toEqual([
        "/fixture/.opencodex-desktop/bin/ocx",
        managedPath,
      ]);
      expect(snapshot.ownership).toBe("adopted");
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
    yield* TestClock.adjust("10 seconds");
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
    yield* TestClock.adjust("15 seconds");
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

it.effect("a digest that cannot be computed is omitted, so the snapshot stays JSON", () =>
  Effect.gen(function* () {
    const { inventory } = yield* setup({
      fixture: fleet["mac-studio"],
      crypto: failingCrypto,
      files: {
        "/fixture/.opencodex/link/home-codex-settings.json": JSON.stringify(
          parityFixture.settingsRecord,
        ),
      },
      response: (url) =>
        new Response(
          JSON.stringify(
            url.endsWith("/v1/models")
              ? { data: [{ id: "a" }] }
              : url.endsWith("/healthz")
                ? fleet["mac-studio"].health
                : fleet["mac-studio"].ready,
          ),
        ),
    });
    const evidence = (yield* inventory.readParity).parityEvidence;
    expect(evidence?.settingsLinkId).toBe(parityFixture.settingsRecord.linkId);
    expect(evidence?.modelsStatus).toBe(200);
    expect(Object.hasOwn(evidence ?? {}, "settingsDigest")).toBe(false);
    expect(Object.hasOwn(evidence ?? {}, "catalogDigest")).toBe(false);
    expect(isJson(evidence)).toBe(true);
  }),
);

it.effect(
  "null lastApplyAt from a home link is omitted, so host status can encode the snapshot",
  () =>
    Effect.gen(function* () {
      const { inventory } = yield* setup({
        fixture: fleet.home,
        link: {
          ...fleet.home.link,
          links: fleet.home.link.links.map((link) => ({ ...link, lastApplyAt: null })),
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
      expect(snapshot.link.links.every((link) => !("lastApplyAt" in link))).toBe(true);
      expect(snapshot.parityEvidence?.startedAt).toBeUndefined();
      yield* encodeHostStatus({
        hosts: [
          {
            host: null,
            reachability: "ok",
            metrics: {
              sampledAt: 1,
              cpuUtilization: 0,
              cpuCount: 1,
              availableMemoryBytes: 1,
              totalMemoryBytes: 1,
              loadAvg: { oneMinute: 0, fiveMinutes: 0, fifteenMinutes: 0 },
              disk: { path: "/", availableBytes: 1, totalBytes: 1 },
              threads: { running: 0, waiting: 0, queued: 0 },
              quotas: [],
              opencodex: snapshot,
            },
          },
        ],
      });
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

it.effect("a Child reads its own row of the Home's OCX-11 fallback view by link id", () =>
  Effect.gen(function* () {
    // The shape of OpenCodex buildFallbackState for a passive read through the link: no aliases.
    const view = (localFallback: boolean) => ({
      schema: "ocx.fallback/1",
      source: "home",
      global: { model: true, provider: true },
      providers: {},
      routes: {},
      devices: [
        {
          id: "lnk_51d15fa48b90b40e",
          kind: "link",
          localFallback: !localFallback,
          model: null,
          provider: null,
        },
        { id: "lnk_781ccea3cdb84745", kind: "link", localFallback, model: null, provider: false },
      ],
      last: null,
      recent: [],
    });
    const studio = (fallback: unknown) =>
      ({
        ...fleet["mac-studio"],
        status: {
          ...fleet["mac-studio"].status,
          remoteHub: { link: { linkId: "lnk_781ccea3cdb84745" } },
          ...(fallback === undefined ? {} : { fallback }),
        },
      }) as unknown as typeof fleet.home;
    const granted = yield* setup({ fixture: studio(view(true)) });
    expect((yield* granted.inventory.read).fallback).toEqual({
      source: "home",
      localFallback: true,
    });
    const denied = yield* setup({ fixture: studio(view(false)) });
    expect((yield* denied.inventory.read).fallback).toEqual({
      source: "home",
      localFallback: false,
    });
    // OpenCodex before OCX-11 says nothing, which GOAT treats as not allowed.
    const older = yield* setup({ fixture: studio(undefined) });
    expect((yield* older.inventory.read).fallback).toBeUndefined();
  }),
);

const noService = () => new Response("", { status: 404 });

it.effect("an ocx that takes four seconds per call is still read, as on a Cortex-A53 board", () =>
  Effect.gen(function* () {
    const slow = (value: unknown) =>
      Effect.sleep("4 seconds").pipe(Effect.as(JSON.stringify(value) ?? ""));
    const { inventory } = yield* setup({
      fixture: fleet.home,
      response: noService,
      versionProbe: () => Effect.sleep("4 seconds").pipe(Effect.as("opencodex 2.92.0")),
      command: (input) =>
        slow(
          input.args[0] === "link"
            ? fleet.home.link
            : input.args[0] === "status"
              ? fleet.home.status
              : null,
        ),
    });
    const fiber = yield* inventory.read.pipe(Effect.forkChild);
    yield* TestClock.adjust("20 seconds");
    const snapshot = yield* Fiber.join(fiber);
    expect(snapshot.installed).toBe(true);
    expect(snapshot.binaries).toEqual([
      { path: "/fixture/.opencodex-desktop/bin/ocx", version: "2.92.0" },
    ]);
    expect(snapshot.link.available).toBe(true);
    expect(snapshot.slow).toBeUndefined();
  }),
);

it.effect("an ocx that never answers is slow, not missing", () =>
  Effect.gen(function* () {
    const { inventory } = yield* setup({
      fixture: fleet.home,
      response: noService,
      versionProbe: () => Effect.never,
    });
    const fiber = yield* inventory.read.pipe(Effect.forkChild);
    yield* TestClock.adjust("20 seconds");
    const snapshot = yield* Fiber.join(fiber);
    expect(snapshot).toMatchObject({
      installed: false,
      ownership: "none",
      binaries: [],
      slow: true,
    });
  }),
);

it.effect("parity reads a settings record that carries OpenCodex's appliedAt", () =>
  Effect.gen(function* () {
    const read = (record: unknown) =>
      setup({
        fixture: fleet["mac-studio"],
        files: { "/fixture/.opencodex/link/home-codex-settings.json": JSON.stringify(record) },
      }).pipe(Effect.flatMap(({ inventory }) => inventory.readParity));
    const plain = yield* read(parityFixture.settingsRecord);
    const applied = yield* read({
      ...parityFixture.settingsRecord,
      appliedAt: "2026-11-03T23:10:26.422Z",
    });
    expect(applied.parityEvidence?.settingsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(applied.parityEvidence?.settingsDigest).toBe(plain.parityEvidence?.settingsDigest);
  }),
);

// The ?traffic=1, ?routes=1 and ?transport=1 row fields of OpenCodex src/link/status-projection.ts.
const trafficRow = (toHomeBytes: number) => ({
  id: "lnk_a",
  alias: "mac-ts",
  tunnelPort: 54001,
  direction: "hub-initiated",
  state: "connected",
  routes: [
    {
      name: "mac-ts",
      eligibleAt: "2026-11-13T00:05:00.000Z",
      lastOutcome: { class: "transient", at: "2026-11-13T00:00:00.000Z" },
    },
    { name: "pen-mac", eligibleAt: null, lastOutcome: null },
  ],
  route: { name: "pen-mac", index: 1, since: "2026-11-13T00:00:00.000Z" },
  routeBlocked: null,
  ws: { open: 0, upgrades: 0, refused: {}, closes: {}, holds: 0 },
  traffic: {
    since: "2026-11-13T00:00:00.000Z",
    epoch: "ab12cd34",
    generation: 3,
    requests: 9,
    incomplete: 0,
    toHomeBytes,
    fromHomeBytes: toHomeBytes / 10,
    toHomeSource: "content-length",
    toHomeUncounted: 0,
    untrackedRequests: 0,
  },
});

it.effect(
  "a Home's link traffic, route and WebSocket counters reach host status as relay bytes, a relay route and HTTP",
  () =>
    Effect.gen(function* () {
      const linkTraffic = yield* HubLinkTraffic.make(
        Effect.succeed(new Set(["pen-mac", "pen-old"])),
      ).pipe(Effect.provide(Settings.ServerSettingsService.layerTest()));
      const olderHomeRow = { id: "lnk_b", alias: "pen-old", tunnelPort: 54002, state: "connected" };
      const link = {
        role: "home",
        links: [trafficRow(1_000_000), { ...olderHomeRow, direction: "hub-initiated" }],
      };
      const { inventory } = yield* setup({ fixture: fleet.home, link, linkTraffic });
      yield* inventory.read;
      link.links[0] = trafficRow(6_001_000_000);
      yield* TestClock.adjust("4 minutes");
      const result = yield* inventory.read;
      expect(result.link.links[0]).toEqual({
        id: "lnk_a",
        alias: "mac-ts",
        direction: "hub-initiated",
        tunnelPort: 54001,
        state: "connected",
        route: { name: "pen-mac", via: "relay", since: Date.parse("2026-11-13T00:00:00.000Z") },
        transport: "http",
        traffic: {
          hour: {
            toHomeBytes: 6_000_000_000,
            fromHomeBytes: 600_000_000,
            relayToHomeBytes: 6_000_000_000,
            relayFromHomeBytes: 600_000_000,
            directToHomeBytes: 0,
            directFromHomeBytes: 0,
            measuredMs: 240_000,
            averagedMs: 0,
            uncountedRequests: 0,
          },
          day: {
            toHomeBytes: 6_000_000_000,
            fromHomeBytes: 600_000_000,
            relayToHomeBytes: 6_000_000_000,
            relayFromHomeBytes: 600_000_000,
            directToHomeBytes: 0,
            directFromHomeBytes: 0,
            measuredMs: 240_000,
            averagedMs: 0,
            uncountedRequests: 0,
          },
          warning: { thresholdBytes: 5_000_000_000 },
        },
      });
      // An older Home reports no counters: its one-route link uses its alias, and nothing is measured.
      expect(result.link.links[1]).toEqual({
        ...olderHomeRow,
        direction: "hub-initiated",
        route: { name: "pen-old", via: "relay" },
      });
      expect(result.link.relayWarning).toBeUndefined();
      expect(yield* decodeSnapshot(result)).toEqual(result);
    }),
);

it.effect(
  "a relay warning outlives the Home's last link, which OpenCodex then reports as standalone",
  () =>
    Effect.gen(function* () {
      const linkTraffic = yield* HubLinkTraffic.make(Effect.succeed(new Set(["pen-mac"]))).pipe(
        Effect.provide(Settings.ServerSettingsService.layerTest()),
      );
      const link: { role: string; links: Array<unknown> } = {
        role: "home",
        links: [trafficRow(0)],
      };
      const { inventory } = yield* setup({ fixture: fleet.home, link, linkTraffic });
      yield* inventory.read;
      link.links[0] = trafficRow(30_000_000_000);
      yield* TestClock.adjust("10 minutes");
      expect((yield* inventory.read).link.relayWarning).toEqual({
        relayBytes: 33_000_000_000,
        thresholdBytes: 30_000_000_000,
      });
      link.role = "standalone";
      link.links = [];
      yield* TestClock.adjust("10 minutes");
      expect((yield* inventory.read).link.relayWarning).toEqual({
        relayBytes: 33_000_000_000,
        thresholdBytes: 30_000_000_000,
      });
    }),
);

it.effect(
  "a multi-route row whose route blocks do not decode reads as route not measured, never as its alias",
  () =>
    Effect.gen(function* () {
      const linkTraffic = yield* HubLinkTraffic.make(Effect.succeed(new Set(["mac-ts"]))).pipe(
        Effect.provide(Settings.ServerSettingsService.layerTest()),
      );
      const row = { ...trafficRow(0), routes: [{ label: "future shape" }], route: { label: "x" } };
      const { inventory } = yield* setup({
        fixture: fleet.home,
        link: { role: "home", links: [row] },
        linkTraffic,
      });
      const result = yield* inventory.read;
      expect(result.link.links[0]?.route).toBeUndefined();
    }),
);

it.effect("a malformed traffic block reads as not measured and never hides its link row", () =>
  Effect.gen(function* () {
    const linkTraffic = yield* HubLinkTraffic.make(Effect.succeed(new Set(["pen-mac"]))).pipe(
      Effect.provide(Settings.ServerSettingsService.layerTest()),
    );
    const row = {
      ...trafficRow(0),
      traffic: { epoch: "not hex", generation: -1, toHomeBytes: "x" },
    };
    const { inventory } = yield* setup({
      fixture: fleet.home,
      link: { role: "home", links: [row] },
      linkTraffic,
    });
    const result = yield* inventory.read;
    expect(result.link.links[0]).toMatchObject({
      id: "lnk_a",
      route: { name: "pen-mac", via: "relay" },
    });
    expect(result.link.links[0]?.traffic).toBeUndefined();
  }),
);
