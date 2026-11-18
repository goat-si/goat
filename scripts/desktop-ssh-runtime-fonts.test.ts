import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@goat/shared/HostProcess";
import { cliArchiveTarCommand } from "@goat/shared/cliRelease";

import {
  createBuildConfig,
  stageSshRuntimeArchives,
  validateSshRuntimeArchives,
} from "./build-desktop-artifact.ts";
import { decodeReleaseReport, writePayloadReport } from "./lib/release-verify.ts";

it.effect("strips only shared CJK assets and checksums the staged archive's own bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = yield* HostProcess.Platform;
    const tar = cliArchiveTarCommand(platform, process.env);
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-ssh-fonts-" });
    const version = "9.8.7";
    const stem = `goat-${version}-linux-x64`;
    const sourceDirectory = path.join(root, "source");
    const destinationDirectory = path.join(root, "destination");
    const clientAssetsDirectory = path.join(root, "desktop-assets");
    const stage = path.join(root, "stage", stem);
    const filename = "NotoSansJP-Regular-abc_123.otf";
    for (const [member, contents] of [
      ["goat", "executable"],
      ["client/index.html", "index"],
      [`client/assets/${filename}`, "shared font"],
      ["client/assets/other.otf", "another font"],
      ["resource-monitor/linux-x64/goat-resource-monitor", "monitor"],
      ["screen-code/quickjs.wasm", "quickjs"],
      ["node_modules/node-pty/build/Release/pty.node", "pty"],
    ] as const) {
      const file = path.join(stage, member);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, contents);
    }
    yield* fs.makeDirectory(clientAssetsDirectory);
    yield* fs.writeFileString(path.join(clientAssetsDirectory, filename), "shared font");
    yield* fs.makeDirectory(sourceDirectory);
    const source = path.join(sourceDirectory, `${stem}.tar.gz`);
    const pack = yield* spawner.spawn(
      ChildProcess.make(tar, ["-czf", source, "-C", path.dirname(stage), stem]),
    );
    assert.equal(Number(yield* pack.exitCode), 0);
    const before = yield* fs.readFile(source);
    const input = {
      sourceDirectory,
      destinationDirectory,
      clientAssetsDirectory,
      version,
      requireAll: false,
    };
    const sizes = yield* stageSshRuntimeArchives(input);
    assert.deepEqual(sizes, { sharedBytes: 11, removedBytes: 11 });
    const [archive] = yield* validateSshRuntimeArchives({
      directory: destinationDirectory,
      version,
      requireAll: false,
      requireSidecars: true,
    });
    assert.isDefined(archive);
    const listing = yield* spawner.spawn(
      ChildProcess.make(tar, ["-tzf", path.join(destinationDirectory, archive.fileName)]),
    );
    const names = yield* listing.stdout.pipe(Stream.decodeText(), Stream.mkString);
    assert.equal(Number(yield* listing.exitCode), 0);
    assert.notInclude(names, `client/assets/${filename}`);
    assert.include(names, "client/assets/other.otf");
    assert.notDeepEqual(archive.bytes, before);
    assert.deepEqual(yield* fs.readFile(source), before);
    assert.equal(
      yield* fs.readFileString(path.join(clientAssetsDirectory, filename)),
      "shared font",
    );
    const manifest = archive.fileName + ".fonts.sha256";
    const config = yield* createBuildConfig(
      "mac",
      "dmg",
      version,
      false,
      false,
      undefined,
      undefined,
      false,
      "arm64",
      true,
    );
    const resources = config.extraResources as Array<{ to: string; filter?: string[] }>;
    assert.include(
      resources.find((item) => item.to === "ssh-runtime/archives")?.filter ?? [],
      "*.tar.gz.fonts.sha256",
    );
    assert.match(
      yield* fs.readFileString(path.join(destinationDirectory, manifest)),
      new RegExp(`^[0-9a-f]{64}  ${filename}\n$`),
    );

    const payloadDirectory = path.join(root, "payload");
    yield* fs.makeDirectory(payloadDirectory);
    yield* fs.writeFileString(path.join(payloadDirectory, "GOAT-x86_64.AppImage"), "installer");
    const report = path.join(root, "size-report.json");
    yield* writePayloadReport(payloadDirectory, report, "desktop-linux-x64", version, [], sizes);
    const written = yield* decodeReleaseReport(yield* fs.readFileString(report));
    assert.deepEqual(written.sshRuntimeCjkFonts, sizes);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
