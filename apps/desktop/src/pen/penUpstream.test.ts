// @effect-diagnostics nodeBuiltinImport:off -- Uses in-memory byte streams as the Pen target.
import * as NodeStream from "node:stream";
import { describe, expect, it, vi } from "vite-plus/test";
import { exchangePenResponse, mintPenSession } from "./penUpstream.ts";

describe("Pen upstream exchange", () => {
  it("kills a stalled exchange after the idle deadline", async () => {
    vi.useFakeTimers();
    try {
      const stdout = new NodeStream.PassThrough();
      let killed = 0;
      const pending = exchangePenResponse(
        {
          stdout,
          write: async () => {},
          kill: async () => {
            killed++;
          },
        },
        { method: "GET", target: "/", host: "goat", headers: [] },
        async () => {},
      );
      const outcome = pending.catch((error: unknown) => error);
      await Promise.resolve();
      vi.advanceTimersByTime(120_000);
      expect(await outcome).toBeInstanceOf(Error);
      expect(killed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("reserializes requests and delivers chunked response events in order", async () => {
    const stdout = new NodeStream.PassThrough();
    const writes: Buffer[] = [];
    const events: string[] = [];
    const result = exchangePenResponse(
      {
        stdout,
        write: async (bytes) => {
          writes.push(Buffer.from(bytes));
        },
        kill: async () => {},
      },
      { method: "GET", target: "/api/projects", host: "goat", headers: [] },
      async (event) => {
        events.push(event.type === "body" ? Buffer.from(event.bytes).toString() : event.type);
      },
    );
    stdout.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n");
    await result;
    expect(Buffer.concat(writes).toString()).toContain("Connection: close\r\n");
    expect(events).toEqual(["head", "abc", "end"]);
  });

  it("does not deliver partial parser events when the same input is malformed", async () => {
    const stdout = new NodeStream.PassThrough();
    const events: string[] = [];
    const result = exchangePenResponse(
      { stdout, write: async () => {}, kill: async () => {} },
      { method: "GET", target: "/", host: "goat", headers: [] },
      async (event) => {
        events.push(event.type);
      },
    );
    stdout.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nnothex\r\n");
    await expect(result).rejects.toThrow();
    expect(events).toEqual([]);
  });

  it("mints only the proxy scope ceiling and rejects a widened response", async () => {
    const stdout = new NodeStream.PassThrough();
    const writes: Buffer[] = [];
    const pending = mintPenSession({
      stdout,
      write: async (bytes) => {
        writes.push(Buffer.from(bytes));
      },
      kill: async () => {},
    });
    const body = JSON.stringify({
      token: "secret",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["hub:proxy"],
      kind: "proxy",
    });
    stdout.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await expect(pending).rejects.toThrow();
    const request = Buffer.concat(writes).toString();
    expect(request).toContain('"kind":"proxy"');
    expect(request).not.toContain("hub:proxy");
  });
});
