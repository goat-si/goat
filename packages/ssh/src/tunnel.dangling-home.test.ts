import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { remoteShell } from "./tunnel.fixture.ts";
import * as SshTunnel from "./tunnel.ts";

const runner = { archiveVersion: "0.1.6", releaseBaseUrl: "http://127.0.0.1:9" };
const scripts = {
  launch: () => SshTunnel.buildRemoteLaunchScript(runner),
  pairing: () => SshTunnel.buildRemotePairingScript("test-state", runner),
};

// An NFS home can carry a ~/.goat symlink whose target exists only on another host.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("dangling ~/.goat symlink", () => {
  it.live.each(["launch", "pairing"] as const)(
    "%s creates its state through a ~/.goat symlink whose target is missing",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-dangling-home-" });
        const home = `${root}/home`;
        const target = `${root}/shared/goat`;
        yield* fs.makeDirectory(home, { recursive: true });
        yield* fs.symlink(target, `${home}/.goat`);
        yield* fs.writeFileString(`${root}/script.sh`, scripts[kind]());
        const child = yield* spawner.spawn(
          ChildProcess.make(remoteShell, [`${root}/script.sh`, "test-state"], {
            env: { HOME: home },
          }),
        );
        const stderr = yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString);
        yield* child.exitCode;
        assert.isTrue(yield* fs.exists(`${target}/ssh-launch/test-state`), stderr);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
