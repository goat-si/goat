import * as NodeStream from "node:stream";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeNet from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  PEN_SNAPSHOT_LINE_CAP,
  parsePenSnapshot,
  penLeftMesh,
  penStateDir,
  watchPenSnapshots,
} from "./snapshot.ts";

const id = "a".repeat(26);
const snapshot = (gen = 1) => ({
  t: "snapshot",
  gen,
  mesh: id,
  self: id,
  members: [{ nodeId: id, noisePub: "key", name: "node", online: true, extra: 3 }],
  revoked: [{ nodeId: id, name: "old", extra: 1 }],
  relays: [],
});

function fixture() {
  const writes: string[] = [];
  const socket = new NodeStream.Duplex({
    read() {},
    write(chunk, _encoding, done) {
      writes.push(chunk.toString());
      done();
    },
  });
  const onSnapshot = vi.fn();
  const onStale = vi.fn();
  const connect = vi.fn((_path: string) => socket as NodeNet.Socket);
  const stop = watchPenSnapshots({ stateDir: "/test", connect, onSnapshot, onStale });
  socket.emit("connect");
  const send = (line: string) => socket.emit("data", Buffer.from(line));
  return { socket, writes, onSnapshot, onStale, connect, stop, send };
}

describe("Pen snapshots", () => {
  it("parses v1.3 and ignores unknown members, with v1.1 online default", () => {
    expect(parsePenSnapshot(JSON.stringify(snapshot()))).toEqual({
      gen: 1,
      mesh: id,
      self: id,
      members: [{ nodeId: id, noisePub: "key", name: "node", online: true }],
      revoked: [{ nodeId: id, name: "old" }],
    });
    const old = snapshot();
    const { online: _online, ...member } = old.members[0]!;
    expect(
      parsePenSnapshot(JSON.stringify({ ...old, members: [member] }))?.members[0]?.online,
    ).toBe(false);
  });
  it("rejects invalid ids, fields, names and oversized collections", () => {
    for (const bad of [
      { ...snapshot(), self: "bad" },
      { ...snapshot(), gen: 1.5 },
      { ...snapshot(), members: [{ ...snapshot().members[0], online: "yes" }] },
      { ...snapshot(), revoked: [{ nodeId: id, name: "x".repeat(65) }] },
      { ...snapshot(), members: Array(4097).fill(snapshot().members[0]) },
      { ...snapshot(), revoked: Array(4097).fill(snapshot().revoked[0]) },
    ])
      expect(parsePenSnapshot(JSON.stringify(bad))).toBeUndefined();
    expect(parsePenSnapshot("{")).toBeUndefined();
  });
  it("resolves state and detects only the left marker", async () => {
    expect(penStateDir({ PEN_HOME: "relative" }, "/home/me")).toBeUndefined();
    expect(penStateDir({ PEN_HOME: "/other" }, "/home/me")).toBe("/other");
    expect(penStateDir({}, "/home/me")).toBe("/home/me/.pen");
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pen-snapshot-"));
    try {
      expect(await penLeftMesh(dir)).toBe(false);
      await NodeFSP.writeFile(NodePath.join(dir, "left"), "");
      expect(await penLeftMesh(dir)).toBe(true);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
  it("watches complete lines and detects a skipped generation once", () => {
    const f = fixture();
    expect(f.connect).toHaveBeenCalledWith("/test/control.sock");
    expect(f.writes).toEqual(['{"op":"watch.snapshot"}\n']);
    const line = JSON.stringify(snapshot());
    f.send(line.slice(0, 10));
    f.send(line.slice(10) + "\n" + JSON.stringify(snapshot(3)) + "\n");
    f.socket.emit("close");
    expect(f.onSnapshot).toHaveBeenCalledTimes(1);
    expect(f.onStale.mock.calls).toEqual([["gap"]]);
  });
  it.each([
    ["closed", "close"],
    ["connect", "error"],
  ] as const)("reports %s once", (reason, event) => {
    const f = fixture();
    f.socket.emit(event, new Error("failure"));
    f.socket.emit("close");
    expect(f.onStale.mock.calls).toEqual([[reason]]);
  });
  it.each([
    ["refused", '{"error":"too many snapshot watchers"}\n'],
    ["line", "{bad}\n"],
    ["line", "x".repeat(PEN_SNAPSHOT_LINE_CAP + 1)],
  ] as const)("reports %s for an invalid response", (reason, line) => {
    const f = fixture();
    f.send(line);
    f.socket.emit("close");
    expect(f.onStale.mock.calls).toEqual([[reason]]);
  });
  it("reports a synchronous connect failure", () => {
    const onStale = vi.fn();
    watchPenSnapshots({
      stateDir: "/test",
      onSnapshot: vi.fn(),
      onStale,
      connect: () => {
        throw new Error("failed");
      },
    });
    expect(onStale.mock.calls).toEqual([["connect"]]);
  });
  it("stop destroys the socket and silences callbacks", () => {
    const f = fixture();
    f.stop();
    f.send(JSON.stringify(snapshot()) + "\n");
    f.socket.emit("error", new Error("late"));
    f.socket.emit("close");
    expect(f.socket.destroyed).toBe(true);
    expect(f.onSnapshot).not.toHaveBeenCalled();
    expect(f.onStale).not.toHaveBeenCalled();
  });
});
