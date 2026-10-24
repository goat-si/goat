// @effect-diagnostics nodeBuiltinImport:off -- A scripted X server on a Unix socket stands in for Xorg.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { makeX11WindowPlacement } from "./x11WindowPlacement.ts";

const PID_ATOM = 300;
const ROOT = 0x2b;
const XRES = 150;

interface FakeWindow {
  /** Its _NET_WM_PID, if it publishes one. */
  readonly pid?: number;
  /** The X server's own record of its client's pid, through X-Resource. */
  readonly clientPid?: number;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}

/** An X server holding these windows; withResources adds X-Resource 1.2. */
async function scriptedServer(
  windows: ReadonlyMap<number, FakeWindow>,
  options: { readonly withResources?: boolean } = {},
) {
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
        // No vendor string and no pixmap formats, so the first screen's root is at byte 40.
        const setup = Buffer.alloc(48);
        setup[0] = 1;
        setup.writeUInt16LE((setup.length - 8) / 4, 6);
        setup.writeUInt32LE(ROOT, 40);
        socket.write(setup);
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt16LE(2) * 4;
        if (buffer.length < length) return;
        const body = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        const op = body[0];
        const found = windows.get(body.readUInt32LE(4));
        if (op === 16) {
          const extra = Buffer.alloc(24);
          extra.writeUInt32LE(PID_ATOM, 0);
          reply(extra);
        } else if (op === 98) {
          const extra = Buffer.alloc(24);
          extra[0] = options.withResources ? 1 : 0;
          extra[1] = XRES;
          reply(extra);
        } else if (op === XRES && body[1] === 0) {
          const extra = Buffer.alloc(24);
          extra.writeUInt16LE(1, 0);
          extra.writeUInt16LE(2, 2);
          reply(extra);
        } else if (op === XRES && body[1] === 4) {
          const pid = windows.get(body.readUInt32LE(8))?.clientPid;
          const extra = Buffer.alloc(pid === undefined ? 24 : 40);
          if (pid !== undefined) {
            extra.writeUInt32LE(1, 0);
            extra.writeUInt32LE(body.readUInt32LE(8), 24);
            extra.writeUInt32LE(2, 28);
            extra.writeUInt32LE(4, 32);
            extra.writeUInt32LE(pid, 36);
          }
          reply(extra);
        } else if (op === 14) {
          if (!found) return badWindow();
          const extra = Buffer.alloc(24);
          extra.writeUInt16LE(found.width ?? 100, 8);
          extra.writeUInt16LE(found.height ?? 80, 10);
          reply(extra, 24);
        } else if (op === 40) {
          if (!found || body.readUInt32LE(8) !== ROOT) return badWindow();
          const extra = Buffer.alloc(24);
          extra.writeInt16LE(found.x ?? 0, 4);
          extra.writeInt16LE(found.y ?? 0, 6);
          reply(extra, 1);
        } else if (op === 20) {
          if (!found) return badWindow();
          const extra = Buffer.alloc(found.pid === undefined ? 24 : 28);
          if (found.pid !== undefined) {
            extra.writeUInt32LE(6, 0);
            extra.writeUInt32LE(1, 8);
            extra.writeUInt32LE(found.pid, 24);
          }
          reply(extra, found.pid === undefined ? 0 : 32);
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
const bounds = { x: 0, y: 0, width: 100, height: 80 };

describe("X11 window placement (#1358)", () => {
  it("windows on the display, owned by the pid the driver named, are on it", async () => {
    await using server = await scriptedServer(
      new Map([
        [20, { pid: 10 }],
        [21, { clientPid: 11 }],
      ]),
      { withResources: true },
    );
    const placement = makeX11WindowPlacement(display, server.path);
    expect(await placement([{ pid: 10, windowId: 20, bounds }])).toBe("same");
    // A window without _NET_WM_PID is read through the X server's own record of its client.
    expect(
      await placement([
        { pid: 10, windowId: 20 },
        { pid: 11, windowId: 21 },
      ]),
    ).toBe("same");
  });

  it("one window whose owner cannot be read leaves the whole answer unknown", async () => {
    await using server = await scriptedServer(
      new Map([
        [20, { pid: 10 }],
        [21, {}],
      ]),
    );
    const placement = makeX11WindowPlacement(display, server.path);
    expect(await placement([{ pid: 11, windowId: 21 }])).toBe("unknown");
    expect(
      await placement([
        { pid: 10, windowId: 20 },
        { pid: 11, windowId: 21 },
      ]),
    ).toBe("unknown");
  });

  it("a window the display lacks, another process owns, or that sits elsewhere is elsewhere", async () => {
    await using server = await scriptedServer(new Map([[20, { pid: 10 }]]));
    const placement = makeX11WindowPlacement(display, server.path);
    expect(
      await placement([
        { pid: 10, windowId: 20 },
        { pid: 900, windowId: 77 },
      ]),
    ).toBe("other");
    expect(await placement([{ pid: 900, windowId: 20 }])).toBe("other");
    // The same id and pid on another X server, as one process with windows on both would have.
    expect(await placement([{ pid: 10, windowId: 20, bounds: { ...bounds, x: 300 } }])).toBe(
      "other",
    );
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
