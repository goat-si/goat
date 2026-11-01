// @effect-diagnostics nodeBuiltinImport:off - round-trips real files through tar.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { makeGitHubReleasesClient } from "./lib/github-releases.ts";
import {
  cleanupStaging,
  getHandoffs,
  globMatcher,
  handoffOfAsset,
  handoffTag,
  parseHandoffTag,
  partAssetName,
  putHandoff,
} from "./nightly-staging.ts";

const tag = "goat-nightly-staging-42";
const now = Date.parse("2026-10-19T00:00:00Z");

interface FakeAsset {
  id: number;
  name: string;
  size: number;
  state: string;
  bytes: Uint8Array;
}
interface FakeRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  created_at: string;
  assets: FakeAsset[];
}

function fakeGitHub(releases: FakeRelease[] = []) {
  let nextId = 1000;
  // Uploads GitHub acknowledges but does not keep.
  const dropUploads = new Set<string>();
  const calls: string[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const assetView = ({ bytes: _bytes, ...asset }: FakeAsset) => asset;
  const fetch: typeof globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    const method = init.method ?? "GET";
    const path = target.pathname.replace(/^\/repos\/owner\/repo/, "");
    calls.push(`${method} ${path}`);
    const allAssets = releases.flatMap((release) => release.assets);
    let match: RegExpExecArray | null;
    if (method === "GET" && path === "/releases")
      return json(releases.map(({ assets: _a, ...r }) => r));
    if (method === "POST" && path === "/releases") {
      const body = JSON.parse(String(init.body)) as { tag_name: string; draft: boolean };
      const release: FakeRelease = {
        id: nextId++,
        tag_name: body.tag_name,
        draft: body.draft,
        prerelease: true,
        published_at: null,
        created_at: "2026-10-19T00:00:00.000Z",
        assets: [],
      };
      releases.push(release);
      return json(release, 201);
    }
    if ((match = /^\/releases\/(\d+)\/assets$/.exec(path))) {
      const release = releases.find((candidate) => candidate.id === Number(match![1]))!;
      if (method === "GET") return json(release.assets.map(assetView));
      const name = target.searchParams.get("name")!;
      if (release.assets.some((asset) => asset.name === name)) return json({}, 422);
      const bytes = new Uint8Array(init.body as Uint8Array);
      const asset = { id: nextId++, name, size: bytes.byteLength, state: "uploaded", bytes };
      if (!dropUploads.has(name)) release.assets.push(asset);
      return json(assetView(asset), 201);
    }
    if ((match = /^\/releases\/assets\/(\d+)$/.exec(path))) {
      const id = Number(match[1]);
      if (method === "DELETE") {
        for (const release of releases) release.assets = release.assets.filter((a) => a.id !== id);
        return new Response(null, { status: 204 });
      }
      const asset = allAssets.find((candidate) => candidate.id === id);
      return asset ? new Response(Uint8Array.from(asset.bytes)) : json({}, 404);
    }
    if ((match = /^\/releases\/(\d+)$/.exec(path)) && method === "DELETE") {
      const index = releases.findIndex((release) => release.id === Number(match![1]));
      releases.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return json({ path }, 404);
  };
  return { fetch, releases, calls, dropUploads };
}

const clientFor = (fetch: typeof globalThis.fetch) =>
  makeGitHubReleasesClient("owner/repo", { fetch, retries: 0 }).pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: { GOAT_RELEASES_TOKEN: "fake-token" } })),
    ),
  );

function tempDir() {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nightly-staging-test-"));
}

function writeTree(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, file), content);
  }
}

describe("nightly staging names", () => {
  it("maps parts, manifests and draft tags back to their hand-off", () => {
    expect(partAssetName("cli-linux-x64", 7)).toBe("cli-linux-x64.tar.007");
    expect(handoffOfAsset("cli-linux-x64.tar.007")).toBe("cli-linux-x64");
    expect(handoffOfAsset("verify-cli-linux-x64.manifest.json")).toBe("verify-cli-linux-x64");
    expect(handoffOfAsset("stray.zip")).toBeUndefined();
    expect(handoffTag(tag, "cli-linux-x64")).toBe("goat-nightly-staging-42--cli-linux-x64");
    expect(parseHandoffTag("goat-nightly-staging-42--js-bundle")).toEqual({
      run: tag,
      name: "js-bundle",
    });
    expect(parseHandoffTag("goat-nightly-staging-4--x")?.run).not.toBe(tag);
    expect(parseHandoffTag("v1.0.0")).toBeUndefined();
  });

  it("anchors globs so cli-* never matches verify-cli-*", () => {
    const cli = globMatcher("cli-*");
    expect(cli("cli-win32-x64")).toBe(true);
    expect(cli("verify-cli-win32-x64")).toBe(false);
    expect(globMatcher("desktop-*")("desktop-mac-arm64")).toBe(true);
    expect(globMatcher("js-bundle")("js-bundle.x")).toBe(false);
  });
});

const sha = "a".repeat(40);
const draftOf = (github: ReturnType<typeof fakeGitHub>, name: string) =>
  github.releases.find((release) => release.tag_name === handoffTag(tag, name))!;

describe("nightly staging hand-off", () => {
  it.effect("splits a hand-off into verified parts and restores it byte for byte", () =>
    Effect.gen(function* () {
      const github = fakeGitHub();
      const client = yield* clientFor(github.fetch);
      const source = tempDir();
      const big = "x".repeat(5000);
      writeTree(source, {
        "server/dist/index.mjs": big,
        "desktop/dist-electron/main.js": "main",
        "other/skip": "no",
      });
      const manifest = yield* putHandoff(client, {
        tag,
        target: sha,
        name: "js-bundle",
        dir: source,
        paths: ["server/dist", "desktop/dist-electron"],
        partBytes: 2048,
      });
      expect(manifest.parts.length).toBeGreaterThan(2);
      const draft = draftOf(github, "js-bundle");
      expect(draft.draft).toBe(true);
      expect(draft.assets.map((asset) => asset.name).at(-1)).toBe("js-bundle.manifest.json");

      const dest = tempDir();
      expect(yield* getHandoffs(client, { tag, names: ["js-bundle"], dir: dest })).toEqual([
        "js-bundle",
      ]);
      expect(NodeFS.readFileSync(NodePath.join(dest, "server/dist/index.mjs"), "utf8")).toBe(big);
      expect(
        NodeFS.readFileSync(NodePath.join(dest, "desktop/dist-electron/main.js"), "utf8"),
      ).toBe("main");
      expect(NodeFS.existsSync(NodePath.join(dest, "other"))).toBe(false);
    }),
  );

  it.effect(
    "keeps each hand-off in its own draft, merges glob matches and replaces a re-stage",
    () =>
      Effect.gen(function* () {
        const github = fakeGitHub();
        const client = yield* clientFor(github.fetch);
        for (const key of ["linux-x64", "win32-x64"]) {
          const dir = tempDir();
          writeTree(dir, { [`goat-${key}.tar.gz`]: key });
          yield* putHandoff(client, { tag, target: sha, name: `cli-${key}`, dir, paths: [] });
          const reports = tempDir();
          writeTree(reports, { [`verify-cli-${key}.json`]: "{}" });
          yield* putHandoff(client, {
            tag,
            target: sha,
            name: `verify-cli-${key}`,
            dir: reports,
            paths: [],
          });
        }
        const again = tempDir();
        writeTree(again, { "goat-linux-x64.tar.gz": "rebuilt" });
        yield* putHandoff(client, {
          tag,
          target: sha,
          name: "cli-linux-x64",
          dir: again,
          paths: [],
        });
        expect(github.releases.map((release) => release.tag_name).toSorted()).toEqual(
          ["cli-linux-x64", "cli-win32-x64", "verify-cli-linux-x64", "verify-cli-win32-x64"].map(
            (name) => handoffTag(tag, name),
          ),
        );
        expect(draftOf(github, "cli-linux-x64").assets.map((asset) => asset.name)).toEqual([
          "cli-linux-x64.tar.000",
          "cli-linux-x64.manifest.json",
        ]);

        const dest = tempDir();
        expect(yield* getHandoffs(client, { tag, names: ["cli-*"], dir: dest })).toEqual([
          "cli-linux-x64",
          "cli-win32-x64",
        ]);
        expect(NodeFS.readdirSync(dest).toSorted()).toEqual([
          "goat-linux-x64.tar.gz",
          "goat-win32-x64.tar.gz",
        ]);
        expect(NodeFS.readFileSync(NodePath.join(dest, "goat-linux-x64.tar.gz"), "utf8")).toBe(
          "rebuilt",
        );
      }),
  );

  it.effect("refuses tampered and missing parts, unknown hand-offs and empty inputs", () =>
    Effect.gen(function* () {
      const github = fakeGitHub();
      const client = yield* clientFor(github.fetch);
      const dir = tempDir();
      writeTree(dir, { "a.txt": "a".repeat(3000) });
      yield* putHandoff(client, { tag, target: sha, name: "x", dir, paths: [], partBytes: 1024 });
      expect(
        (yield* getHandoffs(client, { tag, names: ["desktop-*"], dir: tempDir() }).pipe(
          Effect.flip,
        )).message,
      ).toContain("No hand-off matches desktop-*");
      const draft = draftOf(github, "x");
      draft.assets[1]!.bytes = new Uint8Array(1024);
      expect(
        (yield* getHandoffs(client, { tag, names: ["x"], dir: tempDir() }).pipe(Effect.flip))
          .message,
      ).toContain("does not match its manifest");
      draft.assets.splice(1, 1);
      const missing = yield* getHandoffs(client, {
        tag,
        names: ["x"],
        dir: tempDir(),
        retryDelayMs: 0,
      }).pipe(Effect.flip);
      expect(missing.message).toContain("x is missing part x.tar.001 (absent; release holds");
      expect(
        (yield* putHandoff(client, {
          tag,
          target: sha,
          name: "y",
          dir: tempDir(),
          paths: [],
        }).pipe(Effect.flip)).message,
      ).toContain("missing or empty");
      expect(
        (yield* putHandoff(client, { tag, target: sha, name: "y", dir, paths: ["../etc"] }).pipe(
          Effect.flip,
        )).message,
      ).toContain("must be relative");
    }),
  );

  it.effect("fails the producer when GitHub does not keep an uploaded part", () =>
    Effect.gen(function* () {
      const github = fakeGitHub();
      github.dropUploads.add("lost.tar.000");
      const client = yield* clientFor(github.fetch);
      const dir = tempDir();
      writeTree(dir, { "a.txt": "a" });
      const error = yield* putHandoff(client, {
        tag,
        target: sha,
        name: "lost",
        dir,
        paths: [],
      }).pipe(Effect.flip);
      expect(error.message).toContain("lost.tar.000 is not stored in");
    }),
  );
});

describe("nightly staging cleanup", () => {
  const draft = (id: number, tagName: string, created: string, draftFlag = true): FakeRelease => ({
    id,
    tag_name: tagName,
    draft: draftFlag,
    prerelease: true,
    published_at: null,
    created_at: created,
    assets: [],
  });

  it.effect("deletes this run's drafts and stale staging drafts only", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const github = fakeGitHub([
        draft(1, handoffTag(tag, "js-bundle"), "2026-10-18T23:00:00Z"),
        draft(2, tag, "2026-10-18T23:00:00Z"),
        draft(3, "goat-nightly-staging-7--cli-linux-x64", "2026-10-15T00:00:00Z"),
        draft(4, "goat-nightly-staging-8--js-bundle", "2026-10-18T12:00:00Z"),
        draft(5, "goat-nightly-staging-9", "2026-10-01T00:00:00Z", false),
        draft(6, "v1.0.0", "2026-10-01T00:00:00Z"),
      ]);
      const client = yield* clientFor(github.fetch);
      yield* cleanupStaging(client, { tag, keep: [], maxAgeHours: 72 });
      expect(github.releases.map((release) => release.id)).toEqual([4, 5, 6]);
      yield* cleanupStaging(client, { tag, keep: [], maxAgeHours: 72 });
      expect(github.releases.map((release) => release.id)).toEqual([4, 5, 6]);
    }),
  );

  it.effect("keeps only the selected hand-offs of a dry run", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const github = fakeGitHub([
        draft(1, handoffTag(tag, "release-assets"), "2026-10-18T23:00:00Z"),
        draft(2, handoffTag(tag, "js-bundle"), "2026-10-18T23:00:00Z"),
      ]);
      const client = yield* clientFor(github.fetch);
      yield* cleanupStaging(client, { tag, keep: ["release-assets"], maxAgeHours: 72 });
      expect(github.releases.map((release) => release.tag_name)).toEqual([
        handoffTag(tag, "release-assets"),
      ]);
    }),
  );
});
