// @effect-diagnostics nodeBuiltinImport:off -- The Linux helper is its own Node process; X11 needs a raw socket and zlib.
// @effect-diagnostics globalTimers:off -- One bounded exchange at a socket callback boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { localDisplayNumber, x11SetupRequest, xauthorityCookie } from "../CuaDisplayCapability.ts";

/**
 * One X11 window's own pixels (#1328). Cua Driver captures an X11 window with XGetImage on the
 * window itself, and nothing outside the driver can prove those pixels were not whatever
 * covered the window. So the helper captures it here instead: it names the composite pixmap of
 * the window's top-level frame (CompositeNameWindowPixmap) and reads the window's part of it.
 * Naming succeeds only while a compositing manager or Xwayland redirects that frame, and the
 * pixmap holds only that window's rendering, so a capture that succeeds is the window's own;
 * an unredirected window (no compositor, a fullscreen unredirect, rootful Xwayland) is refused.
 */
export type X11WindowCapture =
  | {
      readonly png: Uint8Array;
      readonly width: number;
      readonly height: number;
      /** Where the window's top-left corner is on the root window, in screen pixels. */
      readonly origin: { readonly x: number; readonly y: number };
    }
  | { readonly refused: string };

export const UNREDIRECTED_CAPTURE =
  "This X display does not render the window by itself (no compositing manager, or it stopped redirecting windows), so a capture could show whatever covers it, other apps included. Screenshots are off here; app controls still work. A desktop with a compositor (GNOME, KDE, or picom on other window managers) can show GOAT a single window.";
const UNREADABLE = "The window's pixels could not be read in a format GOAT understands.";

const EXCHANGE_TIMEOUT_MS = 3_000;
const MAX_WINDOW_PIXELS = 16_000_000;

const pad4 = (length: number) => (4 - (length % 4)) % 4;

interface Setup {
  readonly idBase: number;
  readonly root: number;
  readonly lsbImages: boolean;
  readonly bitsPerPixel: ReadonlyMap<number, { readonly bpp: number; readonly pad: number }>;
  readonly visuals: ReadonlyMap<
    number,
    {
      readonly trueColor: boolean;
      readonly red: number;
      readonly green: number;
      readonly blue: number;
    }
  >;
}

/** The parts of the connection setup reply a capture needs (X11 protocol, section 8). */
export function parseSetup(reply: Uint8Array, screen: number): Setup | undefined {
  const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  if (reply.byteLength < 40 || reply[0] !== 1) return undefined;
  const vendor = view.getUint16(24, true);
  const screens = reply[28] ?? 0;
  const formats = reply[29] ?? 0;
  const bitsPerPixel = new Map<number, { bpp: number; pad: number }>();
  let offset = 40 + vendor + pad4(vendor);
  for (let index = 0; index < formats; index++, offset += 8)
    bitsPerPixel.set(reply[offset] ?? 0, {
      bpp: reply[offset + 1] ?? 0,
      pad: reply[offset + 2] ?? 0,
    });
  const visuals = new Map<
    number,
    { trueColor: boolean; red: number; green: number; blue: number }
  >();
  let root: number | undefined;
  for (let index = 0; index < screens; index++) {
    if (offset + 40 > reply.byteLength) return undefined;
    if (index === screen) root = view.getUint32(offset, true);
    const depths = reply[offset + 39] ?? 0;
    offset += 40;
    for (let depth = 0; depth < depths; depth++) {
      const count = view.getUint16(offset + 2, true);
      offset += 8;
      for (let visual = 0; visual < count; visual++, offset += 24)
        visuals.set(view.getUint32(offset, true), {
          trueColor: reply[offset + 4] === 4,
          red: view.getUint32(offset + 8, true),
          green: view.getUint32(offset + 12, true),
          blue: view.getUint32(offset + 16, true),
        });
    }
  }
  if (root === undefined) return undefined;
  return {
    idBase: view.getUint32(12, true),
    root,
    lsbImages: reply[30] === 0,
    bitsPerPixel,
    visuals,
  };
}

const request = (opcode: number, data: number, words: number, fill: (view: DataView) => void) => {
  const bytes = new Uint8Array(words * 4);
  const view = new DataView(bytes.buffer);
  bytes[0] = opcode;
  bytes[1] = data;
  view.setUint16(2, words, true);
  fill(view);
  return bytes;
};

const shiftOf = (mask: number) => {
  let shift = 0;
  while (shift < 32 && ((mask >>> shift) & 1) === 0) shift++;
  return shift;
};

/** A ZPixmap of 32 bits per pixel, as an RGB PNG. */
export function zpixmapToPng(
  data: Uint8Array,
  width: number,
  height: number,
  stride: number,
  masks: { readonly red: number; readonly green: number; readonly blue: number },
): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const raw = new Uint8Array((width * 3 + 1) * height);
  const channel = (pixel: number, mask: number) => {
    const shift = shiftOf(mask);
    const top = mask >>> shift;
    return top === 0 ? 0 : Math.round((((pixel & mask) >>> shift) * 255) / top);
  };
  for (let row = 0; row < height; row++) {
    const out = row * (width * 3 + 1) + 1;
    for (let x = 0; x < width; x++) {
      const pixel = view.getUint32(row * stride + x * 4, true);
      raw[out + x * 3] = channel(pixel, masks.red);
      raw[out + x * 3 + 1] = channel(pixel, masks.green);
      raw[out + x * 3 + 2] = channel(pixel, masks.blue);
    }
  }
  const chunk = (type: string, body: Uint8Array) => {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, body.length);
    head.set(new TextEncoder().encode(type), 4);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, NodeZlib.crc32(Buffer.concat([head.subarray(4), body])));
    return Buffer.concat([head, body, crc]);
  };
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Talks to one X server in order: each ask resolves with its reply, or undefined on an error. */
function connection(socket: NodeNet.Socket) {
  let buffer = new Uint8Array(0);
  let setup: ((reply: Uint8Array | undefined) => void) | undefined;
  const waiting: Array<(reply: Uint8Array | undefined) => void> = [];
  const fail = () => {
    setup?.(undefined);
    setup = undefined;
    for (const wake of waiting.splice(0)) wake(undefined);
  };
  socket.on("error", fail);
  socket.on("close", fail);
  socket.on("data", (chunk: Buffer) => {
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer);
    next.set(chunk, buffer.length);
    buffer = next;
    if (setup) {
      if (buffer.length < 8) return;
      const total = 8 + 4 * new DataView(buffer.buffer).getUint16(6, true);
      if (buffer.length < total) return;
      const done = setup;
      setup = undefined;
      const reply = buffer.slice(0, total);
      buffer = buffer.slice(total);
      done(reply);
    }
    for (;;) {
      if (buffer.length < 32) return;
      const kind = buffer[0] ?? 0;
      const length = kind === 1 ? 32 + 4 * new DataView(buffer.buffer).getUint32(4, true) : 32;
      if (buffer.length < length) return;
      const message = buffer.slice(0, length);
      buffer = buffer.slice(length);
      // An error ends the exchange: an unnamed pixmap errs and so does every read of it.
      if (kind === 0) fail();
      else if (kind === 1) waiting.shift()?.(message);
    }
  });
  return {
    start: (bytes: Uint8Array) =>
      new Promise<Uint8Array | undefined>((resolve) => {
        setup = resolve;
        socket.write(bytes);
      }),
    send: (bytes: Uint8Array) => void socket.write(bytes),
    ask: (bytes: Uint8Array) =>
      new Promise<Uint8Array | undefined>((resolve) => {
        waiting.push(resolve);
        socket.write(bytes);
      }),
  };
}

export async function captureX11Window(
  environment: { readonly DISPLAY?: string | undefined; readonly XAUTHORITY?: string | undefined },
  windowId: number,
  /** For tests: a scripted server's socket. */
  socketPath?: string,
): Promise<X11WindowCapture> {
  const display = localDisplayNumber(environment.DISPLAY);
  if (display === null) return { refused: UNREDIRECTED_CAPTURE };
  const screen = Number(/\.(\d+)$/u.exec(environment.DISPLAY?.trim() ?? "")?.[1] ?? 0);
  const authFile = environment.XAUTHORITY?.trim() || NodePath.join(NodeOS.homedir(), ".Xauthority");
  const cookie = await NodeFSP.readFile(authFile).then(
    (bytes) => xauthorityCookie(bytes, display),
    () => null,
  );
  const socket = NodeNet.createConnection(socketPath ?? "/tmp/.X11-unix/X" + display);
  const timer = setTimeout(() => socket.destroy(), EXCHANGE_TIMEOUT_MS);
  try {
    return (
      (await exchange(connection(socket), cookie, screen, windowId)) ?? {
        refused: UNREDIRECTED_CAPTURE,
      }
    );
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

async function exchange(
  x: ReturnType<typeof connection>,
  cookie: Uint8Array | null,
  screen: number,
  windowId: number,
): Promise<X11WindowCapture | undefined> {
  const setupReply = await x.start(x11SetupRequest(cookie));
  const setup = setupReply && parseSetup(setupReply, screen);
  if (!setup) return undefined;
  const name = new TextEncoder().encode("Composite");
  const extension = await x.ask(
    request(98, 0, 2 + Math.ceil(name.length / 4), (view) => {
      view.setUint16(4, name.length, true);
      name.forEach((byte, index) => view.setUint8(8 + index, byte));
    }),
  );
  if (!extension || extension[8] !== 1) return undefined;
  const composite = extension[9] ?? 0;
  // CompositeQueryVersion must come first; NameWindowPixmap needs 0.2.
  const version = await x.ask(
    request(composite, 0, 3, (view) => {
      view.setUint32(4, 0, true);
      view.setUint32(8, 4, true);
    }),
  );
  if (!version) return undefined;
  const versionView = new DataView(version.buffer);
  if (versionView.getUint32(8, true) === 0 && versionView.getUint32(12, true) < 2) return undefined;
  const geometry = await x.ask(request(14, 0, 2, (view) => view.setUint32(4, windowId, true)));
  if (!geometry) return undefined;
  const geometryView = new DataView(geometry.buffer);
  const width = geometryView.getUint16(16, true);
  const height = geometryView.getUint16(18, true);
  if (width === 0 || height === 0 || width * height > MAX_WINDOW_PIXELS)
    return { refused: UNREADABLE };
  // The redirected window is the top-level one: the window itself or its frame's child of root.
  let topLevel = windowId;
  for (let hops = 0; hops < 32; hops++) {
    const tree = await x.ask(request(15, 0, 2, (view) => view.setUint32(4, topLevel, true)));
    if (!tree) return undefined;
    const parent = new DataView(tree.buffer).getUint32(12, true);
    if (parent === setup.root || parent === 0) break;
    topLevel = parent;
  }
  const translate = (destination: number) =>
    x.ask(
      request(40, 0, 4, (view) => {
        view.setUint32(4, windowId, true);
        view.setUint32(8, destination, true);
      }),
    );
  const inFrame = await translate(topLevel);
  const onScreen = await translate(setup.root);
  if (!inFrame || !onScreen) return undefined;
  const offset = (reply: Uint8Array) => {
    const view = new DataView(reply.buffer);
    return { x: view.getInt16(12, true), y: view.getInt16(14, true) };
  };
  // The named pixmap holds the top-level window with its border, and its pixels are in that
  // window's visual: a pixmap read answers with no visual of its own.
  const frameGeometry = await x.ask(request(14, 0, 2, (view) => view.setUint32(4, topLevel, true)));
  const attributes = await x.ask(request(3, 0, 2, (view) => view.setUint32(4, topLevel, true)));
  if (!frameGeometry || !attributes) return undefined;
  const border = new DataView(frameGeometry.buffer).getUint16(20, true);
  const inside = offset(inFrame);
  const at = { x: inside.x + border, y: inside.y + border };
  const visualId = new DataView(attributes.buffer).getUint32(8, true);
  const pixmap = setup.idBase | 1;
  // No reply; if the frame is not redirected it errs, and the read below never answers.
  x.send(
    request(composite, 6, 3, (view) => {
      view.setUint32(4, topLevel, true);
      view.setUint32(8, pixmap, true);
    }),
  );
  const image = await x.ask(
    request(73, 2, 5, (view) => {
      view.setUint32(4, pixmap, true);
      view.setInt16(8, at.x, true);
      view.setInt16(10, at.y, true);
      view.setUint16(12, width, true);
      view.setUint16(14, height, true);
      view.setUint32(16, 0xffffffff, true);
    }),
  );
  x.send(request(54, 0, 2, (view) => view.setUint32(4, pixmap, true)));
  if (!image) return undefined;
  const depth = image[1] ?? 0;
  const visual = setup.visuals.get(visualId);
  const format = setup.bitsPerPixel.get(depth);
  if (!setup.lsbImages || !visual?.trueColor || format?.bpp !== 32) return { refused: UNREADABLE };
  const stride = Math.ceil((width * format.bpp) / format.pad) * (format.pad / 8);
  const data = image.subarray(32);
  if (data.length < stride * height) return { refused: UNREADABLE };
  return {
    png: zpixmapToPng(data, width, height, stride, visual),
    width,
    height,
    origin: offset(onScreen),
  };
}
