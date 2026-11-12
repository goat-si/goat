import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

import * as ProcessRunner from "../processRunner.ts";
import {
  detectServerMachineIdentity,
  ensureServerMachineNonce,
} from "./ServerEnvironmentMachine.ts";

const layer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));
// Every clone of one image reads this /etc/machine-id and the same home path.
const IMAGE_MACHINE_ID = "4f1c0e5a9b2d4c7e8f6a1b3c5d7e9f02";
const HOME = "/home/ubuntu";
const NONCE = HOME + "/.goat/machine-nonce";

const missing = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
  });

/** One machine's disk, holding only what the identity reads and writes. */
function disk(options: { readonly createdByAnotherServer?: string } = {}) {
  const files = new Map([["/etc/machine-id", IMAGE_MACHINE_ID + "\n"]]);
  let hideOtherServersNonce = options.createdByAnotherServer !== undefined;
  return FileSystem.makeNoop({
    readFileString: (path) => {
      // Another server creates the file between this server's first read and its own create.
      if (path === NONCE && hideOtherServersNonce && options.createdByAnotherServer) {
        hideOtherServersNonce = false;
        files.set(NONCE, options.createdByAnotherServer);
        return Effect.fail(missing("readFile", path));
      }
      const value = files.get(path);
      return value === undefined ? Effect.fail(missing("readFile", path)) : Effect.succeed(value);
    },
    makeDirectory: () => Effect.void,
    writeFileString: (path, data) => Effect.sync(() => void files.set(path, data)),
    link: (from, to) => {
      const value = files.get(from);
      if (files.has(to) || value === undefined) {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "AlreadyExists",
            module: "FileSystem",
            method: "link",
          }),
        );
      }
      return Effect.sync(() => void files.set(to, value));
    },
    remove: (path) => Effect.sync(() => void files.delete(path)),
  });
}

/** What one GOAT server reports when it starts on this disk. */
const startServerOn = (fileSystem: FileSystem.FileSystem, home = HOME) =>
  Effect.gen(function* () {
    yield* ensureServerMachineNonce();
    return yield* detectServerMachineIdentity();
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.HomeDirectory, home),
  );

it.layer(layer)("detectServerMachineIdentity", (it) => {
  it.effect("clones of one image with the same OS machine id name different machines", () =>
    Effect.gen(function* () {
      const first = yield* startServerOn(disk());
      const second = yield* startServerOn(disk());

      expect(first.machineId).toMatch(/^[0-9a-f]{32}$/);
      expect(second.machineId).toMatch(/^[0-9a-f]{32}$/);
      expect(second.machineId).not.toBe(first.machineId);
      expect(second.machineUserId).not.toBe(first.machineUserId);
    }),
  );

  it.effect("servers of one account on one machine name the same machine and SSH config", () =>
    Effect.gen(function* () {
      const machine = disk();
      // The desktop app's server and the headless server SSH launches start in ~/.goat.
      const desktop = yield* startServerOn(machine);
      const headless = yield* startServerOn(machine);
      const otherAccount = yield* startServerOn(machine, "/home/someone-else");

      expect(desktop.machineId).toMatch(/^[0-9a-f]{32}$/);
      expect(headless).toEqual(desktop);
      expect(otherAccount.machineUserId).not.toBe(desktop.machineUserId);
    }),
  );

  it.effect("a server that loses the race to create the machine nonce uses the winner's", () =>
    Effect.gen(function* () {
      const winner = disk();
      const desktop = yield* startServerOn(winner);
      const nonce = yield* winner.readFileString(NONCE);

      const headless = yield* startServerOn(disk({ createdByAnotherServer: nonce }));

      expect(headless).toEqual(desktop);
    }),
  );
});
