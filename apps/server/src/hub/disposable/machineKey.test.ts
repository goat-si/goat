import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../../processRunner.ts";
import { make } from "./machineKey.ts";

// POSIX modes; a Windows hub keeps the key under its profile's ACL.
const WINDOWS = HostProcess.Platform.defaultValue() === "win32";
const services = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.live.skipIf(WINDOWS)(
  "makes one ed25519 key for the hub, private to GOAT, and keeps it across uses",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(root, "disposable");
      const first = yield* make(directory);
      // Two first uses at once make one key.
      const [a, b] = yield* Effect.all([first.identity, first.identity], {
        concurrency: "unbounded",
      });
      expect(a).toEqual(b);
      expect(a.publicLine).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]{68} goat-disposable$/u);
      expect((yield* fs.readDirectory(directory)).toSorted()).toEqual([
        "machine_ed25519",
        "machine_ed25519.pub",
      ]);
      expect((yield* fs.stat(a.privateKeyFile)).mode & 0o777).toBe(0o600);
      expect((yield* fs.stat(directory)).mode & 0o777).toBe(0o700);
      const privateBytes = yield* fs.readFileString(a.privateKeyFile);
      // A later server start reads the same key; a lost public half is derived from the private one.
      yield* fs.remove(a.privateKeyFile + ".pub");
      const again = yield* (yield* make(directory)).identity;
      expect(again).toEqual(a);
      expect(yield* fs.readFileString(a.privateKeyFile)).toBe(privateBytes);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live.skipIf(WINDOWS)("reading the key before attach makes one creates nothing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(yield* fs.makeTempDirectoryScoped(), "disposable");
    const service = yield* make(directory);
    expect(yield* service.known).toBeUndefined();
    expect(yield* fs.exists(directory)).toBe(false);
    const made = yield* service.identity;
    expect(yield* service.known).toEqual(made);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live.skipIf(WINDOWS)("a key folder GOAT cannot read never gets a replacement key", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(yield* fs.makeTempDirectoryScoped(), "disposable");
    const made = yield* (yield* make(directory)).identity;
    const before = yield* fs.readFileString(made.privateKeyFile);
    yield* fs.chmod(directory, 0o000);
    const later = yield* (yield* make(directory)).identity.pipe(Effect.flip);
    yield* fs.chmod(directory, 0o700);
    expect(later._tag).toBe("MachineKeyError");
    expect(yield* fs.readFileString(made.privateKeyFile)).toBe(before);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live.skipIf(WINDOWS)(
  "a key others can read is refused, and a public half that does not match is rebuilt",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(yield* fs.makeTempDirectoryScoped(), "disposable");
      const made = yield* (yield* make(directory)).identity;
      yield* fs.writeFileString(
        made.privateKeyFile + ".pub",
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFcDqbodCFNuBkK2emUwDpZghtdTw4e9ROT+jlVvIhId other\n",
      );
      expect(yield* (yield* make(directory)).identity).toEqual(made);
      yield* fs.chmod(made.privateKeyFile, 0o644);
      const open = yield* (yield* make(directory)).identity.pipe(Effect.flip);
      expect(open._tag).toBe("MachineKeyError");
      expect(yield* (yield* make(directory)).known).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live.skipIf(WINDOWS)(
  "a key made again while the server runs is the one shown, and a half-made key is cleared",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(yield* fs.makeTempDirectoryScoped(), "disposable");
      const service = yield* make(directory);
      const first = yield* service.identity;
      yield* fs.remove(first.privateKeyFile);
      yield* fs.remove(first.privateKeyFile + ".pub");
      const second = yield* service.identity;
      expect(second.publicLine).not.toBe(first.publicLine);
      expect((yield* fs.readFileString(second.privateKeyFile + ".pub")).trim()).toBe(
        second.publicLine,
      );
      // A crash left a half-made key behind; the next run's first use removes it.
      yield* fs.writeFileString(second.privateKeyFile + ".new-left-by-a-crash", "x", {
        mode: 0o600,
      });
      expect(yield* (yield* make(directory)).identity).toEqual(second);
      expect((yield* fs.readDirectory(directory)).toSorted()).toEqual([
        "machine_ed25519",
        "machine_ed25519.pub",
      ]);
    }).pipe(Effect.scoped, Effect.provide(services)),
);
