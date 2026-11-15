// @effect-diagnostics nodeBuiltinImport:off - Runs the rendered launcher in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

import { type CliShimTarget, install, launcherPath, renderCliShim } from "./DesktopCliShim.ts";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

const tempRoot = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-cli-shim-"));
  directories.push(root);
  return root;
};

const writeExecutable = (path: string, content: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content, { mode: 0o755 });
};

const writeShim = (root: string, target: CliShimTarget) => {
  const shim = NodePath.join(root, "bin", "goat");
  writeExecutable(shim, renderCliShim({ target, shimPath: shim, goatHome: `${root}/home` }));
  return shim;
};

const run = (shim: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
  NodeChildProcess.spawnSync(shim, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });

const REPORTER =
  '#!/bin/sh\necho "node=$ELECTRON_RUN_AS_NODE cli=$GOAT_CLI_PATH home=$GOAT_HOME appimage=$APPIMAGE"\nprintf "%s\\n" "$@"\nexit 3\n';

const fakeAppImage = (canMount = true, app = REPORTER) => {
  const root = tempRoot();
  const image = NodePath.join(root, "image");
  writeExecutable(NodePath.join(image, "t3code"), app);
  const appImage = NodePath.join(root, "T3 Code.AppImage");
  writeExecutable(
    appImage,
    [
      "#!/bin/sh",
      `if [ "$1" = --appimage-extract ]; then cp -R '${image}' squashfs-root; exit 0; fi`,
      '[ "$1" = --appimage-mount ] || exit 9',
      '[ -n "$APPIMAGE_EXTRACT_AND_RUN" ] && exit 8',
      `echo $$ >'${root}/mounter.pid'`,
      canMount ? `echo '${image}'` : 'echo "Cannot mount AppImage"; exit 1',
      // Like the FUSE runtime, any of these unmounts. fd 3 reports to the test when it is open.
      "trap 'echo unmounted >&3 2>/dev/null; exit 0' TERM HUP INT",
      "trap 'echo mounted >&3 2>/dev/null' WINCH",
      "while :; do sleep 0.05; done",
      "",
    ].join("\n"),
  );
  const shim = writeShim(root, { kind: "appimage", appImage, executableName: "t3code" });
  return { root, image, appImage, shim };
};

// Stays up after a signal until the test lets it finish, like a server shutting down.
const SLOW_SERVER = [
  "#!/bin/sh",
  "trap 'echo stopping >&3; read go; echo stopped >&3; exit 0' TERM HUP",
  "echo ready",
  "while :; do sleep 0.05; done",
  "",
].join("\n");

// The launcher mounts only under setsid, which stock macOS and Windows lack; there it extracts instead.
const hasSetsid = NodeChildProcess.spawnSync("setsid", ["true"]).status === 0;

const lines = (stream: NodeJS.ReadableStream) => {
  const seen: Array<string> = [];
  const waiters: Array<() => void> = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop()!;
    seen.push(...parts);
    for (const wake of waiters.splice(0)) wake();
  });
  const until = async (match: (line: string) => boolean) => {
    for (;;) {
      const line = seen.find(match);
      if (line !== undefined) return line;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return { seen, until };
};

describe("renderCliShim", () => {
  effectIt.effect(
    "executes a packaged GOAT shim in a scratch HOME, respecting overrides and preserving upstream data",
    () =>
      Effect.gen(function* () {
        const root = tempRoot();
        const old = NodePath.join(root, ".t3", "sentinel");
        NodeFS.mkdirSync(NodePath.dirname(old), { recursive: true });
        NodeFS.writeFileSync(old, "upstream data");
        const executable = NodePath.join(root, "app");
        writeExecutable(executable, REPORTER);
        for (const override of [undefined, NodePath.join(root, "custom")]) {
          const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
            Effect.provide(
              DesktopEnvironment.layer({
                dirname: "/repo/apps/desktop/dist-electron",
                homeDirectory: root,
                platform: "darwin",
                processArch: "arm64",
                appVersion: "1.2.3",
                appPath: "/install/app.asar",
                isPackaged: true,
                resourcesPath: "/install",
                runningUnderArm64Translation: false,
              }).pipe(
                Layer.provide(
                  Layer.mergeAll(
                    NodeServices.layer,
                    DesktopConfig.layerTest({ GOAT_HOME: override }),
                  ),
                ),
              ),
            ),
          );
          const shim = launcherPath(environment);
          const selected = override ?? NodePath.join(root, ".goat", "desktop");
          expect(environment.baseDir).toBe(selected);
          const content = renderCliShim({
            target: { kind: "direct", executable, entry: "/bin.mjs" },
            shimPath: shim,
            goatHome: environment.baseDir,
          });
          expect(content).toContain(selected);
          expect(content).not.toContain(".t3");
          writeExecutable(shim, content);
          const result = run(shim, [], { HOME: root });
          expect(result.status).toBe(3);
          expect(result.stdout).toContain(`home=${selected}`);
          expect(
            run(shim, [], { HOME: root, GOAT_HOME: `${root}/runtime-override` }).stdout,
          ).toContain(`home=${root}/runtime-override`);
        }
        expect(NodeFS.readFileSync(old, "utf8")).toBe("upstream data");
        expect(NodeFS.readdirSync(NodePath.dirname(old))).toEqual(["sentinel"]);
      }),
  );

  effectIt.effect(
    "keeps a launcher per channel, each in its channel's GOAT home (#1091, #1009)",
    () =>
      Effect.gen(function* () {
        const root = tempRoot();
        const installChannel = (appVersion: string, appPath: string) =>
          install.pipe(
            Effect.map(Option.getOrThrow),
            Effect.provide(
              DesktopEnvironment.layer({
                dirname: "/repo/apps/desktop/dist-electron",
                homeDirectory: root,
                platform: "darwin",
                processArch: "arm64",
                appVersion,
                appPath,
                isPackaged: true,
                resourcesPath: NodePath.dirname(appPath),
                runningUnderArm64Translation: false,
              }).pipe(
                Layer.provideMerge(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
              ),
            ),
          );
        const stableApp = "/Applications/GOAT.app/Contents/Resources/app.asar";
        const nightlyApp = "/Applications/GOAT (Nightly).app/Contents/Resources/app.asar";
        const stable = yield* installChannel("0.1.1", stableApp);
        const nightly = yield* installChannel("0.1.2-nightly.20261023.256", nightlyApp);

        const home = NodePath.join(root, ".goat", "desktop");
        expect(stable).toBe(NodePath.join(home, "bin", "goat"));
        expect(nightly).not.toBe(stable);
        expect(
          nightly.startsWith(NodePath.join(root, ".goat", "desktop-nightly") + NodePath.sep),
        ).toBe(true);
        for (const [launcher, app] of [
          [stable, stableApp],
          [nightly, nightlyApp],
        ] as const) {
          const content = NodeFS.readFileSync(launcher, "utf8");
          expect(content).toContain(`export GOAT_CLI_PATH='${launcher}'`);
          expect(content).toContain(`'${app}/apps/server/dist/bin.mjs'`);
        }
      }),
  );

  it.skipIf(!hasSetsid).each(["SIGTERM", "SIGHUP"] as const)(
    "keeps the AppImage mounted until the server exits after %s to the process group",
    async (signal) => {
      const { root, shim } = fakeAppImage(true, SLOW_SERVER);
      const child = NodeChildProcess.spawn(shim, [], {
        detached: true,
        env: { PATH: process.env.PATH },
        stdio: ["pipe", "pipe", "ignore", "pipe"],
      });
      let mounter: number | undefined;
      try {
        const stdout = lines(child.stdout!);
        const events = lines(child.stdio[3] as NodeJS.ReadableStream);
        const exited = new Promise((resolve) => child.on("close", resolve));
        await stdout.until((line) => line === "ready");
        mounter = Number(NodeFS.readFileSync(NodePath.join(root, "mounter.pid"), "utf8"));

        // Ctrl-C in a terminal, a closed SSH session, or a service manager signals the whole group.
        process.kill(-child.pid!, signal);
        // The shell runs pending traps in ascending signal number, and WINCH outnumbers TERM and
        // HUP, so a mounter that also got the group signal unmounts before it answers this probe.
        process.kill(mounter, "SIGWINCH");
        const mount = await events.until((line) => line === "mounted" || line === "unmounted");
        expect(mount).toBe("mounted");

        await events.until((line) => line === "stopping");
        child.stdin!.end("go\n");
        await exited;
        expect(events.seen.slice(-2)).toEqual(["stopped", "unmounted"]);
      } finally {
        for (const pid of [-child.pid!, mounter]) {
          if (pid === undefined) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
    },
  );

  it("extracts the AppImage where it cannot be mounted", () => {
    const { shim } = fakeAppImage(false);
    const result = run(shim, ["--version"], { APPIMAGE_EXTRACT_AND_RUN: "1" });
    expect(result.status).toBe(3);
    expect(result.stdout).toMatch(
      /squashfs-root\/resources\/app\.asar\/apps\/server\/dist\/bin\.mjs/,
    );
  });

  it.each([true, false])("passes the AppImage path to the CLI (mounted=%s)", (mounted) => {
    const { appImage, shim } = fakeAppImage(mounted);
    const result = run(shim, ["--version"]);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain(`appimage=${appImage}`);
  });

  it("keeps the install's GOAT home under sudo, unless one is set", () => {
    const root = tempRoot();
    writeExecutable(NodePath.join(root, "app"), REPORTER);
    const shim = writeShim(root, {
      kind: "direct",
      executable: NodePath.join(root, "app"),
      entry: "/bin.mjs",
    });
    expect(run(shim, []).stdout).toContain(`home=${root}/home`);
    expect(run(shim, [], { GOAT_HOME: "/elsewhere" }).stdout).toContain("home=/elsewhere");
    const relative = NodeChildProcess.spawnSync("./bin/goat", [], { cwd: root, encoding: "utf8" });
    expect(relative.stdout).toContain(`cli=${shim}`);
  });

  it("runs an installed app's server directly", () => {
    const root = tempRoot();
    const executable = NodePath.join(root, "opt", "T3 Code", "t3code");
    writeExecutable(executable, REPORTER);
    const shim = writeShim(root, {
      kind: "direct",
      executable,
      entry: "/opt/T3's/app.asar/bin.mjs",
    });
    expect(run(shim, ["browser", "setup"]).stdout.split("\n").slice(1)).toEqual([
      "/opt/T3's/app.asar/bin.mjs",
      "browser",
      "setup",
      "",
    ]);
  });

  it("writes a Windows launcher that keeps cmd from reinterpreting paths", () => {
    const executable = "C:\\Apps\\R&whoami&X 100%\\!CHANNEL!\\T3 Code.exe";
    const script = renderCliShim({
      target: { kind: "windows", executable, entry: "C:\\Apps\\server.asar\\bin.mjs" },
      shimPath: "C:\\Users\\José\\.t3\\bin\\goat.cmd",
      goatHome: "C:\\Users\\José\\.t3",
    });
    const lines = script.split("\r\n");
    expect(lines).toContain("setlocal EnableExtensions DisableDelayedExpansion");
    expect(lines).toContain("chcp 65001 >nul");
    expect(lines).toContain(
      'if exist "C:\\Apps\\R&whoami&X 100%%\\!CHANNEL!\\T3 Code.exe" goto run',
    );
    const bare = lines.filter(
      (line) => line.includes("whoami") && !/"[^"]*whoami[^"]*"/.test(line),
    );
    expect(bare).toEqual([]);
    expect(lines).toContain('set "GOAT_CLI_PATH=C:\\Users\\José\\.t3\\bin\\goat.cmd"');
  });
});
