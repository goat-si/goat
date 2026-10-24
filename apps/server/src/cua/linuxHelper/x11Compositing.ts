// @effect-diagnostics nodeBuiltinImport:off -- The Linux helper is its own Node process; X11 needs a raw socket.
// @effect-diagnostics globalTimers:off -- One bounded request at a socket callback boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { localDisplayNumber, x11SetupRequest, xauthorityCookie } from "../CuaDisplayCapability.ts";

const ASK_TIMEOUT_MS = 1_000;
const INTERN_ATOM = 16;
const GET_SELECTION_OWNER = 23;

const screenOf = (display: string | undefined) =>
  Number(/\.(\d+)$/u.exec(display?.trim() ?? "")?.[1] ?? 0);

function internAtom(name: string): Uint8Array {
  const bytes = new TextEncoder().encode(name);
  const words = 2 + Math.ceil(bytes.length / 4);
  const request = new Uint8Array(words * 4);
  const view = new DataView(request.buffer);
  request[0] = INTERN_ATOM;
  // only-if-exists: no compositing manager means no such atom, and none is made for asking.
  request[1] = 1;
  view.setUint16(2, words, true);
  view.setUint16(4, bytes.length, true);
  request.set(bytes, 8);
  return request;
}

function getSelectionOwner(atom: number): Uint8Array {
  const request = new Uint8Array(8);
  const view = new DataView(request.buffer);
  request[0] = GET_SELECTION_OWNER;
  view.setUint16(2, 2, true);
  view.setUint32(4, atom, true);
  return request;
}

/**
 * Whether a compositing manager owns this X screen (EWMH `_NET_WM_CM_S<n>`), so each top-level
 * window renders into its own pixmap (#1328). Cua Driver captures an X11 window with XShm or
 * XGetImage on the window itself; without a compositing manager the obscured parts of that
 * image are whatever covers the window on screen, other apps included. Anything this cannot
 * read (no local socket, no cookie, no answer in time) is false.
 */
export async function x11Compositing(
  environment: { readonly DISPLAY?: string | undefined; readonly XAUTHORITY?: string | undefined },
  /** For tests: a scripted server's socket. */
  socketPath?: string,
): Promise<boolean> {
  const display = localDisplayNumber(environment.DISPLAY);
  if (display === null) return false;
  const authFile = environment.XAUTHORITY?.trim() || NodePath.join(NodeOS.homedir(), ".Xauthority");
  const cookie = await NodeFSP.readFile(authFile).then(
    (bytes) => xauthorityCookie(bytes, display),
    () => null,
  );
  const atomName = "_NET_WM_CM_S" + screenOf(environment.DISPLAY);
  return new Promise<boolean>((resolve) => {
    const socket = NodeNet.createConnection(socketPath ?? "/tmp/.X11-unix/X" + display);
    let buffer = new Uint8Array(0);
    let stage: "setup" | "atom" | "owner" = "setup";
    const finish = (answer: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => finish(false), ASK_TIMEOUT_MS);
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
    socket.on("connect", () => socket.write(x11SetupRequest(cookie)));
    socket.on("data", (chunk: Buffer) => {
      const next = new Uint8Array(buffer.length + chunk.length);
      next.set(buffer);
      next.set(chunk, buffer.length);
      buffer = next;
      for (;;) {
        if (stage === "setup") {
          if (buffer.length < 8) return;
          if (buffer[0] !== 1) return finish(false);
          const total = 8 + 4 * new DataView(buffer.buffer).getUint16(6, true);
          if (buffer.length < total) return;
          buffer = buffer.slice(total);
          stage = "atom";
          socket.write(internAtom(atomName));
          continue;
        }
        if (buffer.length < 32) return;
        const message = buffer.slice(0, 32);
        buffer = buffer.slice(32);
        // An error, or an event before the reply: neither is an owner.
        if (message[0] !== 1) return finish(false);
        const value = new DataView(message.buffer).getUint32(8, true);
        if (stage === "atom") {
          if (value === 0) return finish(false);
          stage = "owner";
          socket.write(getSelectionOwner(value));
          continue;
        }
        return finish(value !== 0);
      }
    });
  });
}
