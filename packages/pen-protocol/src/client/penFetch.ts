// A fetch function over Pen streams (design 10.1, 10.2), for client-runtime's layerRemoteHttpClient seam.
// One request at a time per stream; reuse only after a cleanly delimited response; no automatic retry.
import { utf8Encode } from "./bytes.ts";
import { PenError } from "./errors.ts";
import { HTTP1_LIMITS, type HeaderList, ResponseParser, serializeRequest } from "./http1.ts";
import type { Clock, Timer } from "./runtime.ts";
import type { PenStream } from "./stream.ts";

export const FETCH_LIMITS = {
  /** From the request's last byte to the response head (the pairing poll is held at most 25 s). */
  headMs: 30_000,
  bodyIdleMs: 60_000,
  queue: 16,
  writePiece: 1024 * 1024,
} as const;

export interface PenFetchOptions {
  /** The one origin this fetch serves, e.g. the Pen route's base URL. Other origins are refused (H47). */
  readonly origin: string;
  readonly openStream: () => Promise<PenStream>;
  readonly clock: Clock;
  /** The buffered body cap (8 MiB). */
  readonly bodyCap?: number;
}

export type PenFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ResponseHead {
  readonly status: number;
  readonly statusText: string;
  readonly headers: HeaderList;
}

interface Target {
  readonly origin: string;
  readonly host: string;
  readonly path: string;
}

function parseTarget(url: string): Target | null {
  const match = /^(https?):\/\/([^/?#@\s]+)([^#\s]*)(?:#.*)?$/i.exec(url);
  if (match === null) return null;
  const host = (match[2] ?? "").toLowerCase();
  const rest = match[3] ?? "";
  return {
    origin: (match[1] ?? "").toLowerCase() + "://" + host,
    host,
    path: rest === "" ? "/" : rest.startsWith("?") ? "/" + rest : rest,
  };
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

const NULL_BODY_STATUS = new Set([204, 205, 304]);

function headerPairs(headers: HeadersInit | undefined): Array<readonly [string, string]> {
  if (headers === undefined) return [];
  if (Array.isArray(headers))
    return headers.map(([name, value]) => [String(name), String(value)] as const);
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const out: Array<readonly [string, string]> = [];
    headers.forEach((value, name) => out.push([name, value]));
    return out;
  }
  return Object.entries(headers as Record<string, string>).map(
    ([name, value]) => [name, String(value)] as const,
  );
}

function bodyBytes(body: unknown): Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return utf8Encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError("a Pen fetch body is a string, a Uint8Array or an ArrayBuffer");
}

interface Prepared {
  readonly head: Uint8Array;
  readonly body: Uint8Array | undefined;
  readonly method: string;
  readonly signal: AbortSignal | undefined;
}

/** One deadline at a time; firing rejects the exchange it belongs to. */
class Deadline {
  #timer: Timer | undefined;
  #fire: (error: PenError) => void = () => undefined;
  readonly fired: Promise<never>;
  readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
    this.fired = new Promise<never>((_resolve, reject) => {
      this.#fire = reject;
    });
    this.fired.catch(() => undefined);
  }

  arm(ms: number, error: () => PenError): void {
    this.#timer?.cancel();
    this.#timer = this.clock.setTimer(ms, () => this.#fire(error()));
  }

  disarm(): void {
    this.#timer?.cancel();
    this.#timer = undefined;
  }
}

class PenFetcher {
  readonly #options: PenFetchOptions;
  readonly #bound: Target;
  #stream: PenStream | undefined;
  #busy = false;
  #queue: Array<() => void> = [];

  constructor(options: PenFetchOptions) {
    const bound = parseTarget(options.origin);
    if (bound === null) throw new TypeError("a Pen fetch origin is an http or https URL");
    this.#options = options;
    this.#bound = bound;
  }

  /** Builds the request before anything is sent; every refusal here sends nothing. */
  prepare(input: string | URL | Request, init: RequestInit | undefined): Prepared {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
    const target = parseTarget(request?.url ?? String(input));
    if (target === null || target.origin !== this.#bound.origin) {
      throw new PenError("http1/H47", "a Pen fetch serves only " + this.#bound.origin);
    }
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const body = bodyBytes(init?.body ?? undefined);
    if (body !== undefined && body.length > (this.#options.bodyCap ?? HTTP1_LIMITS.body)) {
      throw new PenError("http1/body-too-large", "a request body is at most the body cap");
    }
    const sendsLength =
      body !== undefined || method === "POST" || method === "PUT" || method === "PATCH";
    const head = serializeRequest({
      method,
      target: target.path,
      host: this.#bound.host,
      headers: headerPairs(init?.headers ?? (request?.headers as HeadersInit | undefined)),
      ...(sendsLength ? { bodyLength: body?.length ?? 0 } : {}),
    });
    return { head, body, method, signal: init?.signal ?? request?.signal ?? undefined };
  }

  async #turn(): Promise<void> {
    if (!this.#busy) {
      this.#busy = true;
      return;
    }
    if (this.#queue.length >= FETCH_LIMITS.queue)
      throw new PenError("fetch-busy", "too many Pen requests waiting");
    await new Promise<void>((resolve) => this.#queue.push(resolve));
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next === undefined) this.#busy = false;
    else next();
  }

  #discard(code: number): void {
    this.#stream?.close(code);
    this.#stream = undefined;
  }

  async exchange(
    prepared: Prepared,
    bodyCap: number,
    onBody: (bytes: Uint8Array) => void | Promise<void>,
  ): Promise<ResponseHead> {
    if (prepared.signal?.aborted === true) throw abortError();
    await this.#turn();
    const deadline = new Deadline(this.#options.clock);
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortError());
        prepared.signal?.addEventListener("abort", onAbort, { once: true });
      });
      aborted.catch(() => undefined);
      const stream = this.#stream ?? (await this.#options.openStream());
      this.#stream = stream;
      return await Promise.race([
        this.#run(stream, prepared, bodyCap, onBody, deadline),
        deadline.fired,
        aborted,
      ]);
    } catch (error) {
      // No reuse after any error and no retry (H43).
      const code = error instanceof PenError ? (error.closeCode ?? 4400) : 1000;
      this.#discard(code);
      throw error;
    } finally {
      deadline.disarm();
      if (onAbort !== undefined) prepared.signal?.removeEventListener("abort", onAbort);
      this.#release();
    }
  }

  async #run(
    stream: PenStream,
    prepared: Prepared,
    bodyCap: number,
    onBody: (bytes: Uint8Array) => void | Promise<void>,
    deadline: Deadline,
  ): Promise<ResponseHead> {
    await stream.write(prepared.head);
    const body = prepared.body ?? new Uint8Array(0);
    for (let at = 0; at < body.length; at += FETCH_LIMITS.writePiece) {
      await stream.write(body.subarray(at, at + FETCH_LIMITS.writePiece));
    }
    deadline.arm(
      FETCH_LIMITS.headMs,
      () => new PenError("http1/H38", "no response head within 30 s", { closeCode: 4408 }),
    );
    const idle = () =>
      deadline.arm(
        FETCH_LIMITS.bodyIdleMs,
        () => new PenError("http1/H39", "no body byte for 60 s", { closeCode: 4408 }),
      );
    const parser = new ResponseParser({ method: prepared.method, bodyCap });
    let head: ResponseHead | undefined;
    for (;;) {
      const chunk = await stream.read();
      const events = chunk === null ? parser.finish() : parser.push(chunk);
      for (const event of events) {
        if (event.type === "head") {
          head = { status: event.status, statusText: event.reason, headers: event.headers };
          idle();
        } else if (event.type === "body") {
          idle();
          await onBody(event.bytes);
        } else if (head !== undefined) {
          deadline.disarm();
          // Reuse only after a length- or chunk-delimited response with nothing after it (H40, H41, H42).
          const reusable = event.delimiter !== "close" && parser.leftover().length === 0;
          if (!reusable) this.#discard(1000);
          return head;
        }
      }
    }
  }
}

/** A fetch-shaped function bound to one origin, for layerRemoteHttpClient. Bodies are buffered up to the cap. */
export function makePenFetch(options: PenFetchOptions): PenFetch {
  const fetcher = new PenFetcher(options);
  const cap = options.bodyCap ?? HTTP1_LIMITS.body;
  return async (input, init) => {
    const prepared = fetcher.prepare(input, init);
    const parts: Array<Uint8Array> = [];
    const head = await fetcher.exchange(prepared, cap, (bytes) => {
      parts.push(bytes);
    });
    let body: Uint8Array<ArrayBuffer> | null = null;
    if (!NULL_BODY_STATUS.has(head.status) && prepared.method !== "HEAD") {
      body = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let at = 0;
      for (const part of parts) {
        body.set(part, at);
        at += part.length;
      }
    }
    return new Response(body, {
      status: head.status,
      statusText: head.statusText,
      headers: head.headers.map(([name, value]) => [name, value]),
    });
  };
}

/** Streams a response body (an asset or an attachment) to a sink; more than sink.cap bytes is H37. */
export function makePenFetchToSink(options: PenFetchOptions) {
  const fetcher = new PenFetcher(options);
  return async (
    input: string | URL | Request,
    init: RequestInit | undefined,
    sink: { readonly cap: number; write(bytes: Uint8Array): void | Promise<void> },
  ): Promise<ResponseHead> => {
    const prepared = fetcher.prepare(input, init);
    try {
      return await fetcher.exchange(prepared, sink.cap, (bytes) => sink.write(bytes));
    } catch (error) {
      const overCap =
        error instanceof PenError && ["http1/H17", "http1/H26", "http1/H36"].includes(error.code);
      if (overCap)
        throw new PenError("http1/H37", "the attachment is over its cap", { cause: error });
      throw error;
    }
  };
}
