// @effect-diagnostics nodeBuiltinImport:off - Reads the adapter test files to check that each adapter rule has a named test.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import httpCases from "../../vectors/http1-malformed.json" with { type: "json" };
import httpRules from "../../vectors/http1-rules.json" with { type: "json" };
import wsCases from "../../vectors/websocket-malformed.json" with { type: "json" };
import wsRules from "../../vectors/websocket-rules.json" with { type: "json" };
import { fromHex, toHex } from "./bytes.ts";
import { PenError } from "./errors.ts";
import { HTTP1_LIMITS, ResponseParser, type ResponseEvent } from "./http1.ts";
import { decodeInto } from "./testing/frames.ts";
import { FrameDecoder, type FrameEvent } from "./websocket.ts";

type Chunk =
  | { hex: string }
  | { fill: string; count: number }
  | { repeatHex: string; count: number };

function materialize(input: ReadonlyArray<Chunk>): Uint8Array {
  const parts = input.map((chunk) => {
    if ("hex" in chunk) return fromHex(chunk.hex);
    if ("fill" in chunk) return new Uint8Array(chunk.count).fill(Number.parseInt(chunk.fill, 16));
    const one = fromHex(chunk.repeatHex);
    const out = new Uint8Array(one.length * chunk.count);
    for (let i = 0; i < chunk.count; i++) out.set(one, i * one.length);
    return out;
  });
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Split points: every byte for small inputs; the edges and even points for large ones (fewer past 1 MiB). */
function splits(length: number): Array<number> {
  if (length <= 2048) return Array.from({ length: length + 1 }, (_, i) => i);
  const edge = length > 1024 * 1024 ? 8 : 512;
  const even = length > 1024 * 1024 ? 8 : 64;
  const points = new Set<number>([0, length]);
  for (let i = 0; i < edge; i++) {
    points.add(i);
    points.add(length - i);
  }
  for (let i = 1; i < even; i++) points.add(Math.floor((length * i) / even));
  return [...points];
}

/**
 * Feeds the pieces, then summarizes what was decoded. On a PenError the summary of what came before it is part of
 * the outcome, so every split must agree on that too: a caller acts on each event as it comes.
 */
function outcome<T>(
  feed: () => void,
  summary: () => T,
): { ok: T } | { error: string; closeCode: number | undefined; before: T } {
  try {
    feed();
    return { ok: summary() };
  } catch (error) {
    if (!(error instanceof PenError)) throw error;
    return { error: error.code, closeCode: error.closeCode, before: summary() };
  }
}

interface HttpContext {
  readonly method?: string;
  readonly upgrade?: { readonly key: string; readonly protocol?: string };
  readonly eof?: boolean;
}

function runHttp(context: HttpContext, pieces: ReadonlyArray<Uint8Array>) {
  const parser = new ResponseParser({
    method: context.method ?? "GET",
    ...(context.upgrade === undefined ? {} : { upgrade: context.upgrade }),
    bodyCap: 8 * 1024 * 1024,
  });
  const events: Array<ResponseEvent> = [];
  return outcome(
    () => {
      for (const piece of pieces) parser.push(piece, events);
      if (context.eof === true) events.push(...parser.finish());
    },
    () => {
      const head = events.find((event) => event.type === "head");
      const end = events.find((event) => event.type === "end");
      let bodyLength = 0;
      const body: Array<number> = [];
      for (const event of events) {
        if (event.type !== "body") continue;
        bodyLength += event.bytes.length;
        if (body.length < 64) body.push(...event.bytes.subarray(0, 64));
      }
      return {
        status: head?.type === "head" ? head.status : undefined,
        headers: head?.type === "head" ? head.headers : undefined,
        end: end?.type === "end" ? end.delimiter : undefined,
        bodyLength,
        bodyHex: toHex(Uint8Array.from(body.slice(0, 64))),
        leftoverHex: toHex(parser.leftover()),
      };
    },
  );
}

function runWs(context: { readonly eof?: boolean }, pieces: ReadonlyArray<Uint8Array>) {
  const decoder = new FrameDecoder();
  const events: Array<FrameEvent> = [];
  return outcome(
    () => {
      for (const piece of pieces) decodeInto(decoder, piece, events);
      if (context.eof === true) events.push(...decoder.finish());
    },
    () =>
      events.map((event) => {
        if (event.type === "message") {
          return typeof event.data === "string"
            ? { type: "message", text: event.data }
            : { type: "message", binaryLength: event.data.length };
        }
        if (event.type === "ping") return { type: "ping", payloadHex: toHex(event.payload) };
        return { type: "close", code: event.code, reason: event.reason };
      }),
  );
}

function matchHttp(expected: Record<string, unknown>, actual: Record<string, unknown>) {
  const subset: Record<string, unknown> = {};
  for (const key of Object.keys(expected)) subset[key] = actual[key];
  if (expected.bodyHex !== undefined) subset.bodyHex = actual.bodyHex;
  return subset;
}

describe("HTTP/1.1 response corpus (design 10.2, vectors/http1-malformed.json)", () => {
  it.each(httpCases.cases.map((c) => [c.id + " " + c.name, c] as const))(
    "%s, whole and split",
    (_title, c) => {
      const bytes = materialize(c.input as ReadonlyArray<Chunk>);
      const context = c.context as HttpContext;
      const results = [
        [bytes],
        ...splits(bytes.length).map((at) => [bytes.subarray(0, at), bytes.subarray(at)]),
      ].map((pieces) => runHttp(context, pieces));
      for (const result of results) {
        if ("error" in c.expect) expect(result).toMatchObject({ error: c.expect.error });
        else {
          expect(result).toHaveProperty("ok");
          if ("ok" in result) expect(matchHttp(c.expect.ok, result.ok)).toEqual(c.expect.ok);
        }
        // Every split decodes the same, the events before an error included.
        expect(result).toEqual(results[0]);
      }
      if (bytes.length <= 64 * 1024) {
        const oneByOne = runHttp(
          context,
          Array.from(bytes, (byte) => Uint8Array.of(byte)),
        );
        expect(oneByOne).toEqual(results[0]);
      }
    },
  );

  it("H42: the bytes kept after a response are the same at the refusal, however they were split", () => {
    const head = new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    const after = new Uint8Array(HTTP1_LIMITS.body + 1);
    const run = (pieces: ReadonlyArray<Uint8Array>) => {
      const parser = new ResponseParser({ method: "GET", bodyCap: 0 });
      let error = "";
      try {
        for (const piece of [head, ...pieces]) parser.push(piece);
      } catch (caught) {
        error = (caught as PenError).code;
      }
      return { error, kept: parser.leftover().length };
    };
    const whole = run([after]);
    expect(whole.error).toBe("http1/H42");
    expect(run([after.subarray(0, HTTP1_LIMITS.body), after.subarray(HTTP1_LIMITS.body)])).toEqual(
      whole,
    );
  });

  it("H36: body bytes within the cap come before the refusal, however the body is split", () => {
    const run = (pieces: ReadonlyArray<string>) => {
      const parser = new ResponseParser({ method: "GET", bodyCap: 2 });
      const events: Array<ResponseEvent> = [];
      let error = "";
      try {
        for (const piece of pieces) parser.push(new TextEncoder().encode(piece), events);
      } catch (caught) {
        error = (caught as PenError).code;
      }
      const body = events.flatMap((event) => (event.type === "body" ? [...event.bytes] : []));
      return { body: String.fromCharCode(...body), error };
    };
    expect(run(["HTTP/1.1 200 OK\r\n\r\nabc"])).toEqual({ body: "ab", error: "http1/H36" });
    expect(run(["HTTP/1.1 200 OK\r\n\r\nab", "c"])).toEqual({ body: "ab", error: "http1/H36" });
  });

  it("every parser rule in vectors/http1-rules.json has a case, and every accepting rule an accepted case", () => {
    for (const rule of httpRules.rules.filter((r) => r.where === "parser")) {
      const matching = httpCases.cases.filter((c) => c.id === rule.id);
      expect(matching.length, rule.id).toBeGreaterThan(0);
      if (rule.accepts)
        expect(
          matching.some((c) => "ok" in c.expect),
          rule.id,
        ).toBe(true);
      else
        expect(
          matching.every((c) => "error" in c.expect && c.expect.error === rule.error),
          rule.id,
        ).toBe(true);
    }
  });
});

describe("WebSocket frame corpus (design 10.2, vectors/websocket-malformed.json)", () => {
  it.each(wsCases.cases.map((c) => [c.id + " " + c.name, c] as const))(
    "%s, whole and split",
    (_title, c) => {
      const bytes = materialize(c.input as ReadonlyArray<Chunk>);
      const context = c.context as { eof?: boolean };
      const results = [
        [bytes],
        ...splits(bytes.length).map((at) => [bytes.subarray(0, at), bytes.subarray(at)]),
      ].map((pieces) => runWs(context, pieces));
      for (const result of results) {
        if ("error" in c.expect)
          expect(result).toMatchObject({ error: c.expect.error, closeCode: c.expect.closeCode });
        else expect(result).toEqual({ ok: c.expect.ok });
        expect(result).toEqual(results[0]);
      }
    },
  );

  it("every decoder rule in vectors/websocket-rules.json has a case with its error and close code", () => {
    for (const rule of wsRules.rules.filter((r) => r.where === "decoder")) {
      const matching = wsCases.cases.filter((c) => c.id === rule.id);
      expect(matching.length, rule.id).toBeGreaterThan(0);
      if (rule.accepts)
        expect(
          matching.some((c) => "ok" in c.expect),
          rule.id,
        ).toBe(true);
      else
        expect(
          matching.every(
            (c) =>
              "error" in c.expect &&
              c.expect.error === rule.error &&
              c.expect.closeCode === rule.closeCode,
          ),
          rule.id,
        ).toBe(true);
    }
  });
});

describe("adapter rules are each named by a test", () => {
  const source = (file: string) =>
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");
  it.each([
    [
      "http1-rules.json fetch rules",
      httpRules.rules.filter((r) => r.where === "fetch").map((r) => r.id),
      ["penFetch.test.ts"],
    ],
    [
      "websocket-rules.json adapter rules",
      wsRules.rules.filter((r) => r.where === "adapter").map((r) => r.id),
      ["penWebSocket.test.ts"],
    ],
  ])("%s", (_name, ids, files) => {
    const text = files.map(source).join("\n");
    // A test title names the rule: it("W27a, W27b: ...") or it("H38: ...").
    const titles = [...text.matchAll(/\bit(?:\.each\([\s\S]*?\))?\(\s*"([^"]*)"/g)].map(
      (match) => match[1] ?? "",
    );
    for (const id of ids) {
      expect(
        titles.some((title) => new RegExp("(^|[ ,])" + id + "[:,]").test(title)),
        id,
      ).toBe(true);
    }
  });
});
