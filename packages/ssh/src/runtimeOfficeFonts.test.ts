import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { readBundledOfficeFonts, runtimeArchiveUploadScript } from "./runtimeOfficeFonts.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("bundled font inputs", () => {
  it.effect.each([
    "manifest symlink",
    "font symlink",
    "manifest directory",
    "manifest FIFO",
  ] as const)("refuses a %s before packing", (mode) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const digest = yield* Digest.Digest;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-office-font-inputs-" });
      const assets = path.join(root, "assets");
      yield* fs.makeDirectory(assets);
      const archive = "goat-9.8.7-linux-x64.tar.gz";
      const manifest = path.join(root, archive + ".fonts.sha256");
      const name = "NotoSansJP-Regular-abc_123.otf";
      const asset = path.join(assets, name);
      const bytes = new TextEncoder().encode("synthetic font");
      const hash = Hex.encode(yield* digest.digest(Digest.sha256, bytes));
      const manifestText = `${hash}  ${name}\n`;

      if (mode === "manifest symlink") {
        const ordinaryManifest = path.join(root, "ordinary-manifest");
        yield* fs.writeFileString(ordinaryManifest, manifestText);
        yield* fs.symlink(ordinaryManifest, manifest);
      } else if (mode === "manifest directory") {
        yield* fs.makeDirectory(manifest);
      } else if (mode === "manifest FIFO") {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fifo = yield* spawner.spawn(ChildProcess.make("mkfifo", [manifest]));
        assert.equal(Number(yield* fifo.exitCode), 0);
      } else {
        yield* fs.writeFileString(manifest, manifestText);
      }
      if (mode === "font symlink") {
        const sibling = path.join(root, "ordinary-font");
        yield* fs.writeFile(sibling, bytes);
        yield* fs.symlink(sibling, asset);
      } else {
        yield* fs.writeFile(asset, bytes);
      }

      const result = yield* readBundledOfficeFonts(root, archive, assets).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          // Make an old unguarded FIFO read return immediately instead of waiting for a writer.
          readFileString: (file, encoding) =>
            mode === "manifest FIFO" && file === manifest
              ? Effect.succeed(manifestText)
              : fs.readFileString(file, encoding),
        }),
      );
      assert.isUndefined(result);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );
});

it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "discards failed font split output before starting the runtime installer",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-ssh-font-split-" });
      const bin = path.join(home, "bin");
      yield* fs.makeDirectory(bin);
      yield* fs.writeFileString(path.join(bin, "tail"), "#!/bin/sh\nprintf partial\nexit 1\n", {
        mode: 0o700,
      });
      const installer = `set -eu
archive="$GOAT_SSH_UPLOADED_ARCHIVE"
[ "$(cat "$archive")" = "runtime" ]
[ ! -e "${"$"}{archive%/*}/fonts.tar.gz" ] || { printf 'partial font output survived\\n'; exit 31; }
GOAT_STAGING="$HOME/staging"
GOAT_ARCHIVE="fixture.tar.gz"
  rm -f "$GOAT_STAGING/$GOAT_ARCHIVE" "$GOAT_STAGING/SHA256SUMS"
printf 'install completed\\n'
`;
      const script = runtimeArchiveUploadScript(installer, "bundle", {
        archiveBytes: "runtime".length,
        sha256: "0".repeat(64),
      });
      const child = yield* spawner.spawn(
        ChildProcess.make("/bin/sh", ["-c", script], {
          env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
          stdin: { stream: Stream.make(new TextEncoder().encode("runtimefont")), endOnDone: true },
        }),
      );
      const stdout = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
      assert.equal(Number(yield* child.exitCode), 0, stdout.trim());
      assert.equal(stdout, "install completed\n");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
