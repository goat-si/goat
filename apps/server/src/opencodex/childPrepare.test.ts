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
 * A fresh Linux machine as GOAT finds it: GOAT's provisioned runtime in its versioned directory,
 * no OpenCodex, and no public `goat` command. The fake runtime installs a fake ocx in
 * ~/.local/bin; that ocx answers healthy only once `service` (or `start`) ran. A `goat` and an
 * `npm` on PATH are decoys that record a call if anything reaches for them.
 */
const prepareHost = Effect.fn("HubOcxTest.prepareHost")(function* (options: {
  readonly goat?: boolean;
  readonly serviceWorks?: boolean;
  /** An ocx already installed, as a Desktop install, before preparing. */
  readonly adopted?: boolean;
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
  if (options.adopted === true) {
    yield* fs.makeDirectory(path.join(home, ".opencodex-desktop", "bin"), { recursive: true });
    yield* fs.writeFileString(path.join(home, ".opencodex-desktop", "bin", "ocx"), ocx, {
      mode: 0o755,
    });
    yield* fs.writeFileString(path.join(home, "running"), "");
  }
  const runtime = path.join(home, "runtime with ' quote $(touch pwned)", "selected", "goat");
  if (options.goat !== false) {
    yield* fs.makeDirectory(path.dirname(runtime), { recursive: true });
    yield* fs.writeFileString(
      runtime,
      [
        "#!/bin/sh",
        `printf 'goat %s\\n' "$*" >> '${log}'`,
        '[ "$1 $2" = "opencodex install" ] || exit 1',
        'mkdir -p "$HOME/.local/bin"',
        `cp '${home}/ocx-template' "$HOME/.local/bin/ocx"; chmod 755 "$HOME/.local/bin/ocx"`,
        'echo "$HOME/.local/bin/ocx"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  for (const decoy of ["goat", "npm"])
    yield* fs.writeFileString(
      path.join(bin, decoy),
      `#!/bin/sh\nprintf 'decoy ${decoy} %s\\n' "$*" >> '${log}'\nexit 1\n`,
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
  /** `null` runs the script with no provisioned runtime resolved. */
  const run = (supplied: string | null = runtime) =>
    Effect.gen(function* () {
      const output = yield* (yield* ProcessRunner.ProcessRunner).run({
        command: "/bin/sh",
        args: ["-s"],
        stdin: prepareScript("2.91.0", supplied ?? undefined, layout),
        env: { HOME: home, PATH: bin },
      });
      return parseDeviceOutput(output.stdout);
    });
  const calls = fs.readFileString(log).pipe(
    Effect.map((text) => text.trim().split("\n")),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  return { run, calls, runtime, home, fs };
});

it.live(
  "prepares a fresh machine through the supplied provisioned GOAT executable without npm",
  () =>
    Effect.gen(function* () {
      const host = yield* prepareHost({});
      expect(yield* host.run()).toEqual({ code: 0, stdout: "2.91.0" });
      const first = yield* host.calls;
      expect(first.filter((call) => call.startsWith("goat"))).toEqual([
        "goat opencodex install --print-path",
      ]);
      expect(first.filter((call) => call.startsWith("decoy"))).toEqual([]);
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

it.live(
  "reports goat_runtime_missing before changing OpenCodex when the supplied executable is absent",
  () =>
    Effect.gen(function* () {
      // No runtime was resolved: even a healthy adopted ocx is not touched.
      const unresolved = yield* prepareHost({ adopted: true });
      expect((yield* unresolved.run(null))?.code).toBe(PREPARE_EXIT.goatRuntimeMissing);
      expect(yield* unresolved.calls).toEqual([]);
      // A resolved runtime that disappeared before the script ran.
      const removed = yield* prepareHost({ goat: false });
      expect((yield* removed.run())?.code).toBe(PREPARE_EXIT.goatRuntimeMissing);
      expect(yield* removed.calls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("keeps spaces and apostrophes in the supplied executable path inert", () =>
  Effect.gen(function* () {
    const host = yield* prepareHost({});
    expect((yield* host.run())?.code).toBe(0);
    expect(yield* host.fs.exists(`${host.home}/pwned`)).toBe(false);
    expect(yield* host.fs.exists(`${process.cwd()}/pwned`)).toBe(false);
    for (const unsafe of ["relative/goat", "/goat\nid", "/goat\0id"])
      expect(() => prepareScript("2.91.0", unsafe)).toThrow(TypeError);
    expect(() => prepareScript("2.91.0'; id; '", host.runtime)).toThrow(TypeError);
  }).pipe(Effect.scoped, Effect.provide(services)),
);
