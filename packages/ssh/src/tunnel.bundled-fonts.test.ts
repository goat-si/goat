import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { REMOTE_RUNTIME_STATE_KEY } from "./command.ts";
import * as SshTunnel from "./tunnel.ts";
import { ARCHIVE, arch, platform, uploadTarget } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("bundled SSH fonts", () => {
  it.live.each(["shared", "damaged", "remote copy refused", "old full bundle"] as const)(
    "publishes a usable runtime from a %s bundle",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: false,
          kind: "managed",
          oldVersion: "1.2.2",
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const digest = yield* Digest.Digest;
        const hash = (bytes: Uint8Array) =>
          digest.digest(Digest.sha256, bytes).pipe(Effect.map(Hex.encode));
        const bundle = `${f.test}/bundle`;
        const localAssets = `${f.test}/desktop-assets`;
        const stem = `goat-${ARCHIVE.archiveVersion}-${platform}-${arch}`;
        const filename = "NotoSansJP-Regular-abc_123.otf";
        const stageAssets = `${f.home}/stage/${stem}/client/assets`;
        const fontBytes = new TextEncoder().encode("verified offline font");
        yield* f.fs.makeDirectory(bundle);
        yield* f.fs.makeDirectory(localAssets);
        if (mode !== "remote copy refused") {
          yield* f.fs.makeDirectory(stageAssets, { recursive: true });
        }
        if (mode === "old full bundle") {
          yield* f.fs.writeFile(`${stageAssets}/${filename}`, fontBytes);
        } else {
          yield* f.fs.writeFileString(
            `${bundle}/${stem}.tar.gz.fonts.sha256`,
            `${yield* hash(fontBytes)}  ${filename}\n`,
          );
          yield* f.fs.writeFile(
            `${localAssets}/${filename}`,
            mode === "damaged" ? new Uint8Array([0]) : fontBytes,
          );
        }
        const archive = `${bundle}/${stem}.tar.gz`;
        const packed = yield* spawner.spawn(
          ChildProcess.make("tar", ["-czf", archive, "-C", `${f.home}/stage`, stem]),
        );
        assert.equal(Number(yield* packed.exitCode), 0);
        const archiveHash = yield* hash(yield* f.fs.readFile(archive));
        yield* f.fs.writeFileString(`${archive}.sha256`, `${archiveHash}  ${stem}.tar.gz\n`);

        const runner = {
          ...f.runner,
          bundledArchiveDirectory: bundle,
          bundledFontAssetDirectory: localAssets,
        };
        const selected = yield* SshTunnel.prepareRemoteRuntime(
          uploadTarget,
          {},
          runner,
          REMOTE_RUNTIME_STATE_KEY,
          true,
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
            ...f.transport,
            spawn: (command) =>
              ChildProcess.isStandardCommand(command) && command.command === "tar"
                ? spawner.spawn(command)
                : f.transport.spawn(command),
          }),
        );
        assert.equal(selected.version, ARCHIVE.archiveVersion);
        assert.equal(f.counters().uploads, 1);
        const installed = `${f.home}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}`;
        assert.equal(
          (yield* f.fs.readFileString(`${installed}/.install-complete`)).trim(),
          ARCHIVE.archiveVersion,
        );
        const [version, recordedHash, , source] = (yield* f.fs.readFileString(
          `${installed}/.install-record`,
        ))
          .trim()
          .split(" ");
        assert.deepEqual(
          [version, recordedHash, source],
          [ARCHIVE.archiveVersion, archiveHash, "bundle"],
        );
        const installedFont = `${installed}/client/assets/${filename}`;
        if (mode === "damaged" || mode === "remote copy refused")
          assert.isFalse(yield* f.fs.exists(installedFont));
        else assert.deepEqual(yield* f.fs.readFile(installedFont), fontBytes);
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );
});
