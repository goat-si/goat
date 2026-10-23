import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { parseDeviceOutput } from "../hub/HubOcx.ts";
import * as ProcessRunner from "../processRunner.ts";
import { PREPARE_EXIT, prepareScript, type OcxLayout } from "./childPrepare.ts";

/** Only the temporary home: the developer's own OpenCodex must never be found, or started. */
const layout: OcxLayout = {
  candidates: ['"$HOME/.opencodex-desktop/bin/ocx"'],
  searchPath: "$HOME/.local/bin",
};

const services = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

/**
 * A fresh Linux machine as GOAT finds it: npm, no OpenCodex. The fake npm installs a fake ocx
 * under --prefix; that ocx answers healthy only once `service` (or `start`) ran.
 */
const prepareHost = Effect.fn("HubOcxTest.prepareHost")(function* (options: {
  readonly npm?: boolean;
  readonly serviceWorks?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-hub-prepare-" });
  const bin = path.join(home, "bin");
  yield* fs.makeDirectory(bin);
  const log = path.join(home, "calls.log");
  const ocx = [
    "#!/bin/sh",
    `printf 'ocx %s\\n' "$*" >> '${log}'`,
    'case "$1" in',
    "  --version) echo 'opencodex 2.91.0' ;;",
    `  health) [ -f '${home}/running' ] ;;`,
    `  service) ${options.serviceWorks === false ? "exit 1" : `touch '${home}/running'`} ;;`,
    `  start) touch '${home}/running' ;;`,
    "esac",
    "",
  ].join("\n");
  yield* fs.writeFileString(path.join(home, "ocx-template"), ocx);
  if (options.npm !== false)
    yield* fs.writeFileString(
      path.join(bin, "npm"),
      [
        "#!/bin/sh",
        `printf 'npm %s\\n' "$*" >> '${log}'`,
        'while [ $# -gt 0 ]; do [ "$1" = --prefix ] && goat_prefix=$2; shift; done',
        'mkdir -p "$goat_prefix/bin"',
        `cp '${home}/ocx-template' "$goat_prefix/bin/ocx"; chmod 755 "$goat_prefix/bin/ocx"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  // The script waits up to 20 seconds for the runtime; a test host has no reason to.
  yield* fs.writeFileString(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const tools = ["sh", "sed", "sort", "head", "mkdir", "cp", "chmod", "touch", "cat", "nohup"];
  for (const tool of tools) {
    const found = ["/bin", "/usr/bin"].map((dir) => path.join(dir, tool));
    for (const candidate of found)
      if (yield* fs.exists(candidate)) {
        yield* fs.symlink(candidate, path.join(bin, tool));
        break;
      }
  }
  const run = (version = "2.91.0") =>
    Effect.gen(function* () {
      const output = yield* (yield* ProcessRunner.ProcessRunner).run({
        command: "/bin/sh",
        args: ["-s"],
        stdin: prepareScript(version, layout),
        env: { HOME: home, PATH: bin },
      });
      return parseDeviceOutput(output.stdout);
    });
  const calls = fs.readFileString(log).pipe(
    Effect.map((text) => text.trim().split("\n")),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  return { run, calls };
});

it.live(
  "prepares a fresh machine once: installs this Home's release for the user, then starts it",
  () =>
    Effect.gen(function* () {
      const host = yield* prepareHost({});
      expect(yield* host.run()).toEqual({ code: 0, stdout: "2.91.0" });
      const first = yield* host.calls;
      expect(first.filter((call) => call.startsWith("npm"))).toHaveLength(1);
      expect(first.find((call) => call.startsWith("npm"))).toMatch(
        /^npm install -g --prefix \S+\/\.local @bitkyc08\/opencodex@2\.91\.0$/u,
      );
      expect(first).toContain("ocx service");
      // Prepared again: the healthy install is left alone.
      expect(yield* host.run()).toEqual({ code: 0, stdout: "2.91.0" });
      expect((yield* host.calls).slice(first.length)).toEqual(["ocx --version", "ocx health"]);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("starts OpenCodex directly where no service manager works", () =>
  Effect.gen(function* () {
    const host = yield* prepareHost({ serviceWorks: false });
    expect(yield* host.run()).toEqual({ code: 0, stdout: "2.91.0" });
    expect(yield* host.calls).toContain("ocx start");
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("reports a machine without npm instead of installing anything", () =>
  Effect.gen(function* () {
    const host = yield* prepareHost({ npm: false });
    expect((yield* host.run())?.code).toBe(PREPARE_EXIT.npmMissing);
    expect(yield* host.calls).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("refuses a version the install script could not quote", () =>
  Effect.sync(() => expect(() => prepareScript("2.91.0'; id; '")).toThrow(TypeError)),
);
