import * as NodeServices from "@effect/platform-node/NodeServices";
import { createPackage, uncacheAll } from "@electron/asar";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as HostProcess from "@goat/shared/HostProcess";
import { GOAT_CONNECT_COMING_SOON } from "@goat/shared/goatConnect";
import {
  archiveMemberProblems,
  assembleRelease,
  checkReleaseAssetSet,
  checkReleaseManifest,
  checkReleaseReports,
  exposureProblems,
  isMachO,
  readReleaseAsset,
  releaseAssetKey,
  releaseAssetVersion,
  releaseInputs,
  decodeReleaseReport,
  ReleaseVerificationError,
  renderSha256Sums,
  requiredReleaseAssets,
  scanReleasePayload,
  writePayloadReport,
  writeReleaseReport,
  type ReleaseAsset,
  type ReleaseCommandRunner,
  type ReleaseReport,
} from "./lib/release-verify.ts";
import {
  ownRuntimeManifest,
  releaseRuntimeManifest,
  runtimeManifestAssetName,
} from "@goat/shared/runtimeManifest";
import { finalizeMacosDmgs, rewriteDmgManifest } from "./finalize-macos-dmg.ts";
import { verifyMacPayload, verifyReleaseDirectory } from "./verify-release-artifacts.ts";
import { mergeUpdateManifestFiles } from "./merge-update-manifests.ts";
import { buildNpmLauncher } from "./build-npm-launcher.ts";
import {
  parseUpdateManifest,
  serializeUpdateManifest,
  type UpdateManifest,
} from "./lib/update-manifest.ts";

const version = "0.1.0-nightly.20261012.1";
const bytes = (text: string) => new TextEncoder().encode(text);
const testLayer = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(HostProcess.Platform, "linux"),
  Layer.succeed(HostProcess.Environment, {}),
);
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | Path.Path
    | import("effect/process/ChildProcessSpawner").ChildProcessSpawner
    | Scope.Scope
  >,
) => effect.pipe(Effect.scoped, Effect.provide(testLayer));
const asset = (name: string, sha256 = "a".repeat(64)): ReleaseAsset => ({
  name,
  sha256,
  sha512: "digest",
  size: 10,
});
const manifest = (assets: readonly ReleaseAsset[], forVersion = version): UpdateManifest => ({
  version: forVersion,
  releaseDate: "2026-10-12T00:00:00Z",
  files: assets.map(({ name, sha512, size }) => ({ url: name, sha512, size })),
  extras: {},
});
const report = (
  key: string,
  assets: readonly ReleaseAsset[],
  mode: "payload" | "mac" = "payload",
  forVersion = version,
): ReleaseReport => ({
  key,
  mode,
  version: forVersion,
  inputs: assets.map(({ name, sha256 }) => ({ name, sha256 })),
  ok: true,
  checks: mode === "mac" ? ["require-signing", "exposure-scan"] : ["exposure-scan"],
  problems: [],
});
const neverRun: ReleaseCommandRunner = (program) =>
  Effect.fail(
    new ReleaseVerificationError({ problems: [`unexpected external command: ${program}`] }),
  );
const decodeReport = decodeReleaseReport;

describe("release payload helpers", () => {
  it("classifies thin and fat Mach-O while excluding Java classes and invalid counts", () => {
    for (const magic of [
      [0xfe, 0xed, 0xfa, 0xce],
      [0xfe, 0xed, 0xfa, 0xcf],
      [0xce, 0xfa, 0xed, 0xfe],
      [0xcf, 0xfa, 0xed, 0xfe],
    ])
      expect(isMachO(new Uint8Array(magic))).toBe(true);
    for (const magic of [
      [0xca, 0xfe, 0xba, 0xbe],
      [0xbe, 0xba, 0xfe, 0xca],
    ]) {
      for (const count of [1, 20])
        expect(isMachO(new Uint8Array([...magic, 0, 0, 0, count]))).toBe(true);
      for (const count of [0, 21, 61])
        expect(isMachO(new Uint8Array([...magic, 0, 0, 0, count]))).toBe(false);
      expect(isMachO(new Uint8Array([...magic, 0, 0, 0, 61, 0, 1]))).toBe(false);
    }
    expect(isMachO(bytes("text"))).toBe(false);
    expect(isMachO(new Uint8Array(3))).toBe(false);
  });
  it("rejects every exposure pattern in GOAT code and this machine's paths everywhere", () => {
    for (const name of [
      "client/main.map",
      "src/a.ts",
      "a.tsx",
      "a.mts",
      "a.cts",
      "types/a.d.ts",
      "x/.git/config",
    ])
      expect(exposureProblems(name).length).toBeGreaterThan(0);
    for (const content of [
      "//# sourceMappingURL=data:abc",
      '{"sourcesContent":["secret"]}',
      "/Users/jun/src/",
      "/home/runner/work/",
      "/opt/actions-runner/_work/",
      "D:\\a\\goat",
      "C:\\a\\goat",
      "$GITHUB_WORKSPACE",
      "https://github.com/goat-si/goat/issues",
      "https://github.com/goat-si/goat/blob/dev/docs/user/remote-access.md#tailscale-https",
    ])
      expect(exposureProblems("main.js", content).length).toBeGreaterThan(0);
    // Clients and the CLI ship this link; a source-repository URL here blocks every nightly.
    expect(exposureProblems("main.js", GOAT_CONNECT_COMING_SOON.guideUrl)).toEqual([]);
    expect(exposureProblems("node_modules/pkg/types.d.ts")).toEqual([]);
    expect(
      exposureProblems(
        "main.js",
        "github.com/goat-si/goat-releases github.com/goat-si/goat_native",
      ),
    ).toEqual([]);
    // Third-party code ships its own sources, maps and CI paths; D-10 covers GOAT's.
    for (const [name, content] of [
      ["app.asar!/node_modules/zod/src/index.ts", ""],
      ["app.asar!/node_modules/pkg/main.js.map", ""],
      ["node_modules/pkg/LICENSE", "sourceMappingURL=data:bad"],
      ["node_modules/pkg/addon.node", "/Users/runner/work/pkg/build/"],
      ["GOAT.app/Contents/Frameworks/Electron Framework", "sourceMappingURL=data:x"],
    ] as const)
      expect(exposureProblems(name, content, [])).toEqual([]);
    // GOAT workspace packages are GOAT sources wherever they are installed.
    expect(exposureProblems("app.asar!/node_modules/@goat/shared/src/x.ts", "", [])).toEqual([
      "app.asar!/node_modules/@goat/shared/src/x.ts: original source",
    ]);
    expect(
      exposureProblems("x.js", "C:\\Users\\runneradmin\\work\\x", ["C:\\Users\\runneradmin"]),
    ).toEqual(["x.js: absolute build path"]);
    // Placeholders and prefix lists in GOAT code are not paths.
    expect(exposureProblems("main.js", "`/Users/<user>/.claude`", [])).toEqual([]);
    expect(exposureProblems("main.js", "[`/Users/`,`/home/`,`/tmp/`]", [])).toEqual([]);
    // This build machine's own paths fail in any file, including dependencies.
    const roots = ["/Users/builder/actions-runner/_work/goat/goat"];
    // A GOAT executable embeds Node, whose binary carries Node's own build paths.
    expect(exposureProblems("goat", "/Users/admin/build/ws/deps/x.rs", [], true)).toEqual([]);
    expect(exposureProblems("goat", `${roots[0]}/apps/server/x.ts`, roots, true)).toEqual([
      "goat: absolute build path",
    ]);
    expect(
      exposureProblems("node_modules/pkg/addon.node", `${roots[0]}/node_modules/x`, roots),
    ).toEqual(["node_modules/pkg/addon.node: absolute build path"]);
    // Every GitHub-hosted Linux runner's home is /home/runner, so a dependency built
    // on one carries it; only this checkout's paths count in third-party files.
    const hosted = ["/home/runner", "/home/runner/work/goat/goat"];
    const sandbox = "node_modules/@cursor/sdk-linux-arm64/bin/cursorsandbox";
    expect(
      exposureProblems(sandbox, "/home/runner/.cargo/registry/src/x/lib.rs", hosted, true),
    ).toEqual([]);
    expect(exposureProblems(sandbox, "/home/runner/work/goat/goat/x", hosted, true)).toEqual([
      `${sandbox}: absolute build path`,
    ]);
    expect(exposureProblems("goat", "/home/runner/.cargo/registry/src/x.rs", hosted, true)).toEqual(
      ["goat: absolute build path"],
    );
    // Cua Driver is an upstream release; its Windows executables carry its hosted CI's paths.
    const cua = "win-unpacked/resources/cua-driver/cua-driver.exe";
    const windowsRunner = ["C:\\Users\\runneradmin", "C:\\a\\goat\\goat"];
    expect(
      exposureProblems(
        cua,
        "D:\\a\\cua\\cua\\src C:\\Users\\runneradmin\\.cargo\\x",
        windowsRunner,
      ),
    ).toEqual([]);
    expect(exposureProblems(cua, "C:\\a\\goat\\goat\\apps\\x", windowsRunner)).toEqual([
      `${cua}: absolute build path`,
    ]);
    expect(exposureProblems("main.js", "'C:\\a\\b\\c'")).toEqual([]);
    // Electron's own executable and libraries carry Chromium's inline source maps.
    for (const name of [
      "win-arm64-unpacked/GOAT (Nightly).exe",
      "win-unpacked/ffmpeg.dll",
      "linux-unpacked/goat",
      "__appImage-arm64/locales/en-US.pak",
    ])
      expect(exposureProblems(name, "sourceMappingURL=data:x", [])).toEqual([]);
    // GOAT code under resources/ is still checked, and so are this machine's paths.
    expect(
      exposureProblems("win-unpacked/resources/app/main.js", "sourceMappingURL=data:x", []),
    ).toEqual(["win-unpacked/resources/app/main.js: inline source map"]);
    expect(
      exposureProblems("win-unpacked/GOAT.exe", "D:\\a\\goat\\goat\\x", ["D:\\a\\goat\\goat"]),
    ).toEqual(["win-unpacked/GOAT.exe: absolute build path"]);
    expect(exposureProblems("main.js", "C:\\a\\b\\c\\build")).not.toEqual([]);
  });
  it("rejects unsafe archive members before extraction", () => {
    expect(archiveMemberProblems("root/file\nroot/node_modules/pkg/a.d.ts\n")).toEqual([]);
    expect(
      archiveMemberProblems("../escape\n/absolute\nD:\\a\\file\nroot/.git/config\nroot/a.map\n"),
    ).toHaveLength(5);
  });
  it("requires each channel's own update manifests", () => {
    const manifests = (v: string) =>
      requiredReleaseAssets(v).filter((name) => name.endsWith(".yml"));
    expect(manifests(version)).toEqual([
      "nightly-linux-arm64.yml",
      "nightly-linux.yml",
      "nightly-mac.yml",
      "nightly.yml",
    ]);
    expect(manifests("0.1.1")).toEqual([
      "latest-linux-arm64.yml",
      "latest-linux.yml",
      "latest-mac.yml",
      "latest.yml",
    ]);
  });
  it("checks required assets, explicit dry-run globs and unexpected files", () => {
    const names = requiredReleaseAssets(version);
    expect(names).toContain("goat-npm.tgz");
    expect(checkReleaseAssetSet(names, version)).toEqual([]);
    expect(
      checkReleaseAssetSet(
        names.filter((name) => !name.endsWith(".deb")),
        version,
      ),
    ).toHaveLength(2);
    expect(
      checkReleaseAssetSet(
        names.filter((name) => !name.endsWith(".deb")),
        version,
        ["*.deb"],
      ),
    ).toEqual([]);
    expect(
      checkReleaseAssetSet(
        [...names, "builder-debug.yml", `GOAT-${version}-arm64.dmg.blockmap`],
        version,
      ),
    ).toHaveLength(2);
    expect(
      checkReleaseAssetSet([...names, `GOAT-${version}-x86_64.AppImage.blockmap`], version),
    ).toEqual([]);
  });
  it("keys Linux x64 packages by electron-builder's distro arch names", () => {
    expect(releaseAssetKey(`GOAT-${version}-x86_64.AppImage`)).toBe("desktop-linux-x64");
    expect(releaseAssetKey(`GOAT-${version}-amd64.deb`)).toBe("desktop-linux-x64");
    expect(releaseAssetKey(`GOAT-${version}-arm64.deb`)).toBe("desktop-linux-arm64");
    expect(releaseAssetKey(`GOAT-${version}-x64.dmg`)).toBe("desktop-mac-x64");
    expect(releaseAssetKey(`goat-${version}-win32-arm64.zip`)).toBe("cli-win-arm64");
    expect(releaseAssetVersion(`GOAT-${version}-amd64.deb`)).toBe(version);
  });
  it("checks manifest versions, local URLs, digests and sizes", () => {
    const zip = asset(`GOAT-${version}-arm64.zip`);
    expect(checkReleaseManifest(manifest([zip]), [zip], version)).toEqual([]);
    expect(
      checkReleaseManifest({ ...manifest([zip]), version: "other" }, [zip], version),
    ).toHaveLength(1);
    expect(
      checkReleaseManifest(
        manifest([{ ...zip, name: "https://example.com/asset" }]),
        [zip],
        version,
      ),
    ).toHaveLength(1);
    expect(checkReleaseManifest(manifest([{ ...zip, size: 20 }]), [zip], version)).toHaveLength(1);
    expect(
      checkReleaseManifest(manifest([{ ...zip, sha512: "other" }]), [zip], version),
    ).toHaveLength(1);
  });
  it("rewrites only the DMG manifest entry", () => {
    const dmg = asset(`GOAT-${version}-arm64.dmg`);
    const zip = asset(`GOAT-${version}-arm64.zip`);
    const rewritten = rewriteDmgManifest(manifest([zip, dmg]), { ...dmg, sha512: "new", size: 25 });
    expect(rewritten.files).toEqual([
      { url: zip.name, sha512: zip.sha512, size: zip.size },
      { url: dmg.name, sha512: "new", size: 25 },
    ]);
    expect(() => rewriteDmgManifest(manifest([zip]), dmg)).toThrow("absent");
  });
  it("gates complete reports, versions, keys and a single independently covered DMG transform", () => {
    const dmg = asset(`GOAT-${version}-arm64.dmg`, "b".repeat(64));
    const zip = asset(`GOAT-${version}-arm64.zip`);
    const builder = {
      ...report("desktop-mac-arm64", [zip, { ...dmg, sha256: "c".repeat(64) }]),
      transforms: [
        { name: dmg.name, from: "c".repeat(64), to: dmg.sha256, step: "dmg-finalize" as const },
      ],
    };
    const mac = report(builder.key, [zip, dmg], "mac");
    expect(checkReleaseReports([builder, mac], [zip, dmg], version)).toEqual([]);
    expect(
      checkReleaseReports([report(builder.key, [zip, dmg]), mac], [zip, dmg], version),
    ).toContain(`missing DMG finalization transform: ${dmg.name}`);
    for (const broken of [
      [],
      [builder],
      [mac],
      [{ ...builder, key: "unrelated" }, mac],
      [{ ...builder, version: "old" }, mac],
      [{ ...builder, ok: false }, mac],
      [{ ...builder, transforms: [...builder.transforms, ...builder.transforms] }, mac],
      [{ ...builder, inputs: builder.inputs.slice(0, 1) }, mac],
      // A mac report made without --require-signing, or one listing unsigned files.
      [builder, { ...mac, checks: ["exposure-scan"] }],
      [builder, { ...mac, checks: [...mac.checks, "unsigned/unverified: codesign x"] }],
    ])
      expect(checkReleaseReports(broken, [zip, dmg], version).length).toBeGreaterThan(0);
    expect(
      checkReleaseReports([builder, mac], [zip, { ...dmg, sha256: "d".repeat(64) }], version),
    ).toContain(`report hash mismatch: ${dmg.name}`);
    expect(
      checkReleaseReports([builder, mac], [{ ...zip, sha256: "d".repeat(64) }, dmg], version),
    ).toContain(`report hash mismatch: ${zip.name}`);
    expect(checkReleaseReports([builder, mac, mac], [zip, dmg], version).length).toBeGreaterThan(0);
  });
  it("renders sorted two-space SHA256SUMS without hashing itself", () => {
    expect(
      renderSha256Sums([
        asset("z", "1"),
        asset("SHA256SUMS", "old"),
        asset("A", "2"),
        asset("a", "3"),
      ]),
    ).toBe("2  A\n3  a\n1  z\n");
  });
});

describe("release payload filesystem verification", () => {
  it.effect(
    "scans all ASARs, unpacked files and embedded runtime archives through the runner",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temp = yield* fs.makeTempDirectoryScoped({ prefix: "goat-s1-test-" });
          const root = path.join(temp, "stage");
          const source = path.join(temp, "asar-source");
          yield* fs.makeDirectory(
            path.join(root, "linux-unpacked/resources/server.asar.unpacked"),
            { recursive: true },
          );
          yield* fs.makeDirectory(source);
          yield* fs.writeFileString(path.join(source, "bad.js"), "sourceMappingURL=data:secret");
          yield* Effect.promise(() =>
            createPackage(source, path.join(root, "linux-unpacked/resources/server.asar")),
          );
          yield* fs.writeFileString(
            path.join(root, "linux-unpacked/resources/server.asar.unpacked/main.map"),
            "{}",
          );
          yield* fs.writeFileString(
            path.join(root, "linux-unpacked/resources/runtime.tar.gz"),
            "stub archive",
          );
          const commands: string[] = [];
          const runner: ReleaseCommandRunner = (program, args) =>
            Effect.gen(function* () {
              commands.push(program + " " + args[0]);
              if (args[0] === "-tf")
                return { exitCode: 0, stdout: "runtime/main.js\n", stderr: "" };
              const dest = args[args.indexOf("-C") + 1]!;
              yield* fs.writeFileString(
                path.join(dest, "main.js"),
                "github.com/goat-si/goat/private",
              );
              return { exitCode: 0, stdout: "", stderr: "" };
            });
          const problems = yield* scanReleasePayload(root, runner);
          expect(problems.join("\n")).toContain("server.asar!/bad.js: inline source map");
          expect(problems.join("\n")).toContain("main.map: source map");
          expect(problems.join("\n")).toContain("runtime.tar.gz!/main.js: private repository URL");
          expect(commands).toEqual(["tar -tf", "tar -xf"]);
          yield* Effect.sync(uncacheAll);
        }),
      ),
  );
  it.effect("hashes only distributables in builder reports and fails on exposure", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-s1-test-" });
        const name = `GOAT-${version}-x64.exe`;
        for (const file of [name, "nightly.yml", name + ".blockmap", "builder-debug.yml"])
          yield* fs.writeFileString(path.join(root, file), "bytes");
        const file = path.join(root, "builder.json");
        yield* writePayloadReport(root, file, "desktop-win-x64", version, []);
        const result = yield* decodeReport(yield* fs.readFileString(file));
        expect(result.inputs.map((input) => input.name)).toEqual([name]);
        expect((yield* releaseInputs(root)).length).toBe(1);
        expect(
          (yield* Effect.exit(
            writePayloadReport(root, file, "desktop-win-x64", version, ["exposure"]),
          ))._tag,
        ).toBe("Failure");
        expect((yield* decodeReport(yield* fs.readFileString(file))).ok).toBe(false);
      }),
    ),
  );
  it.effect(
    "lists unsigned Mac binaries in dry run and fails signing verification when required",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-s1-test-" });
          yield* fs.makeDirectory(path.join(root, "GOAT.app/Contents/MacOS"), { recursive: true });
          yield* fs.writeFile(
            path.join(root, "GOAT.app/Contents/MacOS/goat"),
            new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]),
          );
          const unsigned: ReleaseCommandRunner = () =>
            Effect.succeed({ exitCode: 1, stdout: "", stderr: "unsigned" });
          const dry = yield* verifyMacPayload(root, "U9ATA49N28", false, unsigned);
          expect(dry.problems).toEqual([]);
          expect(dry.checks.join("\n")).toContain("unsigned/unverified");
          expect(
            (yield* verifyMacPayload(root, "U9ATA49N28", true, unsigned)).problems,
          ).toHaveLength(5);
          const wrongTeam: ReleaseCommandRunner = () =>
            Effect.succeed({ exitCode: 0, stdout: "", stderr: "TeamIdentifier=WRONGTEAM" });
          expect(
            (yield* verifyMacPayload(root, "U9ATA49N28", true, wrongTeam)).problems.join("\n"),
          ).toContain("Mach-O team");
        }),
      ),
  );
  it.effect("verifies Mach-O files inside every ASAR and embedded runtime archive", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-s1-test-" });
        const payload = path.join(root, "payload");
        const resources = path.join(payload, "GOAT.app/Contents/Resources");
        const source = path.join(root, "native-source");
        yield* fs.makeDirectory(resources, { recursive: true });
        yield* fs.makeDirectory(source);
        yield* fs.writeFile(
          path.join(source, "addon.node"),
          new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]),
        );
        yield* Effect.promise(() => createPackage(source, path.join(resources, "server.asar")));
        yield* fs.writeFileString(path.join(resources, "darwin-runtime.tar.gz"), "archive");
        yield* fs.symlink("/Applications", path.join(payload, "Applications"));
        yield* fs.writeFileString(
          path.join(payload, "builder-debug.yml"),
          "/Users/builder/worktree/",
        );
        const calls: string[] = [];
        const runner: ReleaseCommandRunner = (program, args) =>
          Effect.gen(function* () {
            calls.push(`${program} ${args[0]}`);
            if (program === "tar" && args[0] === "-tf")
              return { exitCode: 0, stdout: "runtime/goat\n", stderr: "" };
            if (program === "tar")
              yield* fs.writeFile(
                path.join(args[args.indexOf("-C") + 1]!, "goat"),
                new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]),
              );
            return {
              exitCode: 0,
              stdout: args[0] === "-dvv" ? "TeamIdentifier=U9ATA49N28\n" : "",
              stderr: "",
            };
          });
        const result = yield* verifyMacPayload(payload, "U9ATA49N28", true, runner);
        expect(result.problems).toEqual([]);
        expect(result.checks).toContain("structure: 1 apps, 2 Mach-O files");
        expect(calls.filter((call) => call === "codesign -dvv")).toHaveLength(2);
        yield* Effect.sync(uncacheAll);
      }),
    ),
  );

  it.effect("always detaches a DMG when attach or inspection fails", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-s1-test-" });
        const name = `GOAT-${version}-arm64.dmg`;
        yield* fs.writeFileString(path.join(root, name), "dmg");
        for (const failAttach of [true, false]) {
          const calls: string[] = [];
          const runner: ReleaseCommandRunner = (program, args) =>
            Effect.sync(() => {
              calls.push(`${program} ${args[0]}`);
              return {
                exitCode: failAttach && args[0] === "attach" ? 1 : 0,
                stdout: "",
                stderr: "test",
              };
            });
          expect(
            (yield* Effect.exit(
              verifyReleaseDirectory(
                {
                  mode: "mac",
                  dir: root,
                  report: path.join(root, "report.json"),
                  team: "U9ATA49N28",
                },
                runner,
              ),
            ))._tag,
          ).toBe("Failure");
          expect(calls.at(-1)).toBe("hdiutil detach");
          expect(
            (yield* decodeReport(yield* fs.readFileString(path.join(root, "report.json")))).ok,
          ).toBe(false);
        }
      }),
    ),
  );
  it.effect("unpacks CLI archives and rejects archive exposure before extracting", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-s1-test-" });
        yield* fs.writeFileString(path.join(root, `goat-${version}-linux-x64.tar.gz`), "tar");
        const calls: string[] = [];
        const runner: ReleaseCommandRunner = (program, args) =>
          Effect.gen(function* () {
            calls.push(`${program} ${args[0]}`);
            if (args[0] === "-tf")
              return { exitCode: 0, stdout: "goat/client/main.js\n", stderr: "" };
            yield* fs.writeFileString(
              path.join(args[args.indexOf("-C") + 1]!, "goat"),
              "executable",
            );
            return { exitCode: 0, stdout: "", stderr: "" };
          });
        const result = yield* verifyReleaseDirectory(
          { mode: "payload", dir: root, report: path.join(root, "report.json") },
          runner,
        );
        expect(result.ok).toBe(true);
        expect(result.key).toBe("cli-linux-x64");
        expect(result.version).toBe(version);
        expect(calls).toEqual(["tar -tf", "tar -xf"]);
        const unsafe: ReleaseCommandRunner = () =>
          Effect.succeed({ exitCode: 0, stdout: "../escape\n", stderr: "" });
        expect(
          (yield* Effect.exit(
            verifyReleaseDirectory(
              { mode: "payload", dir: root, report: path.join(root, "report.json") },
              unsafe,
            ),
          ))._tag,
        ).toBe("Failure");
      }),
    ),
  );
});

// Stable has its own update manifests (latest*.yml); both channels go through the same pipeline.
const releaseChannels = [
  { channel: "nightly", prefix: "nightly", version },
  { channel: "stable", prefix: "latest", version: "0.1.1" },
] as const;
it.effect.each(releaseChannels)(
  "$channel: builder report -> DMG finalize -> manifest rename and merge -> assemble passes; substituted ZIP or DMG fails",
  ({ prefix, version }) =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-s1-test-" });
        const dir = path.join(root, "release");
        const reportsDir = path.join(root, "reports");
        yield* fs.makeDirectory(dir);
        yield* fs.makeDirectory(reportsDir);
        for (const name of requiredReleaseAssets(version).filter((name) => !name.endsWith(".yml")))
          yield* fs.writeFileString(path.join(dir, name), `payload ${name}`);
        const npm = yield* buildNpmLauncher({ version, outputDir: path.join(root, "npm") });
        yield* fs.copyFile(npm.tarball, path.join(dir, "goat-npm.tgz"));
        const all = yield* releaseInputs(dir);
        for (const key of new Set(all.map((entry) => releaseAssetKey(entry.name)))) {
          const payloads = all.filter((entry) => releaseAssetKey(entry.name) === key);
          const builderPath = path.join(reportsDir, `${key}.json`);
          yield* writeReleaseReport(builderPath, report(key!, payloads, "payload", version));
          if (key!.startsWith("desktop-mac-")) {
            const stage = path.join(root, key!);
            yield* fs.makeDirectory(stage);
            for (const entry of payloads)
              yield* fs.copyFile(path.join(dir, entry.name), path.join(stage, entry.name));
            const dmg = payloads.find((entry) => entry.name.endsWith(".dmg"))!;
            yield* fs.writeFileString(path.join(stage, dmg.name + ".blockmap"), "stale");
            yield* fs.writeFileString(
              path.join(stage, `${prefix}-mac.yml`),
              serializeUpdateManifest(manifest(payloads, version), { platformLabel: "macOS" }),
            );
            const commands: Array<{ program: string; args: readonly string[] }> = [];
            const runner: ReleaseCommandRunner = (program, args) =>
              Effect.gen(function* () {
                commands.push({ program, args });
                if (program === "codesign")
                  yield* fs.writeFileString(path.join(stage, dmg.name), `signed ${dmg.name}`);
                return {
                  exitCode: 0,
                  stdout: args[0] === "notarytool" ? '{"status":"Accepted"}' : "",
                  stderr: "",
                };
              });
            const finalized = yield* finalizeMacosDmgs(
              stage,
              builderPath,
              {
                identity: "Developer ID Application: GOAT",
                profile: "goat-notary",
                keychain: "/test/login.keychain-db",
              },
              runner,
            );
            expect(finalized.transforms).toHaveLength(1);
            expect(commands[0]!.args).toContain("--timestamp");
            expect(commands[1]!.args).toContain("--keychain-profile");
            expect(commands[1]!.args).toContain("/test/login.keychain-db");
            expect(yield* fs.exists(path.join(stage, dmg.name + ".blockmap"))).toBe(false);
            yield* fs.copyFile(path.join(stage, dmg.name), path.join(dir, dmg.name));
            const current = yield* releaseInputs(stage);
            yield* writeReleaseReport(
              path.join(reportsDir, `${key}-mac.json`),
              report(key!, current, "mac", version),
            );
            yield* fs.copyFile(path.join(stage, `${prefix}-mac.yml`), path.join(dir, `${key}.yml`));
          }
        }
        // Collector renames each architecture's manifest; assembler merges then removes them.
        yield* fs.rename(
          path.join(dir, "desktop-mac-arm64.yml"),
          path.join(dir, `${prefix}-mac.yml`),
        );
        yield* fs.rename(
          path.join(dir, "desktop-mac-x64.yml"),
          path.join(dir, `${prefix}-mac-x64.yml`),
        );
        yield* mergeUpdateManifestFiles(
          "mac",
          path.join(dir, `${prefix}-mac.yml`),
          path.join(dir, `${prefix}-mac-x64.yml`),
          undefined,
        );
        yield* fs.remove(path.join(dir, `${prefix}-mac-x64.yml`));
        const final = yield* releaseInputs(dir);
        for (const [name, selected] of [
          [`${prefix}.yml`, final.filter((entry) => entry.name.endsWith(".exe"))],
          [`${prefix}-linux.yml`, final.filter((entry) => entry.name.endsWith("-x86_64.AppImage"))],
          [
            `${prefix}-linux-arm64.yml`,
            final.filter((entry) => entry.name.endsWith("-arm64.AppImage")),
          ],
        ] as const)
          yield* fs.writeFileString(
            path.join(dir, name),
            serializeUpdateManifest(manifest(selected, version), { platformLabel: "release" }),
          );
        const runtimeName = runtimeManifestAssetName(version);
        const runtime = releaseRuntimeManifest(
          ownRuntimeManifest({ version, commitTime: 123 }),
          new Map(final.map((a) => [a.name, a.sha256])),
        );
        yield* fs.writeFileString(path.join(dir, runtimeName), JSON.stringify(runtime));
        expect((yield* assembleRelease(dir, reportsDir, version)).ok).toBe(true);
        const runtimeSource = yield* fs.readFileString(path.join(dir, runtimeName));
        for (const bad of ["invalid", JSON.stringify({ ...runtime, platforms: {} })]) {
          yield* fs.writeFileString(path.join(dir, runtimeName), bad);
          expect((yield* Effect.result(assembleRelease(dir, reportsDir, version)))._tag).toBe(
            "Failure",
          );
        }
        yield* fs.remove(path.join(dir, runtimeName));
        expect((yield* Effect.result(assembleRelease(dir, reportsDir, version)))._tag).toBe(
          "Failure",
        );
        yield* fs.writeFileString(path.join(dir, runtimeName), runtimeSource);
        const sums = yield* fs.readFileString(path.join(dir, "SHA256SUMS"));
        expect(sums.split("\n").filter(Boolean)).toHaveLength(
          requiredReleaseAssets(version).length,
        );
        expect(sums).not.toContain("  SHA256SUMS");
        for (const ext of ["zip", "dmg"]) {
          const name = `GOAT-${version}-arm64.${ext}`;
          const original = yield* fs.readFile(path.join(dir, name));
          yield* fs.writeFileString(path.join(dir, name), "substituted");
          // Even a newly matching manifest cannot legitimize replacement bytes.
          const macPath = path.join(dir, `${prefix}-mac.yml`);
          const originalManifest = yield* fs.readFileString(macPath);
          const changed = yield* readReleaseAsset(dir, name);
          const parsed = parseUpdateManifest(originalManifest, macPath, "macOS");
          yield* fs.writeFileString(
            macPath,
            serializeUpdateManifest(
              {
                ...parsed,
                files: parsed.files.map((file) =>
                  file.url === name
                    ? { url: name, sha512: changed.sha512, size: changed.size }
                    : file,
                ),
              },
              { platformLabel: "macOS" },
            ),
          );
          const failure = yield* assembleRelease(dir, reportsDir, version).pipe(Effect.result);
          expect(failure._tag).toBe("Failure");
          if (failure._tag === "Failure")
            expect(String(failure.failure)).toContain(`report hash mismatch: ${name}`);
          expect(yield* fs.readFileString(path.join(dir, "SHA256SUMS"))).toBe(sums);
          yield* fs.writeFile(path.join(dir, name), original);
          yield* fs.writeFileString(macPath, originalManifest);
        }
      }),
    ),
);

it.effect("refuses rejected notarization and leaves manifests and report unchanged", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-s1-test-" });
      const name = `GOAT-${version}-arm64.dmg`;
      yield* fs.writeFileString(path.join(root, name), "dmg");
      const dmg = yield* readReleaseAsset(root, name);
      const builder = path.join(root, "builder.json");
      const source = serializeUpdateManifest(manifest([dmg]), { platformLabel: "macOS" });
      yield* fs.writeFileString(path.join(root, "nightly-mac.yml"), source);
      yield* writeReleaseReport(builder, report("desktop-mac-arm64", [dmg]));
      const calls: string[] = [];
      const runner: ReleaseCommandRunner = (program, args) =>
        Effect.sync(() => {
          calls.push(`${program} ${args[0]}`);
          return { exitCode: 0, stdout: '{"status":"Invalid"}', stderr: "" };
        });
      const failed = yield* Effect.exit(
        finalizeMacosDmgs(
          root,
          builder,
          { identity: "Developer ID", profile: "goat-notary" },
          runner,
        ),
      );
      expect(failed._tag).toBe("Failure");
      expect(calls).toEqual(["codesign --sign", "xcrun notarytool"]);
      expect(yield* fs.readFileString(path.join(root, "nightly-mac.yml"))).toBe(source);
      expect((yield* decodeReport(yield* fs.readFileString(builder))).transforms).toBeUndefined();
      expect(
        (yield* Effect.exit(
          finalizeMacosDmgs(root, builder, { identity: "-", profile: "goat-notary" }, neverRun),
        ))._tag,
      ).toBe("Failure");
    }),
  ),
);
