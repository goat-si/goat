import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { discoverSshHosts } from "./config.ts";

it.effect("includes wildcard filenames with line separators", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-ssh-glob-" });
    const sshDir = path.join(homeDir, ".ssh");
    yield* fs.makeDirectory(path.join(sshDir, "config.d"), { recursive: true });
    yield* fs.writeFileString(
      path.join(sshDir, "config"),
      "Include config.d/team*.conf\nInclude config.d/one?x.conf\n",
    );
    yield* fs.writeFileString(
      path.join(sshDir, "config.d", "team\none.conf"),
      "Host team\n HostName team.example.invalid\n",
    );
    yield* fs.writeFileString(
      path.join(sshDir, "config.d", "one\nx.conf"),
      "Host one\n HostName one.example.invalid\n",
    );
    const hosts = yield* discoverSshHosts({ homeDir });
    assert.isTrue(
      hosts.some((host) => host.alias === "team" && host.hostname === "team.example.invalid"),
    );
    assert.isTrue(
      hosts.some((host) => host.alias === "one" && host.hostname === "one.example.invalid"),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("matches SSH host question marks against UTF-8 bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-ssh-host-glob-" });
    const sshDir = path.join(homeDir, ".ssh");
    yield* fs.makeDirectory(sshDir);
    yield* fs.writeFileString(
      path.join(sshDir, "config"),
      "Host ??\n HostName two.example.invalid\nHost ?\n HostName one.example.invalid\nHost é\n User fixture\nHost 한\n User fixture\n",
    );
    const hosts = yield* discoverSshHosts({ homeDir });
    assert.equal(hosts.find((host) => host.alias === "é")?.hostname, "two.example.invalid");
    assert.equal(hosts.find((host) => host.alias === "한")?.hostname, "한");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
