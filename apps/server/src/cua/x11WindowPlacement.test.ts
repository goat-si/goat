// @effect-diagnostics nodeBuiltinImport:off -- A scripted X server on a Unix socket stands in for Xorg.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { makeX11WindowPlacement } from "./x11WindowPlacement.ts";

const PID_ATOM = 300;

/** An X server holding these windows, each with the pid in its _NET_WM_PID (or none). */
async function scriptedServer(windows: ReadonlyMap<number, number | undefined>) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-x-"));
  const path = NodePath.join(dir, "X0");
  const server = NodeNet.createServer((socket) => {
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    let started = false;
    const reply = (extra: Buffer, data = 0) => {
      const head = Buffer.alloc(32);
      head[0] = 1;
      head[1] = data;
      head.writeUInt32LE(Math.max(0, extra.length - 24) / 4, 4);
      extra.copy(head, 8, 0, Math.min(24, extra.length));
      socket.write(extra.length > 24 ? Buffer.concat([head, extra.subarray(24)]) : head);
    };
    const badWindow = () => {
      const bytes = Buffer.alloc(32);
      bytes[1] = 3;
      socket.write(bytes);
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!started) {
        if (buffer.length < 12) return;
        started = true;
        buffer = buffer.subarray(12);
        const setup = Buffer.alloc(40);
        setup[0] = 1;
        setup.writeUInt16LE((setup.length - 8) / 4, 6);
        socket.write(setup);
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt16LE(2) * 4;
        if (buffer.length < length) return;
        const body = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        const op = body[0];
        if (op === 16) {
          const extra = Buffer.alloc(24);
          extra.writeUInt32LE(PID_ATOM, 0);
          reply(extra);
        } else if (op === 14) {
          if (!windows.has(body.readUInt32LE(4))) badWindow();
          else reply(Buffer.alloc(24), 24);
        } else if (op === 20) {
          const window = body.readUInt32LE(4);
          if (!windows.has(window)) return badWindow();
          const pid = windows.get(window);
          const extra = Buffer.alloc(pid === undefined ? 24 : 28);
          if (pid !== undefined) {
            extra.writeUInt32LE(6, 0);
            extra.writeUInt32LE(1, 8);
            extra.writeUInt32LE(pid, 24);
          }
          reply(extra, pid === undefined ? 0 : 32);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    [Symbol.asyncDispose]: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const display = { DISPLAY: ":0", XAUTHORITY: "/nonexistent/goat-xauthority" };

describe("X11 window placement (#1358)", () => {
  it("windows that exist on the display with the pid the driver named are on it", async () => {
    await using server = await scriptedServer(
      new Map([
        [20, 10],
        [21, undefined],
      ]),
    );
    const placement = makeX11WindowPlacement(display, server.path);
    expect(await placement([{ pid: 10, windowId: 20 }])).toBe("same");
    // Window ids repeat across X servers, so one that names no pid proves nothing by itself.
    expect(await placement([{ pid: 11, windowId: 21 }])).toBe("unknown");
    expect(
      await placement([
        { pid: 10, windowId: 20 },
        { pid: 11, windowId: 21 },
      ]),
    ).toBe("same");
  });

  it("a window the display does not have, or one another process owns there, is elsewhere", async () => {
    await using server = await scriptedServer(new Map([[20, 10]]));
    const placement = makeX11WindowPlacement(display, server.path);
    expect(
      await placement([
        { pid: 10, windowId: 20 },
        { pid: 900, windowId: 77 },
      ]),
    ).toBe("other");
    expect(await placement([{ pid: 900, windowId: 20 }])).toBe("other");
  });

  it("a display that cannot be read is unknown, never the same", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-x-"));
    const placement = makeX11WindowPlacement(display, NodePath.join(dir, "missing"));
    expect(await placement([{ pid: 10, windowId: 20 }])).toBe("unknown");
    expect(await makeX11WindowPlacement({ DISPLAY: "remote:0" })([{ pid: 1, windowId: 2 }])).toBe(
      "unknown",
    );
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});
