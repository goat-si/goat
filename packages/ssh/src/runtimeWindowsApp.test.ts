// @effect-diagnostics nodeBuiltinImport:off - Runs the real PowerShell operation against a loopback server the test owns.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";

import {
  powershellCommand,
  WINDOWS_LOADER,
  windowsAppOperations,
  windowsFrame,
} from "./runtimeWindowsScripts.ts";

const TOKEN = "ab".repeat(32);
const ID = "44444444-4444-4444-8444-444444444444";
const INSTANCE = "instance-app-1";
const STATE = ".goat/desktop/userdata";

const powershell = (args: ReadonlyArray<string>, stdin: Uint8Array | string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const [exe = "powershell.exe", ...rest] = args;
    const child = NodeChildProcess.spawn(exe, rest, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });

/** The operation as an SSH client frames it, with the fixture home as the user's profile. */
const runOp = (root: string, request: object) =>
  powershell(
    powershellCommand(WINDOWS_LOADER),
    windowsFrame(windowsAppOperations("'" + root.replaceAll("'", "''") + "'"), request),
  );

/** A loopback stand-in for the desktop app's server, run by this test's own process. */
const startApp = (descriptor: Record<string, unknown>, chunked = false) =>
  new Promise<{ port: number; sessions: Array<string | undefined>; server: NodeHttp.Server }>(
    (resolve, reject) => {
      const sessions: Array<string | undefined> = [];
      const server = NodeHttp.createServer((request, response) => {
        if (request.method === "GET" && request.url === "/.well-known/goat/environment") {
          const bytes = Buffer.from(JSON.stringify(descriptor));
          if (!chunked) return void response.end(bytes);
          // Three-byte characters split across chunks: framing counts bytes, not characters.
          const middle = bytes.indexOf(Buffer.from("맥")) + 1;
          response.write(bytes.subarray(0, middle));
          response.end(bytes.subarray(middle));
          return;
        }
        if (request.method === "POST" && request.url === "/.well-known/goat/runtime/session") {
          const header = request.headers["x-goat-runtime-control"];
          sessions.push(typeof header === "string" ? header : undefined);
          response.statusCode = header === TOKEN ? 200 : 403;
          response.end(JSON.stringify({ sessionId: "app-session-1", token: "issued" }));
          return;
        }
        response.statusCode = 404;
        response.end();
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address !== "object" || address === null) return reject(new Error("no port"));
        resolve({ port: address.port, sessions, server });
      });
    },
  );

const writeApp = async (
  root: string,
  record: { readonly pid: number; readonly port: number; readonly instanceId?: string },
  token: string | null = TOKEN,
) => {
  const dir = NodePath.join(root, ...STATE.split("/"));
  await NodeFSP.mkdir(dir, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(dir, "server-runtime.json"),
    JSON.stringify({
      version: 1,
      pid: record.pid,
      port: record.port,
      origin: "http://127.0.0.1:" + record.port,
      startedAt: "2026-11-07T00:00:00.000Z",
      ...(record.instanceId === undefined ? {} : { instanceId: record.instanceId }),
    }),
  );
  await NodeFSP.writeFile(NodePath.join(dir, "environment-id"), ID + "\n");
  if (token === null)
    await NodeFSP.rm(NodePath.join(dir, "runtime-control.token"), { force: true });
  else await NodeFSP.writeFile(NodePath.join(dir, "runtime-control.token"), token + "\n");
};

const fixture = async (descriptor: Record<string, unknown> = {}, chunked = false) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-win-app-"));
  const app = await startApp(
    {
      environmentId: ID,
      instanceId: INSTANCE,
      serverVersion: "0.1.0",
      capabilities: { runtimeSessions: true },
      ...descriptor,
    },
    chunked,
  );
  return {
    root,
    app,
    [Symbol.asyncDispose]: async () => {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
};

/** Whether this test process runs in a desktop session; SSH and CI services run in Session 0. */
const inDesktopSession = async () => {
  const { stdout } = await powershell(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "-"],
    "(Get-Process -Id " + process.pid + ").SessionId\n",
  );
  return Number(stdout.trim()) !== 0;
};

describe.runIf(HostProcess.Platform.defaultValue() === "win32")(
  "Windows desktop app server",
  () => {
    it("attaches only an app server whose loopback listener the recorded process owns", async () => {
      await using env = await fixture();
      await writeApp(env.root, { pid: process.pid, port: env.app.port, instanceId: INSTANCE });
      const desktop = await inDesktopSession();
      const probe = await runOp(env.root, { op: "app-probe" });
      const lines = probe.stdout.trim().split(/\r?\n/u);
      if (desktop) {
        expect(lines[0]).toBe(
          "GOAT_APP_SERVER=live " + process.pid + " " + env.app.port + " " + STATE,
        );
        expect(lines.at(-1)).toBe("GOAT_APP_SERVER_ID=" + ID);
      } else {
        // Every identity check passed; only the missing desktop refuses it.
        expect(lines).toEqual(["GOAT_APP_SERVER=no-desktop"]);
      }
      // Another live process of this user names the port it does not listen on.
      await writeApp(env.root, { pid: process.ppid, port: env.app.port, instanceId: INSTANCE });
      expect((await runOp(env.root, { op: "app-probe" })).stdout.trim()).toBe(
        "GOAT_APP_SERVER=port-owner",
      );
      expect(env.app.sessions).toEqual([]);
    });

    it("writes the control token only on the verified connection to a desktop session", async () => {
      await using env = await fixture();
      await writeApp(env.root, { pid: process.pid, port: env.app.port, instanceId: INSTANCE });
      const desktop = await inDesktopSession();
      const body = JSON.stringify({
        kind: "session",
        subject: "mcp-client",
        scopes: ["orchestration:read"],
        ttl: "30s",
      });
      const issued = await runOp(env.root, {
        op: "app-session",
        port: env.app.port,
        environmentId: ID,
        body,
      });
      if (desktop) {
        expect(issued.stdout.trim().split(/\r?\n/u).at(-1)).toBe("GOAT_HTTP_STATUS=200");
        expect(env.app.sessions).toEqual([TOKEN]);
      } else {
        expect(issued.code).toBe(1);
        expect(issued.stderr).toContain("GOAT_NATIVE_ERROR=no-desktop");
        expect(env.app.sessions).toEqual([]);
      }
      await writeApp(env.root, { pid: process.ppid, port: env.app.port, instanceId: INSTANCE });
      const squatted = await runOp(env.root, { op: "app-session", port: env.app.port, body });
      expect(squatted.stderr).toContain("GOAT_NATIVE_ERROR=port-owner");
      expect(env.app.sessions).toHaveLength(desktop ? 1 : 0);
    });

    it("reads a chunked descriptor whose multibyte label spans chunks", async () => {
      await using env = await fixture({ label: "집 맥미니 데스크톱" }, true);
      await writeApp(env.root, { pid: process.pid, port: env.app.port, instanceId: INSTANCE });
      const lines = (await runOp(env.root, { op: "app-probe" })).stdout.trim().split(/\r?\n/u);
      if (await inDesktopSession())
        expect(JSON.parse(lines[1] ?? "").label).toBe("집 맥미니 데스크톱");
      // Session 0 refuses only after the descriptor parsed and matched the record.
      else expect(lines).toEqual(["GOAT_APP_SERVER=no-desktop"]);
    });

    it("refuses records that do not prove which server they name", async () => {
      await using env = await fixture({ instanceId: "another-instance" });
      const probe = async () => (await runOp(env.root, { op: "app-probe" })).stdout.trim();
      await writeApp(env.root, { pid: process.pid, port: env.app.port });
      expect(await probe()).toBe("GOAT_APP_SERVER=bad-record");
      await writeApp(env.root, { pid: process.pid, port: env.app.port, instanceId: INSTANCE });
      expect(await probe()).toBe("GOAT_APP_SERVER=identity");
      await writeApp(
        env.root,
        { pid: process.pid, port: env.app.port, instanceId: INSTANCE },
        null,
      );
      expect(await probe()).toBe("GOAT_APP_SERVER=no-token");
      // A quit app's PID no longer runs: nothing to attach, nothing to refuse.
      await writeApp(env.root, { pid: 2_147_483_000, port: env.app.port, instanceId: INSTANCE });
      // Its environment stays on disk, so it is stopped rather than absent.
      expect(await probe()).toBe("GOAT_APP_SERVER=none\r\nGOAT_APP_SERVER_STOPPED=1");
      // A junction anywhere on the path is refused before any record is read.
      await NodeFSP.rm(NodePath.join(env.root, ".goat"), { recursive: true });
      const elsewhere = NodePath.join(env.root, "elsewhere");
      await NodeFSP.mkdir(NodePath.join(elsewhere, "desktop", "userdata"), { recursive: true });
      await NodeFSP.symlink(elsewhere, NodePath.join(env.root, ".goat"), "junction");
      expect(await probe()).toBe("GOAT_APP_SERVER=reparse-path");
      expect(env.app.sessions).toEqual([]);
    });
  },
);
