import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  gitBlobSha,
  hashBytes,
  makeGitHubReleasesClient,
  type GitHubRelease,
  type GitHubReleaseAsset,
} from "./lib/github-releases.ts";
import { cliArchiveFileName } from "@goat/shared/cliRelease";
import {
  ownRuntimeManifest,
  releaseRuntimeManifest,
  runtimeManifestAssetName,
} from "@goat/shared/runtimeManifest";
import { publishNightlyRelease, writePublishOutcome } from "./publish-nightly-release.ts";

const version = "0.1.0-nightly.20261012.2";
const newer = "0.1.0-nightly.20261012.10";
const stable = "0.1.0";
const dir = "/fake/release";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const release = (id = 1, tagVersion = version, draft = true): GitHubRelease => ({
  id,
  tag_name: `v${tagVersion}`,
  draft,
  prerelease: tagVersion.includes("-"),
  published_at: draft ? null : "2026-10-12T00:00:00Z",
});

/** In-memory filesystem and GitHub API: no processes, disk writes, or network. */
const fixture = (
  options: {
    published?: boolean;
    draft?: boolean;
    partial?: boolean;
    noDigest?: boolean;
    superseded?: "before" | "after";
    paginate?: boolean;
    corruptUpload?: boolean;
    badPublication?: boolean;
    synced?: boolean;
    version?: string;
    newer?: string;
    assetsOnly?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const target = options.version ?? version;
    const newerTag = options.newer ?? newer;
    const files = new Map<string, Uint8Array>(
      options.assetsOnly
        ? []
        : [
            ["install.sh", new TextEncoder().encode("#!/bin/sh\necho GOAT\n")],
            ["install.ps1", new TextEncoder().encode("Write-Host GOAT\n")],
            ["install-goat-server.sh", new TextEncoder().encode("#!/bin/sh\necho GOAT server\n")],
            ["THIRD_PARTY_NOTICES.md", new TextEncoder().encode("Notices\n")],
            ["GOAT-arm64.dmg", new TextEncoder().encode("macos artifact")],
          ],
    );
    const runtimeAsset = cliArchiveFileName(target, "linux-x64");
    const runtimeBytes = new TextEncoder().encode("runtime archive");
    files.set(runtimeAsset, runtimeBytes);
    files.set(
      runtimeManifestAssetName(target),
      new TextEncoder().encode(
        JSON.stringify(
          releaseRuntimeManifest(
            ownRuntimeManifest({ version: target }),
            new Map([[runtimeAsset, yield* hashBytes(runtimeBytes)]]),
          ),
        ),
      ),
    );
    const lines: string[] = [];
    for (const [name, bytes] of files) lines.push(`${yield* hashBytes(bytes)}  ${name}\n`);
    files.set("SHA256SUMS", new TextEncoder().encode(lines.join("")));
    const assets: GitHubReleaseAsset[] = [];
    const assetBytes = new Map<number, Uint8Array>();
    let nextId = 10;
    for (const [name, bytes] of files) {
      const id = nextId++;
      assets.push({
        id,
        name,
        size: bytes.byteLength,
        ...(options.noDigest ? {} : { digest: `sha256:${yield* hashBytes(bytes)}` }),
      });
      assetBytes.set(id, bytes);
    }
    if (options.partial) {
      assets[0] = { ...assets[0]!, digest: `sha256:${"0".repeat(64)}` };
      assets.splice(2);
      assets.push({ id: 99, name: "unexpected.zip", size: 3, digest: `sha256:${"f".repeat(64)}` });
    } else if (!options.published && !options.draft) assets.splice(0);
    const releases: GitHubRelease[] = options.published
      ? [release(1, target, false)]
      : options.draft
        ? [release(1, target)]
        : [];
    if (options.superseded === "before" && !options.paginate)
      releases.push(release(2, newerTag, false));
    const calls: { method: string; path: string; host: string; body: unknown }[] = [];
    const contents = new Map<string, string>();
    if (options.synced)
      for (const [name, bytes] of files) contents.set(name, yield* gitBlobSha(bytes));
    let releaseLists = 0;
    const fetch: typeof globalThis.fetch = async (url, init = {}) => {
      const requestUrl = new URL(String(url));
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      calls.push({ method, path: requestUrl.pathname, host: requestUrl.hostname, body });
      const endpoint = requestUrl.pathname.replace(/^\/repos\/owner\/releases/, "");
      if (endpoint === "/releases" && method === "GET") {
        if (requestUrl.searchParams.get("page") === "2") return json([release(2, newerTag, false)]);
        releaseLists++;
        if (options.superseded === "after" && releaseLists === 2)
          releases.push(release(2, newerTag, false));
        return options.paginate
          ? json(releases, 200, {
              link: '<https://api.github.com/repos/owner/releases/releases?per_page=100&page=2>; rel="next"',
            })
          : json(releases);
      }
      if (endpoint === "/releases" && method === "POST") {
        const draft = release(1, target);
        releases.push(draft);
        return json(draft, 201);
      }
      if (endpoint === "/releases/1/assets" && method === "GET") return json(assets);
      if (endpoint === "/releases/1/assets" && method === "POST") {
        const bytes = Uint8Array.from(init.body as Uint8Array);
        const id = nextId++;
        const asset = {
          id,
          name: requestUrl.searchParams.get("name")!,
          size: bytes.byteLength,
          digest: `sha256:${options.corruptUpload ? "0".repeat(64) : Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
        };
        assets.push(asset);
        assetBytes.set(id, bytes);
        return json(asset, 201);
      }
      if (/^\/releases\/assets\/\d+$/.test(endpoint)) {
        const id = Number(endpoint.split("/").at(-1));
        if (method === "DELETE") {
          assets.splice(
            assets.findIndex((asset) => asset.id === id),
            1,
          );
          return new Response(null, { status: 204 });
        }
        return new Response(Uint8Array.from(assetBytes.get(id)!));
      }
      if (endpoint.startsWith("/contents/")) {
        const file = decodeURIComponent(endpoint.slice("/contents/".length));
        if (method === "GET")
          return contents.has(file) ? json({ sha: contents.get(file) }) : json({}, 404);
        return json({}, 200);
      }
      if (endpoint === "/releases/1" && method === "PATCH") {
        const index = releases.findIndex((row) => row.id === 1);
        releases[index] = { ...release(1, target, options.badPublication ?? false) };
        return json(releases[index]);
      }
      if (endpoint === "/releases/1" && method === "GET")
        return json(releases.find((row) => row.id === 1));
      throw new Error(`Unhandled fake request: ${method} ${requestUrl.href}`);
    };
    const client = yield* makeGitHubReleasesClient("owner/releases", { fetch }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { GOAT_RELEASES_TOKEN: "fake-token" } }),
        ),
      ),
    );
    const fs = FileSystem.makeNoop({
      readDirectory: () => Effect.succeed([...files.keys()]),
      readFile: (file) => Effect.succeed(files.get(file.slice(dir.length + 1))!),
      readFileString: (file) =>
        Effect.succeed(new TextDecoder().decode(files.get(file.slice(dir.length + 1))!)),
    });
    const run = (dryRun = false) =>
      publishNightlyRelease({
        client,
        dir,
        version: target,
        name: "GOAT Nightly",
        dryRun,
        ...(options.assetsOnly ? { assetsOnly: true, target: "abc1234" } : {}),
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(NodeServices.layer));
    return { run, calls, assets, files, releases };
  });

const mutations = (calls: Effect.Success<ReturnType<typeof fixture>>["calls"]) =>
  calls.filter((call) => call.method !== "GET");

describe("publish nightly release", () => {
  it.effect(
    "fresh publish creates a main-target prerelease draft, uploads all verified bytes, syncs files, and publishes",
    () =>
      Effect.gen(function* () {
        const state = yield* fixture();
        expect(yield* state.run()).toBe("published");
        expect(state.assets.map((asset) => asset.name).toSorted()).toEqual(
          [...state.files.keys()].toSorted(),
        );
        const create = state.calls.find(
          (call) => call.path.endsWith("/releases") && call.method === "POST",
        )!;
        expect(create.body).toMatchObject({
          tag_name: `v${version}`,
          target_commitish: "main",
          draft: true,
          prerelease: true,
          make_latest: "false",
          name: "GOAT Nightly",
        });
        expect(state.calls.filter((call) => call.host === "uploads.github.com")).toHaveLength(
          state.files.size,
        );
        expect(state.calls.filter((call) => call.method === "PUT")).toHaveLength(4);
        expect(state.calls.find((call) => call.method === "PATCH")!.body).toEqual({
          draft: false,
          prerelease: true,
          make_latest: "false",
        });
        expect(state.calls.at(-1)).toMatchObject({
          method: "GET",
          path: "/repos/owner/releases/releases/1",
        });
      }),
  );

  it.effect(
    "resumes partial uploads, replaces a wrong-digest asset, removes extras, and keeps correct bytes",
    () =>
      Effect.gen(function* () {
        const state = yield* fixture({ draft: true, partial: true });
        expect(yield* state.run()).toBe("published");
        expect(
          state.calls.filter((call) => call.method === "DELETE").map((call) => call.path),
        ).toEqual([
          "/repos/owner/releases/releases/assets/10",
          "/repos/owner/releases/releases/assets/99",
        ]);
        expect(state.calls.filter((call) => call.host === "uploads.github.com")).toHaveLength(
          state.files.size - 1,
        );
        expect(state.assets.find((asset) => asset.name === "install.ps1")!.id).toBe(11);
        expect(
          state.calls.some((call) => call.path.endsWith("/releases") && call.method === "POST"),
        ).toBe(false);
      }),
  );

  it.effect(
    "assets-only publishes runtime archives at the built commit without installers or repository commits",
    () =>
      Effect.gen(function* () {
        const state = yield* fixture({ assetsOnly: true });
        expect(yield* state.run()).toBe("published");
        expect(state.assets.map((asset) => asset.name).toSorted()).toEqual(
          [...state.files.keys()].toSorted(),
        );
        expect(
          state.calls.find((call) => call.path.endsWith("/releases") && call.method === "POST")!
            .body,
        ).toMatchObject({ tag_name: `v${version}`, target_commitish: "abc1234" });
        expect(state.calls.some((call) => call.path.includes("/contents/"))).toBe(false);
      }),
  );

  it.effect("superseded before uploads performs no mutations, including across release pages", () =>
    Effect.gen(function* () {
      for (const paginate of [false, true]) {
        const state = yield* fixture({ superseded: "before", paginate });
        expect(yield* state.run()).toBe("superseded");
        expect(mutations(state.calls)).toEqual([]);
      }
    }),
  );

  it.effect("stable publishes the latest release and ignores newer nightlies", () =>
    Effect.gen(function* () {
      const state = yield* fixture({
        version: stable,
        newer: "0.2.0-nightly.20261013.1",
        superseded: "before",
      });
      expect(yield* state.run()).toBe("published");
      const create = state.calls.find(
        (call) => call.path.endsWith("/releases") && call.method === "POST",
      )!;
      expect(create.body).toMatchObject({
        tag_name: `v${stable}`,
        prerelease: false,
        make_latest: "true",
      });
      expect(state.calls.find((call) => call.method === "PATCH")!.body).toEqual({
        draft: false,
        prerelease: false,
        make_latest: "true",
      });
    }),
  );

  it.effect("refuses versions outside the nightly and stable channels", () =>
    Effect.gen(function* () {
      for (const rejected of ["0.1.0-preview.20261012.1", "0.1.0-rc.1"]) {
        const state = yield* fixture({ version: rejected });
        const exit = yield* Effect.exit(state.run());
        expect(exit._tag).toBe("Failure");
        expect(state.calls).toEqual([]);
      }
    }),
  );

  it.effect("superseded after uploads leaves the reconciled draft unpublished", () =>
    Effect.gen(function* () {
      const state = yield* fixture({ superseded: "after" });
      expect(yield* state.run()).toBe("superseded");
      expect(state.assets).toHaveLength(state.files.size);
      expect(state.releases[0]!.draft).toBe(true);
      expect(state.calls.some((call) => call.method === "PATCH")).toBe(false);
    }),
  );

  it.effect("already published identical bytes exits successfully without writes", () =>
    Effect.gen(function* () {
      const state = yield* fixture({ published: true });
      expect(yield* state.run()).toBe("already-published");
      expect(mutations(state.calls)).toEqual([]);
    }),
  );

  it.effect("already published different bytes fails without modifying the release", () =>
    Effect.gen(function* () {
      const state = yield* fixture({ published: true });
      state.assets[0] = { ...state.assets[0]!, digest: `sha256:${"f".repeat(64)}` };
      expect((yield* state.run().pipe(Effect.flip)).message).toContain(
        "tag already published with different bytes",
      );
      expect(mutations(state.calls)).toEqual([]);
    }),
  );

  it.effect("replaces draft size mismatches even when the reported digest matches", () =>
    Effect.gen(function* () {
      const state = yield* fixture({ draft: true });
      state.assets[0] = { ...state.assets[0]!, size: state.assets[0]!.size + 1 };
      expect(yield* state.run()).toBe("published");
      expect(state.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
      expect(state.calls.filter((call) => call.host === "uploads.github.com")).toHaveLength(1);
    }),
  );

  it.effect("published asset inventory must match names, sizes, and SHA256SUMS bytes", () =>
    Effect.gen(function* () {
      for (const mismatch of ["name", "size", "checksum-file"] as const) {
        const state = yield* fixture({ published: true });
        if (mismatch === "name") state.assets[0] = { ...state.assets[0]!, name: "wrong-name" };
        if (mismatch === "size")
          state.assets[0] = { ...state.assets[0]!, size: state.assets[0]!.size + 1 };
        if (mismatch === "checksum-file") {
          const index = state.assets.findIndex((asset) => asset.name === "SHA256SUMS");
          state.assets[index] = { ...state.assets[index]!, digest: `sha256:${"f".repeat(64)}` };
        }
        expect((yield* state.run().pipe(Effect.flip)).message).toContain(
          "tag already published with different bytes",
        );
        expect(mutations(state.calls)).toEqual([]);
      }
    }),
  );

  it.effect("missing digest downloads and hashes assets for published and draft releases", () =>
    Effect.gen(function* () {
      for (const published of [true, false]) {
        const state = yield* fixture({ published, draft: !published, noDigest: true });
        expect(yield* state.run()).toBe(published ? "already-published" : "published");
        expect(
          state.calls.filter(
            (call) => /\/releases\/assets\/\d+$/.test(call.path) && call.method === "GET",
          ),
        ).toHaveLength(state.files.size * (published ? 1 : 2));
        expect(state.calls.some((call) => call.host === "uploads.github.com")).toBe(false);
      }
    }),
  );

  it.effect("skips repository content commits when git blob hashes already match", () =>
    Effect.gen(function* () {
      const state = yield* fixture({ synced: true });
      expect(yield* state.run()).toBe("published");
      expect(state.calls.some((call) => call.method === "PUT")).toBe(false);
    }),
  );

  it.effect(
    "refuses to publish when post-upload verification or published-state verification fails",
    () =>
      Effect.gen(function* () {
        const corrupt = yield* fixture({ corruptUpload: true });
        expect((yield* corrupt.run().pipe(Effect.flip)).message).toContain(
          "Draft assets differ after reconciliation",
        );
        expect(corrupt.calls.some((call) => call.method === "PATCH" || call.method === "PUT")).toBe(
          false,
        );
        const draft = yield* fixture({ badPublication: true });
        expect((yield* draft.run().pipe(Effect.flip)).message).toContain(
          "Published release must be a non-draft prerelease",
        );
      }),
  );

  it.effect("validates local SHA256SUMS before making any API requests", () =>
    Effect.gen(function* () {
      const state = yield* fixture();
      state.files.set("install.sh", new TextEncoder().encode("tampered"));
      expect((yield* state.run().pipe(Effect.flip)).message).toContain(
        "Local checksum differs for install.sh",
      );
      expect(state.calls).toEqual([]);
    }),
  );

  it.effect(
    "requires a checksummed runtime manifest matching every published archive before API reads",
    () =>
      Effect.gen(function* () {
        for (const [mode, assetsOnly] of [
          ["missing", false],
          ["invalid", false],
          ["omitted-platform", false],
          ["digest-mismatch", false],
          ["invalid", true],
          ["omitted-platform", true],
          ["digest-mismatch", true],
        ] as const) {
          const state = yield* fixture({ assetsOnly });
          const name = runtimeManifestAssetName(version);
          if (mode === "missing") state.files.delete(name);
          else if (mode === "invalid") state.files.set(name, new TextEncoder().encode("invalid"));
          else {
            const manifest = JSON.parse(new TextDecoder().decode(state.files.get(name)!));
            if (mode === "omitted-platform") manifest.platforms = {};
            else manifest.platforms["linux-x64"].sha256 = "b".repeat(64);
            state.files.set(name, new TextEncoder().encode(JSON.stringify(manifest)));
          }
          const lines: string[] = [];
          for (const [asset, bytes] of state.files) {
            if (asset !== "SHA256SUMS") lines.push(`${yield* hashBytes(bytes)}  ${asset}\n`);
          }
          state.files.set("SHA256SUMS", new TextEncoder().encode(lines.join("")));
          expect((yield* Effect.result(state.run()))._tag).toBe("Failure");
          expect(state.calls).toEqual([]);
        }
      }),
  );

  it.effect("backfills a runtime-only release published before manifests", () =>
    Effect.gen(function* () {
      const state = yield* fixture({ assetsOnly: true });
      state.files.delete(runtimeManifestAssetName(version));
      const lines: string[] = [];
      for (const [asset, bytes] of state.files) {
        if (asset !== "SHA256SUMS") lines.push(`${yield* hashBytes(bytes)}  ${asset}\n`);
      }
      state.files.set("SHA256SUMS", new TextEncoder().encode(lines.join("")));
      expect((yield* Effect.result(state.run()))._tag).toBe("Success");
    }),
  );

  it.effect("rejects malformed, duplicate, and escaping checksum entries before API reads", () =>
    Effect.gen(function* () {
      for (const sums of [
        "not a checksum",
        `${"a".repeat(64)}  ../escape\n`,
        `${"a".repeat(64)}  install.sh\n${"a".repeat(64)}  install.sh\n`,
      ]) {
        const state = yield* fixture();
        state.files.set("SHA256SUMS", new TextEncoder().encode(sums));
        expect((yield* state.run().pipe(Effect.flip)).message).toContain(
          "Invalid or duplicate SHA256SUMS entry",
        );
        expect(state.calls).toEqual([]);
      }
    }),
  );

  it.effect("dry-run only reads and prints a plan for fresh and existing drafts", () =>
    Effect.gen(function* () {
      for (const draft of [false, true]) {
        const state = yield* fixture({ draft });
        expect(yield* state.run(true)).toBeUndefined();
        expect(mutations(state.calls)).toEqual([]);
      }
    }),
  );

  it.effect("appends the publish outcome to GITHUB_OUTPUT", () =>
    Effect.gen(function* () {
      const writes: { path: string; text: string; flag: string | undefined }[] = [];
      yield* writePublishOutcome("superseded").pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { GITHUB_OUTPUT: "/fake/output" } })),
        ),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            writeFileString: (path, text, options) =>
              Effect.sync(() => {
                writes.push({ path, text, flag: options?.flag });
              }),
          }),
        ),
      );
      expect(writes).toEqual([{ path: "/fake/output", text: "outcome=superseded\n", flag: "a" }]);
    }),
  );
});
