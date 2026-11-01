// @effect-diagnostics nodeBuiltinImport:off - Drives the real Windows installer against a local release fixture.
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { describe, expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const ps = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const installer = NodePath.join(import.meta.dirname, "install.ps1");
const powershell = (command: string, env: NodeJS.ProcessEnv = process.env) =>
  execFile(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    { env, timeout: 90_000 },
  );

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
  "Windows archive installer",
  () => {
    // oxlint-disable-next-line goat/no-test-timeout-or-unreasoned-skip -- Windows-only integration launches real PowerShell and native archive executables; its process watchdog is 90 seconds.
    it("repairs marker-only/broken entries, reuses a runnable cache, preserves upstream t3 and runs goat opencodex install only when opted in", async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-install-"));
      // The copied node.exe stands in for goat.exe, so "goat opencodex install" runs this script.
      const commandDir = NodePath.join(root, "command");
      await NodeFSP.mkdir(commandDir);
      await NodeFSP.writeFile(
        NodePath.join(commandDir, "opencodex"),
        'if (process.argv[2] !== "install") process.exit(29); console.error("OCX_INSTALL_CALLED"); process.exit(Number(process.env.FAKE_OCX_EXIT || 0));',
      );
      let server: NodeHttp.Server | undefined;
      try {
        const version = "1.2.3";
        const stem = `goat-${version}-win32-${HostProcess.Architecture.defaultValue()}`;
        const stage = NodePath.join(root, stem);
        await NodeFSP.mkdir(stage);
        // A real native executable exercises --version without claiming SEA-build proof.
        await NodeFSP.copyFile(process.execPath, NodePath.join(stage, "goat.exe"));
        const zip = NodePath.join(root, `${stem}.zip`);
        await powershell(`Compress-Archive -LiteralPath ${ps(stage)} -DestinationPath ${ps(zip)}`);
        const bytes = await NodeFSP.readFile(zip);
        const checksum = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        let archiveRequests = 0;
        server = NodeHttp.createServer((request, response) => {
          if (request.url === `/v${version}/SHA256SUMS`) response.end(`${checksum}  ${stem}.zip\n`);
          else if (request.url === `/v${version}/${stem}.zip`) {
            archiveRequests += 1;
            response.end(bytes);
          } else response.writeHead(404).end();
        });
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
        for (const cache of ["marker-only", "broken", "ready"] as const) {
          const home = NodePath.join(root, `home ${cache}`);
          const bin = NodePath.join(root, `bin ${cache}`);
          const upstream = NodePath.join(home, "runtime", "versions", version);
          const target = NodePath.join(home, "runtime", "goat", "versions", version);
          await NodeFSP.mkdir(upstream, { recursive: true });
          await NodeFSP.mkdir(target, { recursive: true });
          await NodeFSP.mkdir(bin, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(upstream, "t3.exe"), "upstream runtime");
          await NodeFSP.writeFile(NodePath.join(upstream, ".install-complete"), version);
          await NodeFSP.writeFile(NodePath.join(bin, "t3.cmd"), "upstream launcher");
          await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), version);
          if (cache === "broken")
            await NodeFSP.writeFile(NodePath.join(target, "goat.exe"), "not an executable");
          if (cache === "ready")
            await NodeFSP.copyFile(process.execPath, NodePath.join(target, "goat.exe"));
          const before = archiveRequests;
          await powershell(`& ${ps(installer)}`, {
            ...process.env,
            GOAT_VERSION: version,
            GOAT_CHANNEL: "stable",
            GOAT_HOME: home,
            GOAT_INSTALL_BIN_DIR: bin,
            GOAT_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
          });
          expect(archiveRequests - before).toBe(cache === "ready" ? 0 : 1);
          expect(
            (await NodeFSP.readFile(NodePath.join(target, ".install-complete"), "utf8")).trim(),
          ).toBe(version);
          const result = await powershell(
            `& ${ps(NodePath.join(bin, "goat.cmd"))} --version; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
          );
          expect(result.stdout.trim()).toBe(process.version);
          expect(await NodeFSP.readFile(NodePath.join(upstream, "t3.exe"), "utf8")).toBe(
            "upstream runtime",
          );
          expect(await NodeFSP.readFile(NodePath.join(upstream, ".install-complete"), "utf8")).toBe(
            version,
          );
          expect(await NodeFSP.readFile(NodePath.join(bin, "t3.cmd"), "utf8")).toBe(
            "upstream launcher",
          );
        }
        for (const [option, exitCode] of [
          ["", "0"],
          ["--opencodex", "0"],
          ["--opencodex", "17"],
        ] as const) {
          const execution = powershell(
            `Set-Location ${ps(commandDir)}; & ${ps(installer)} ${option}`,
            {
              ...process.env,
              GOAT_VERSION: version,
              GOAT_CHANNEL: "stable",
              GOAT_HOME: NodePath.join(root, "home opencodex"),
              GOAT_INSTALL_BIN_DIR: NodePath.join(root, "bin opencodex"),
              GOAT_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
              FAKE_OCX_EXIT: exitCode,
            },
          );
          if (exitCode === "17") {
            await expect(execution).rejects.toMatchObject({
              code: 1,
              stderr: expect.stringContaining("OpenCodex installation failed; GOAT is installed"),
            });
          } else {
            const result = await execution;
            expect(result.stderr.includes("OCX_INSTALL_CALLED")).toBe(option === "--opencodex");
            if (option === "--opencodex")
              expect(result.stderr).toContain("installation alone does not make it Ready");
          }
        }
      } finally {
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server!.close(() => resolve()));
        }
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }, 120_000);

    it("prints installer help listing --opencodex before downloading or changing state", async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-install-help-"));
      try {
        const result = await powershell(`& ${ps(installer)} --help`, {
          ...process.env,
          GOAT_HOME: NodePath.join(root, "home"),
          GOAT_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
          GOAT_RELEASE_BASE_URL: "http://127.0.0.1:9",
        });
        expect(result.stdout).toContain("--opencodex");
        expect(await NodeFSP.readdir(root)).toEqual([]);
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });

    it("rejects a misspelled installer option before downloading or changing state", async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-install-typo-"));
      try {
        await expect(
          powershell(`& ${ps(installer)} --opencodxe`, {
            ...process.env,
            GOAT_HOME: NodePath.join(root, "home"),
            GOAT_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
            GOAT_RELEASE_BASE_URL: "http://127.0.0.1:9",
          }),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining("unknown option --opencodxe"),
        });
        expect(await NodeFSP.readdir(root)).toEqual([]);
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });
  },
);
