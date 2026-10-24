// @effect-diagnostics nodeBuiltinImport:off -- A scripted X server on a Unix socket stands in for Xorg.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { x11Compositing } from "./x11Compositing.ts";

/** Answers setup, InternAtom and GetSelectionOwner the way an X server with this state would. */
async function scriptedServer(answers: {
  readonly atom: number | "error";
  readonly owner: number;
}) {
  const asked: string[] = [];
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-x-"));
  const path = NodePath.join(dir, "X0");
  const server = NodeNet.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let setup = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!setup) {
        if (buffer.length < 12) return;
        setup = true;
        buffer = buffer.subarray(12);
        const reply = Buffer.alloc(44);
        reply[0] = 1;
        reply.writeUInt16LE((reply.length - 8) / 4, 6);
        socket.write(reply);
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt16LE(2) * 4;
        if (buffer.length < length) return;
        const request = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        const reply = Buffer.alloc(32);
        if (request[0] === 16) {
          asked.push(
            request.subarray(8, 8 + request.readUInt16LE(4)).toString() +
              " only-if-exists=" +
              request[1],
          );
          if (answers.atom === "error") {
            // BadAlloc, as an error rather than a reply.
            reply[0] = 0;
            reply[1] = 11;
          } else {
            reply[0] = 1;
            reply.writeUInt32LE(answers.atom, 8);
          }
        } else if (request[0] === 23) {
          asked.push("owner of " + request.readUInt32LE(4));
          reply[0] = 1;
          reply.writeUInt32LE(answers.owner, 8);
        }
        socket.write(reply);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    asked,
    [Symbol.asyncDispose]: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const environment = { DISPLAY: ":0.1", XAUTHORITY: "/nonexistent/goat-xauthority" };

describe("X11 compositing manager (#1328)", () => {
  it("is present when someone owns the screen's _NET_WM_CM selection, asked without making the atom", async () => {
    await using server = await scriptedServer({ atom: 300, owner: 0x400001 });
    expect(await x11Compositing(environment, server.path)).toBe(true);
    expect(server.asked).toEqual(["_NET_WM_CM_S1 only-if-exists=1", "owner of 300"]);
  });

  it("is absent when no one owns the selection, the atom was never made, or the server errs", async () => {
    await using unowned = await scriptedServer({ atom: 300, owner: 0 });
    expect(await x11Compositing(environment, unowned.path)).toBe(false);
    await using unmade = await scriptedServer({ atom: 0, owner: 0x400001 });
    expect(await x11Compositing(environment, unmade.path)).toBe(false);
    await using failing = await scriptedServer({ atom: "error", owner: 0x400001 });
    expect(await x11Compositing(environment, failing.path)).toBe(false);
  });

  it("is absent for a display that is not local", async () => {
    expect(await x11Compositing({ DISPLAY: "remote:0" })).toBe(false);
  });
});
