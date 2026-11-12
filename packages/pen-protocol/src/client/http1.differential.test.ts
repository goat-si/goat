// @effect-diagnostics nodeBuiltinImport:off - Differential run against Node's own HTTP parser over loopback sockets.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { describe, expect, it } from "vite-plus/test";
import { ResponseParser } from "./http1.ts";
import { seededRandom } from "./testing/seededRandom.ts";

interface Generated {
  readonly method: "GET" | "HEAD";
  readonly bytes: Uint8Array;
}

const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789-";
const VALUE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ;=/,.:";

/** A well-formed response under every 10.2 rule, from a seeded generator. */
function generate(rand: ReturnType<typeof seededRandom>): Generated {
  const pick = <T>(items: ReadonlyArray<T>): T => items[rand.int(items.length)] as T;
  const status = pick([200, 201, 202, 204, 301, 304, 400, 404, 409, 500, 503, 599]);
  const method = rand.int(8) === 0 ? "HEAD" : "GET";
  const headers: Array<string> = [];
  for (let i = rand.int(12); i > 0; i--) {
    const name = "x-" + Array.from({ length: 1 + rand.int(12) }, () => pick([...TOKEN])).join("");
    const inner = Array.from({ length: rand.int(40) }, () => pick([...VALUE])).join("");
    headers.push(name + ": " + ("v" + inner + "v"));
  }
  const bodyless = status === 204 || status === 304 || method === "HEAD";
  const length = pick([0, 1, 2, 125, 126, 1000, 65_535, 65_536, 70_000, rand.int(200_000)]);
  const body = Uint8Array.from({ length: bodyless ? 0 : length }, () => rand.int(256));
  const chunked = !bodyless && rand.int(2) === 0;
  let framed: Uint8Array = body;
  if (chunked) {
    headers.push("Transfer-Encoding: chunked");
    const parts: Array<number> = [];
    for (let at = 0; at < body.length;) {
      const size = Math.min(body.length - at, 1 + rand.int(20_000));
      parts.push(...ascii(size.toString(16) + "\r\n"), ...body.subarray(at, at + size), 13, 10);
      at += size;
    }
    parts.push(...ascii("0\r\n\r\n"));
    framed = Uint8Array.from(parts);
  } else if (!(status === 204 || status === 304)) {
    headers.push("Content-Length: " + length);
  }
  const head = ascii(
    "HTTP/1.1 " +
      status +
      " Reason " +
      status +
      "\r\n" +
      headers.map((h) => h + "\r\n").join("") +
      "\r\n",
  );
  const bytes = new Uint8Array(head.length + (method === "HEAD" ? 0 : framed.length));
  bytes.set(head);
  if (method !== "HEAD") bytes.set(framed, head.length);
  return { method, bytes };
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (ch) => ch.charCodeAt(0));
}

function ours(generated: Generated) {
  const parser = new ResponseParser({ method: generated.method, bodyCap: 8 * 1024 * 1024 });
  const events = parser.push(generated.bytes);
  const head = events.find((event) => event.type === "head");
  const body = events.flatMap((event) => (event.type === "body" ? [...event.bytes] : []));
  if (head?.type !== "head" || !events.some((event) => event.type === "end"))
    throw new Error("incomplete");
  return { status: head.status, headers: head.headers.map(([name, value]) => [name, value]), body };
}

/** Node's parser (llhttp) reading the same bytes from a raw loopback server. */
async function node(generated: Generated) {
  const server = NodeNet.createServer((socket) => {
    socket.once("data", () => socket.end(generated.bytes));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    return await new Promise<{
      status: number;
      headers: Array<Array<string>>;
      body: Array<number>;
    }>((resolve, reject) => {
      const request = NodeHttp.request(
        { host: "127.0.0.1", port, method: generated.method, path: "/", agent: false },
        (response) => {
          const chunks: Array<Buffer> = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const raw = response.rawHeaders;
            const headers: Array<Array<string>> = [];
            for (let i = 0; i < raw.length; i += 2)
              headers.push([(raw[i] ?? "").toLowerCase(), raw[i + 1] ?? ""]);
            resolve({
              status: response.statusCode ?? 0,
              headers,
              body: Array.from(Buffer.concat(chunks)),
            });
          });
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      request.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("HTTP/1.1 differential against Node's parser on well-formed responses (design 10.2 exit criterion)", () => {
  it("200 seeded responses parse to the same status, header list and body", async () => {
    const rand = seededRandom(0x5eed_1001);
    for (let i = 0; i < 200; i++) {
      const generated = generate(rand);
      expect(ours(generated), "response " + i).toEqual(await node(generated));
    }
  });
});
