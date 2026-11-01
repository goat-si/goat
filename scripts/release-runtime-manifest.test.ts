import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { cliArchiveFileName } from "@goat/shared/cliRelease";
import {
  ownRuntimeManifest,
  runtimeManifestAssetName,
  RUNTIME_MANIFEST_ARCHIVE_ENTRY,
} from "@goat/shared/runtimeManifest";
import {
  createReleaseRuntimeManifest,
  writeReleaseRuntimeManifest,
} from "./release-runtime-manifest.ts";
import { checkReleaseRuntimeManifest } from "./lib/runtime-manifest.ts";
import {
  readReleaseAsset,
  requireReleaseCommand,
  runReleaseCommand,
} from "./lib/release-verify.ts";

const version = "1.2.3";
const manifest = ownRuntimeManifest({ version, commit: "abc123", commitTime: 123 });
const archive = (key: "linux-x64" | "win32-arm64") => ({
  asset: cliArchiveFileName(version, key),
  sha256: "a".repeat(64),
  manifest,
});

describe("release runtime manifest", () => {
  it("includes every platform digest and preserves build metadata", () => {
    const archives = [archive("linux-x64"), archive("win32-arm64")];
    const result = createReleaseRuntimeManifest(version, archives);
    expect(result).toEqual({
      ...manifest,
      platforms: {
        "linux-x64": { asset: archives[0]!.asset, sha256: "a".repeat(64) },
        "win32-arm64": { asset: archives[1]!.asset, sha256: "a".repeat(64) },
      },
    });
    expect(
      checkReleaseRuntimeManifest(
        JSON.stringify(result),
        version,
        new Map(archives.map((a) => [a.asset, a.sha256])),
      ),
    ).toEqual([]);
  });
  it.each([
    { version: "1.2.4" },
    { commit: "def" },
    { commitTime: 124 },
    { capabilities: [] },
    { protocol: { ...manifest.protocol, ssh: { min: 99, max: 99 } } },
  ])("refuses disagreement across platform archives: %j", (change) => {
    expect(() =>
      createReleaseRuntimeManifest(version, [
        archive("linux-x64"),
        { ...archive("win32-arm64"), manifest: { ...manifest, ...change } },
      ]),
    ).toThrow();
  });
  it("refuses empty releases and embedded release manifests", () => {
    expect(() => createReleaseRuntimeManifest(version, [])).toThrow(/No runtime archives/);
    expect(() =>
      createReleaseRuntimeManifest(version, [
        { ...archive("linux-x64"), manifest: { ...manifest, platforms: {} } },
      ]),
    ).toThrow();
  });
  it("rejects duplicate archives, unknown asset names and invalid hashes", () => {
    const a = archive("linux-x64");
    for (const entries of [
      [a, a],
      [{ ...a, asset: "goat-1.2.4-linux-x64.tar.gz" }],
      [{ ...a, sha256: "invalid" }],
    ])
      expect(() => createReleaseRuntimeManifest(version, entries)).toThrow();
  });
  it("rejects omitted, extra, substituted and stale platform digests", () => {
    const a = archive("linux-x64");
    const result = createReleaseRuntimeManifest(version, [a]);
    const sums = new Map([[a.asset, a.sha256]]);
    for (const platforms of [
      {},
      { ...result.platforms, extra: { asset: "extra", sha256: a.sha256 } },
      { "linux-x64": { asset: "other.tar.gz", sha256: a.sha256 } },
      { "linux-x64": { asset: a.asset, sha256: "b".repeat(64) } },
    ])
      expect(
        checkReleaseRuntimeManifest(JSON.stringify({ ...result, platforms }), version, sums),
      ).not.toEqual([]);
    expect(
      checkReleaseRuntimeManifest(
        JSON.stringify(result),
        version,
        new Map([...sums, [cliArchiveFileName("1.2.4", "win32-arm64"), "a".repeat(64)]]),
      ),
    ).not.toEqual([]);
    expect(checkReleaseRuntimeManifest("", version, sums)).not.toEqual([]);
    expect(checkReleaseRuntimeManifest(JSON.stringify(result), "1.2.4", sums)).not.toEqual([]);
  });
  it.effect(
    "rejects missing, duplicate and invalid embedded manifests before writing the asset",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-manifest-missing-" });
        const asset = cliArchiveFileName(version, "linux-x64");
        yield* fs.writeFileString(path.join(dir, asset), "archive");
        const entry = `goat-${version}-linux-x64/${RUNTIME_MANIFEST_ARCHIVE_ENTRY}`;
        for (const mode of ["missing", "duplicate", "invalid"] as const) {
          const runner = (_program: string, args: readonly string[]) =>
            Effect.succeed({
              exitCode: 0,
              stderr: "",
              stdout:
                args[0] === "-tf"
                  ? mode === "missing"
                    ? "goat\n"
                    : mode === "duplicate"
                      ? `${entry}\n${entry}\n`
                      : `${entry}\n`
                  : "invalid json",
            });
          expect(
            (yield* Effect.result(writeReleaseRuntimeManifest(dir, version, runner)))._tag,
          ).toBe("Failure");
          expect(yield* fs.exists(path.join(dir, runtimeManifestAssetName(version)))).toBe(false);
        }
        yield* fs.writeFileString(
          path.join(dir, cliArchiveFileName("1.2.4", "linux-x64")),
          "archive",
        );
        expect((yield* Effect.result(writeReleaseRuntimeManifest(dir, version)))._tag).toBe(
          "Failure",
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("reads tar and zip manifests and hashes the final archive bytes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-runtime-release-" });
      const release = path.join(root, "release");
      yield* fs.makeDirectory(release);
      const checksums = new Map<string, string>();
      for (const key of ["linux-x64", "win32-arm64"] as const) {
        const asset = cliArchiveFileName(version, key);
        const stem = asset.replace(/\.(?:tar\.gz|zip)$/, "");
        const content = path.join(root, stem);
        yield* fs.makeDirectory(content);
        yield* fs.writeFileString(
          path.join(content, RUNTIME_MANIFEST_ARCHIVE_ENTRY),
          JSON.stringify(manifest),
        );
        const archivePath = path.join(release, asset);
        // zip takes absolute input paths, so use a tiny Python fixture to preserve the shipped root.
        if (key === "win32-arm64")
          yield* requireReleaseCommand(runReleaseCommand, "python3", [
            "-c",
            "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.write(sys.argv[2],sys.argv[3]); z.close()",
            archivePath,
            path.join(content, RUNTIME_MANIFEST_ARCHIVE_ENTRY),
            `${stem}/${RUNTIME_MANIFEST_ARCHIVE_ENTRY}`,
          ]);
        else
          yield* requireReleaseCommand(runReleaseCommand, "tar", [
            "-czf",
            archivePath,
            "-C",
            root,
            stem,
          ]);
        checksums.set(asset, (yield* readReleaseAsset(release, asset)).sha256);
      }
      const result = yield* writeReleaseRuntimeManifest(release, version);
      const source = yield* fs.readFileString(
        path.join(release, runtimeManifestAssetName(version)),
      );
      expect(JSON.parse(source)).toEqual(result);
      expect(checkReleaseRuntimeManifest(source, version, checksums)).toEqual([]);
      yield* fs.writeFileString(
        path.join(release, cliArchiveFileName(version, "linux-x64")),
        "broken archive",
      );
      expect((yield* Effect.result(writeReleaseRuntimeManifest(release, version)))._tag).toBe(
        "Failure",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
