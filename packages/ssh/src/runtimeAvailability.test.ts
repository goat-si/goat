import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as Stream from "effect/Stream";
import {
  checkRuntimeAvailability,
  RuntimeReleaseHead,
  RuntimePublishedSearch,
} from "./runtimeAvailability.ts";
import type { PublishedRuntimeSearch } from "./runtimePublished.ts";
import { makeSuccessfulProcess } from "./tunnel.fixture.ts";
import { MAX_RUNTIME_ARCHIVE_BYTES } from "./runtimeArchive.ts";
import { cliArchiveFileName } from "@goat/shared/cliRelease";

const fixture = (
  options: {
    local?: "archive" | "both" | "directory" | "oversized";
    cache?: boolean;
    head?: "present" | "absent" | "unknown";
    gh?: "both" | "archive" | "absent" | "unknown";
    installed?: string[];
    held?: Readonly<Record<string, "pending" | "rejected">>;
    source?: boolean;
    checksum?: "absent" | "unknown";
    publishedFallback?: boolean;
    releaseBaseUrl?: string;
    hostHasData?: boolean;
    host?: string;
    published?: PublishedRuntimeSearch;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-runtime-preflight-" });
    const fileName = cliArchiveFileName("0.1.0", "linux-arm64");
    if (options.local === "directory") yield* fs.makeDirectory(`${directory}/${fileName}`);
    else if (options.local)
      yield* fs.writeFileString(`${directory}/${fileName}`, "not read or hashed");
    if (options.local === "oversized") {
      const file = yield* fs.open(`${directory}/${fileName}`, { flag: "r+" });
      yield* file.truncate(MAX_RUNTIME_ARCHIVE_BYTES + 1);
    }
    if (options.local === "both")
      yield* fs.writeFileString(`${directory}/${fileName}.sha256`, "not read or hashed");
    let requests = 0;
    const searches: Array<{
      platformKey: string;
      requestedVersion: string;
      exclude: ReadonlySet<string>;
    }> = [];
    const process = ChildProcessSpawner.make(() =>
      Effect.succeed({
        ...makeSuccessfulProcess(
          JSON.stringify({
            assets:
              options.gh === "both"
                ? [{ name: fileName }, { name: "SHA256SUMS" }]
                : [{ name: fileName }],
          }),
        ),
        exitCode: Effect.succeed(
          ChildProcessSpawner.ExitCode(
            options.gh === "absent" || options.gh === undefined || options.gh === "unknown" ? 1 : 0,
          ),
        ),
        stderr: Stream.make(
          new TextEncoder().encode(
            options.gh === "unknown" ? "not logged in" : "release not found",
          ),
        ),
      }),
    );
    const result = yield* checkRuntimeAvailability({
      ownerLabel: "Origin",
      platformKey: "linux-arm64",
      installedCandidates: (options.installed ?? []).map((version) => {
        const held = options.held?.[version];
        return { version, ...(held ? { held } : {}) };
      }),
      hostHasData: options.hostHasData ?? false,
      ...(options.host === undefined ? {} : { host: options.host }),
      runner: {
        archiveVersion: "0.1.0",
        ...(options.publishedFallback === undefined
          ? {}
          : { publishedFallback: options.publishedFallback }),
        ...(options.releaseBaseUrl === undefined ? {} : { releaseBaseUrl: options.releaseBaseUrl }),
        ...(options.cache
          ? { archiveDirectory: directory }
          : { bundledArchiveDirectory: directory }),
        ...(options.source
          ? { nodeScriptPath: "/src/server.ts", nodeEngineRange: "^24.13.1" }
          : {}),
      },
    }).pipe(
      Effect.provideService(RuntimePublishedSearch, (input) => {
        searches.push(input);
        return Effect.succeed(options.published ?? { miss: "none", rejected: [] });
      }),
      Effect.provideService(RuntimeReleaseHead, (url) => {
        requests++;
        return Effect.succeed(
          url.endsWith("/SHA256SUMS") && options.checksum
            ? options.checksum
            : (options.head ?? "absent"),
        );
      }),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, process),
      Effect.provide(FetchHttpClient.layer),
    );
    return { ...result, requests, searches };
  });
it.effect("source runners warn without looking for archives", () =>
  Effect.gen(function* () {
    const result = yield* fixture({ source: true });
    expect(result.step.state).toBe("warning");
    expect(result.step.summary).toContain("/src/server.ts");
    expect(result.step.summary).toContain("^24.13.1");
    expect(result.requests).toBe(0);
    expect(result.needsTransfer).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("installed requested runtime needs no transfer", () =>
  Effect.gen(function* () {
    const result = yield* fixture({ installed: ["0.1.0"] });
    expect(result.step.state).toBe("passed");
    expect(result.requests).toBe(0);
    expect(result.needsTransfer).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("a local archive and sidecar are checked by metadata only", () =>
  Effect.gen(function* () {
    const result = yield* fixture({ local: "both" });
    expect(result.step.state).toBe("passed");
    expect(result.step.summary).toContain("Origin");
    expect(result.requests).toBe(0);
    expect(result.needsTransfer).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("a local archive without a checksum is not a confirmed source", () =>
  Effect.gen(function* () {
    const result = yield* fixture({ local: "archive" });
    expect(result.step.state).toBe("failed");
    expect(result.step.fix?.instruction).toContain("published GOAT release");
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["present", "absent", "unknown"] as const)("handles public HTTPS %s", (head) =>
  Effect.gen(function* () {
    const result = yield* fixture({ head });
    expect(result.step.state).toBe(
      head === "present" ? "passed" : head === "absent" ? "failed" : "warning",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["absent", "unknown"] as const)(
  "requires the release checksum asset (%s)",
  (checksum) =>
    Effect.gen(function* () {
      const result = yield* fixture({ head: "present", checksum });
      expect(result.step.state).toBe(checksum === "absent" ? "failed" : "warning");
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["both", "archive", "unknown"] as const)(
  "handles authenticated release assets %s",
  (gh) =>
    Effect.gen(function* () {
      const result = yield* fixture({ gh });
      expect(result.step.state).toBe(
        gh === "both" ? "passed" : gh === "archive" ? "failed" : "warning",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("preserves a compatible-runtime fallback when the requested release is absent", () =>
  Effect.gen(function* () {
    const result = yield* fixture({ installed: ["0.0.9"] });
    expect(result.step.state).toBe("warning");
    expect(result.step.summary).toContain("connect checks whether it is compatible");
    expect(result.needsTransfer).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([200, 404, 401, 500])(
  "release HEAD classifies HTTP %s without downloading",
  (status) =>
    Effect.gen(function* () {
      const head = yield* RuntimeReleaseHead;
      const client = HttpClient.make((request) => {
        expect(request.method).toBe("HEAD");
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));
      });
      expect(
        yield* head("https://releases.example/runtime").pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        ),
      ).toBe(status === 200 ? "present" : status === 404 ? "absent" : "unknown");
    }),
);

it.effect("accepts a user-supplied cache archive without a checksum or content reads", () =>
  Effect.gen(function* () {
    const result = yield* fixture({ local: "archive", cache: true });
    expect(result.step.state).toBe("passed");
    expect(result.step.summary).toContain("Uploads GOAT");
    expect(result.requests).toBe(0);
    expect(result.needsTransfer).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["directory", "oversized"] as const)(
  "rejects a cache archive with invalid %s metadata",
  (local) =>
    Effect.gen(function* () {
      const result = yield* fixture({ local, cache: true });
      expect(result.step.state).toBe("failed");
      expect(result.needsTransfer).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["bundle", "cache", "release", "authenticated"] as const)(
  "an available %s does not require transferring over a retained newer runtime",
  (source) =>
    Effect.gen(function* () {
      const result = yield* fixture({
        installed: ["0.2.0"],
        ...(source === "bundle"
          ? { local: "both" as const }
          : source === "cache"
            ? { local: "archive" as const, cache: true }
            : source === "release"
              ? { head: "present" as const }
              : { gh: "both" as const }),
      });
      expect(result.step.state).toBe("passed");
      expect(result.needsTransfer).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["nightly", "stable"] as const)(
  "offers the newest compatible published %s runtime on a fresh host",
  (channel) =>
    Effect.gen(function* () {
      const version = channel === "nightly" ? "0.2.0-nightly.1" : "0.2.0";
      const result = yield* fixture({
        publishedFallback: true,
        published: { found: { version, channel }, rejected: [] },
      });
      expect(result.step).toEqual({
        id: "runtime",
        state: "passed",
        summary: `GOAT 0.1.0 isn't published for linux-arm64; GOAT installs ${version}, the newest compatible ${channel} release.`,
      });
      expect(result.needsTransfer).toBe(true);
      expect(result.searches).toEqual([
        { platformKey: "linux-arm64", requestedVersion: "0.1.0", exclude: new Set() },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["unreachable", "client-too-old", "none"] as const)(
  "explains a published runtime search miss: %s",
  (miss) =>
    Effect.gen(function* () {
      const result = yield* fixture({ publishedFallback: true, published: { miss, rejected: [] } });
      expect(result.searches).toHaveLength(1);
      expect(result.needsTransfer).toBe(false);
      if (miss === "unreachable") {
        expect(result.step).toEqual({
          id: "runtime",
          state: "warning",
          summary: "Could not check published GOAT runtimes for linux-arm64.",
          detail: "Check that this computer can reach github.com, then check again.",
        });
      } else if (miss === "client-too-old") {
        expect(result.step).toEqual({
          id: "runtime",
          state: "failed",
          summary: "Every published GOAT runtime for linux-arm64 needs a newer app.",
          fix: { actor: "human", instruction: "Update this app, then check again." },
        });
      } else {
        expect(result.step.state).toBe("failed");
        expect(result.step.summary).toBe(
          "GOAT 0.1.0 has no runtime for linux-arm64: it isn't bundled with this build or published.",
        );
        expect(result.step.fix?.instruction).toContain("on Origin.");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each([undefined, "build.example"])(
  "refuses fallback when %s has GOAT data but no installed runtime",
  (host) =>
    Effect.gen(function* () {
      const result = yield* fixture({
        publishedFallback: true,
        hostHasData: true,
        ...(host === undefined ? {} : { host }),
        published: { found: { version: "0.2.0", channel: "stable" }, rejected: [] },
      });
      expect(result.step.state).toBe("failed");
      expect(result.step.summary).toBe(
        `${host ?? "The host"} has GOAT data but no runtime this app can start, and GOAT 0.1.0 isn't published for linux-arm64.`,
      );
      expect(result.step.fix?.instruction).toContain("on Origin.");
      expect(result.searches).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["mirror", "disabled", "not opted in", "installed"] as const)(
  "does not search published fallbacks with %s",
  (gate) =>
    Effect.gen(function* () {
      const result = yield* fixture({
        ...(gate === "not opted in" ? {} : { publishedFallback: gate !== "disabled" }),
        ...(gate === "mirror" ? { releaseBaseUrl: " https://mirror.example/releases " } : {}),
        ...(gate === "installed" ? { installed: ["0.0.9"] } : {}),
        published: { found: { version: "0.2.0", channel: "stable" }, rejected: [] },
      });
      expect(result.searches).toEqual([]);
      expect(result.step.state).toBe(gate === "installed" ? "warning" : "failed");
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["installed", "bundle", "cache", "release", "authenticated"] as const)(
  "an exact %s runtime takes precedence over published fallback",
  (source) =>
    Effect.gen(function* () {
      const result = yield* fixture({
        publishedFallback: true,
        ...(source === "installed"
          ? { installed: ["0.1.0"] }
          : source === "bundle"
            ? { local: "both" as const }
            : source === "cache"
              ? { local: "archive" as const, cache: true }
              : source === "release"
                ? { head: "present" as const }
                : { gh: "both" as const }),
      });
      expect(result.step.state).toBe("passed");
      expect(result.step.summary).toContain("0.1.0");
      expect(result.searches).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each(["found", "none"] as const)(
  "keeps exact-source uncertainty unless published fallback is %s",
  (outcome) =>
    Effect.gen(function* () {
      const result = yield* fixture({
        publishedFallback: true,
        releaseBaseUrl: "  ",
        head: "unknown",
        gh: "unknown",
        published:
          outcome === "found"
            ? { found: { version: "0.2.0", channel: "stable" }, rejected: [] }
            : { miss: "none", rejected: [] },
      });
      expect(result.searches).toHaveLength(1);
      expect(result.step.state).toBe(outcome === "found" ? "passed" : "warning");
      expect(result.step.summary).toContain(
        outcome === "found" ? "GOAT installs 0.2.0" : "Could not confirm",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps exact-source uncertainty on a host with existing data", () =>
  Effect.gen(function* () {
    const result = yield* fixture({ publishedFallback: true, hostHasData: true, head: "unknown" });
    expect(result.step.state).toBe("warning");
    expect(result.step.summary).toContain("Could not confirm");
    expect(result.searches).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["pending", "rejected"] as const)(
  "a held %s requested runtime still requires an exact-source transfer",
  (held) =>
    Effect.gen(function* () {
      const result = yield* fixture({
        installed: ["0.1.0"],
        held: { "0.1.0": held },
        head: "present",
      });
      expect(result.step.state).toBe("passed");
      expect(result.step.summary).toContain("Downloads the published GOAT 0.1.0");
      expect(result.needsTransfer).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("only rejected held runtimes are excluded from the published search", () =>
  Effect.gen(function* () {
    const result = yield* fixture({
      installed: ["0.2.0-nightly.1", "0.2.0"],
      held: { "0.2.0-nightly.1": "rejected", "0.2.0": "pending" },
      publishedFallback: true,
      published: { found: { version: "0.2.0", channel: "stable" }, rejected: [] },
    });
    expect(result.step.state).toBe("passed");
    expect(result.needsTransfer).toBe(true);
    expect(result.searches).toEqual([
      {
        platformKey: "linux-arm64",
        requestedVersion: "0.1.0",
        exclude: new Set(["0.2.0-nightly.1"]),
      },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
