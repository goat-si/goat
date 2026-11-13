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
