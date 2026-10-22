// @effect-diagnostics nodeBuiltinImport:off - Tests exercise native Node fixture boundaries.
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { ownRuntimeManifest } from "@goat/shared/runtimeManifest";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import packageJson from "../../package.json" with { type: "json" };
import { readLiveSshRuntimeProtocol, readSshServerActivity } from "./sshHelper.ts";

const startDescriptor = async (value: unknown, legacyOnly = false) => {
  const paths: string[] = [];
  const server = NodeHttp.createServer((request, response) => {
    paths.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (
      request.url === (legacyOnly ? "/.well-known/t3/environment" : "/.well-known/goat/environment")
    )
      response.end(JSON.stringify(value));
    else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No loopback port");
  return {
    port: address.port,
    paths,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
};
const descriptor = {
  environmentId: "helper-fixture",
  label: "Fixture",
  platform: { os: "linux", arch: "x64" },
  capabilities: {},
  serverVersion: packageJson.version,
  sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
};

describe("SSH runtime protocol", () => {
  it("registers the protocol command and prints only build JSON", async () => {
    const moduleUrl = new URL("./sshHelper.ts", import.meta.url).href;
    // Module specifier resolution originates in this real source directory, not HOME.
    const effectUrl = import.meta.resolve("effect/Effect");
    const cliUrl = import.meta.resolve("effect/cli");
    const script = `import * as Effect from ${JSON.stringify(effectUrl)};
import {Command} from ${JSON.stringify(cliUrl)};
import {sshHelperCommand} from ${JSON.stringify(moduleUrl)};
await Effect.runPromise(Command.runWith(sshHelperCommand,{version:'test'})(['protocol']));`;
    const stdout = await new Promise<string>((resolve, reject) => {
      NodeChildProcess.execFile(
        process.execPath,
        ["--input-type=module", "-e", script],
        { timeout: 10000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          if (stderr.trim()) {
            reject(new Error(stderr));
            return;
          }
          resolve(stdout);
        },
      );
    });
    expect(JSON.parse(stdout)).toEqual({
      serverVersion: packageJson.version,
      sshRuntimeProtocolVersion: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    });
  });

  it.each([
    { commit: undefined, commitTime: undefined },
    { commit: "abc123", commitTime: 123456 },
  ])("prints one runtime manifest JSON line with build metadata: %j", async (build) => {
    const moduleUrl = new URL("./sshHelper.ts", import.meta.url).href;
    const effectUrl = import.meta.resolve("effect/Effect");
    const cliUrl = import.meta.resolve("effect/cli");
    const script = `import * as Effect from ${JSON.stringify(effectUrl)};
import {Command} from ${JSON.stringify(cliUrl)};
globalThis.__GOAT_BUILD_COMMIT__ = ${JSON.stringify(build.commit) ?? "undefined"};
globalThis.__GOAT_BUILD_COMMIT_TIME__ = ${JSON.stringify(build.commitTime?.toString()) ?? "undefined"};
const {sshHelperCommand} = await import(${JSON.stringify(moduleUrl)});
await Effect.runPromise(Command.runWith(sshHelperCommand,{version:'test'})(['runtime-manifest']));`;
    const stdout = await new Promise<string>((resolve, reject) => {
      NodeChildProcess.execFile(
        process.execPath,
        ["--input-type=module", "-e", script],
        { timeout: 10000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          if (stderr.trim()) {
            reject(new Error(stderr));
            return;
          }
          resolve(stdout);
        },
      );
    });
    expect(stdout.split("\n")).toHaveLength(2);
    expect(JSON.parse(stdout)).toEqual(
      ownRuntimeManifest({ version: packageJson.version, ...build }),
    );
  });

  it.each(
    (["matching", "legacy", "disagreeing", "malformed"] as const).flatMap((mode) =>
      [false, true].map((legacyOnly) => ({ mode, legacyOnly })),
    ),
  )(
    "checks a live loopback descriptor: $mode, legacy path=$legacyOnly",
    async ({ mode, legacyOnly }) => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-helper-"));
      const liveDescriptor =
        mode === "legacy"
          ? {
              ...descriptor,
              sshRuntimeProtocolVersion: undefined,
              orchestrationProtocolVersion: undefined,
            }
          : mode === "malformed"
            ? { ...descriptor, sshRuntimeProtocolVersion: "1" }
            : descriptor;
      const server = await startDescriptor(liveDescriptor, legacyOnly);
      try {
        const file = NodePath.join(home, "server-runtime.json");
        NodeFS.writeFileSync(
          file,
          JSON.stringify({
            version: 1,
            pid: process.pid,
            port: server.port,
            origin: `http://127.0.0.1:${server.port}`,
            startedAt: "2026-10-11T00:00:00.000Z",
            ...(mode === "legacy"
              ? {}
              : {
                  serverVersion: packageJson.version,
                  sshRuntimeProtocolVersion:
                    mode === "disagreeing" ? 99 : SSH_RUNTIME_PROTOCOL_VERSION,
                  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
                }),
          }),
        );
        const result = await readLiveSshRuntimeProtocol(file);
        expect(server.paths).toEqual(
          legacyOnly
            ? ["/.well-known/goat/environment", "/.well-known/t3/environment"]
            : ["/.well-known/goat/environment"],
        );
        expect(result.status).toBe(mode === "matching" || mode === "legacy" ? "live" : "unknown");
        if (result.status === "live") {
          expect(result.serverVersion).toBe(packageJson.version);
          expect(result.sshRuntimeProtocolVersion).toBe(
            mode === "legacy" ? undefined : SSH_RUNTIME_PROTOCOL_VERSION,
          );
        }
      } finally {
        await server.close();
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

describe("SSH live identity and bounded responses", () => {
  it.each(
    (
      [
        "missing",
        "broken",
        "remembered alive",
        "dead PID",
        "service",
        "stale version",
        "stale protocol",
        "remembered mismatch",
        "remembered stale",
        "origin",
        "origin port",
        "string",
        "fraction",
        "negative",
        "unsafe",
        "version",
        "root only",
        "oversized",
        "held",
        "malformed JSON",
        "split UTF8",
      ] as const
    ).map((mode) => ({ mode })),
  )("observes $mode", async ({ mode }) => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-helper-identity-"));
    const value = {
      ...descriptor,
      ...(mode === "string" ? { sshRuntimeProtocolVersion: "1" } : {}),
      ...(mode === "fraction" ? { sshRuntimeProtocolVersion: 1.5 } : {}),
      ...(mode === "negative" ? { orchestrationProtocolVersion: -1 } : {}),
      ...(mode === "unsafe" ? { orchestrationProtocolVersion: 9007199254740992 } : {}),
      ...(mode === "version" ? { serverVersion: "1.2.3-01" } : {}),
      ...(mode === "split UTF8" ? { label: "한글" } : {}),
    };
    const server = NodeHttp.createServer((request, response) => {
      if (mode === "root only" && request.url !== "/") {
        response.writeHead(404);
        response.end("{}");
      } else if (mode === "oversized") response.end("x".repeat(65537));
      else if (mode === "held") response.write("{");
      else if (mode === "malformed JSON") response.end("{");
      else if (mode === "split UTF8") {
        const bytes = Buffer.from(JSON.stringify(value));
        const split = bytes.indexOf(Buffer.from("한")) + 1;
        response.write(bytes.subarray(0, split), () => response.end(bytes.subarray(split)));
      } else response.end(JSON.stringify(value));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const port = address.port;
    const file = NodePath.join(home, "runtime.json"),
      ports = NodePath.join(home, "port"),
      pids = NodePath.join(home, "pid");
    try {
      const state = {
        version: 1,
        pid: mode === "dead PID" ? 2147483647 : process.pid,
        port,
        origin:
          mode === "origin"
            ? `http://example.invalid:${port}`
            : mode === "origin port"
              ? `http://127.0.0.1:${port === 65535 ? 65534 : port + 1}`
              : `http://127.0.0.1:${port}`,
        startedAt: "2026-10-11T00:00:00.000Z",
        serverVersion: mode === "stale version" ? "0.0.1" : packageJson.version,
        sshRuntimeProtocolVersion: mode === "stale protocol" ? 99 : SSH_RUNTIME_PROTOCOL_VERSION,
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        ...(mode === "service" ? { serviceManaged: true } : {}),
      };
      if (!["missing", "remembered alive"].includes(mode))
        NodeFS.writeFileSync(file, mode === "broken" ? "{" : JSON.stringify(state));
      NodeFS.writeFileSync(ports, String(port));
      if (
        mode === "remembered alive" ||
        mode === "remembered mismatch" ||
        mode === "remembered stale"
      )
        NodeFS.writeFileSync(
          pids,
          // A living second claim is ambiguous; an exited one is left over from an earlier server.
          String(
            mode === "remembered mismatch"
              ? process.ppid
              : mode === "remembered stale"
                ? 2147483647
                : process.pid,
          ),
        );
      const result = await readLiveSshRuntimeProtocol(file, ports, pids);
      const live = [
        "missing",
        "remembered alive",
        "remembered stale",
        "dead PID",
        "service",
        "split UTF8",
      ].includes(mode);
      expect(result.status).toBe(live ? "live" : "unknown");
      if (live && mode !== "split UTF8" && mode !== "remembered stale") expect(result.pid).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
  it("returns none without a record or remembered identity", async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-helper-none-"));
    try {
      expect(await readLiveSshRuntimeProtocol(NodePath.join(home, "absent"))).toEqual({
        status: "none",
        pid: 0,
        port: 0,
      });
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});

it("bounds an active incomplete response by its total deadline", async () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-helper-trickle-"));
  let send: NodeHttp.ServerResponse | undefined;
  let received: (() => void) | undefined;
  const requestReceived = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = NodeHttp.createServer((_request, response) => {
    send = response;
    response.write("{", () => received?.());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const file = NodePath.join(home, "runtime.json");
  NodeFS.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      port: address.port,
      origin: `http://127.0.0.1:${address.port}`,
      startedAt: "2026-10-11T00:00:00.000Z",
      serverVersion: packageJson.version,
    }),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const observed = readLiveSshRuntimeProtocol(file);
    await requestReceived;
    await vi.advanceTimersByTimeAsync(900);
    await new Promise<void>((resolve) => send?.write(" ", () => resolve()));
    await vi.advanceTimersByTimeAsync(600);
    expect((await observed).status).toBe("unknown");
  } finally {
    vi.useRealTimers();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

describe("SSH server activity", () => {
  it.each([
    { activity: "idle", expected: "idle", status: 200 },
    { activity: "busy", expected: "busy", status: 200 },
    { activity: "broken", expected: "unknown", status: 200 },
    { activity: "idle", expected: "unknown", status: 404 },
  ])("handles $activity with HTTP $status", async ({ activity, expected, status }) => {
    const server = NodeHttp.createServer((request, response) => {
      expect(["/.well-known/goat/activity", "/.well-known/t3/activity"]).toContain(request.url);
      response.writeHead(status);
      response.end(
        JSON.stringify({ activity, serverVersion: packageJson.version, pid: process.pid }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    try {
      expect(await readSshServerActivity(address.port, process.pid)).toBe(expected);
      expect(await readSshServerActivity(address.port, process.pid + 1)).toBe("unknown");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("returns unknown for unreachable servers", async () => {
    const server = NodeHttp.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await readSshServerActivity(address.port)).toBe("unknown");
  });
});

it("activity CLI prints unknown with exit zero", async () => {
  const moduleUrl = new URL("./sshHelper.ts", import.meta.url).href;
  const script = `import * as Effect from ${JSON.stringify(import.meta.resolve("effect/Effect"))};
import {Command} from ${JSON.stringify(import.meta.resolve("effect/cli"))};
import {sshHelperCommand} from ${JSON.stringify(moduleUrl)};
await Effect.runPromise(Command.runWith(sshHelperCommand,{version:'test'})(['activity','--port','0','--shell']));`;
  const stdout = await new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { timeout: 10000 },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else if (stderr.trim()) reject(new Error(stderr));
        else resolve(stdout);
      },
    );
  });
  expect(stdout).toBe("unknown\n");
});

it("returns unknown when an activity response exceeds the deadline", async () => {
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = NodeHttp.createServer(() => received());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const result = readSshServerActivity(address.port);
    await requestReceived;
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toBe("unknown");
  } finally {
    vi.useRealTimers();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([404, 403, 500])("activity falls back only on HTTP %s", async (status) => {
  const paths: string[] = [];
  const server = NodeHttp.createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(request.url === "/.well-known/goat/activity" ? status : 200);
    response.end(
      JSON.stringify({ activity: "idle", serverVersion: packageJson.version, pid: process.pid }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  try {
    expect(await readSshServerActivity(address.port, process.pid)).toBe(
      status === 404 ? "idle" : "unknown",
    );
    expect(paths).toEqual(
      status === 404
        ? ["/.well-known/goat/activity", "/.well-known/t3/activity"]
        : ["/.well-known/goat/activity"],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too. macOS needs neither.
