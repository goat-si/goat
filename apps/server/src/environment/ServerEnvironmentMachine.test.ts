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
  serverMachineNonceDirectory,
} from "./ServerEnvironmentMachine.ts";

const layer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));
// Every clone of one image reads this /etc/machine-id and the same home path.
const IMAGE_MACHINE_ID = "4f1c0e5a9b2d4c7e8f6a1b3c5d7e9f02";
const HOME = "/home/ubuntu";
const NONCE = HOME + "/.goat/machine-nonce";

const failure = (_tag: "NotFound" | "AlreadyExists" | "PermissionDenied", method: string) =>
  PlatformError.systemError({ _tag, module: "FileSystem", method });

/** One machine's disk, holding only what the identity reads and writes. */
function disk(
  options: {
    readonly nonce?: string;
    readonly createdByAnotherServer?: string | undefined;
    readonly linkDenied?: boolean;
    readonly readDenied?: boolean;
  } = {},
) {
  const files = new Map([["/etc/machine-id", IMAGE_MACHINE_ID + "\n"]]);
  if (options.nonce !== undefined) files.set(NONCE, options.nonce);
  let racing = options.createdByAnotherServer;
  const fileSystem = FileSystem.makeNoop({
    readFileString: (path) => {
      if (path === NONCE && options.readDenied) {
        return Effect.fail(failure("PermissionDenied", "readFile"));
      }
      // Another server creates the file between this server's first read and its own create.
      if (path === NONCE && racing !== undefined) {
        files.set(NONCE, racing);
        racing = undefined;
        return Effect.fail(failure("NotFound", "readFile"));
      }
      const value = files.get(path);
      return value === undefined
        ? Effect.fail(failure("NotFound", "readFile"))
        : Effect.succeed(value);
    },
    makeDirectory: () => Effect.void,
    writeFileString: (path, data) => Effect.sync(() => void files.set(path, data)),
    link: (from, to) => {
      const value = files.get(from);
      if (options.linkDenied) return Effect.fail(failure("PermissionDenied", "link"));
      if (files.has(to) || value === undefined)
        return Effect.fail(failure("AlreadyExists", "link"));
      return Effect.sync(() => void files.set(to, value));
    },
    remove: (path) => Effect.sync(() => void files.delete(path)),
  });
  return { fileSystem, files };
}

/** What one GOAT server reports when it starts on this disk. */
const startServerOn = (
  fileSystem: FileSystem.FileSystem,
  options: { readonly home?: string; readonly devBaseDir?: string } = {},
) =>
  Effect.gen(function* () {
    const directory = yield* serverMachineNonceDirectory({
      devUrl: options.devBaseDir === undefined ? undefined : new URL("http://127.0.0.1:5733"),
      baseDir: options.devBaseDir ?? "/unused",
    });
    yield* ensureServerMachineNonce(directory);
    return yield* detectServerMachineIdentity(directory);
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.HomeDirectory, options.home ?? HOME),
  );

it.layer(layer)("detectServerMachineIdentity", (it) => {
  it.effect("clones of one image share the OS machine id but report their own install", () =>
    Effect.gen(function* () {
      const first = yield* startServerOn(disk().fileSystem);
      const second = yield* startServerOn(disk().fileSystem);

      // Older clients and servers keep comparing the ids they always had.
      expect(second.machineId).toBe(first.machineId);
      expect(second.machineUserId).toBe(first.machineUserId);
      expect(first.machineInstallId).toMatch(/^[0-9a-f]{32}$/);
      expect(second.machineInstallId).toMatch(/^[0-9a-f]{32}$/);
      expect(second.machineInstallId).not.toBe(first.machineInstallId);
    }),
  );

  it.effect("servers of one account on one machine report the same machine and install", () =>
    Effect.gen(function* () {
      const machine = disk().fileSystem;
      // The desktop app's server and the headless server SSH launches start in ~/.goat.
      const desktop = yield* startServerOn(machine);
      const headless = yield* startServerOn(machine);
      const otherAccount = yield* startServerOn(machine, { home: "/home/someone-else" });

      expect(desktop.machineId).toMatch(/^[0-9a-f]{32}$/);
      expect(headless).toEqual(desktop);
      expect(otherAccount.machineId).toBe(desktop.machineId);
      expect(otherAccount.machineUserId).not.toBe(desktop.machineUserId);
      expect(otherAccount.machineInstallId).not.toBe(desktop.machineInstallId);
    }),
  );

  it.effect("a server that loses the race to create the machine nonce uses the winner's", () =>
    Effect.gen(function* () {
      const winner = disk();
      const desktop = yield* startServerOn(winner.fileSystem);
      const nonce = winner.files.get(NONCE);

      const headless = yield* startServerOn(disk({ createdByAnotherServer: nonce }).fileSystem);

      expect(headless).toEqual(desktop);
    }),
  );

  it.effect("a development server keeps its nonce in its base directory, not ~/.goat", () =>
    Effect.gen(function* () {
      const machine = disk();
      yield* startServerOn(machine.fileSystem, { devBaseDir: "/work/goat/.goat" });

      expect(machine.files.get("/work/goat/.goat/machine-nonce")).toMatch(/^[0-9a-f]{32}\n$/);
      expect(machine.files.has(NONCE)).toBe(false);
    }),
  );

  it.effect("an unusable nonce is reported and leaves the server grouped by machine id", () =>
    Effect.gen(function* () {
      const expected = yield* startServerOn(disk().fileSystem);
      const cases = [
        [{ nonce: "" }, "is empty"],
        [{ nonce: "not a nonce\n" }, "is not a GOAT nonce"],
        [{ readDenied: true }, "cannot be read"],
        [{ linkDenied: true }, "could not be created"],
        // The racing server that won wrote nothing usable.
        [{ createdByAnotherServer: "" }, "is empty"],
      ] as const;

      for (const [options, problem] of cases) {
        const { fileSystem } = disk(options);
        const reported = yield* ensureServerMachineNonce(HOME + "/.goat").pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
        expect(reported).toContain(problem);
        expect(yield* startServerOn(fileSystem)).toEqual({ ...expected, machineInstallId: null });
      }
    }),
  );
});
