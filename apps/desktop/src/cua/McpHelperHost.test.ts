// @effect-diagnostics nodeBuiltinImport:off -- In-memory streams exercise the helper/MCP ownership boundary.
import * as NodeStream from "node:stream";
import { describe, expect, it, vi } from "vite-plus/test";

import { helperBundle } from "./ComputerUseHelper.ts";
import { makeMcpHelperHost } from "./McpHelperHost.ts";

const BUNDLE_ID = "si.goat.desktop.dev.computer-use";
const options = {
  bundle: helperBundle("/Helpers/GOAT Computer Use.app", BUNDLE_ID),
  driverVersion: "0.37.0",
  capabilityManifestPath: "/state/verify-manifest.yaml",
  environment: [{ name: "CUA_DRIVER_KEY_GAP_MS", value: "20" }],
};
const greeting = { type: "hello", protocol: 1, pid: 99, bundleId: BUNDLE_ID };

function peer(hello: unknown = greeting, answerInitialize = true) {
  const stdout = new NodeStream.PassThrough();
  const stderr = new NodeStream.PassThrough();
  const exited = Promise.withResolvers<void>();
  let killed = false;
  const die = () => {
    stdout.end();
    stderr.end();
    exited.resolve();
  };
  const stdin = new NodeStream.Writable({
    write(chunk, _encoding, done) {
      const request = JSON.parse(chunk.toString()) as { id?: number; method: string };
      if (request.method === "initialize" && answerInitialize) {
        stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
          }) + "\n",
        );
      } else if (request.method === "tools/call") {
        stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { content: [], structuredContent: { parent_process_id: 99 } },
          }) + "\n",
        );
      }
      done();
    },
    final(done) {
      die();
      done();
    },
  });
  const process = {
    stdin,
    stdout,
    stderr,
    exited: exited.promise,
    kill: () => {
      killed = true;
      die();
    },
  };
  stderr.write("Cua Driver diagnostic\n");
  if (hello !== undefined) stderr.write(JSON.stringify(hello) + "\n");
  const host = makeMcpHelperHost(options, () => process);
  return { host, process, die, killed: () => killed };
}

describe("macOS readiness MCP helper host", () => {
  it("uses one helper's service identity and stdio MCP peer with the verify manifest", async () => {
    const test = peer();
    try {
      const connection = await test.host.start();
      expect(connection.socketPath).toBe("");
      expect(connection.mcp).toEqual({
        command: options.bundle.executable,
        args: ["--mcp", "--capability-manifest", options.capabilityManifestPath],
        environment: options.environment,
      });
      expect(test.host.servicePid()).toBe(99);
      expect(
        JSON.parse(
          (await test.host.readinessPeer()?.callTool("health_report", "{}"))?.structuredJson ??
            "null",
        ),
      ).toEqual({ parent_process_id: 99 });
    } finally {
      await test.host.stop();
    }
    expect(test.process.stdin.writableEnded).toBe(true);
    expect(test.host.servicePid()).toBeUndefined();
    expect(test.host.readinessPeer()).toBeUndefined();
    expect(test.killed()).toBe(false);
  });

  it.each([
    { ...greeting, bundleId: "another.helper" },
    { ...greeting, protocol: 2 },
    { ...greeting, pid: 0 },
    { ...greeting, pid: 99.5 },
  ])(
    "refuses an invalid service greeting and closes the process ($bundleId, $protocol, $pid)",
    async (hello) => {
      const test = peer(hello);
      await expect(test.host.start()).rejects.toMatchObject({ code: "invalid_hello" });
      expect(test.process.stdin.writableEnded).toBe(true);
      expect(test.host.servicePid()).toBeUndefined();
    },
  );

  it("invalidates the service identity when its MCP peer exits", async () => {
    const test = peer();
    await test.host.start();
    const ended = test.host.waitForExit("1", { signal: new AbortController().signal });
    test.die();
    await ended;
    expect(test.host.servicePid()).toBeUndefined();
    await expect(test.host.readinessPeer()?.callTool("health_report", "{}")).rejects.toMatchObject({
      code: "closed",
    });
    await test.host.stop();
  });

  it("fails startup when the MCP peer closes before initialization", async () => {
    const test = peer(greeting, false);
    const started = test.host.start();
    test.die();
    await expect(started).rejects.toBeInstanceOf(Error);
    expect(test.host.servicePid()).toBeUndefined();
    expect(test.process.stdin.writableEnded).toBe(true);
  });

  it("bounds a missing service greeting without real-time waits", async (context) => {
    vi.useFakeTimers();
    context.onTestFinished(() => {
      vi.useRealTimers();
    });
    const test = peer(null);
    const result = test.host.start().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ code: "timeout" });
    expect(test.process.stdin.writableEnded).toBe(true);
    expect(test.host.servicePid()).toBeUndefined();
  });
});
