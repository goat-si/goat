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
 * covered the window. So the helper captures it here: it names the composite pixmap of the
 * window's top-level ancestor (CompositeNameWindowPixmap) and reads the window's part of it.
 * Naming succeeds only while that ancestor is redirected, and the pixmap then holds only what
 * is drawn inside the ancestor. Another client's window can still be drawn there, over the
 * target (a shared frame, a virtual root), so every window painted after the target inside the
 * ancestor is checked, and one from another client that overlaps it refuses the capture. The
 * server is held from the check through the read, so what was checked is what is read, with a
 * best-effort limit of GRAB_LIMIT_MS.
 * An unredirected window (no compositor, a fullscreen unredirect, rootful Xwayland) is refused.
 */
export type X11WindowCapture =
  | {
      readonly png: Uint8Array;
      readonly width: number;
      readonly height: number;
    }
  | { readonly refused: string };

export const UNREDIRECTED_CAPTURE =
  "This X display does not render the window by itself (no compositing manager, or it stopped redirecting windows), so a capture could show whatever covers it, other apps included. Screenshots are off here; app controls still work. A desktop with a compositor (GNOME, KDE, or picom on other window managers) can show GOAT a single window.";
export const SHARED_CAPTURE =
  "Another app's window overlaps this one inside the same frame, so its screenshot could show that app. Observe it without a screenshot, or move the other window away.";
const UNREADABLE = "The window's pixels could not be read in a format GOAT understands.";
export const BUSY_CAPTURE =
  "The window took too long to read without holding up the rest of the desktop. Observe it again.";
export const RESIZED_CAPTURE =
  "The window changed size while it was read, so its screenshot would not match its controls. Observe it again.";

const EXCHANGE_TIMEOUT_MS = 3_000;
/**
 * Longest the X server may be held for one capture. While it is held every other client on the
 * display, the person's own apps included, waits; past this the hold ends and the capture is
 * refused rather than freeze the desktop longer.
 */
const GRAB_LIMIT_MS = 250;
const MAX_WINDOW_PIXELS = 16_000_000;
/** Windows checked for drawing over the target before the capture gives up and refuses. */
const MAX_CHECKED_WINDOWS = 256;

const pad4 = (length: number) => (4 - (length % 4)) % 4;

interface Setup {
  readonly idBase: number;
  readonly idMask: number;
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
    idMask: view.getUint32(16, true),
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

/** A ZPixmap of 32 bits per pixel as packed RGB, by the visual's masks. */
export function zpixmapToRgb(
  data: Uint8Array,
  width: number,
  height: number,
  stride: number,
  masks: { readonly red: number; readonly green: number; readonly blue: number },
): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rgb = new Uint8Array(width * height * 3);
  const channel = (pixel: number, mask: number) => {
    const shift = shiftOf(mask);
    const top = mask >>> shift;
    return top === 0 ? 0 : Math.round((((pixel & mask) >>> shift) * 255) / top);
  };
  for (let row = 0; row < height; row++)
    for (let x = 0; x < width; x++) {
      const pixel = view.getUint32(row * stride + x * 4, true);
      const at = (row * width + x) * 3;
      rgb[at] = channel(pixel, masks.red);
      rgb[at + 1] = channel(pixel, masks.green);
      rgb[at + 2] = channel(pixel, masks.blue);
    }
  return rgb;
}

/** Packed RGB scaled down by averaging each target pixel's area; never scaled up. */
export function shrinkRgb(
  rgb: Uint8Array,
  width: number,
  height: number,
  toWidth: number,
  toHeight: number,
): Uint8Array {
  if (toWidth === width && toHeight === height) return rgb;
  const out = new Uint8Array(toWidth * toHeight * 3);
  for (let y = 0; y < toHeight; y++) {
    const top = Math.floor((y * height) / toHeight);
    const bottom = Math.max(top + 1, Math.floor(((y + 1) * height) / toHeight));
    for (let x = 0; x < toWidth; x++) {
      const left = Math.floor((x * width) / toWidth);
      const right = Math.max(left + 1, Math.floor(((x + 1) * width) / toWidth));
      const sum = [0, 0, 0];
      for (let row = top; row < bottom; row++)
        for (let column = left; column < right; column++)
          for (let channel = 0; channel < 3; channel++)
            sum[channel] = (sum[channel] ?? 0) + (rgb[(row * width + column) * 3 + channel] ?? 0);
      const count = (bottom - top) * (right - left);
      for (let channel = 0; channel < 3; channel++)
        out[(y * toWidth + x) * 3 + channel] = Math.round((sum[channel] ?? 0) / count);
    }
  }
  return out;
}

/** Packed RGB as a PNG, every row unfiltered. */
export function rgbToPng(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let row = 0; row < height; row++)
    raw.set(rgb.subarray(row * width * 3, (row + 1) * width * 3), row * (width * 3 + 1) + 1);
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

/**
 * Talks to one X server in order: each ask resolves with its reply, or undefined once anything
 * failed. After a failure every later ask resolves undefined at once, so nothing waits on a
 * connection that is gone.
 */
function connection(socket: NodeNet.Socket) {
  let buffer = new Uint8Array(0);
  let closed = false;
  let setup: ((reply: Uint8Array | undefined) => void) | undefined;
  const waiting: Array<(reply: Uint8Array | undefined) => void> = [];
  const fail = () => {
    closed = true;
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
        if (closed) return resolve(undefined);
        setup = resolve;
        socket.write(bytes);
      }),
    send: (bytes: Uint8Array) => {
      if (!closed) socket.write(bytes);
    },
    ask: (bytes: Uint8Array) =>
      new Promise<Uint8Array | undefined>((resolve) => {
        if (closed) return resolve(undefined);
        waiting.push(resolve);
        socket.write(bytes);
      }),
    close: fail,
    /** Ends the connection now; the X server then releases anything it held for it. */
    abort: () => {
      fail();
      socket.destroy();
    },
  };
}

type Connection = ReturnType<typeof connection>;

export interface DriverShot {
  readonly width: number;
  readonly height: number;
  /** The window's size when the driver read it (its window_bounds). */
  readonly windowWidth: number;
  readonly windowHeight: number;
}

export async function captureX11Window(
  environment: { readonly DISPLAY?: string | undefined; readonly XAUTHORITY?: string | undefined },
  windowId: number,
  /**
   * The driver's screenshot of this window, which its points and frames are in: the size to
   * deliver, and the window size it was taken at.
   */
  size: DriverShot,
  options: {
    /** For tests: a scripted server's socket. */
    readonly socketPath?: string;
    /** How long the X server was held, in milliseconds. */
    readonly onGrab?: (ms: number) => void;
    /** For tests: a shorter hold limit than GRAB_LIMIT_MS. */
    readonly grabLimitMs?: number;
  } = {},
): Promise<X11WindowCapture> {
  const display = localDisplayNumber(environment.DISPLAY);
  if (display === null) return { refused: UNREDIRECTED_CAPTURE };
  const screen = Number(/\.(\d+)$/u.exec(environment.DISPLAY?.trim() ?? "")?.[1] ?? 0);
  const authFile = environment.XAUTHORITY?.trim() || NodePath.join(NodeOS.homedir(), ".Xauthority");
  const cookie = await NodeFSP.readFile(authFile).then(
    (bytes) => xauthorityCookie(bytes, display),
    () => null,
  );
  const socket = NodeNet.createConnection(options.socketPath ?? "/tmp/.X11-unix/X" + display);
  const x = connection(socket);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      x.close();
      resolve(undefined);
    }, EXCHANGE_TIMEOUT_MS);
  });
  try {
    const answer = await Promise.race([
      exchange(x, cookie, screen, windowId, size, {
        onGrab: options.onGrab,
        limitMs: options.grabLimitMs ?? GRAB_LIMIT_MS,
      }),
      expired,
    ]);
    return answer ?? { refused: UNREDIRECTED_CAPTURE };
  } finally {
    clearTimeout(timer);
    // end() sends what is queued, the server release included; a server that never closes its
    // side is dropped shortly after.
    socket.end();
    setTimeout(() => socket.destroy(), 1_000).unref();
  }
}

const u16 = (reply: Uint8Array, at: number) => new DataView(reply.buffer).getUint16(at, true);
const i16 = (reply: Uint8Array, at: number) => new DataView(reply.buffer).getInt16(at, true);
const u32 = (reply: Uint8Array, at: number) => new DataView(reply.buffer).getUint32(at, true);

const queryTree = (x: Connection, window: number) =>
  x.ask(request(15, 0, 2, (view) => view.setUint32(4, window, true)));
const getGeometry = (x: Connection, window: number) =>
  x.ask(request(14, 0, 2, (view) => view.setUint32(4, window, true)));
const getAttributes = (x: Connection, window: number) =>
  x.ask(request(3, 0, 2, (view) => view.setUint32(4, window, true)));
const translate = (x: Connection, window: number, destination: number) =>
  x.ask(
    request(40, 0, 4, (view) => {
      view.setUint32(4, window, true);
      view.setUint32(8, destination, true);
    }),
  );
const childrenOf = (tree: Uint8Array) =>
  Array.from({ length: u16(tree, 16) }, (_, index) => u32(tree, 32 + index * 4));

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Whether a window another client drew can show in the target's rectangle inside its top-level
 * ancestor: every sibling of the target or one of its ancestors, with all it holds. Siblings
 * stacked below count too, since a shaped target or one without a background shows what lies
 * under it in the pixmap. Undefined when that cannot be read.
 */
async function drawnOver(
  x: Connection,
  setup: Setup,
  chain: ReadonlyArray<number>,
  target: Rect,
): Promise<boolean | undefined> {
  const client = (window: number) => window & ~setup.idMask;
  const owner = client(chain[0] ?? 0);
  const pending: number[] = [];
  for (let level = 0; level + 1 < chain.length; level++) {
    const tree = await queryTree(x, chain[level + 1] ?? 0);
    if (!tree) return undefined;
    const children = childrenOf(tree);
    const at = children.indexOf(chain[level] ?? 0);
    if (at < 0) return undefined;
    pending.push(...children.filter((_, index) => index !== at));
  }
  let checked = 0;
  while (pending.length > 0) {
    if (++checked > MAX_CHECKED_WINDOWS) return undefined;
    const window = pending.pop() ?? 0;
    const attributes = await getAttributes(x, window);
    if (!attributes) return undefined;
    // Only a viewable window draws, and an input-only one draws nothing.
    if (attributes[26] !== 2 || u16(attributes, 12) === 2) continue;
    const geometry = await getGeometry(x, window);
    const origin = await translate(x, window, setup.root);
    if (!geometry || !origin) return undefined;
    const border = u16(geometry, 20);
    const rect = {
      x: i16(origin, 12) - border,
      y: i16(origin, 14) - border,
      width: u16(geometry, 16) + 2 * border,
      height: u16(geometry, 18) + 2 * border,
    };
    if (!overlaps(rect, target)) continue;
    if (client(window) !== owner) return true;
    const tree = await queryTree(x, window);
    if (!tree) return undefined;
    pending.push(...childrenOf(tree));
  }
  return false;
}

async function exchange(
  x: Connection,
  cookie: Uint8Array | null,
  screen: number,
  windowId: number,
  size: DriverShot,
  hold: { readonly onGrab: ((ms: number) => void) | undefined; readonly limitMs: number },
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
  if (!version || (u32(version, 8) === 0 && u32(version, 12) < 2)) return undefined;
  // Read without holding the server: the window's place in the tree and its top-level ancestor's
  // visual. What can change in between is read again while held.
  const first = await getGeometry(x, windowId);
  if (!first) return undefined;
  if (u16(first, 16) * u16(first, 18) > MAX_WINDOW_PIXELS) return { refused: UNREADABLE };
  const chain = [windowId];
  for (let hops = 0; hops < 32; hops++) {
    const tree = await queryTree(x, chain.at(-1) ?? windowId);
    if (!tree) return undefined;
    const parent = u32(tree, 12);
    if (parent === setup.root || parent === 0) break;
    chain.push(parent);
  }
  const topLevel = chain.at(-1) ?? windowId;
  // The named pixmap's pixels are in the top-level window's visual: a pixmap read answers with no
  // visual of its own.
  const attributes = await getAttributes(x, topLevel);
  if (!attributes) return undefined;
  const visual = setup.visuals.get(u32(attributes, 8));
  // Held: nothing else may map, move or draw a window between the check and the read. The hold
  // covers only that, and is cut off at GRAB_LIMIT_MS by ending the connection.
  const held = async () => {
    const geometry = await getGeometry(x, windowId);
    if (!geometry) return undefined;
    const width = u16(geometry, 16);
    const height = u16(geometry, 18);
    // The window may have grown since it was first read; the reply is never larger than this.
    if (width * height > MAX_WINDOW_PIXELS) return { refused: UNREADABLE };
    if (width !== size.windowWidth || height !== size.windowHeight)
      return { refused: RESIZED_CAPTURE };
    const inFrame = await translate(x, windowId, topLevel);
    const onScreen = await translate(x, windowId, setup.root);
    // The pixmap holds the top-level window with its border, so the crop starts past it; read
    // while held, since a border that changed would shift the crop onto other windows.
    const frameGeometry = await getGeometry(x, topLevel);
    if (!inFrame || !onScreen || !frameGeometry) return undefined;
    const border = u16(frameGeometry, 20);
    const target = { x: i16(onScreen, 12), y: i16(onScreen, 14), width, height };
    const shared = await drawnOver(x, setup, chain, target);
    if (shared === undefined) return undefined;
    if (shared) return { refused: SHARED_CAPTURE };
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
        view.setInt16(8, i16(inFrame, 12) + border, true);
        view.setInt16(10, i16(inFrame, 14) + border, true);
        view.setUint16(12, width, true);
        view.setUint16(14, height, true);
        view.setUint32(16, 0xffffffff, true);
      }),
    );
    x.send(request(54, 0, 2, (view) => view.setUint32(4, pixmap, true)));
    return image ? { image, width, height } : undefined;
  };
  let limit: ReturnType<typeof setTimeout> | undefined;
  const started = performance.now();
  x.send(request(36, 0, 1, () => undefined));
  const read = await Promise.race([
    held(),
    new Promise<"limit">((resolve) => {
      limit = setTimeout(() => resolve("limit"), hold.limitMs);
    }),
  ]);
  clearTimeout(limit);
  if (read === "limit") {
    x.abort();
    hold.onGrab?.(performance.now() - started);
    return { refused: BUSY_CAPTURE };
  }
  x.send(request(37, 0, 1, () => undefined));
  hold.onGrab?.(performance.now() - started);
  if (!read) return undefined;
  if (read.refused !== undefined) return { refused: read.refused };
  const { image, width, height } = read;
  const format = setup.bitsPerPixel.get(image[1] ?? 0);
  if (!setup.lsbImages || !visual?.trueColor || format?.bpp !== 32) return { refused: UNREADABLE };
  const stride = Math.ceil((width * format.bpp) / format.pad) * (format.pad / 8);
  const data = image.subarray(32);
  if (data.length < stride * height) return { refused: UNREADABLE };
  // Delivered at the driver's screenshot size, so its points and frames are this image's.
  const toWidth = Math.min(width, size.width);
  const toHeight = Math.min(height, size.height);
  const rgb = shrinkRgb(
    zpixmapToRgb(data, width, height, stride, visual),
    width,
    height,
    toWidth,
    toHeight,
  );
  return { png: rgbToPng(rgb, toWidth, toHeight), width: toWidth, height: toHeight };
}
