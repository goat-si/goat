import { describe, expect, it } from "vite-plus/test";
import httpCases from "../../vectors/http1-malformed.json" with { type: "json" };
import wsCases from "../../vectors/websocket-malformed.json" with { type: "json" };
import { fromHex } from "./bytes.ts";
import { PenError } from "./errors.ts";
import { ResponseParser, type ResponseEvent } from "./http1.ts";
import { decodeInto } from "./testing/frames.ts";
import { seededRandom } from "./testing/seededRandom.ts";
import { FrameDecoder, type FrameEvent } from "./websocket.ts";

type Rand = ReturnType<typeof seededRandom>;
const MAX_SEED = 4096;

/** Corpus inputs that are small enough to mutate (long fills are left to the corpus test). */
function seeds(
  cases: ReadonlyArray<{ input: ReadonlyArray<Record<string, unknown>> }>,
): Array<Uint8Array> {
  return cases
    .filter((c) => c.input.every((chunk) => typeof chunk.hex === "string"))
    .map((c) => fromHex(c.input.map((chunk) => chunk.hex as string).join("")))
    .filter((bytes) => bytes.length <= MAX_SEED);
}

/** Bytes that edit a length: an ASCII digit or a WebSocket length marker (125, 126, 127) or the 0xff high byte. */
const LENGTH_EDITS = [0x30, 0x31, 0x35, 0x39, 0x7d, 0x7e, 0x7f, 0xff];

function mutate(rand: Rand, input: Uint8Array, pool: ReadonlyArray<Uint8Array>): Uint8Array {
  const bytes = [...input];
  for (let n = 1 + rand.int(4); n > 0; n--) {
    const at = rand.int(bytes.length + 1);
    switch (rand.int(6)) {
      case 0:
        if (bytes.length > 0)
          bytes[at % bytes.length] = (bytes[at % bytes.length] ?? 0) ^ (1 << rand.int(8));
        break;
      case 1:
        bytes.splice(at, 0, ...rand.bytes(1 + rand.int(8)));
        break;
      case 2:
        bytes.splice(at, 1 + rand.int(8));
        break;
      case 3: {
        const other = pool[rand.int(pool.length)] ?? new Uint8Array();
        const from = rand.int(other.length + 1);
        bytes.splice(at, rand.int(16), ...other.subarray(from, from + rand.int(64)));
        break;
      }
      case 4:
        // Length-field edits: digits in HTTP heads, length bytes in frames.
        bytes.splice(at, 0, LENGTH_EDITS[rand.int(LENGTH_EDITS.length)] ?? 0);
        break;
      default:
        bytes.splice(at, 0, ...[13, 10, 13, 10].slice(rand.int(4)));
    }
  }
  return Uint8Array.from(bytes.map((b) => b & 255));
}

/** A parser under test: it appends each event it decodes to out, as it decodes it. */
interface Target<T> {
  push(bytes: Uint8Array, out: Array<T>): void;
  finish(out: Array<T>): void;
}

/**
 * Splits at random points, feeding pieces and the EOF, recording events or the first PenError. With
 * keepsEvents, the events before an error are part of the outcome too: a caller acts on each as it comes.
 */
function run<T>(
  make: () => Target<T>,
  input: Uint8Array,
  cuts: ReadonlyArray<number>,
  eof: boolean,
  keepsEvents: boolean,
) {
  const target = make();
  const events: Array<T> = [];
  const shown = () =>
    JSON.stringify(mergeBodies(events), (_k, v) => (v instanceof Uint8Array ? [...v] : v));
  let last = 0;
  try {
    for (const cut of [...cuts, input.length]) {
      target.push(input.subarray(last, cut), events);
      last = cut;
    }
    if (eof) target.finish(events);
    return { events: shown() };
  } catch (error) {
    // Only PenError may escape a parser, and after it the parser accepts nothing more.
    expect(error).toBeInstanceOf(PenError);
    expect(() => target.push(Uint8Array.of(0), [])).toThrow(error as PenError);
    return { error: (error as PenError).code, ...(keepsEvents ? { before: shown() } : {}) };
  }
}

/** Body events follow how the input was chunked; joining runs of them leaves what a split must not change. */
function mergeBodies<T>(events: ReadonlyArray<T>): Array<T> {
  const out: Array<T> = [];
  for (const event of events) {
    const previous = out.at(-1) as { type?: string; bytes?: Uint8Array } | undefined;
    const current = event as { type?: string; bytes?: Uint8Array };
    if (previous?.type === "body" && current.type === "body" && previous.bytes && current.bytes) {
      const joined = new Uint8Array(previous.bytes.length + current.bytes.length);
      joined.set(previous.bytes);
      joined.set(current.bytes, previous.bytes.length);
      out[out.length - 1] = { type: "body", bytes: joined } as T;
    } else {
      out.push(event);
    }
  }
  return out;
}

function property<T>(
  name: string,
  seed: number,
  pool: Array<Uint8Array>,
  make: (rand: Rand) => () => Target<T>,
  keepsEvents: boolean,
) {
  it(name, () => {
    const rand = seededRandom(seed);
    for (let i = 0; i < 2000; i++) {
      const input = mutate(rand, pool[rand.int(pool.length)] ?? new Uint8Array(), pool);
      const eof = rand.int(3) === 0;
      const factory = make(rand);
      const whole = run(factory, input, [], eof, keepsEvents);
      const cuts = Array.from({ length: rand.int(6) }, () => rand.int(input.length + 1)).sort(
        (a, b) => a - b,
      );
      expect(run(factory, input, cuts, eof, keepsEvents), "iteration " + i).toEqual(whole);
    }
  });
}

describe("fixed-seed fuzzing (design 10.2 exit criterion)", () => {
  it("the length-field mutation inserts the intended single bytes", () => {
    const rand = seededRandom(0xf022_0004);
    const seen = new Set<number>();
    for (let i = 0; i < 4000; i++) {
      const out = mutate(rand, new Uint8Array(0), [new Uint8Array(0)]);
      if (out.length === 1) seen.add(out[0] ?? -1);
    }
    for (const byte of LENGTH_EDITS) expect(seen.has(byte), "0x" + byte.toString(16)).toBe(true);
  });

  const httpPool = seeds(httpCases.cases as never);
  const wsPool = seeds(wsCases.cases as never);

  property(
    "HTTP/1.1 parser: only PenError escapes, any split equals the whole input, errors are final",
    0xf022_0001,
    httpPool,
    (rand) => {
      const method = rand.int(5) === 0 ? "HEAD" : "GET";
      const upgrade = rand.int(3) === 0 ? { key: "dGhlIHNhbXBsZSBub25jZQ==" } : undefined;
      return () => {
        const parser = new ResponseParser({
          method,
          ...(upgrade === undefined ? {} : { upgrade }),
          bodyCap: 64 * 1024,
        });
        return {
          push: (bytes, out) => parser.push(bytes, out),
          finish: (out) => out.push(...parser.finish()),
        } satisfies Target<ResponseEvent>;
      };
    },
    // The fetch adapter hands body bytes to a sink as they come, so events before an error count too.
    true,
  );

  property(
    "WebSocket decoder: only PenError escapes, any split gives the same events and error, errors are final",
    0xf022_0002,
    wsPool,
    () => (): Target<FrameEvent> => {
      const decoder = new FrameDecoder();
      return {
        push: (bytes, out) => decodeInto(decoder, bytes, out),
        finish: (out) => out.push(...decoder.finish()),
      };
    },
    // The WebSocket adapter delivers each message as it is decoded, so events before an error count too.
    true,
  );

  it("request, response, next request: a parser per exchange sees the same bytes split any way", () => {
    const rand = seededRandom(0xf022_0003);
    const responses = seeds(
      httpCases.cases.filter(
        (c) => "ok" in c.expect && (c.context as { upgrade?: unknown }).upgrade === undefined,
      ) as never,
    );
    for (let i = 0; i < 500; i++) {
      const a = responses[rand.int(responses.length)] ?? new Uint8Array();
      const b = responses[rand.int(responses.length)] ?? new Uint8Array();
      const both = new Uint8Array(a.length + b.length);
      both.set(a);
      both.set(b, a.length);
      const first = new ResponseParser({ method: "GET", bodyCap: 64 * 1024 });
      let outcome: string;
      try {
        first.push(both);
        outcome = "leftover:" + first.leftover().length;
      } catch (error) {
        expect(error).toBeInstanceOf(PenError);
        outcome = "error";
      }
      const cut = rand.int(both.length + 1);
      const split = new ResponseParser({ method: "GET", bodyCap: 64 * 1024 });
      let splitOutcome: string;
      try {
        split.push(both.subarray(0, cut));
        split.push(both.subarray(cut));
        splitOutcome = "leftover:" + split.leftover().length;
      } catch (error) {
        expect(error).toBeInstanceOf(PenError);
        splitOutcome = "error";
      }
      expect(splitOutcome).toBe(outcome);
    }
  });
});
