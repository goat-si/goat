import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverSshHosts } from "./config.ts";

it.effect("expands Include against a home containing literal replacement sequences", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-ssh-literal-" });
    const homeDir = path.join(root, "home-$&-$$-한글");
    yield* fs.makeDirectory(path.join(homeDir, ".ssh", "config.d"), { recursive: true });
    yield* fs.writeFileString(
      path.join(homeDir, ".ssh", "config"),
      "Include ~/.ssh/config.d/*.conf\n",
    );
    yield* fs.writeFileString(
      path.join(homeDir, ".ssh", "config.d", "host.conf"),
      "Host literal\n  HostName literal.example\n",
    );
    const hosts = yield* discoverSshHosts({ homeDir });
    assert.deepEqual(
      hosts.map(({ alias, hostname }) => [alias, hostname]),
      [["literal", "literal.example"]],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
