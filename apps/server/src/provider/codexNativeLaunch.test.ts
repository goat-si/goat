import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { codexNativeLaunch } from "./codexNativeLaunch.ts";

const VERSION = "0.166.0";
const DARWIN_ARM64 = { platform: "darwin", arch: "arm64", triple: "aarch64-apple-darwin" } as const;
const LINUX_X64 = { platform: "linux", arch: "x64", triple: "x86_64-unknown-linux-musl" } as const;
type Host = typeof DARWIN_ARM64 | typeof LINUX_X64;
const PLATFORM_PACKAGE = { darwin: "codex-darwin-arm64", linux: "codex-linux-x64" } as const;
const STALE_MANAGERS = { CODEX_MANAGED_BY_PNPM: "1", CODEX_MANAGED_BY_BUN: "1" };

const write = Effect.fn("test.write")(function* (file: string, content: string, mode = 0o644) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, content);
  yield* fs.chmod(file, mode);
});

const link = Effect.fn("test.link")(function* (target: string, file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.symlink(target, file);
});

const writeRoot = Effect.fn("test.writeRoot")(function* (root: string, name = "@openai/codex") {
  const path = yield* Path.Path;
  yield* write(
    path.join(root, "package.json"),
    JSON.stringify({ name, version: VERSION, bin: { codex: "bin/codex.js" } }),
  );
  yield* write(path.join(root, "bin", "codex.js"), "#!/usr/bin/env node\n", 0o755);
});

/** Writes vendor/<triple> under packageDir and returns the native binary path. */
const writeVendor = Effect.fn("test.writeVendor")(function* (
  packageDir: string,
  host: Host = DARWIN_ARM64,
  vendorVersion = VERSION,
) {
  const path = yield* Path.Path;
  const vendor = path.join(packageDir, "vendor", host.triple);
  yield* write(
    path.join(vendor, "codex-package.json"),
    JSON.stringify({
      layoutVersion: 1,
      version: vendorVersion,
      target: host.triple,
      variant: "codex",
      entrypoint: "bin/codex",
    }),
  );
  const binary = path.join(vendor, "bin", "codex");
  yield* write(binary, "native", 0o755);
  return binary;
});

const writePlatformPackage = Effect.fn("test.writePlatformPackage")(function* (
  packageDir: string,
  host: Host = DARWIN_ARM64,
  vendorVersion = VERSION,
) {
  const path = yield* Path.Path;
  yield* write(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "@openai/codex", version: VERSION + "-" + host.platform }),
  );
  return yield* writeVendor(packageDir, host, vendorVersion);
});

/** npm -g: <prefix>/bin/codex links to lib/node_modules/@openai/codex/bin/codex.js. */
const npmLayout = Effect.fn("test.npmLayout")(function* (
  base: string,
  options: {
    host?: Host;
    vendorVersion?: string;
    vendor?: "platform" | "root" | "none";
    name?: string;
  } = {},
) {
  const path = yield* Path.Path;
  const host = options.host ?? DARWIN_ARM64;
  const modules = path.join(base, "prefix", "lib", "node_modules");
  const root = path.join(modules, "@openai", "codex");
  yield* writeRoot(root, options.name);
  const vendor = options.vendor ?? "platform";
  const binary =
    vendor === "platform"
      ? yield* writePlatformPackage(
          path.join(modules, "@openai", PLATFORM_PACKAGE[host.platform]),
          host,
          options.vendorVersion,
        )
      : vendor === "root"
        ? yield* writeVendor(root, host, options.vendorVersion)
        : undefined;
  const bin = path.join(base, "prefix", "bin");
  yield* link("../lib/node_modules/@openai/codex/bin/codex.js", path.join(bin, "codex"));
  return { bin, root, binary, manager: "CODEX_MANAGED_BY_NPM" };
});

const bunLayout = Effect.fn("test.bunLayout")(function* (base: string) {
  const path = yield* Path.Path;
  const modules = path.join(base, ".bun", "install", "global", "node_modules");
  const root = path.join(modules, "@openai", "codex");
  yield* writeRoot(root);
  const binary = yield* writePlatformPackage(path.join(modules, "@openai", "codex-darwin-arm64"));
  const bin = path.join(base, ".bun", "bin");
  yield* link("../install/global/node_modules/@openai/codex/bin/codex.js", path.join(bin, "codex"));
  return { bin, root, binary, manager: "CODEX_MANAGED_BY_BUN" };
});

const PNPM_TARGET = "global/5/node_modules/@openai/codex/bin/codex.js";
const PNPM_LEGACY_BASEDIR = 'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")';
const PNPM_NODE_PATH = '  export NODE_PATH="$basedir/global/5/node_modules"';
const PNPM_SHIMS = {
  // pnpm 11's shape: it records the target and resolves the shim's own symlinks.
  marked: [
    "#!/bin/sh",
    'basedir_abs=$(CDPATH= cd -P -- "$basedir" && pwd -P) || exit $?',
    'if [ -z "$NODE_PATH" ]; then',
    '  export NODE_PATH="$basedir_abs/global/5/node_modules"',
    "else",
    '  export NODE_PATH="$basedir_abs/global/5/node_modules:$NODE_PATH"',
    "fi",
    'if [ -n "$exe" ] && [ -x "$basedir/node.exe" ]; then',
    '  exec "$basedir/node.exe"  "$basedir_win/' + PNPM_TARGET + '" "$@"',
    'elif [ -x "$basedir/node" ]; then',
    '  exec "$basedir/node"  "$basedir_abs/' + PNPM_TARGET + '" "$@"',
    "else",
    '  exec node  "$basedir_abs/' + PNPM_TARGET + '" "$@"',
    "fi",
    "# cmd-shim-target=" + PNPM_TARGET,
  ].join("\n"),
  legacy: [
    "#!/bin/sh",
    PNPM_LEGACY_BASEDIR,
    PNPM_NODE_PATH,
    'if [ -x "$basedir/node" ]; then',
    '  exec "$basedir/node"  "$basedir/' + PNPM_TARGET + '" "$@"',
    "else",
    '  exec node  "$basedir/' + PNPM_TARGET + '" "$@"',
    "fi",
  ].join("\n"),
  exportsMore: [
    "#!/bin/sh",
    PNPM_LEGACY_BASEDIR,
    "export CODEX_HOME=/elsewhere",
    'exec node  "$basedir/' + PNPM_TARGET + '" "$@"',
  ].join("\n"),
  markerDisagrees: [
    "#!/bin/sh",
    'exec node  "$basedir_abs/global/5/other.js" "$@"',
    "# cmd-shim-target=" + PNPM_TARGET,
  ].join("\n"),
  otherBranch: [
    "#!/bin/sh",
    PNPM_LEGACY_BASEDIR,
    'if [ -n "$CI" ]; then',
    '  exec node  "$basedir/' + PNPM_TARGET + '" "$@"',
    "else",
    '  exec /usr/local/bin/other-codex "$@"',
    "fi",
  ].join("\n"),
};

/** pnpm add -g: a sh shim in PNPM_HOME, packages in the global virtual store. */
const pnpmLayout = Effect.fn("test.pnpmLayout")(function* (base: string, shim: string) {
  const path = yield* Path.Path;
  const home = path.join(base, "pnpm");
  const store = path.join(home, "global", "5", ".pnpm");
  const rootModules = path.join(store, "@openai+codex@" + VERSION, "node_modules");
  const root = path.join(rootModules, "@openai", "codex");
  yield* writeRoot(root);
  const binary = yield* writePlatformPackage(
    path.join(
      store,
      "@openai+codex@" + VERSION + "-darwin-arm64",
      "node_modules",
      "@openai",
      "codex",
    ),
  );
  yield* link(
    "../../../@openai+codex@" + VERSION + "-darwin-arm64/node_modules/@openai/codex",
    path.join(rootModules, "@openai", "codex-darwin-arm64"),
  );
  const globalModules = path.join(home, "global", "5", "node_modules");
  yield* write(path.join(globalModules, ".modules.yaml"), "layoutVersion: 5\n");
  yield* link(
    "../../.pnpm/@openai+codex@" + VERSION + "/node_modules/@openai/codex",
    path.join(globalModules, "@openai", "codex"),
  );
  yield* write(path.join(home, "codex"), shim, 0o755);
  return { bin: home, root, binary, manager: "CODEX_MANAGED_BY_PNPM" };
});

/** vp install -g: <home>/bin/codex links to vp, which reads packages/@openai/codex.json. */
const vitePlusLayout = Effect.fn("test.vitePlusLayout")(function* (
  base: string,
  installId: "a1b2" | "#a1b2",
) {
  const path = yield* Path.Path;
  const home = path.join(base, ".vite-plus");
  const packages = path.join(home, "packages");
  yield* write(
    path.join(packages, "@openai", "codex.json"),
    JSON.stringify({ name: "@openai/codex", version: VERSION, installId }),
  );
  const installDir = installId.startsWith("#")
    ? path.join(packages, "@openai", "codex" + installId)
    : path.join(packages, "@openai", "codex", installId);
  const modules = installId.startsWith("#")
    ? path.join(installDir, "lib", "node_modules")
    : path.join(installDir, "node_modules");
  const root = path.join(modules, "@openai", "codex");
  yield* writeRoot(root);
  const binary = yield* writePlatformPackage(path.join(modules, "@openai", "codex-darwin-arm64"));
  const bin = path.join(home, "bin");
  yield* write(path.join(bin, "vp"), "vp", 0o755);
  yield* link("vp", path.join(bin, "codex"));
  return { bin, root, binary, manager: "CODEX_MANAGED_BY_VITE_PLUS" };
});

const launchOn = (host: Host, command: string, env: NodeJS.ProcessEnv) =>
  codexNativeLaunch({ command, args: ["app-server"], env, threadId: "thread-1" }).pipe(
    Effect.provideService(HostProcess.Platform, host.platform),
    Effect.provideService(HostProcess.Architecture, host.arch),
  );

const tempBase = Effect.fn("test.tempBase")(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "goat-codex-native-" }));
});

const managers = (env: NodeJS.ProcessEnv) =>
  Object.keys(env)
    .filter((key) => key.startsWith("CODEX_MANAGED_BY_"))
    .toSorted();

it.effect.each([
  { name: "npm with its platform package", layout: (base: string) => npmLayout(base) },
  {
    name: "npm with vendor inside the package",
    layout: (base: string) => npmLayout(base, { vendor: "root" }),
  },
  {
    name: "npm on linux musl",
    layout: (base: string) => npmLayout(base, { host: LINUX_X64 }),
    host: LINUX_X64,
  },
  { name: "bun", layout: bunLayout },
  {
    name: "pnpm with a marked shim",
    layout: (base: string) => pnpmLayout(base, PNPM_SHIMS.marked),
  },
  {
    name: "pnpm with a legacy shim",
    layout: (base: string) => pnpmLayout(base, PNPM_SHIMS.legacy),
  },
  { name: "vite-plus", layout: (base: string) => vitePlusLayout(base, "a1b2") },
  {
    name: "vite-plus with a legacy install id",
    layout: (base: string) => vitePlusLayout(base, "#a1b2"),
  },
])("a bare codex on PATH from $name launches the native binary", ({ layout, host }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* tempBase();
    const installed = yield* layout(base);
    const result = yield* launchOn(host ?? DARWIN_ARM64, "codex", {
      PATH: [base + "/empty", installed.bin].join(":"),
      KEEP: "yes",
      ...STALE_MANAGERS,
    });
    expect(result.command).toBe(yield* fs.realPath(installed.binary ?? ""));
    expect(result.args).toEqual(["app-server"]);
    expect(result.threadId).toBe("thread-1");
    expect(result.env.KEEP).toBe("yes");
    expect(result.env.CODEX_MANAGED_PACKAGE_ROOT).toBe(yield* fs.realPath(installed.root));
    expect(managers(result.env)).toEqual([installed.manager]);
    expect(result.env[installed.manager]).toBe("1");
    expect(result.env._RJEM_MALLOC_CONF).toBe("narenas:2");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("an absolute path to an npm codex link launches the native binary", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* tempBase();
    const installed = yield* npmLayout(base);
    const result = yield* launchOn(DARWIN_ARM64, installed.bin + "/codex", { PATH: "" });
    expect(result.command).toBe(yield* fs.realPath(installed.binary ?? ""));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  {
    name: "a vendor version that differs from the package",
    layout: (base: string) => npmLayout(base, { vendorVersion: "0.165.0" }),
  },
  {
    name: "a missing vendor binary",
    layout: (base: string) => npmLayout(base, { vendor: "none" }),
  },
  {
    name: "a codex.js from another package",
    layout: (base: string) => npmLayout(base, { name: "@someone/codex" }),
  },
  {
    name: "a shim for another program",
    layout: Effect.fn(function* (base: string) {
      const path = yield* Path.Path;
      yield* write(path.join(base, "bin", "lib", "cli.js"), "", 0o755);
      yield* write(
        path.join(base, "bin", "codex"),
        '#!/bin/sh\nexec node  "$basedir/lib/cli.js" "$@"\n',
        0o755,
      );
      return { bin: path.join(base, "bin") };
    }),
  },
  {
    name: "a native codex binary",
    layout: Effect.fn(function* (base: string) {
      const path = yield* Path.Path;
      yield* write(path.join(base, "bin", "codex"), "native", 0o755);
      return { bin: path.join(base, "bin") };
    }),
  },
  { name: "no codex on PATH", layout: (base: string) => Effect.succeed({ bin: base + "/empty" }) },
  {
    name: "a shim that exports more than NODE_PATH",
    layout: (base: string) => pnpmLayout(base, PNPM_SHIMS.exportsMore),
  },
  {
    name: "a package.json over the read limit",
    layout: Effect.fn(function* (base: string) {
      const path = yield* Path.Path;
      const installed = yield* npmLayout(base);
      yield* write(
        path.join(installed.root, "package.json"),
        JSON.stringify({ name: "@openai/codex", version: VERSION, padding: "x".repeat(70_000) }),
      );
      return installed;
    }),
  },
  {
    name: "a shim marker that disagrees with its exec line",
    layout: (base: string) => pnpmLayout(base, PNPM_SHIMS.markerDisagrees),
  },
  {
    name: "a shim that runs another program on one branch",
    layout: (base: string) => pnpmLayout(base, PNPM_SHIMS.otherBranch),
  },
  {
    name: "a relative PATH entry ahead of the install",
    layout: Effect.fn(function* (base: string) {
      const installed = yield* npmLayout(base);
      return { bin: "relative/bin:" + installed.bin };
    }),
  },
  {
    name: "an empty PATH entry ahead of the install",
    layout: Effect.fn(function* (base: string) {
      const installed = yield* npmLayout(base);
      return { bin: ":" + installed.bin };
    }),
  },
  {
    name: "windows",
    layout: (base: string) => npmLayout(base),
    host: { ...DARWIN_ARM64, platform: "win32" },
  },
])("$name leaves the command unchanged", ({ layout, host }) =>
  Effect.gen(function* () {
    const base = yield* tempBase();
    const installed = yield* layout(base);
    const result = yield* launchOn((host ?? DARWIN_ARM64) as Host, "codex", {
      PATH: installed.bin,
      CODEX_MANAGED_BY_BUN: "1",
    });
    expect(result.command).toBe("codex");
    expect(result.env.CODEX_MANAGED_PACKAGE_ROOT).toBeUndefined();
    expect(result.env.CODEX_MANAGED_BY_BUN).toBe("1");
    expect(result.env._RJEM_MALLOC_CONF).toBe("narenas:2");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a relative command path is left unchanged", () =>
  Effect.gen(function* () {
    const result = yield* launchOn(DARWIN_ARM64, "bin/codex", { PATH: "/usr/bin" });
    expect(result.command).toBe("bin/codex");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a vendor binary installed after a fallback is used on the next launch", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* tempBase();
    const installed = yield* npmLayout(base, { vendor: "none" });
    const env = { PATH: installed.bin };
    expect((yield* launchOn(DARWIN_ARM64, "codex", env)).command).toBe("codex");
    const binary = yield* writePlatformPackage(
      path.join(path.dirname(installed.root), "codex-darwin-arm64"),
    );
    expect((yield* launchOn(DARWIN_ARM64, "codex", env)).command).toBe(yield* fs.realPath(binary));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a jemalloc setting from the user's environment is kept", () =>
  Effect.gen(function* () {
    const result = yield* launchOn(DARWIN_ARM64, "codex", {
      PATH: "",
      _RJEM_MALLOC_CONF: "narenas:8",
    });
    expect(result.env._RJEM_MALLOC_CONF).toBe("narenas:8");
  }).pipe(Effect.provide(NodeServices.layer)),
);
