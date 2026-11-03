// @effect-diagnostics nodeBuiltinImport:off -- The fake exercises Node child and stream error events.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { describe, expect, it, vi } from "vite-plus/test";

import { startDriver } from "./CuaDriverMcp.ts";

vi.mock("node:child_process", { spy: true });

function fakeChild(pid: number | undefined) {
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new NodeStream.PassThrough(),
    stdout: new NodeStream.PassThrough(),
    stderr: null,
  });
  const process = Object.assign(child, { stdio: [child.stdin, child.stdout, null] });
  child.stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as { id?: number; method: string };
    if (request.method === "initialize") {
      child.stdout.write(
        JSON.stringify({ id: request.id, result: { serverInfo: { version: "1" } } }) + "\n",
      );
    }
  });
  return process;
}

describe("Cua driver errors", () => {
  it("marks a pending call lost and waits for exit after stdout fails", async () => {
    const child = fakeChild(12345);
    using _spawn = vi.spyOn(NodeChildProcess, "spawn").mockReturnValueOnce(child as never);
    using kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const client = await startDriver({
      executable: "driver",
      environment: {},
      expectedVersion: "1",
    });
    const call = client.call("test", {}, 10_000);
    let exited = false;
    void client.exited.then(() => {
      exited = true;
    });
    child.stdout.destroy(new Error("broken"));
    expect(await call).toBe("lost");
    expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
    expect(exited).toBe(false);
    child.exitCode = 1;
    child.emit("exit", 1, null);
    await client.exited;
    expect(exited).toBe(true);
  });

  it("settles a pid-less spawn failure without signalling a group", async () => {
    const child = fakeChild(undefined);
    using _spawn = vi.spyOn(NodeChildProcess, "spawn").mockReturnValueOnce(child as never);
    using kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const start = startDriver({ executable: "missing", environment: {}, expectedVersion: "1" });
    child.emit("error", new Error("spawn failed"));
    await expect(start).rejects.toThrow("Cua Driver exited before it answered.");
    expect(kill).not.toHaveBeenCalled();
  });
});
