// @effect-diagnostics nodeBuiltinImport:off -- In-memory child pipes exercise the process boundary.
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { openPenPipe, resolvePenBinary } from "./penPipe.ts";

const pin = { meshId: "m".repeat(26), nodeId: "a".repeat(26), noisePub: "a".repeat(43) };
function child() {
  const proc = new NodeEvents.EventEmitter() as NodeChildProcess.ChildProcess;
  const stdin = new NodeStream.PassThrough();
  const stdout = new NodeStream.PassThrough();
  const stderr = new NodeStream.PassThrough();
  Object.assign(proc, {
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr],
    pid: 123,
    exitCode: null,
    signalCode: null,
  });
  proc.kill = () => {
    Object.assign(proc, { signalCode: "SIGKILL" });
    proc.emit("exit", null, "SIGKILL");
    return true;
  };
  return { proc, stdin, stdout, stderr };
}

describe("Pen pipe", () => {
  it("resolves the Windows executable and skips relative PATH entries", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pen-resolve-"));
    try {
      const executable = NodePath.join(dir, "pen.exe");
      NodeFS.writeFileSync(executable, "", { mode: 0o755 });
      expect(await resolvePenBinary({ platform: "win32", path: dir })).toBe(
        NodeFS.realpathSync(executable),
      );
      const relative = NodePath.relative(NodeFS.realpathSync("."), executable);
      expect(
        await resolvePenBinary({ platform: "win32", path: NodePath.dirname(relative) }),
      ).toBeUndefined();
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("writes no bytes until the expected ready line and membership recheck", async () => {
    const c = child();
    const bytes: Buffer[] = [];
    c.stdin.on("data", (data: Buffer) => bytes.push(data));
    const pending = openPenPipe(pin, {
      resolveBinary: async () => "/pen",
      spawn: () => c.proc,
      requireMember: async () => true,
    });
    await Promise.resolve();
    expect(bytes).toEqual([]);
    c.stderr.write(`pen-ready v1 ${pin.nodeId} ${pin.noisePub}\n`);
    const pipe = await pending;
    await pipe.write(Buffer.from("hello"));
    expect(Buffer.concat(bytes).toString()).toBe("hello");
    await pipe.kill();
  });

  it("reaps a child when its ready key is wrong or membership is lost", async () => {
    for (const validReady of [false, true]) {
      const c = child();
      let checks = 0;
      const pending = openPenPipe(pin, {
        resolveBinary: async () => "/pen",
        spawn: () => c.proc,
        requireMember: async () => ++checks === 1,
      });
      await Promise.resolve();
      c.stderr.write(`pen-ready v1 ${pin.nodeId} ${validReady ? pin.noisePub : "b".repeat(43)}\n`);
      await expect(pending).rejects.toThrow();
      expect(c.proc.signalCode).toBe("SIGKILL");
    }
  });

  it("reaps an early stdout child and an aborted pending dial", async () => {
    for (const mode of ["stdout", "abort"] as const) {
      const c = child();
      const controller = new AbortController();
      let signalSpawned = () => {};
      const spawned = new Promise<void>((resolve) => {
        signalSpawned = resolve;
      });
      const pending = openPenPipe(pin, {
        resolveBinary: async () => "/pen",
        spawn: () => {
          signalSpawned();
          return c.proc;
        },
        requireMember: async () => true,
        signal: controller.signal,
      });
      await spawned;
      if (mode === "stdout") c.stdout.write("premature");
      else controller.abort();
      await expect(pending).rejects.toThrow();
      expect(c.proc.signalCode).toBe("SIGKILL");
    }
  });

  it("refuses spawn failure without writing to a pipe", async () => {
    await expect(
      openPenPipe(pin, {
        resolveBinary: async () => "/pen",
        spawn: () => {
          throw new Error("spawn failed");
        },
        requireMember: async () => true,
      }),
    ).rejects.toThrow("spawn failed");
  });

  it("places the explicit state directory before the service argument", async () => {
    const c = child();
    let args: readonly string[] = [];
    const pending = openPenPipe(pin, {
      resolveBinary: async () => "/pen",
      spawn: (_path, received) => {
        args = received;
        return c.proc;
      },
      requireMember: async () => true,
      stateDir: "/pen-state",
    });
    await Promise.resolve();
    c.stderr.write(`pen-ready v1 ${pin.nodeId} ${pin.noisePub}\n`);
    const pipe = await pending;
    expect(args).toEqual([
      "pipe",
      "--node",
      pin.nodeId,
      "--noise",
      pin.noisePub,
      "--home",
      "/pen-state",
      "@goat",
    ]);
    await pipe.kill();
  });
});
