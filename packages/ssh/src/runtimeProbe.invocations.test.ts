// @effect-diagnostics nodeBuiltinImport:off - runs the real generated probe script against a temporary home.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { it } from "@effect/vitest";
import { assert } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { buildRemoteRuntimeProbeScript } from "./runtimeProbe.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const version = "1.2.3";

const fixture = Effect.fn("runtimeProbe.fixture")(function* (
  windows: boolean,
  modern: boolean,
  options: {
    manifest?: string;
    protocolUnsupported?: boolean;
    changeDuring?: "marker" | "executable" | "record";
    versionOutput?: string;
    keyed?: boolean;
  } = {},
) {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-probe-count-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const dir = NodePath.join(home, ".goat/runtime/goat/versions", version);
  const exe = NodePath.join(dir, "goat");
  const marker = NodePath.join(dir, "goat-manifest-shell-v1.sha256");
  const calls = NodePath.join(home, "calls");
  let bytes = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/calls"
case "$*" in
  --version) printf '${options.versionOutput ?? `goat v${version}`}\\n' ;;
  '__ssh-helper protocol --shell') ${options.protocolUnsupported ? "exit 2" : `printf '${version} 1 1 0 0\\n'`} ;;
  '__ssh-helper runtime-manifest --shell') ${
    modern
      ? `${
          options.changeDuring === "marker"
            ? 'printf replaced > "${0%/goat}/goat-manifest-shell-v1.sha256";'
            : options.changeDuring === "executable"
              ? 'printf "\\n# changed during invocation\\n" >> "$0";'
              : options.changeDuring === "record"
                ? 'printf replaced > "${0%/goat}/.install-record";'
                : ""
        }
      printf '${options.manifest ?? `${version} 1 1 0 has`}\\n'`
      : "exit 2"
  } ;;
  *) exit 2 ;;
esac
`;
  const advertise = async () => {
    const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    await NodeFSP.writeFile(marker, `${version} ${hash}\n`);
    await NodeFSP.writeFile(
      NodePath.join(dir, ".install-record"),
      `${version} ${"a".repeat(64)} ${hash} cache\n`,
    );
  };
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(dir, { recursive: true });
    await NodeFSP.writeFile(exe, bytes, { mode: 0o700 });
    await NodeFSP.writeFile(NodePath.join(dir, ".install-complete"), `${version}\n`);
    await NodeFSP.writeFile(calls, "");
    if (modern) await advertise();
  });
  const generated = buildRemoteRuntimeProbeScript(version);
  const boundary = generated.indexOf("\nretained_version=");
  assert.isAbove(boundary, 0);
  const prefix = `${windows ? "uname() { printf 'MINGW64_NT\\n'; }\n" + (options.keyed ? "" : "stat() { return 1; }\n") : ""}
# Fixed future date exercises the existing age gate without waiting for file timestamps.
date() { printf '4102444800\\n'; }
${generated.slice(0, boundary)}
`;
  const run = (tail = 'binary_json "$V"') =>
    Effect.promise(async () => {
      const out = await exec("sh", ["-c", prefix + tail], { env: { ...process.env, HOME: home } });
      return out.stdout;
    });
  const asks = () =>
    Effect.promise(async () =>
      (await NodeFSP.readFile(calls, "utf8")).trim().split("\n").filter(Boolean),
    );
  return {
    home,
    exe,
    marker,
    record: NodePath.join(dir, ".install-record"),
    run,
    asks,
    advertise: () => Effect.promise(advertise),
    replace: () =>
      Effect.promise(async () => {
        bytes += "\n# replacement has different size and digest\n";
        await NodeFSP.writeFile(exe, bytes, { mode: 0o700 });
      }),
  };
});

it.effect("modern Windows binary probe starts only one manifest helper", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true, true);
    assert.deepEqual(JSON.parse(yield* f.run()), {
      serverVersion: version,
      sshRuntimeProtocolVersion: 1,
      orchestrationProtocolVersion: 1,
    });
    assert.deepEqual(yield* f.asks(), ["__ssh-helper runtime-manifest --shell"]);
  }).pipe(Effect.scoped),
);

it.effect("legacy Windows never pays an unsupported manifest cold start", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true, false);
    yield* f.run();
    yield* f.run();
    assert.deepEqual(yield* f.asks(), [
      "--version",
      "__ssh-helper protocol --shell",
      "--version",
      "__ssh-helper protocol --shell",
    ]);
  }).pipe(Effect.scoped),
);

it.effect("warm POSIX keeps zero helper calls and invalidates executable replacement", () =>
  Effect.gen(function* () {
    const f = yield* fixture(false, true);
    yield* f.run();
    const cold = yield* f.asks();
    assert.deepEqual(cold, ["--version", "__ssh-helper protocol --shell"]);
    yield* f.run();
    assert.deepEqual(yield* f.asks(), cold);
    yield* f.replace();
    yield* f.run();
    assert.deepEqual(yield* f.asks(), [...cold, ...cold]);
    yield* f.run();
    assert.deepEqual(yield* f.asks(), [...cold, ...cold]);
  }).pipe(Effect.scoped),
);

it.effect("Windows replacement cannot reuse a stale capability marker", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true, true);
    yield* f.run();
    yield* f.replace();
    yield* f.run();
    assert.deepEqual(yield* f.asks(), [
      "__ssh-helper runtime-manifest --shell",
      "--version",
      "__ssh-helper protocol --shell",
    ]);
    yield* f.advertise();
    yield* f.run();
    assert.deepEqual(yield* f.asks(), [
      "__ssh-helper runtime-manifest --shell",
      "--version",
      "__ssh-helper protocol --shell",
      "__ssh-helper runtime-manifest --shell",
    ]);
  }).pipe(Effect.scoped),
);

it.effect("a replaced POSIX runner invalidates facts even with the same executable", () =>
  Effect.gen(function* () {
    const f = yield* fixture(false, false);
    const runner = NodePath.join(f.home, "runner.sh");
    const bytes = `#!/bin/sh\nGOAT_ARCHIVE_VERSION='${version}'\nexec '${f.exe}' "$@"\n`;
    yield* Effect.promise(() => NodeFSP.writeFile(runner, bytes, { mode: 0o700 }));
    const pair = `exec_fact version '${runner}' --version
exec_fact own '${runner}' __ssh-helper protocol --shell`;
    yield* f.run(pair);
    const first = yield* f.asks();
    assert.deepEqual(first, ["--version", "__ssh-helper protocol --shell"]);
    yield* f.run(pair);
    assert.deepEqual(yield* f.asks(), first);
    yield* Effect.promise(() =>
      NodeFSP.writeFile(runner, bytes + "# runner replaced\n", { mode: 0o700 }),
    );
    yield* f.run(pair);
    assert.deepEqual(yield* f.asks(), [...first, ...first]);
    yield* f.run(pair);
    assert.deepEqual(yield* f.asks(), [...first, ...first]);
  }).pipe(Effect.scoped),
);

it.effect.each([
  "",
  "1.2.3 1 1 0",
  "1.2.3 1 1 0 has extra",
  "9.9.9 1 1 0 has",
  "1.2.3 unknown 1 0 has",
  "1.2.3 0 1 0 has",
  "1.2.3 1 1 -1 has",
  "1.2.3 1 1 9007199254740992 has",
  "1.2.3 1 1 0 unknown",
])("advertised malformed manifest is invalid without fallback (%s)", (manifest) =>
  Effect.gen(function* () {
    const f = yield* fixture(true, true, { manifest });
    assert.deepEqual(JSON.parse(yield* f.run()), { serverVersion: version, invalid: true });
    assert.deepEqual(yield* f.asks(), ["__ssh-helper runtime-manifest --shell"]);
  }).pipe(Effect.scoped),
);

it.effect("an advertised unsupported flag is invalid without legacy fallback", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true, false);
    yield* f.advertise();
    assert.deepEqual(JSON.parse(yield* f.run()), { serverVersion: version, invalid: true });
    assert.deepEqual(yield* f.asks(), ["__ssh-helper runtime-manifest --shell"]);
  }).pipe(Effect.scoped),
);

it.effect.each(["marker", "executable", "record"] as const)(
  "identity changed during the manifest invocation is invalid (%s)",
  (changeDuring) =>
    Effect.gen(function* () {
      const f = yield* fixture(true, true, { changeDuring });
      assert.deepEqual(JSON.parse(yield* f.run()), { serverVersion: version, invalid: true });
      assert.deepEqual(yield* f.asks(), ["__ssh-helper runtime-manifest --shell"]);
    }).pipe(Effect.scoped),
);

it.effect.each(["marker", "record"] as const)(
  "missing or symlinked capability metadata takes the legacy path (%s)",
  (metadata) =>
    Effect.gen(function* () {
      const f = yield* fixture(true, true);
      const file = f[metadata];
      const original = file + ".original";
      yield* Effect.promise(() => NodeFSP.rename(file, original));
      yield* f.run();
      yield* Effect.promise(() => NodeFSP.symlink(original, file));
      yield* f.run();
      assert.deepEqual(yield* f.asks(), [
        "--version",
        "__ssh-helper protocol --shell",
        "--version",
        "__ssh-helper protocol --shell",
      ]);
    }).pipe(Effect.scoped),
);

it.effect.each([true, false])(
  "legacy unsupported protocol keeps exact-version fallback (%s)",
  (matches) =>
    Effect.gen(function* () {
      const f = yield* fixture(true, false, {
        protocolUnsupported: true,
        versionOutput: matches ? `goat v${version}` : "goat v9.9.9",
      });
      if (matches) {
        assert.deepEqual(JSON.parse(yield* f.run()), { serverVersion: version });
        assert.deepEqual(yield* f.asks(), ["--version", "__ssh-helper protocol --shell"]);
      } else {
        assert.isTrue(Exit.isFailure(yield* f.run().pipe(Effect.exit)));
        assert.deepEqual(yield* f.asks(), ["--version"]);
      }
    }).pipe(Effect.scoped),
);

it.effect("keyable legacy Windows keeps its existing warm facts cache", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true, false, { keyed: true });
    yield* f.run();
    yield* f.run();
    assert.deepEqual(yield* f.asks(), ["--version", "__ssh-helper protocol --shell"]);
  }).pipe(Effect.scoped),
);

it.effect("keyable modern Windows probes warm the existing facts cache", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true, true, { keyed: true });
    const first = yield* f.run();
    assert.deepEqual(yield* f.asks(), ["__ssh-helper runtime-manifest --shell"]);
    assert.equal(yield* f.run(), first);
    assert.deepEqual(yield* f.asks(), ["__ssh-helper runtime-manifest --shell"]);
    yield* f.replace();
    assert.equal(yield* f.run(), first);
    assert.deepEqual(yield* f.asks(), [
      "__ssh-helper runtime-manifest --shell",
      "--version",
      "__ssh-helper protocol --shell",
    ]);
    yield* f.run();
    assert.deepEqual(yield* f.asks(), [
      "__ssh-helper runtime-manifest --shell",
      "--version",
      "__ssh-helper protocol --shell",
    ]);
  }).pipe(Effect.scoped),
);
