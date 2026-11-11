// HTTP/1.1 over a Pen stream, client side (design 10.2): a request serializer and an incremental response parser.
// Every check runs per byte in arrival order, so any split of the input gives the same result and the same error.
import { asciiEncode, ByteBuffer, toBase64 } from "./bytes.ts";
import { sha1Hash } from "./crypto.ts";
import { PenError } from "./errors.ts";

export const HTTP1_LIMITS = {
  statusLine: 1024,
  headerLine: 8 * 1024,
  head: 32 * 1024,
  fields: 64,
  contentLengthDigits: 15,
  chunkSizeLine: 16,
  chunkSizeDigits: 8,
  /** The buffered (JSON) body cap. */
  body: 8 * 1024 * 1024,
} as const;

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type HeaderList = ReadonlyArray<readonly [string, string]>;

export type ResponseEvent =
  | {
      readonly type: "head";
      readonly status: number;
      readonly reason: string;
      readonly headers: HeaderList;
    }
  | { readonly type: "body"; readonly bytes: Uint8Array }
  | {
      readonly type: "end";
      readonly delimiter: "length" | "chunked" | "close" | "none" | "upgrade";
    };

export interface ResponseContext {
  readonly method: string;
  /** Present when the request asked for a WebSocket upgrade. */
  readonly upgrade?: { readonly key: string; readonly protocol?: string };
  readonly bodyCap: number;
}

const fail = (rule: string, message: string) => new PenError("http1/" + rule, message);

const TCHAR = /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/;

function tokens(values: ReadonlyArray<string>): Array<string> {
  // Only SP and HTAB are HTTP whitespace (RFC 9110 OWS); String.trim() would also take NBSP and others.
  return values.flatMap((value) =>
    value.split(",").map((token) => token.replace(/^[ \t]+|[ \t]+$/g, "").toLowerCase()),
  );
}

/** Sec-WebSocket-Accept for a key (RFC 6455 section 4.2.2). */
export function websocketAccept(key: string): string {
  return toBase64(sha1Hash(asciiEncode(key + WEBSOCKET_GUID)));
}

type Phase =
  | "status"
  | "headers"
  | "length"
  | "chunk-size"
  | "chunk-data"
  | "chunk-cr"
  | "chunk-lf"
  | "last-cr"
  | "last-lf"
  | "close"
  | "done"
  | "upgraded";

export class ResponseParser {
  readonly #context: ResponseContext;
  #phase: Phase = "status";
  #error: PenError | undefined;
  #line: Array<number> = [];
  #sawCR = false;
  #headBytes = 0;
  #status = 0;
  #reason = "";
  #headers: Array<readonly [string, string]> = [];
  #remaining = 0;
  #received = 0;
  #chunkDigits = 0;
  #chunkSize = 0;
  #chunkLineBytes = 0;
  // Bytes after the response, one coalesced buffer (at most the relay's 1 MiB message per push in practice).
  #leftover = new ByteBuffer(HTTP1_LIMITS.body);

  constructor(context: ResponseContext) {
    this.#context = context;
  }

  /** Bytes after the response ended: frames after a 101, or unsolicited bytes after any other response. */
  leftover(): Uint8Array {
    const bytes = this.#leftover.take();
    this.#leftover.append(bytes);
    return bytes.slice();
  }

  /**
   * Decodes bytes, appending each event to out as it is decoded. When a later byte is malformed the events before it
   * stay in out, whatever the input's split, and the error is thrown.
   */
  push(bytes: Uint8Array, out: Array<ResponseEvent> = []): Array<ResponseEvent> {
    if (this.#error !== undefined) throw this.#error;
    try {
      this.#push(bytes, out);
      return out;
    } catch (error) {
      if (error instanceof PenError) this.#error = error;
      throw error;
    }
  }

  /** The stream ended: completes a close-delimited body, and is H45 anywhere a response is unfinished. */
  finish(): Array<ResponseEvent> {
    if (this.#error !== undefined) throw this.#error;
    if (this.#phase === "close") {
      this.#phase = "done";
      return [{ type: "end", delimiter: "close" }];
    }
    if (this.#phase === "done" || this.#phase === "upgraded") return [];
    this.#error = fail("H45", "the stream ended inside a response");
    throw this.#error;
  }

  #push(bytes: Uint8Array, events: Array<ResponseEvent>): void {
    let at = 0;
    while (at < bytes.length) {
      switch (this.#phase) {
        case "status":
        case "headers":
          at = this.#headByte(bytes, at, events);
          break;
        case "length": {
          const take = Math.min(this.#remaining, bytes.length - at);
          events.push({ type: "body", bytes: bytes.slice(at, at + take) });
          this.#remaining -= take;
          at += take;
          if (this.#remaining === 0) this.#end(events, "length");
          break;
        }
        case "close": {
          const take = bytes.length - at;
          if (this.#received + take > this.#context.bodyCap)
            throw fail("H36", "the body is over its cap");
          this.#received += take;
          events.push({ type: "body", bytes: bytes.slice(at) });
          at = bytes.length;
          break;
        }
        case "chunk-size":
          at = this.#chunkSizeByte(bytes[at] ?? 0, at);
          break;
        case "chunk-data": {
          const take = Math.min(this.#remaining, bytes.length - at);
          events.push({ type: "body", bytes: bytes.slice(at, at + take) });
          this.#remaining -= take;
          at += take;
          if (this.#remaining === 0) this.#phase = "chunk-cr";
          break;
        }
        case "chunk-cr":
        case "chunk-lf": {
          const expected = this.#phase === "chunk-cr" ? 13 : 10;
          if (bytes[at] !== expected) throw fail("H27", "chunk data is not followed by CRLF");
          this.#phase = this.#phase === "chunk-cr" ? "chunk-lf" : "chunk-size";
          at += 1;
          break;
        }
        case "last-cr":
        case "last-lf": {
          const expected = this.#phase === "last-cr" ? 13 : 10;
          if (bytes[at] !== expected) throw fail("H28", "trailers are not accepted");
          at += 1;
          if (this.#phase === "last-cr") this.#phase = "last-lf";
          else this.#end(events, "chunked");
          break;
        }
        case "done":
        case "upgraded":
          if (this.#leftover.length + bytes.length - at > HTTP1_LIMITS.body) {
            throw fail("H42", "too many bytes after the response");
          }
          this.#leftover.append(bytes.subarray(at));
          at = bytes.length;
          break;
      }
    }
  }

  #end(events: Array<ResponseEvent>, delimiter: "length" | "chunked" | "none" | "upgrade"): void {
    events.push({ type: "end", delimiter });
    this.#phase = delimiter === "upgrade" ? "upgraded" : "done";
  }

  /** One byte of the status line or a header line. */
  #headByte(bytes: Uint8Array, at: number, events: Array<ResponseEvent>): number {
    const byte = bytes[at] ?? 0;
    if (byte === 0) throw fail("H13", "NUL in the response head");
    if (this.#sawCR) {
      if (byte !== 10) throw fail("H11", "CR not followed by LF");
      this.#sawCR = false;
      if (this.#phase === "headers") {
        // CRLFs count toward the block, the terminating empty line's included.
        this.#headBytes += 2;
        if (this.#headBytes > HTTP1_LIMITS.head) throw fail("H07", "response head over 32 KiB");
      }
      const line = this.#line;
      this.#line = [];
      if (this.#phase === "status") this.#statusLine(line);
      else this.#headerLine(line, events);
      return at + 1;
    }
    if (byte === 13) {
      this.#sawCR = true;
      return at + 1;
    }
    if (byte === 10) throw fail("H12", "a line ends in LF without CR");
    this.#line.push(byte);
    if (this.#phase === "status") {
      if (this.#line.length > HTTP1_LIMITS.statusLine)
        throw fail("H01", "status line over 1,024 bytes");
    } else {
      this.#headBytes += 1;
      if (this.#line.length > HTTP1_LIMITS.headerLine) throw fail("H06", "header line over 8 KiB");
      if (this.#headBytes > HTTP1_LIMITS.head) throw fail("H07", "response head over 32 KiB");
    }
    return at + 1;
  }

  #statusLine(line: ReadonlyArray<number>): void {
    if (line.length === 0) throw fail("H35", "bytes before the status line");
    const text = String.fromCharCode(...line);
    if (!text.startsWith("HTTP/1.1")) throw fail("H02", "not HTTP/1.1");
    if (text[8] !== " ") throw fail("H02", "no SP after the version");
    const digits = /^[0-9]*/.exec(text.slice(9))?.[0] ?? "";
    if (digits.length !== 3) throw fail("H02", "the status is not three digits");
    if (text[12] !== " ") throw fail("H02", "no SP after the status");
    for (const code of line.slice(13)) {
      if (code !== 9 && (code < 0x20 || code === 0x7f))
        throw fail("H02", "control character in the reason");
    }
    this.#status = Number(digits);
    this.#reason = text.slice(13);
    if (this.#status === 101) {
      if (this.#context.upgrade === undefined) throw fail("H04", "101 without an upgrade request");
    } else if (this.#status >= 100 && this.#status <= 199) {
      throw fail("H05", "informational responses are refused");
    } else if (this.#status < 200 || this.#status > 599) {
      throw fail("H03", "status out of range");
    }
    this.#phase = "headers";
  }

  #headerLine(line: ReadonlyArray<number>, events: Array<ResponseEvent>): void {
    if (line.length === 0) {
      this.#finishHead(events);
      return;
    }
    if (this.#headers.length >= HTTP1_LIMITS.fields)
      throw fail("H08", "more than 64 header fields");
    if (line[0] === 0x20 || line[0] === 0x09) throw fail("H10", "obsolete line folding");
    const colon = line.indexOf(0x3a);
    if (colon <= 0) throw fail("H09", "no field name");
    const name = String.fromCharCode(...line.slice(0, colon));
    if (!TCHAR.test(name)) throw fail("H09", "field name is not a token");
    const rawValue = line.slice(colon + 1);
    for (const code of rawValue) {
      if (code !== 9 && (code < 0x20 || code === 0x7f))
        throw fail("H14", "control character in a field value");
    }
    const value = String.fromCharCode(...rawValue).replace(/^[ \t]+|[ \t]+$/g, "");
    this.#headers.push([name.toLowerCase(), value]);
  }

  #values(name: string): Array<string> {
    return this.#headers.filter(([field]) => field === name).map(([, value]) => value);
  }

  #finishHead(events: Array<ResponseEvent>): void {
    const lengths = this.#values("content-length");
    const encodings = this.#values("transfer-encoding");
    events.push({
      type: "head",
      status: this.#status,
      reason: this.#reason,
      headers: this.#headers,
    });
    // No content encoding on any response, the upgrade included (design 10.2).
    for (const value of this.#values("content-encoding")) {
      if (value.toLowerCase() !== "identity")
        throw fail("H29", "content encodings are not accepted");
    }
    if (this.#status === 101) {
      this.#checkUpgrade(lengths, encodings);
      this.#end(events, "upgrade");
      return;
    }
    if (lengths.length > 1) throw fail("H18", "more than one Content-Length");
    if (encodings.length > 1) throw fail("H22", "more than one Transfer-Encoding");
    if (lengths.length > 0 && encodings.length > 0)
      throw fail("H20", "Content-Length with Transfer-Encoding");
    const length = lengths[0];
    if (length !== undefined && !/^[0-9]+$/.test(length))
      throw fail("H15", "Content-Length is not digits");
    if (length !== undefined && length.length > HTTP1_LIMITS.contentLengthDigits) {
      throw fail("H16", "Content-Length over 15 digits");
    }
    const encoding = encodings[0];
    if (encoding !== undefined && encoding.toLowerCase() !== "chunked") {
      throw fail("H21", "Transfer-Encoding is not chunked");
    }
    // Design 10.2 caps Content-Length itself, before any allocation, whether or not a body follows.
    if (length !== undefined && Number(length) > this.#context.bodyCap) {
      throw fail("H17", "Content-Length over the body cap");
    }
    if (this.#context.method === "HEAD" || this.#status === 204 || this.#status === 304) {
      this.#end(events, "none");
      return;
    }
    if (encoding !== undefined) {
      this.#phase = "chunk-size";
      return;
    }
    if (length !== undefined) {
      const size = Number(length);
      this.#remaining = size;
      if (size === 0) this.#end(events, "length");
      else this.#phase = "length";
      return;
    }
    this.#phase = "close";
  }

  #checkUpgrade(lengths: ReadonlyArray<string>, encodings: ReadonlyArray<string>): void {
    const upgrade = this.#context.upgrade;
    if (upgrade === undefined) throw fail("H04", "101 without an upgrade request");
    if (!tokens(this.#values("upgrade")).includes("websocket"))
      throw fail("H30", "101 without Upgrade: websocket");
    if (!tokens(this.#values("connection")).includes("upgrade"))
      throw fail("H31", "101 without Connection: upgrade");
    const accept = this.#values("sec-websocket-accept");
    if (accept.length !== 1 || accept[0] !== websocketAccept(upgrade.key)) {
      throw fail("H32", "Sec-WebSocket-Accept is missing or wrong");
    }
    if (this.#values("sec-websocket-extensions").length > 0)
      throw fail("H33", "extensions are not accepted");
    const protocols = this.#values("sec-websocket-protocol");
    if (protocols.length > 1 || (protocols.length === 1 && protocols[0] !== upgrade.protocol)) {
      throw fail("H34", "a subprotocol that was not requested");
    }
    if (lengths.length > 0 || encodings.length > 0) throw fail("H35", "a 101 carries no body");
  }

  /** One byte of a chunk-size line: hex digits only, at most 8, no extensions. */
  #chunkSizeByte(byte: number, at: number): number {
    this.#chunkLineBytes += 1;
    if (this.#sawCR) {
      if (byte !== 10) throw fail("H11", "CR not followed by LF");
      this.#sawCR = false;
      const size = this.#chunkSize;
      this.#chunkSize = 0;
      this.#chunkDigits = 0;
      this.#chunkLineBytes = 0;
      if (size === 0) {
        this.#phase = "last-cr";
      } else {
        if (this.#received + size > this.#context.bodyCap)
          throw fail("H26", "chunks over the body cap");
        this.#received += size;
        this.#remaining = size;
        this.#phase = "chunk-data";
      }
      return at + 1;
    }
    const digit = Number.parseInt(String.fromCharCode(byte), 16);
    if (/^[0-9A-Fa-f]$/.test(String.fromCharCode(byte))) {
      this.#chunkDigits += 1;
      if (this.#chunkDigits > HTTP1_LIMITS.chunkSizeDigits)
        throw fail("H24", "chunk size over 8 hex digits");
      this.#chunkSize = this.#chunkSize * 16 + digit;
    } else if (byte === 0x3b) {
      throw fail("H25", "chunk extensions are not accepted");
    } else if (byte === 13) {
      if (this.#chunkDigits === 0) throw fail("H24", "empty chunk size");
      this.#sawCR = true;
    } else if (byte === 10) {
      throw fail("H12", "a line ends in LF without CR");
    } else {
      throw fail("H24", "chunk size is not hex");
    }
    if (this.#chunkLineBytes > HTTP1_LIMITS.chunkSizeLine)
      throw fail("H23", "chunk-size line over 16 bytes");
    return at + 1;
  }
}

export interface RequestHead {
  readonly method: string;
  /** Origin-form target: starts with "/". */
  readonly target: string;
  readonly host: string;
  readonly headers: HeaderList;
  readonly bodyLength?: number;
}

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "expect",
  "transfer-encoding",
  "host",
  "content-length",
  "connection",
  "upgrade",
  "accept-encoding",
  "te",
  "trailer",
  "keep-alive",
]);

function checkFieldText(text: string): void {
  if (/[\r\n\0]/.test(text)) throw fail("H46", "CR, LF or NUL in a request field");
}

/**
 * The request head. The caller cannot set framing or connection fields: Expect and Transfer-Encoding are refused
 * (H46), Host comes from the bound origin (H47), Accept-Encoding is always identity, Content-Length from the body.
 */
export function serializeRequest(head: RequestHead, upgrade?: HeaderList): Uint8Array {
  if (!TCHAR.test(head.method)) throw fail("H46", "method is not a token");
  if (!head.target.startsWith("/") || /[\x00-\x20\x7f]/.test(head.target)) {
    throw fail("H46", "request target is not origin-form");
  }
  checkFieldText(head.host);
  const lines = [head.method + " " + head.target + " HTTP/1.1", "Host: " + head.host];
  for (const [name, value] of head.headers) {
    if (!TCHAR.test(name)) throw fail("H46", "field name is not a token");
    checkFieldText(value);
    const lower = name.toLowerCase();
    if (lower === "expect" || lower === "transfer-encoding")
      throw fail("H46", name + " is not sent by this client");
    if (FORBIDDEN_REQUEST_HEADERS.has(lower)) continue;
    lines.push(name + ": " + value);
  }
  lines.push("Accept-Encoding: identity");
  if (head.bodyLength !== undefined) lines.push("Content-Length: " + head.bodyLength);
  for (const [name, value] of upgrade ?? []) {
    checkFieldText(value);
    lines.push(name + ": " + value);
  }
  const text = lines.join("\r\n") + "\r\n\r\n";
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) throw fail("H46", "a request field is not Latin-1");
    out[i] = code;
  }
  return out;
}
