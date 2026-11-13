// @effect-diagnostics nodeBuiltinImport:off -- Fake child streams exercise the desktop transport.
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import type * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { watchPenSnapshots } from "@goat/pen-protocol/snapshot";
import { openPenSnapshotChild } from "./penSnapshotChild.ts";

const stateDir = NodePath.join(process.cwd(), "test-pen-state");
const binary = NodePath.join(process.cwd(), "pen-test-binary");
const id = "a".repeat(26);
const line = (gen: number) =>
  JSON.stringify({ t: "snapshot", gen, mesh: id, self: id, members: [], revoked: [] }) + "\n";
function fakeChild() {
  const stdin = new NodeStream.PassThrough();
  const stdout = new NodeStream.PassThrough();
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    stdin,
    stdout,
    stderr: null,
    stdio: [stdin, stdout, null],
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
  return child as unknown as NodeChildProcess.ChildProcess & {
    stdin: NodeStream.PassThrough;
    stdout: NodeStream.PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
}
function fixture(
  resolveBinary: () => Promise<string | undefined> = async () => binary,
  throws = false,
) {
  const child = fakeChild();
  let spawned!: () => void;
  const ready = new Promise<void>((resolve) => {
    spawned = resolve;
  });
  const spawn = vi.fn(
    (
      _path: string,
      _args: readonly string[],
      _options: NodeChildProcess.SpawnOptions,
    ): NodeChildProcess.ChildProcess => {
      spawned();
      if (throws) throw new Error("spawn failed");
      return child;
    },
  );
  const events: (string | number)[] = [];
  const stop = watchPenSnapshots({
    stateDir,
    connect: () => openPenSnapshotChild({ stateDir, resolveBinary, spawn }),
    onSnapshot: (snapshot) => events.push(snapshot.gen),
    onStale: (reason) => events.push(reason),
  });
  return { child, spawn, events, stop, ready };
}

describe("Pen snapshot child", () => {
  it("returns a stream before resolving the binary", () => {
    const stream = openPenSnapshotChild({
      stateDir,
      resolveBinary: () => new Promise(() => {}),
      spawn: vi.fn(),
    });
    expect(stream).toBeDefined();
    stream.destroy();
  });
  it("delivers stdout lines before child close and pins the spawned environment", async () => {
    const old = process.env.PEN_HOME;
    process.env.PEN_HOME = "different";
    try {
      const f = fixture();
      await f.ready;
      expect(f.spawn).toHaveBeenCalledWith(
        binary,
        ["ls", "--watch", "--snapshot", "--until-stdin-closes"],
        expect.objectContaining({
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
          env: expect.objectContaining({ PEN_HOME: stateDir }),
        }),
      );
      f.child.emit("spawn");
      f.child.stdout.write(line(1));
      f.child.stdout.write(line(2));
      f.child.emit("close", 0);
      expect(f.events).toEqual([1, 2, "closed"]);
    } finally {
      if (old === undefined) delete process.env.PEN_HOME;
      else process.env.PEN_HOME = old;
    }
  });
  it("reports a refusal", async () => {
    const f = fixture();
    await f.ready;
    f.child.emit("spawn");
    f.child.stdout.write('{"error":"refused"}\n');
    expect(f.events).toEqual(["refused"]);
  });
  it("reports a child that exits without a line as no daemon", async () => {
    const f = fixture();
    await f.ready;
    f.child.emit("spawn");
    f.child.emit("exit", 1);
    f.child.emit("close", 1);
    expect(f.events).toEqual(["connect"]);
  });
  it.each([undefined, "relative"])(
    "reports missing or relative binary as connect failure",
    async (value) => {
      let done!: () => void;
      const stale = new Promise<void>((resolve) => {
        done = resolve;
      });
      const spawn = vi.fn();
      watchPenSnapshots({
        stateDir,
        connect: () => openPenSnapshotChild({ stateDir, resolveBinary: async () => value, spawn }),
        onSnapshot: vi.fn(),
        onStale: (reason) => {
          expect(reason).toBe("connect");
          done();
        },
      });
      await stale;
      expect(spawn).not.toHaveBeenCalled();
    },
  );
  it("reports a thrown spawn as connect failure", async () => {
    const f = fixture(async () => binary, true);
    await f.ready;
    await Promise.resolve();
    expect(f.events).toEqual(["connect"]);
  });
  it("reports a rejected binary lookup", async () => {
    const stale = new Promise<string>((resolve) => {
      watchPenSnapshots({
        stateDir,
        connect: () =>
          openPenSnapshotChild({
            stateDir,
            resolveBinary: async () => {
              throw new Error("lookup");
            },
            spawn: vi.fn(),
          }),
        onSnapshot: vi.fn(),
        onStale: resolve,
      });
    });
    expect(await stale).toBe("connect");
  });
  it.each(["child", "stdout"] as const)("ends the watch on %s error", async (source) => {
    const f = fixture();
    await f.ready;
    f.child.emit("spawn");
    (source === "child" ? f.child : f.child.stdout).emit("error", new Error("failure"));
    expect(f.events).toEqual(["connect"]);
  });
  it("does not kill an exited child while waiting for close", async () => {
    const f = fixture();
    await f.ready;
    f.child.emit("exit", 0);
    f.child.stdout.write(line(1));
    f.child.emit("close", 0);
    expect(f.events).toEqual([1, "closed"]);
    expect(f.child.kill).not.toHaveBeenCalled();
  });
  it("does not spawn when stopped before resolution", async () => {
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((r) => {
      resolve = r;
    });
    const f = fixture(() => pending);
    f.stop();
    resolve(binary);
    await pending;
    await Promise.resolve();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });
  it("stops once and ignores later child events", async () => {
    const f = fixture();
    await f.ready;
    f.stop();
    f.stop();
    f.child.stdout.write(line(1));
    f.child.emit("error", new Error("late"));
    f.child.emit("close");
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual([]);
  });
  it("contains stdin EPIPE and ends the watch", async () => {
    const f = fixture();
    await f.ready;
    f.child.emit("spawn");
    expect(() =>
      f.child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })),
    ).not.toThrow();
    expect(f.events).toEqual(["connect"]);
  });
});
