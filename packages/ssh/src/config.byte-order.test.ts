import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { discoverSshHosts } from "./config.ts";

it.effect("uses UTF-8 byte order for first-match Include configuration", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-ssh-order-" });
    const directory = path.join(homeDir, ".ssh", "config.d");
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(path.join(homeDir, ".ssh", "config"), "Include config.d/*.conf\n");
    yield* fs.writeFileString(
      path.join(directory, "Ｚ.conf"),
      "Host ordered\n  HostName first.example\n",
    );
    yield* fs.writeFileString(
      path.join(directory, "🚀.conf"),
      "Host ordered\n  HostName second.example\n",
    );
    const hosts = yield* discoverSshHosts({ homeDir });
    assert.deepEqual(
      hosts.map(({ alias, hostname }) => [alias, hostname]),
      [["ordered", "first.example"]],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
