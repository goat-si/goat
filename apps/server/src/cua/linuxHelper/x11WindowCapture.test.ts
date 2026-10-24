// @effect-diagnostics nodeBuiltinImport:off -- A scripted X server on a Unix socket stands in for Xorg.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { pngColors } from "./linuxSession.ts";
import {
  BUSY_CAPTURE,
  captureX11Window,
  parseSetup,
  RESIZED_CAPTURE,
  rgbToPng,
  SHARED_CAPTURE,
  shrinkRgb,
  UNREDIRECTED_CAPTURE,
  zpixmapToRgb,
} from "./x11WindowCapture.ts";

/** A setup reply: one pixmap format (depth 24 at 32 bpp), one screen, one TrueColor visual. */
function setupReply(options: { readonly lsb: boolean }) {
  const vendor = "GOAT";
  const bytes = new Uint8Array(40 + 4 + 8 + 40 + 8 + 24);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  view.setUint16(6, (bytes.length - 8) / 4, true);
  view.setUint32(12, 0x0400000, true);
  view.setUint16(24, vendor.length, true);
  bytes[28] = 1;
  bytes[29] = 1;
  bytes[30] = options.lsb ? 0 : 1;
  bytes.set(new TextEncoder().encode(vendor), 40);
  bytes.set([24, 32, 32], 44);
  const screen = 52;
  view.setUint32(screen, 0x2b, true);
  bytes[screen + 39] = 1;
  bytes[screen + 40] = 24;
  view.setUint16(screen + 42, 1, true);
  const visual = screen + 48;
  view.setUint32(visual, 0x21, true);
  bytes[visual + 4] = 4;
  view.setUint32(visual + 8, 0xff0000, true);
  view.setUint32(visual + 12, 0x00ff00, true);
  view.setUint32(visual + 16, 0x0000ff, true);
  return bytes;
}

describe("X11 window capture", () => {
  it("reads the root, resource base, pixel layout and visual masks from the setup reply", () => {
    const setup = parseSetup(setupReply({ lsb: true }), 0);
    expect(setup).toMatchObject({ idBase: 0x0400000, root: 0x2b, lsbImages: true });
    expect(setup?.bitsPerPixel.get(24)).toEqual({ bpp: 32, pad: 32 });
    expect(setup?.visuals.get(0x21)).toEqual({
      trueColor: true,
      red: 0xff0000,
      green: 0x00ff00,
      blue: 0x0000ff,
    });
    // A screen the server does not have is no setup at all.
    expect(parseSetup(setupReply({ lsb: true }), 1)).toBeUndefined();
  });

  it("turns 32-bit pixels into an RGB PNG by the visual's masks", () => {
    const width = 3;
    const height = 2;
    const data = new Uint8Array(width * height * 4);
    const view = new DataView(data.buffer);
    // One red pixel among dark ones, in BGRX order as an LSB server sends them.
    for (let index = 0; index < width * height; index++) view.setUint32(index * 4, 0x101010, true);
    view.setUint32(0, 0xff0000, true);
    const rgb = zpixmapToRgb(data, width, height, width * 4, {
      red: 0xff0000,
      green: 0x00ff00,
      blue: 0x0000ff,
    });
    expect([...rgb.subarray(0, 6)]).toEqual([255, 0, 0, 16, 16, 16]);
    const png = rgbToPng(rgb, width, height);
    expect(pngColors(png)).toBe("varied");
    const header = new DataView(png.buffer, png.byteOffset + 16, 8);
    expect([header.getUint32(0), header.getUint32(4)]).toEqual([width, height]);
  });

  it("shrinks to the driver's screenshot size by averaging, never past the source", () => {
    // Four pixels, two black and two white, become one mid grey.
    const rgb = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0]);
    expect([...shrinkRgb(rgb, 2, 2, 1, 1)]).toEqual([128, 128, 128]);
    expect(shrinkRgb(rgb, 2, 2, 2, 2)).toBe(rgb);
  });
});

interface FakeWindow {
  readonly parent: number;
  readonly children: ReadonlyArray<number>;
  /** Position on the root. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly viewable?: boolean;
  readonly inputOnly?: boolean;
  readonly overrideRedirect?: boolean;
}

const ROOT = 0x2b;
const COMPOSITE = 140;
const CLIENT_LIST = 301;

/**
 * An X server holding these windows: it answers the requests a capture makes, names the pixmap
 * only of a redirected window, and fills images with one gray. closeOnGeometry drops the
 * connection on that GetGeometry (counted from 1).
 */
async function scriptedServer(
  windows: Readonly<Record<number, FakeWindow>>,
  options: {
    readonly redirected: ReadonlyArray<number>;
    readonly closeOnGeometry?: number;
    /** Never answer GetImage, as a server stuck mid-read. */
    readonly stallImage?: boolean;
    /** The target window's size from its second GetGeometry on, as a window that grew. */
    readonly grows?: { readonly width: number; readonly height: number };
    /** The root's _NET_CLIENT_LIST, the windows a window manager manages; none is no manager. */
    readonly managed?: ReadonlyArray<number>;
  },
) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-x-"));
  const path = NodePath.join(dir, "X0");
  /** Every request's major opcode, in the order the server read them. */
  const requests: number[] = [];
  /** Settles when a client's connection has ended and everything it sent was read. */
  const ended = Promise.withResolvers<void>();
  const setup = Buffer.from(setupReply({ lsb: true }));
  setup.writeUInt32LE(0x1fffff, 16);
  const server = NodeNet.createServer((socket) => {
    socket.on("end", () => ended.resolve());
    socket.on("close", () => ended.resolve());
    // A client that dropped the connection makes the next answer fail; that is the client's end.
    socket.on("error", () => ended.resolve());
    let buffer = Buffer.alloc(0);
    let started = false;
    let geometries = 0;
    const sizes = new Map<number, number>();
    let named: number | undefined;
    const reply = (extra: Buffer, data = 0) => {
      const head = Buffer.alloc(32);
      head[0] = 1;
      head[1] = data;
      head.writeUInt32LE(Math.max(0, extra.length - 24) / 4, 4);
      extra.copy(head, 8, 0, Math.min(24, extra.length));
      socket.write(extra.length > 24 ? Buffer.concat([head, extra.subarray(24)]) : head);
    };
    const error = () => {
      const bytes = Buffer.alloc(32);
      bytes[1] = 8;
      socket.write(bytes);
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!started) {
        if (buffer.length < 12) return;
        started = true;
        buffer = buffer.subarray(12);
        socket.write(setup);
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt16LE(2) * 4;
        if (buffer.length < length) return;
        const op = buffer[0];
        const minor = buffer[1];
        requests.push(op ?? 0);
        const body = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        const window = (at: number) => windows[body.readUInt32LE(at)];
        const payload = (size: number) => Buffer.alloc(size);
        if (op === 98) {
          const extra = payload(24);
          extra[0] = 1;
          extra[1] = COMPOSITE;
          reply(extra);
        } else if (op === COMPOSITE && minor === 0) {
          const extra = payload(24);
          extra.writeUInt32LE(0, 0);
          extra.writeUInt32LE(4, 4);
          reply(extra);
        } else if (op === COMPOSITE && minor === 6) {
          const target = body.readUInt32LE(4);
          if (options.redirected.includes(target)) named = body.readUInt32LE(8);
          else error();
        } else if (op === 14) {
          geometries++;
          if (geometries === options.closeOnGeometry) return void socket.destroy();
          const target = body.readUInt32LE(4);
          const seen = (sizes.get(target) ?? 0) + 1;
          sizes.set(target, seen);
          const listed = window(4);
          if (!listed) return error();
          const found =
            options.grows && target === 0x200001 && seen > 1
              ? { ...listed, ...options.grows }
              : listed;
          const parent = windows[found.parent];
          const extra = payload(24);
          extra.writeUInt32LE(ROOT, 0);
          extra.writeInt16LE(found.x - (parent?.x ?? 0), 4);
          extra.writeInt16LE(found.y - (parent?.y ?? 0), 6);
          extra.writeUInt16LE(found.width, 8);
          extra.writeUInt16LE(found.height, 10);
          reply(extra, 24);
        } else if (op === 15) {
          const found = window(4);
          if (!found) return error();
          const extra = payload(24 + found.children.length * 4);
          extra.writeUInt32LE(ROOT, 0);
          extra.writeUInt32LE(found.parent, 4);
          extra.writeUInt16LE(found.children.length, 8);
          found.children.forEach((child, index) => extra.writeUInt32LE(child, 24 + index * 4));
          reply(extra);
        } else if (op === 40) {
          const from = window(4);
          const to = body.readUInt32LE(8) === ROOT ? { x: 0, y: 0 } : window(8);
          if (!from || !to) return error();
          const extra = payload(24);
          extra.writeInt16LE(from.x - to.x, 4);
          extra.writeInt16LE(from.y - to.y, 6);
          reply(extra, 1);
        } else if (op === 16) {
          const extra = payload(24);
          extra.writeUInt32LE(CLIENT_LIST, 0);
          reply(extra);
        } else if (op === 20) {
          const list = body.readUInt32LE(4) === ROOT ? (options.managed ?? [0x200001]) : [];
          const extra = payload(24 + list.length * 4);
          extra.writeUInt32LE(33, 0);
          extra.writeUInt32LE(list.length, 8);
          list.forEach((window, index) => extra.writeUInt32LE(window, 24 + index * 4));
          reply(extra, 32);
        } else if (op === 3) {
          const found = window(4);
          if (!found) return error();
          const extra = payload(36);
          extra.writeUInt32LE(0x21, 0);
          extra.writeUInt16LE(found.inputOnly ? 2 : 1, 4);
          extra[18] = found.viewable === false ? 0 : 2;
          extra[19] = found.overrideRedirect ? 1 : 0;
          reply(extra);
        } else if (op === 73) {
          if (options.stallImage) continue;
          if (body.readUInt32LE(4) !== named) return error();
          const width = body.readUInt16LE(12);
          const height = body.readUInt16LE(14);
          const extra = payload(24 + width * height * 4);
          extra.writeUInt32LE(0x21, 0);
          for (let pixel = 0; pixel < width * height; pixel++)
            extra.writeUInt32LE(0x808080, 24 + pixel * 4);
          reply(extra, 24);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    requests,
    ended: ended.promise,
    [Symbol.asyncDispose]: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const environment = { DISPLAY: ":0", XAUTHORITY: "/nonexistent/goat-xauthority" };
const shot = { width: 100, height: 80, windowWidth: 100, windowHeight: 80 };
// A window manager's frame (client 0x400000) holding the app's window (client 0x200000).
const FRAMED: Record<number, FakeWindow> = {
  [ROOT]: { parent: 0, children: [0x400001], x: 0, y: 0, width: 800, height: 600 },
  0x400001: { parent: ROOT, children: [0x200001], x: 10, y: 10, width: 100, height: 100 },
  0x200001: { parent: 0x400001, children: [], x: 10, y: 30, width: 100, height: 80 },
};

describe("X11 window capture against a scripted server", () => {
  it("captures a window inside its redirected frame, at the driver's size", async () => {
    await using server = await scriptedServer(FRAMED, { redirected: [0x400001] });
    const capture = await captureX11Window(environment, 0x200001, shot, {
      socketPath: server.path,
    });
    expect(capture).toMatchObject({ width: 100, height: 80 });
  });

  it("refuses a window whose frame nothing redirects", async () => {
    await using server = await scriptedServer(FRAMED, { redirected: [] });
    expect(
      await captureX11Window(environment, 0x200001, shot, { socketPath: server.path }),
    ).toEqual({
      refused: UNREDIRECTED_CAPTURE,
    });
  });

  it("refuses when another client's window is drawn over it inside the same frame", async () => {
    const shared: Record<number, FakeWindow> = {
      ...FRAMED,
      0x400001: { ...FRAMED[0x400001]!, children: [0x200001, 0x600001] },
      0x600001: { parent: 0x400001, children: [], x: 40, y: 50, width: 30, height: 30 },
    };
    await using server = await scriptedServer(shared, { redirected: [0x400001] });
    expect(
      await captureX11Window(environment, 0x200001, shot, { socketPath: server.path }),
    ).toEqual({
      refused: SHARED_CAPTURE,
    });
    // The same window unmapped, input-only, or off to the side draws nothing over it.
    for (const other of [{ viewable: false }, { inputOnly: true }, { x: 400, y: 400 }]) {
      await using clear = await scriptedServer(
        { ...shared, 0x600001: { ...shared[0x600001]!, ...other } },
        { redirected: [0x400001] },
      );
      expect(
        await captureX11Window(environment, 0x200001, shot, { socketPath: clear.path }),
      ).toMatchObject({
        width: 100,
      });
    }
  });

  it("refuses when another client's window lies under it inside the same frame (#1335 shaped targets)", async () => {
    // A shaped target, or one without a background, shows what is stacked below it in the pixmap.
    const below: Record<number, FakeWindow> = {
      ...FRAMED,
      0x400001: { ...FRAMED[0x400001]!, children: [0x600001, 0x200001] },
      0x600001: { parent: 0x400001, children: [], x: 40, y: 50, width: 30, height: 30 },
    };
    await using server = await scriptedServer(below, { redirected: [0x400001] });
    expect(
      await captureX11Window(environment, 0x200001, shot, { socketPath: server.path }),
    ).toEqual({ refused: SHARED_CAPTURE });
  });

  it("refuses when another client's window is a child of the target", async () => {
    const embedded: Record<number, FakeWindow> = {
      ...FRAMED,
      0x200001: { ...FRAMED[0x200001]!, children: [0x600001] },
      0x600001: { parent: 0x200001, children: [], x: 40, y: 50, width: 30, height: 30 },
    };
    await using server = await scriptedServer(embedded, { redirected: [0x400001] });
    expect(
      await captureX11Window(environment, 0x200001, shot, { socketPath: server.path }),
    ).toEqual({ refused: SHARED_CAPTURE });
  });

  it("captures a window with the window manager's own backing window under it, as Openbox frames do", async () => {
    const openbox: Record<number, FakeWindow> = {
      ...FRAMED,
      0x400001: { ...FRAMED[0x400001]!, children: [0x400002, 0x200001] },
      0x400002: { parent: 0x400001, children: [], x: 10, y: 30, width: 100, height: 80 },
    };
    await using server = await scriptedServer(openbox, { redirected: [0x400001] });
    expect(
      await captureX11Window(environment, 0x200001, shot, { socketPath: server.path }),
    ).toMatchObject({ width: 100, height: 80 });
  });

  it("trusts the top-level's client only when a window manager frames the target", async () => {
    // Another app's own top-level holding the target and its window beside it (#1335 r11).
    const appTop: Record<number, FakeWindow> = {
      ...FRAMED,
      0x400001: { ...FRAMED[0x400001]!, children: [0x200001, 0x400002] },
      0x400002: { parent: 0x400001, children: [], x: 40, y: 50, width: 30, height: 30 },
    };
    for (const [windows, managed] of [
      [appTop, []],
      [appTop, [0x200001, 0x400001]],
      [{ ...appTop, 0x400001: { ...appTop[0x400001]!, overrideRedirect: true } }, [0x200001]],
    ] as const) {
      await using server = await scriptedServer(windows, { redirected: [0x400001], managed });
      expect(
        await captureX11Window(environment, 0x200001, shot, { socketPath: server.path }),
      ).toEqual({ refused: SHARED_CAPTURE });
    }
  });

  it("refuses when another client's window sits between the target and its frame", async () => {
    // Its background shows wherever a shaped target leaves a gap (#1335 r11).
    const nested: Record<number, FakeWindow> = {
      ...FRAMED,
      0x400001: { ...FRAMED[0x400001]!, children: [0x600001] },
      0x600001: { parent: 0x400001, children: [0x200001], x: 10, y: 30, width: 100, height: 80 },
      0x200001: { ...FRAMED[0x200001]!, parent: 0x600001 },
    };
    await using server = await scriptedServer(nested, { redirected: [0x400001] });
    expect(
      await captureX11Window(environment, 0x200001, shot, { socketPath: server.path }),
    ).toEqual({ refused: SHARED_CAPTURE });
  });

  it("a window that grew since the driver's screenshot is refused rather than mismatched", async () => {
    await using server = await scriptedServer(FRAMED, { redirected: [0x400001] });
    expect(
      await captureX11Window(
        environment,
        0x200001,
        { ...shot, windowHeight: 90 },
        { socketPath: server.path },
      ),
    ).toEqual({ refused: RESIZED_CAPTURE });
  });

  it("holds the server from the size check through the pixel read, and only for that", async () => {
    await using server = await scriptedServer(FRAMED, { redirected: [0x400001] });
    await captureX11Window(environment, 0x200001, shot, { socketPath: server.path });
    await server.ended;
    const grab = server.requests.indexOf(36);
    const release = server.requests.indexOf(37);
    const held = server.requests.slice(grab + 1, release);
    // The size is checked again, the window and its frame's border placed, and the pixels read,
    // all while held; the release follows the read.
    expect(grab).toBeGreaterThan(0);
    expect(release).toBeGreaterThan(server.requests.indexOf(73));
    expect(held[0]).toBe(14);
    expect(held).toContain(40);
    // The window's own size and its frame's border are both read while held.
    expect(held.filter((op) => op === 14)).toHaveLength(2);
    expect(held).toContain(73);
    // The tree walk up to the top-level window happens before the hold.
    expect(server.requests.slice(0, grab)).toContain(15);
  });

  it("an unchanged window read at a rounded thumbnail size is not taken for a resized one", async () => {
    // 1920 x 1040 at 256 wide is 256 x 138.67, which the driver rounds to 139.
    const wide: Record<number, FakeWindow> = {
      [ROOT]: { parent: 0, children: [0x200001], x: 0, y: 0, width: 1920, height: 1080 },
      0x200001: { parent: ROOT, children: [], x: 0, y: 0, width: 1920, height: 1040 },
    };
    await using server = await scriptedServer(wide, { redirected: [0x200001] });
    expect(
      await captureX11Window(
        environment,
        0x200001,
        { width: 256, height: 139, windowWidth: 1920, windowHeight: 1040 },
        // The scripted server's 2 MP reply can outlast the real hold limit on a slow runner; this
        // test is about rounding, the hold limit has its own test.
        { socketPath: server.path, grabLimitMs: 60_000 },
      ),
    ).toMatchObject({ width: 256, height: 139 });
  });

  it("a hold that runs past its limit is ended, by dropping the connection, and refused", async () => {
    await using server = await scriptedServer(FRAMED, { redirected: [0x400001], stallImage: true });
    const held: number[] = [];
    const capture = await captureX11Window(environment, 0x200001, shot, {
      socketPath: server.path,
      grabLimitMs: 1,
      onGrab: (ms) => held.push(ms),
    });
    expect(capture).toEqual({ refused: BUSY_CAPTURE });
    // The server sees the connection end, which releases the hold.
    await server.ended;
    expect(held).toHaveLength(1);
  });

  it("a window that grew past the pixel budget after its first read is refused before any pixels are asked for", async () => {
    await using server = await scriptedServer(FRAMED, {
      redirected: [0x400001],
      grows: { width: 8000, height: 8000 },
    });
    const capture = await captureX11Window(
      environment,
      0x200001,
      { width: 1568, height: 1568, windowWidth: 8000, windowHeight: 8000 },
      { socketPath: server.path },
    );
    expect(capture).toEqual({ refused: expect.stringContaining("could not be read") });
    await server.ended;
    expect(server.requests).not.toContain(73);
  });

  it("a window whose size differs from the driver's read by any amount is refused", async () => {
    await using server = await scriptedServer(FRAMED, { redirected: [0x400001] });
    for (const changed of [{ windowHeight: 81 }, { windowWidth: 99 }])
      expect(
        await captureX11Window(
          environment,
          0x200001,
          { ...shot, ...changed },
          { socketPath: server.path },
        ),
      ).toEqual({ refused: RESIZED_CAPTURE });
  });

  it("a connection lost in the middle ends the capture instead of leaving it waiting", async () => {
    // The second GetGeometry is the frame's, asked after the window's own.
    await using server = await scriptedServer(FRAMED, {
      redirected: [0x400001],
      closeOnGeometry: 2,
    });
    expect(
      await captureX11Window(environment, 0x200001, shot, { socketPath: server.path }),
    ).toEqual({
      refused: UNREDIRECTED_CAPTURE,
    });
  });
});
