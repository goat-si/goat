// @effect-diagnostics nodeBuiltinImport:off - spawns real children to stand in for pen pipe.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import { describe, expect, it, vi } from "vite-plus/test";
import { awaitPenReady, PEN_STDERR_TAIL, PenReadyError } from "./ready.ts";

const NODE = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOISE = Buffer.alloc(32, 7).toString("base64url");
const READY = "pen-ready v1 " + NODE + " " + NOISE + "\n";
const HOLD = "setInterval(() => {}, 1 << 30);";

// A stand-in for pen pipe: runs script in a fresh node with piped stdio.
function child(script: string) {
  const proc = NodeChildProcess.spawn(process.execPath, ["-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.on("error", () => {});
  proc.stdin.on("error", () => {});
  return proc;
}

async function refused(script: string, reason: string) {
  const proc = child(script);
  const error = await awaitPenReady(proc, { nodeId: NODE, noisePub: NOISE }).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PenReadyError);
  expect((error as PenReadyError).reason).toBe(reason);
  // Rejected only once the child is gone, and nothing was written to it.
  expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
  if (!(proc.stdin instanceof NodeNet.Socket)) throw new Error("stdin is not a pipe");
  expect(proc.stdin.bytesWritten).toBe(0);
}

describe("awaitPenReady (CONTRACT Exact dial and the ready line)", () => {
  it("kills and reaps a child that floods stderr without a line", async () => {
    await refused("process.stderr.write('x'.repeat(1 << 20));" + HOLD, "line");
  });

  it("kills and reaps a child whose ready line is over the cap", async () => {
    await refused(
      "process.stderr.write('pen-ready v1 ' + 'a'.repeat(200) + '\\n');" + HOLD,
      "line",
    );
  });

  it("kills and reaps a child whose first line names another node or key", async () => {
    await refused(
      "process.stderr.write('pen-ready v1 " +
        NODE +
        " " +
        Buffer.alloc(32, 8).toString("base64url") +
        "\\n');" +
        HOLD,
      "line",
    );
    await refused("process.stderr.write('pen trace: dialing\\n');" + HOLD, "line");
  });

  it("kills and reaps a child that writes stdout before its ready line", async () => {
    await refused("process.stdout.write('HTTP/1.1 200 OK\\r\\n');" + HOLD, "stdout");
  });

  it("rejects a child that exits before its ready line", async () => {
    await refused(
      "process.stderr.write('pen pipe: node is not a member\\n'.slice(0, 5)); process.exit(255);",
      "exit",
    );
  });

  it("kills a child that has not printed its line by the deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const proc = child(HOLD);
      const pending = awaitPenReady(proc, { nodeId: NODE, noisePub: NOISE }).catch(
        (e: unknown) => e,
      );
      vi.advanceTimersByTime(25_000);
      const error = await pending;
      expect((error as PenReadyError).reason).toBe("deadline");
      expect(proc.signalCode).toBe("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves on the exact line, leaves stdout for the caller and keeps only a bounded stderr tail", async () => {
    const proc = child(
      "process.stderr.write(" +
        JSON.stringify(READY) +
        ");" +
        "process.stderr.write('y'.repeat(1 << 20) + 'END\\n');" +
        "process.stdin.pipe(process.stdout);",
    );
    const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
    const ready = await awaitPenReady(proc, { nodeId: NODE, noisePub: NOISE });
    const echoed = new Promise<string>((resolve) =>
      proc.stdout.once("data", (d: Buffer) => resolve(d.toString())),
    );
    proc.stdout.resume();
    proc.stdin.end("ping");
    expect(await echoed).toBe("ping");
    await closed;
    expect(ready.stderrTail().length).toBeLessThanOrEqual(PEN_STDERR_TAIL);
    expect(ready.stderrTail().endsWith("yEND\n")).toBe(true);
  });
});
