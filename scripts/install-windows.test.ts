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
    it("repairs marker-only/broken entries, reuses a runnable cache and preserves upstream t3", async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-install-"));
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
          await powershell(`& ${ps(NodePath.join(import.meta.dirname, "install.ps1"))}`, {
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
      } finally {
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server!.close(() => resolve()));
        }
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
