// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell script against a fake goat CLI archive.
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve(import.meta.dirname, "install-goat-server.sh");
const platformKey = `${HostProcess.Platform.defaultValue() === "darwin" ? "darwin" : "linux"}-${HostProcess.Architecture.defaultValue() === "arm64" ? "arm64" : "x64"}`;

/** A goat that records each call and prints what goat pair prints. */
const FAKE_GOAT = `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_GOAT_LOG"
case "$1" in
  --version) echo "goat v1.2.3" ;;
  opencodex) [ -z "$FAKE_OCX_FAIL" ] || exit 17 ;;
  service) ;;
  pair)
    if [ -n "$FAKE_NO_SERVER" ]; then echo "No running GOAT server found." >&2; exit 1; fi
    n=$(wc -l < "$FAKE_GOAT_LOG" | tr -d ' ')
    echo "Pairing with test (http://box.test:3773)."
    echo "Pairing URL: http://box.test:3773/pair#token=CODE$n"
    echo "Token: CODE$n"
    ;;
esac
`;

const roots: Array<string> = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const makeArchive = async (root: string, key: string) => {
  const stem = `goat-1.2.3-nightly.20261019.1-${key}`;
  await NodeFSP.mkdir(NodePath.join(root, stem));
  await NodeFSP.writeFile(NodePath.join(root, stem, "goat"), FAKE_GOAT, { mode: 0o755 });
  NodeChildProcess.execFileSync("tar", [
    "-czf",
    NodePath.join(root, `${stem}.tar.gz`),
    "-C",
    root,
    stem,
  ]);
  return NodePath.join(root, `${stem}.tar.gz`);
};

const run = async (
  args: ReadonlyArray<string>,
  options: {
    /** Runs with HOME=<root>/user and no GOAT_HOME, after preparing that home. */
    readonly userHome?: (home: string) => Promise<void>;
    /** Writes a SHA256SUMS next to the archive. */
    readonly sums?: (archive: string) => string;
    /** goat pair fails as it does when no server is running. */
    readonly noServer?: boolean;
    /** goat opencodex install exits nonzero. */
    readonly opencodexFails?: boolean;
  } = {},
) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-server-install-"));
  roots.push(root);
  const log = NodePath.join(root, "calls.log");
  await NodeFSP.writeFile(log, "");
  const { GOAT_HOME: _ambientHome, ...ambient } = process.env;
  const userHome = NodePath.join(root, "user");
  if (options.userHome !== undefined) {
    await NodeFSP.mkdir(userHome, { recursive: true });
    await options.userHome(userHome);
  }
  const env = {
    ...ambient,
    ...(options.userHome === undefined
      ? { GOAT_HOME: NodePath.join(root, "home") }
      : { HOME: userHome }),
    GOAT_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
    FAKE_GOAT_LOG: log,
    FAKE_NO_SERVER: options.noServer === true ? "1" : "",
    FAKE_OCX_FAIL: options.opencodexFails === true ? "1" : "",
    // Never reach a real installer from a test.
    GOAT_INSTALLER_URL: "http://127.0.0.1:9/install.sh",
  };
  const resolved = await Promise.all(
    args.map(async (arg) => {
      if (!arg.startsWith("archive:")) return [arg];
      const archive = await makeArchive(root, arg.slice(8));
      if (options.sums !== undefined)
        await NodeFSP.writeFile(NodePath.join(root, "SHA256SUMS"), options.sums(archive));
      return ["--archive", archive];
    }),
  );
  const result = NodeChildProcess.spawnSync("sh", [script, ...resolved.flat()], {
    env,
    encoding: "utf8",
  });
  return {
    root,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: (await NodeFSP.readFile(log, "utf8")).trim().split("\n").filter(Boolean),
  };
};

describe("install-goat-server.sh", () => {
  it("installs a CLI archive, starts the service and prints an app link and an agent-only link", async () => {
    const result = await run([`archive:${platformKey}`]);
    expect(result.stderr).toContain("Installed GOAT 1.2.3-nightly.20261019.1");
    expect(result.status).toBe(0);
    const installed = NodePath.join(
      result.root,
      "home/runtime/goat/versions/1.2.3-nightly.20261019.1",
    );
    expect(await NodeFSP.readFile(NodePath.join(installed, ".install-complete"), "utf8")).toBe(
      "1.2.3-nightly.20261019.1\n",
    );
    expect(await NodeFSP.realpath(NodePath.join(result.root, "bin/goat"))).toBe(
      await NodeFSP.realpath(NodePath.join(installed, "goat")),
    );
    expect(result.calls).toEqual([
      "--version",
      "service install",
      "pair --label GOAT app",
      "pair --label Agent link --scope orchestration:read --scope orchestration:operate",
    ]);
    expect(result.stdout).toContain("Pairing URL: http://box.test:3773/pair#token=CODE3");
    expect(result.stdout).toMatch(/Link http:\/\/box\.test:3773\/pair#token=CODE4 as \S+/);
  });

  it("publishes over Tailscale and skips the service when asked", async () => {
    const result = await run([`archive:${platformKey}`, "--tailscale", "--no-service"]);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      "--version",
      "pair --tailscale --label GOAT app",
      "pair --tailscale --label Agent link --scope orchestration:read --scope orchestration:operate",
    ]);
    expect(result.stderr).toContain("goat serve");
  });

  it("finishes with instructions when the service is skipped and no server runs", async () => {
    const result = await run([`archive:${platformKey}`, "--no-service"], { noServer: true });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["--version", "pair --label GOAT app"]);
    expect(result.stderr).toContain("then run goat pair");
  });

  it("refuses an archive built for another platform and installs nothing", async () => {
    const other = platformKey.startsWith("linux") ? "darwin-arm64" : "linux-x64";
    const result = await run([`archive:${other}`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`is built for ${other}`);
    expect(result.calls).toEqual([]);
    await expect(NodeFSP.access(NodePath.join(result.root, "bin/goat"))).rejects.toThrow();
  });

  it("refuses an archive that SHA256SUMS does not list", async () => {
    const result = await run([`archive:${platformKey}`, "--no-pair"], {
      sums: () => `${"0".repeat(64)}  goat-other.tar.gz\n`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not listed in");
    expect(result.calls).toEqual([]);
  });

  it("installs into a pre-rename ~/.t3 home that still holds the state", async () => {
    const result = await run([`archive:${platformKey}`, "--no-pair"], {
      userHome: async (home) => {
        await NodeFSP.mkdir(NodePath.join(home, ".t3/userdata"), { recursive: true });
      },
    });
    expect(result.status).toBe(0);
    await NodeFSP.access(
      NodePath.join(result.root, "user/.t3/runtime/goat/versions/1.2.3-nightly.20261019.1/goat"),
    );
  });

  it("installs OpenCodex through the installed goat before starting the service when opted in", async () => {
    const result = await run([`archive:${platformKey}`, "--opencodex"]);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      "--version",
      "opencodex install",
      "service install",
      "pair --label GOAT app",
      "pair --label Agent link --scope orchestration:read --scope orchestration:operate",
    ]);
    expect(result.stderr).toContain("installation alone does not make it Ready");
  });

  it("installs OpenCodex even when the service and pairing links are skipped", async () => {
    const result = await run([
      `archive:${platformKey}`,
      "--opencodex",
      "--no-service",
      "--no-pair",
    ]);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["--version", "opencodex install"]);
  });

  it("stops before the service and pairing links when OpenCodex installation fails", async () => {
    const result = await run([`archive:${platformKey}`, "--opencodex"], {
      opencodexFails: true,
    });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual(["--version", "opencodex install"]);
    expect(result.stderr).toContain("OpenCodex installation failed; GOAT is installed");
  });

  it("prints help listing --opencodex without installing anything", async () => {
    const result = await run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain("--opencodex");
  });

  it("rejects a misspelled option before installing anything", async () => {
    const result = await run(["--opencodxe"]);
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain("unknown option --opencodxe");
  });
});
