import { describe, expect, it } from "vite-plus/test";
import { PenError } from "./errors.ts";
import { makePenFetch, makePenFetchToSink } from "./penFetch.ts";
import { ManualClock } from "./testing/manualClock.ts";
import { memoryStreamPair } from "./testing/memoryStream.ts";

const ORIGIN = "http://goat.pen";
const latin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes);

function setup() {
  const clock = new ManualClock();
  const pairs: Array<ReturnType<typeof memoryStreamPair>> = [];
  const waiters: Array<() => void> = [];
  const options = {
    origin: ORIGIN,
    clock,
    openStream: async () => {
      const pair = memoryStreamPair();
      pairs.push(pair);
      for (const wake of waiters.splice(0)) wake();
      return pair.client;
    },
  };
  return {
    clock,
    pairs,
    fetch: makePenFetch(options),
    toSink: makePenFetchToSink(options),
    /** The nth stream (1-based) once it is opened. */
    stream: (n: number) =>
      new Promise<ReturnType<typeof memoryStreamPair>["server"]>((resolve) => {
        const check = () => {
          const pair = pairs[n - 1];
          if (pair !== undefined) resolve(pair.server);
          else waiters.push(check);
        };
        check();
      }),
  };
}

/** Waits until the client has written text containing needle. */
async function written(server: ReturnType<typeof memoryStreamPair>["server"], needle: string) {
  while (!latin1(server.written()).includes(needle))
    await server.whenWritten(server.written().length + 1);
}

/** Waits for a whole request head (and body of bodyLength) on the server side. */
async function request(server: ReturnType<typeof memoryStreamPair>["server"], bodyLength = 0) {
  for (let seen = 0; ;) {
    const text = latin1(server.written());
    const end = text.indexOf("\r\n\r\n");
    if (end >= 0 && text.length >= end + 4 + bodyLength) return text;
    seen = text.length;
    await server.whenWritten(seen + 1);
  }
}

describe("Pen fetch adapter (design 10.2 HTTP rules on the fetch side)", () => {
  it("sends GET with Host from the bound origin and Accept-Encoding identity, and returns a Response", async () => {
    const t = setup();
    const pending = t.fetch(ORIGIN + "/api/thing?x=1", { headers: { Accept: "application/json" } });
    const server = await t.stream(1);
    const sent = await request(server);
    expect(sent).toBe(
      "GET /api/thing?x=1 HTTP/1.1\r\nHost: goat.pen\r\nAccept: application/json\r\nAccept-Encoding: identity\r\n\r\n",
    );
    server.write(
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}',
    );
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.statusText).toBe("OK");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("H46a: every request carries Accept-Encoding: identity, even when the caller asks for gzip", async () => {
    const t = setup();
    const pending = t.fetch(ORIGIN + "/", { headers: { "accept-encoding": "gzip" } });
    const server = await t.stream(1);
    const sent = await request(server);
    expect(sent.match(/accept-encoding/gi)).toHaveLength(1);
    expect(sent).toContain("Accept-Encoding: identity\r\n");
    server.write("HTTP/1.1 204 No Content\r\n\r\n");
    await pending;
  });

  it("POST sends the body with Content-Length", async () => {
    const t = setup();
    const pending = t.fetch(ORIGIN + "/api/pen/pair", { method: "POST", body: '{"name":"p"}' });
    const server = await t.stream(1);
    expect(await request(server, 12)).toMatch(
      /^POST \/api\/pen\/pair HTTP\/1\.1\r\n[\s\S]*Content-Length: 12\r\n\r\n\{"name":"p"\}$/,
    );
    server.write("HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n");
    expect((await pending).status).toBe(202);
  });

  it.each([
    [204, "Content-Length: 3"],
    [304, "Content-Length: 3"],
    [205, "Content-Length: 0"],
  ])("a %i response has a null body (%s)", async (status, length) => {
    const t = setup();
    const pending = t.fetch(ORIGIN + "/poll");
    const server = await t.stream(1);
    await request(server);
    server.write("HTTP/1.1 " + status + " X\r\n" + length + "\r\n\r\n");
    const response = await pending;
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
  });

  it("HEAD reads no body and returns a null body", async () => {
    const t = setup();
    const pending = t.fetch(ORIGIN + "/", { method: "HEAD" });
    const server = await t.stream(1);
    await request(server);
    server.write("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n");
    expect((await pending).body).toBeNull();
  });

  it("H40: the stream is reused after a length-delimited and after a chunked response", async () => {
    const t = setup();
    const first = t.fetch(ORIGIN + "/a");
    const server = await t.stream(1);
    await request(server);
    server.write("HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\na");
    expect(await (await first).text()).toBe("a");
    const second = t.fetch(ORIGIN + "/b");
    await written(server, "GET /b ");
    server.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nb\r\n0\r\n\r\n");
    expect(await (await second).text()).toBe("b");
    const third = t.fetch(ORIGIN + "/c");
    await written(server, "GET /c ");
    server.write("HTTP/1.1 204 No Content\r\n\r\n");
    await third;
    expect(t.pairs).toHaveLength(1);
  });

  it.each([
    ["a 204", "HTTP/1.1 204 No Content\r\n\r\n", "GET"],
    ["a 304", "HTTP/1.1 304 Not Modified\r\n\r\n", "GET"],
    ["a HEAD response", "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n", "HEAD"],
    [
      "Connection: close",
      "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 1\r\n\r\na",
      "GET",
    ],
  ])("H40: the stream is not reused after %s", async (_name, response, method) => {
    const t = setup();
    const first = t.fetch(ORIGIN + "/a", { method });
    const server = await t.stream(1);
    await request(server);
    server.write(response);
    await first;
    expect(server.closeCode()).toBe(1000);
    const second = t.fetch(ORIGIN + "/b");
    const next = await t.stream(2);
    await request(next);
    next.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    await second;
  });

  it("H41: a close-delimited response is read to the end and the next request opens a new stream", async () => {
    const t = setup();
    const first = t.fetch(ORIGIN + "/a");
    const server = await t.stream(1);
    await request(server);
    server.write("HTTP/1.1 200 OK\r\n\r\nabc");
    server.end();
    expect(await (await first).text()).toBe("abc");
    const second = t.fetch(ORIGIN + "/b");
    const next = await t.stream(2);
    await request(next);
    next.write("HTTP/1.1 204 No Content\r\n\r\n");
    await second;
  });

  it("H42: unsolicited bytes after a response: the response is delivered and the stream closed", async () => {
    const t = setup();
    const pending = t.fetch(ORIGIN + "/a");
    const server = await t.stream(1);
    await request(server);
    server.write("HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\naHTTP/1.1 200 OK\r\n");
    expect(await (await pending).text()).toBe("a");
    expect(server.closeCode()).toBe(1000);
  });

  it("H42: a whole response the server sends between exchanges is never taken as the next request's response", async () => {
    const t = setup();
    const first = t.fetch(ORIGIN + "/a");
    const server = await t.stream(1);
    await request(server);
    server.write("HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\na");
    expect(await (await first).text()).toBe("a");
    // Queued before the second request exists: it must close the stream, not answer the next request.
    server.write("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nforged");
    await server.whenClosed();
    expect(server.closeCode()).toBe(1000);
    const second = t.fetch(ORIGIN + "/b");
    const next = await t.stream(2);
    await request(next);
    next.write("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nreal");
    expect(await (await second).text()).toBe("real");
    expect(latin1(server.written())).not.toContain("GET /b");
  });

  it("H42: the server ending the stream while idle makes the next request open a new stream", async () => {
    const t = setup();
    const first = t.fetch(ORIGIN + "/a");
    const server = await t.stream(1);
    await request(server);
    server.write("HTTP/1.1 204 No Content\r\n\r\n");
    await first;
    server.end();
    await server.whenClosed();
    const second = t.fetch(ORIGIN + "/b");
    const next = await t.stream(2);
    await request(next);
    next.write("HTTP/1.1 204 No Content\r\n\r\n");
    expect((await second).status).toBe(204);
  });

  it("an abort while a request waits its turn sends nothing for it", async () => {
    const t = setup();
    const controller = new AbortController();
    const first = t.fetch(ORIGIN + "/a");
    const queued = t.fetch(ORIGIN + "/b", {
      method: "POST",
      body: "mutation",
      signal: controller.signal,
    });
    const server = await t.stream(1);
    await request(server);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    server.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    await first;
    const third = t.fetch(ORIGIN + "/c");
    await written(server, "GET /c ");
    server.write("HTTP/1.1 204 No Content\r\n\r\n");
    await third;
    expect(latin1(server.written())).not.toContain("/b");
  });

  it("an abort while the stream is opening sends nothing and closes the stream that opens late", async () => {
    const clock = new ManualClock();
    let finishOpen!: (stream: ReturnType<typeof memoryStreamPair>["client"]) => void;
    const opening = new Promise<ReturnType<typeof memoryStreamPair>["client"]>((resolve) => {
      finishOpen = resolve;
    });
    let opened!: () => void;
    const openCalled = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const fetch = makePenFetch({
      origin: ORIGIN,
      clock,
      openStream: () => {
        opened();
        return opening;
      },
    });
    const controller = new AbortController();
    const pending = fetch(ORIGIN + "/a", { method: "POST", body: "x", signal: controller.signal });
    await openCalled;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const pair = memoryStreamPair();
    finishOpen(pair.client);
    await pair.server.whenClosed();
    expect(pair.server.written()).toHaveLength(0);
  });

  it("a Request that may carry a body is refused before reading it or sending a byte; init.body is the way", async () => {
    const t = setup();
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const streamed = new Request(ORIGIN + "/echo", {
      method: "POST",
      body: endless,
      duplex: "half",
    } as RequestInit);
    await expect(t.fetch(streamed)).rejects.toThrow(TypeError);
    expect(pulled).toBeLessThanOrEqual(1);
    expect(t.pairs).toHaveLength(0);
    // A method override does not make a POST Request's body go away silently.
    await expect(
      t.fetch(new Request(ORIGIN + "/echo", { method: "POST", body: "hello" }), { method: "GET" }),
    ).rejects.toThrow(TypeError);
    expect(t.pairs).toHaveLength(0);
    const pending = t.fetch(new Request(ORIGIN + "/echo", { method: "POST" }), { body: "hello" });
    const server = await t.stream(1);
    const sent = await request(server, 5);
    expect(sent.endsWith("\r\n\r\nhello")).toBe(true);
    server.write("HTTP/1.1 204 No Content\r\n\r\n");
    await pending;
  });

  it("H43: after a malformed response the stream is closed and the request is not retried", async () => {
    const t = setup();
    const pending = t.fetch(ORIGIN + "/a");
    const server = await t.stream(1);
    await request(server);
    server.write("HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\na");
    await expect(pending).rejects.toMatchObject({ code: "http1/H18" });
    expect(server.closeCode()).toBe(4400);
    expect(t.pairs).toHaveLength(1);
  });

  it("H38: no response head within 30 s of the request's end closes the stream 4408", async () => {
    const t = setup();
    const pending = t.fetch(ORIGIN + "/a");
    const server = await t.stream(1);
    await request(server);
    await t.clock.nextTimer();
    t.clock.advance(29_999);
    server.write("HTTP/1.1 200 OK\r\n");
    t.clock.advance(1);
    await expect(pending).rejects.toMatchObject({ code: "http1/H38" });
    expect(server.closeCode()).toBe(4408);
  });

  it("H39: 60 s with no body byte closes the stream 4408", async () => {
    const t = setup();
    const pending = t.fetch(ORIGIN + "/a");
    const server = await t.stream(1);
    await request(server);
    server.write("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nab");
    await t.clock.whenTimer(60_000);
    t.clock.advance(60_000);
    await expect(pending).rejects.toMatchObject({ code: "http1/H39" });
  });

  it("H46b: a caller's Expect is refused before any byte is sent", async () => {
    const t = setup();
    await expect(
      t.fetch(ORIGIN + "/", { headers: { Expect: "100-continue" } }),
    ).rejects.toMatchObject({ code: "http1/H46" });
    expect(t.pairs).toHaveLength(0);
  });

  it("H46c: a caller's Transfer-Encoding is refused before any byte is sent", async () => {
    const t = setup();
    await expect(
      t.fetch(ORIGIN + "/", { headers: { "Transfer-Encoding": "chunked" } }),
    ).rejects.toMatchObject({
      code: "http1/H46",
    });
    expect(t.pairs).toHaveLength(0);
  });

  it("H46d: CR, LF or NUL in a request field is refused before any byte is sent", async () => {
    const t = setup();
    // Headers objects refuse these themselves, so a plain record carries them to the adapter.
    for (const value of ["a\r\nX-Injected: 1", "a\nb", "a\u0000b"]) {
      await expect(t.fetch(ORIGIN + "/", { headers: { "X-A": value } })).rejects.toMatchObject({
        code: "http1/H46",
      });
    }
    expect(t.pairs).toHaveLength(0);
  });

  it("H47: a request to another origin is refused before any byte is sent", async () => {
    const t = setup();
    for (const url of ["http://other.pen/", "https://goat.pen/", "http://goat.pen.evil/"]) {
      await expect(t.fetch(url)).rejects.toMatchObject({ code: "http1/H47" });
    }
    expect(t.pairs).toHaveLength(0);
  });

  it("bodies other than strings and bytes are refused before any byte is sent", async () => {
    const t = setup();
    await expect(t.fetch(ORIGIN + "/", { method: "POST", body: new FormData() })).rejects.toThrow(
      TypeError,
    );
    expect(t.pairs).toHaveLength(0);
  });

  it("an abort closes the stream and rejects with AbortError", async () => {
    const t = setup();
    const controller = new AbortController();
    const pending = t.fetch(ORIGIN + "/a", { signal: controller.signal });
    const server = await t.stream(1);
    await request(server);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(server.closeCode()).toBe(1000);
  });

  it("requests on one fetch run one at a time on the stream", async () => {
    const t = setup();
    const first = t.fetch(ORIGIN + "/a");
    const second = t.fetch(ORIGIN + "/b");
    const server = await t.stream(1);
    const sent = await request(server);
    expect(sent.startsWith("GET /a ")).toBe(true);
    expect(sent).not.toContain("GET /b");
    server.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    await first;
    await written(server, "GET /b ");
    server.write("HTTP/1.1 204 No Content\r\n\r\n");
    await second;
  });

  it("H37: an attachment streamed to a sink is refused past its cap", async () => {
    const t = setup();
    const received: Array<number> = [];
    const sink = { cap: 4, write: (bytes: Uint8Array) => void received.push(bytes.length) };
    const ok = t.toSink(ORIGIN + "/file", undefined, sink);
    const server = await t.stream(1);
    await request(server);
    server.write("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabcd");
    expect((await ok).status).toBe(200);
    expect(received).toEqual([4]);
    const over = t.toSink(ORIGIN + "/file", undefined, sink);
    await written(server, "\r\n\r\nGET /file ");
    server.write("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nabcde");
    await expect(over).rejects.toBeInstanceOf(PenError);
    await expect(over).rejects.toMatchObject({ code: "http1/H37" });
  });

  it("an exchange aborted while its sink write is pending stops there and cannot close the next exchange's stream", async () => {
    const t = setup();
    const controller = new AbortController();
    let finishWrite!: () => void;
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => (writeStarted = resolve));
    const writes: Array<number> = [];
    const sink = {
      cap: 16,
      write: (bytes: Uint8Array) => {
        writes.push(bytes.length);
        if (writes.length > 1) return Promise.resolve();
        writeStarted();
        return new Promise<void>((resolve) => (finishWrite = resolve));
      },
    };
    const first = t.toSink(ORIGIN + "/file", { signal: controller.signal }, sink);
    const one = await t.stream(1);
    await request(one);
    one.write(
      "HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nab\r\n2\r\ncd\r\n0\r\n\r\n",
    );
    await started;
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = t.toSink(ORIGIN + "/b", undefined, { cap: 16, write: () => undefined });
    const two = await t.stream(2);
    await request(two);
    finishWrite();
    two.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    expect((await second).status).toBe(200);
    expect(two.closeCode()).toBeUndefined();
    expect(writes).toEqual([2]);
  });
});
