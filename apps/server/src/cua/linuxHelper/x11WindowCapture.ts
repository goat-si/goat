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
  /** Transient refusals (busy, resized, still drawing) clear on their own: observe again. */
  | { readonly refused: string; readonly transient?: true };

export const UNREDIRECTED_CAPTURE =
  "This X display does not render the window by itself (no compositing manager, or it stopped redirecting windows), so a capture could show whatever covers it, other apps included. Screenshots are off here; app controls still work. A desktop with a compositor (GNOME, KDE, or picom on other window managers) can show GOAT a single window.";
export const SHARED_CAPTURE =
  "Another app's window overlaps this one inside the same frame, so its screenshot could show that app. Observe it without a screenshot, or move the other window away.";
const UNREADABLE = "The window's pixels could not be read in a format GOAT understands.";
export const BUSY_CAPTURE =
  "The window took too long to read without holding up the rest of the desktop. Observe it again.";
export const STILL_DRAWING =
  "The app did not finish redrawing the window in time, so its screenshot could show what was behind it. Observe it again.";
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
/**
 * How long the app has to redraw the whole window after the capture asks it to (#1381). The
 * server is not held meanwhile.
 */
const REDRAW_LIMIT_MS = 500;

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
  /** The sequence number of the last request sent, as the server counts them (16 bits). */
  let sequence = 0;
  let onEvent: ((event: Uint8Array) => void) | undefined;
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
      // Replies and GenericEvents carry a length; every other message is 32 bytes.
      const length =
        kind === 1 || (kind & 0x7f) === 35
          ? 32 + 4 * new DataView(buffer.buffer).getUint32(4, true)
          : 32;
      if (buffer.length < length) return;
      const message = buffer.slice(0, length);
      buffer = buffer.slice(length);
      // An error ends the exchange: an unnamed pixmap errs and so does every read of it.
      if (kind === 0) fail();
      else if (kind === 1) waiting.shift()?.(message);
      else onEvent?.(message);
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
      if (closed) return;
      sequence = (sequence + 1) & 0xffff;
      socket.write(bytes);
    },
    ask: (bytes: Uint8Array) =>
      new Promise<Uint8Array | undefined>((resolve) => {
        if (closed) return resolve(undefined);
        sequence = (sequence + 1) & 0xffff;
        waiting.push(resolve);
        socket.write(bytes);
      }),
    sequence: () => sequence,
    /** Every event the server sends from now on, until replaced. */
    listen: (listener: ((event: Uint8Array) => void) | undefined) => {
      onEvent = listener;
    },
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

const internAtom = (x: Connection, name: string) => {
  const bytes = new TextEncoder().encode(name);
  return x.ask(
    request(16, 1, 2 + Math.ceil(bytes.length / 4), (view) => {
      view.setUint16(4, bytes.length, true);
      bytes.forEach((byte, index) => view.setUint8(8 + index, byte));
    }),
  );
};
const MAX_CLIENT_LIST = 1024;

/**
 * Whether the target's top-level ancestor is a window manager's frame around it: the window
 * manager lists the target (or an ancestor below the frame) in _NET_CLIENT_LIST and not the
 * top-level itself, and the top-level is not override-redirect, which nothing manages. Only then
 * may the top-level's client draw inside it; an app's own top-level that holds another app's
 * window is not trusted. Undefined when that cannot be read.
 */
async function managedFrame(
  x: Connection,
  setup: Setup,
  chain: ReadonlyArray<number>,
): Promise<boolean | undefined> {
  const topLevel = chain.at(-1) ?? 0;
  if (chain.length < 2) return false;
  const attributes = await getAttributes(x, topLevel);
  if (!attributes) return undefined;
  if (attributes[27] !== 0) return false;
  const atom = await internAtom(x, "_NET_CLIENT_LIST");
  if (!atom) return undefined;
  const clientList = u32(atom, 8);
  if (clientList === 0) return false;
  const property = await x.ask(
    request(20, 0, 6, (view) => {
      view.setUint32(4, setup.root, true);
      view.setUint32(8, clientList, true);
      view.setUint32(12, 33, true);
      view.setUint32(16, 0, true);
      view.setUint32(20, MAX_CLIENT_LIST, true);
    }),
  );
  if (!property) return undefined;
  // A list too long to read whole, or of another type, proves nothing.
  if (property[1] !== 32 || u32(property, 12) !== 0) return false;
  const managed = new Set(
    Array.from({ length: u32(property, 16) }, (_, index) => u32(property, 32 + index * 4)),
  );
  return !managed.has(topLevel) && chain.slice(0, -1).some((window) => managed.has(window));
}

/**
 * Whether a window another client drew can show in the target's rectangle inside its top-level
 * ancestor's pixmap: the target's ancestors, which show their background and border wherever
 * the target leaves a gap (a shaped target), its own children, and every sibling of the target
 * or one of its ancestors, with all they hold. Siblings stacked below count too, for the same
 * gaps. The app's own windows are not another app's, and neither are those of a window manager
 * frame around it (managedFrame), such as Openbox's backing window under the client.
 * Undefined when that cannot be read.
 */
async function drawnOver(
  x: Connection,
  setup: Setup,
  chain: ReadonlyArray<number>,
  target: Rect,
): Promise<boolean | undefined> {
  const client = (window: number) => window & ~setup.idMask;
  const framed = await managedFrame(x, setup, chain);
  if (framed === undefined) return undefined;
  const own = new Set([client(chain[0] ?? 0), ...(framed ? [client(chain.at(-1) ?? 0)] : [])]);
  if (chain.slice(1).some((ancestor) => !own.has(client(ancestor)))) return true;
  const targetTree = await queryTree(x, chain[0] ?? 0);
  if (!targetTree) return undefined;
  const pending: number[] = childrenOf(targetTree);
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
    if (!own.has(client(window))) return true;
    const tree = await queryTree(x, window);
    if (!tree) return undefined;
    pending.push(...childrenOf(tree));
  }
  return false;
}

/**
 * Which part of a width by height window drawing has covered so far, row by row, so each report
 * costs only the rows it touches.
 */
export function coverage(width: number, height: number) {
  const rows: Array<Array<[number, number]>> = Array.from({ length: height }, () => []);
  let full = 0;
  let work = 0;
  let exhausted = false;
  return {
    /** Adds drawing; false once the bookkeeping passed its budget and the answer is no. */
    add(rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }) {
      const left = Math.max(0, rect.x);
      const right = Math.min(width, rect.x + rect.w);
      if (exhausted) return false;
      if (right <= left) return true;
      for (let y = Math.max(0, rect.y); y < Math.min(height, rect.y + rect.h); y++) {
        const spans = rows[y] ?? [];
        if (spans.length === 1 && spans[0]?.[0] === 0 && spans[0][1] === width) continue;
        work += spans.length + 1;
        // Drawing in many disjoint slivers is not a whole redraw worth waiting for.
        if (spans.length > MAX_ROW_SPANS || work > MAX_COVERAGE_WORK) {
          exhausted = true;
          return false;
        }
        const merged: Array<[number, number]> = [];
        let next: [number, number] = [left, right];
        for (const span of spans) {
          if (span[1] < next[0]) merged.push(span);
          else if (span[0] > next[1]) {
            merged.push(next);
            next = span;
          } else next = [Math.min(span[0], next[0]), Math.max(span[1], next[1])];
        }
        merged.push(next);
        rows[y] = merged;
        if (merged.length === 1 && merged[0]?.[0] === 0 && merged[0][1] === width) full++;
      }
      return true;
    },
    whole: () => full === height,
  };
}

/** Past these, the window counts as not redrawn, so the wait stays bounded in work and time. */
const MAX_DRAW_REPORTS = 4_096;
const MAX_ROW_SPANS = 64;
const MAX_COVERAGE_WORK = 4_000_000;

/**
 * Asks the app to redraw the window and watches it until the pixels are read (#1381).
 *
 * A window with no background keeps, where it has not drawn, the pixels Composite copied in
 * from behind it, and those can be another app's. The protocol does not say which windows have
 * no background. So every capture sends the app a synthetic Expose for the whole window, which
 * paints nothing by itself, and waits, without holding the server, until the app's drawing
 * (Damage, which includes the window's children) covers all of it.
 *
 * Damage rectangles bound what was drawn rather than prove each pixel. An app that answers by
 * drawing only part of a window without a background shows the same leftovers on screen; that
 * limit is documented in #1381. Damage also cannot tell whose window drew, so from before the
 * Expose until the read, another app's window that is created, mapped or reparented anywhere in
 * the target's subtree spoils the capture.
 *
 * Resolves with whether the window was redrawn whole, and a check of whether nothing else
 * arrived since; undefined when the display cannot track drawing.
 */
async function watchRedraw(
  x: Connection,
  setup: Setup,
  /** The target, then each ancestor up to its top-level window, whose pixmap is read. */
  chain: ReadonlyArray<number>,
  width: number,
  height: number,
): Promise<{ readonly redrawn: boolean; readonly undisturbed: () => boolean } | undefined> {
  const name = new TextEncoder().encode("DAMAGE");
  const extension = await x.ask(
    request(98, 0, 2 + Math.ceil(name.length / 4), (view) => {
      view.setUint16(4, name.length, true);
      name.forEach((byte, index) => view.setUint8(8 + index, byte));
    }),
  );
  if (!extension || extension[8] !== 1) return undefined;
  const damage = extension[9] ?? 0;
  const notify = extension[10] ?? 0;
  // DamageQueryVersion must come first.
  const version = await x.ask(
    request(damage, 0, 3, (view) => {
      view.setUint32(4, 1, true);
      view.setUint32(8, 1, true);
    }),
  );
  if (!version) return undefined;
  const windowId = chain[0] ?? 0;
  const topLevel = chain.at(-1) ?? windowId;
  // Every window inside the top-level whose pixmap is read, whoever owns it: any of them that
  // is created, destroyed, mapped, unmapped, reparented, moved, resized or restacked can leave
  // pixels the app's redraw never covered. A new window is reported through its parent, which is
  // already watched, so nothing joins unseen.
  const tree = [topLevel];
  for (let index = 0; index < tree.length; index++) {
    if (tree.length > MAX_CHECKED_WINDOWS) return undefined;
    const answer = await queryTree(x, tree[index] ?? 0);
    if (!answer) return undefined;
    tree.push(...childrenOf(answer));
  }
  const watched = new Set(tree);
  const topSize = await getGeometry(x, topLevel);
  if (!topSize) return undefined;
  let disturbed = false;
  const drawn = coverage(width, height);
  let reports = 0;
  let asked: number | undefined;
  const id = setup.idBase | 2;
  const deadline = performance.now() + REDRAW_LIMIT_MS;
  const done = Promise.withResolvers<boolean>();
  x.listen((event) => {
    const code = (event[0] ?? 0) & 0x7f;
    // Structure events: [4] the window watched (or the new window's parent), [8] the window.
    if (code >= 16 && code <= 22 && code !== 20) {
      const parent = u32(event, 4);
      const window = u32(event, 8);
      // The top-level itself only matters when it is replaced or resized: moving it on screen
      // keeps its pixmap.
      if (window === topLevel && parent === topLevel) {
        if (
          code !== 22 ||
          u16(event, 20) !== u16(topSize, 16) ||
          u16(event, 22) !== u16(topSize, 18)
        )
          disturbed = true;
      } else if (watched.has(parent)) disturbed = true;
      return;
    }
    if (code !== notify || asked === undefined || u32(event, 8) !== id) return;
    // Drawing reported before the Expose was sent, creating the Damage object's own report
    // included, is not the redraw.
    if (((u16(event, 2) - asked) & 0xffff) >= 0x8000) return;
    if (++reports > MAX_DRAW_REPORTS || performance.now() > deadline) return done.resolve(false);
    const added = drawn.add({
      x: i16(event, 16),
      y: i16(event, 18),
      w: u16(event, 20),
      h: u16(event, 22),
    });
    if (!added) done.resolve(false);
    else if (drawn.whole()) done.resolve(true);
  });
  // ChangeWindowAttributes for this connection only: SubstructureNotify on every window in the
  // top-level, StructureNotify on the top-level too, whose parent (the root) is not watched.
  for (const window of tree)
    x.send(
      request(2, 0, 4, (view) => {
        view.setUint32(4, window, true);
        view.setUint32(8, 1 << 11, true);
        view.setUint32(12, window === topLevel ? (1 << 17) | (1 << 19) : 1 << 19, true);
      }),
    );
  // DamageCreate at the raw-rectangles level: every drawing operation is reported.
  x.send(
    request(damage, 1, 4, (view) => {
      view.setUint32(4, id, true);
      view.setUint32(8, windowId, true);
      view.setUint8(12, 0);
    }),
  );
  // SendEvent of an Expose for the whole window to whoever selected exposure on it.
  x.send(
    request(25, 0, 11, (view) => {
      view.setUint32(4, windowId, true);
      view.setUint32(8, 1 << 15, true);
      view.setUint8(12, 12);
      view.setUint32(16, windowId, true);
      view.setUint16(24, width, true);
      view.setUint16(26, height, true);
    }),
  );
  asked = x.sequence();
  const timer = setTimeout(() => done.resolve(false), Math.max(0, deadline - performance.now()));
  // A lost connection never redraws; the exchange then ends on its own.
  const redrawn = await done.promise;
  clearTimeout(timer);
  x.send(request(damage, 2, 2, (view) => view.setUint32(4, id, true)));
  return { redrawn, undisturbed: () => !disturbed };
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
  const redraw = await watchRedraw(x, setup, chain, u16(first, 16), u16(first, 18));
  if (redraw === undefined) return undefined;
  if (!redraw.redrawn || !redraw.undisturbed()) return { refused: STILL_DRAWING, transient: true };
  // Held: nothing else may map, move or draw a window between the check and the read. The hold
  // covers only that, and is cut off at GRAB_LIMIT_MS by ending the connection.
  const held = async () => {
    const geometry = await getGeometry(x, windowId);
    if (!geometry) return undefined;
    // Every event from before the hold has arrived ahead of this reply.
    if (!redraw.undisturbed()) return { refused: STILL_DRAWING, transient: true as const };
    const width = u16(geometry, 16);
    const height = u16(geometry, 18);
    // The window may have grown since it was first read; the reply is never larger than this.
    if (width * height > MAX_WINDOW_PIXELS) return { refused: UNREADABLE };
    if (width !== size.windowWidth || height !== size.windowHeight)
      return { refused: RESIZED_CAPTURE, transient: true };
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
    return { refused: BUSY_CAPTURE, transient: true };
  }
  x.send(request(37, 0, 1, () => undefined));
  hold.onGrab?.(performance.now() - started);
  if (!read) return undefined;
  if (read.refused !== undefined)
    return read.transient ? { refused: read.refused, transient: true } : { refused: read.refused };
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
