import * as NodeUtil from "node:util";
import * as NodeVm from "node:vm";

import { assert, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redactable from "effect/Redactable";

import { defectSummary, redactCause, redactedDefects, redactLogMessage } from "./LogRedaction.ts";
import { redactLogText } from "./LogTextRedaction.ts";

// Synthetic canaries throughout; none of them is a real credential.
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.Y2FuYXJ5LXNpZ25hdHVyZQ";
// The header { "alg": "HS256", "typ": "JWT" }, with spaces, encodes as "eyAi…".
// A header that starts with a space, so it encodes as "IHsi…".
const leadingSpaceJwt = `${Buffer.from(' {"alg":"HS256"}').toString("base64url")}.eyJzdWIiOiJjYW5hcnkifQ.c2ln`;
const spacedJwt =
  "eyAiYWxnIjogIkhTMjU2IiwgInR5cCI6ICJKV1QiIH0.eyJzdWIiOiJjYW5hcnktd3Mtand0In0.Y2FuYXJ5LXdzLXNpZw";

describe("redactLogText", () => {
  it.each([
    [
      "fatal: unable to access 'https://bot:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git/'",
      "fatal: unable to access 'https://***@github.com/o/r.git/'",
    ],
    ["token github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "token ***"],
    ["Authorization: Bearer abcdefghijklmnop.qrstuv", "Authorization: ***"],
    ["Authorization: abcdef0123456789", "Authorization: ***"],
    ["export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv", "export OPENAI_API_KEY=***"],
    ["password=hunter2hunter2 user=me", "password=*** user=me"],
    ["GET /cb?refresh_token=abc123&state=1", "GET /cb?refresh_token=***"],
    ["GOAT_MCP_BEARER_TOKEN=abc123 goat call", "GOAT_MCP_BEARER_TOKEN=[redacted] goat call"],
    [`session ${jwt} expired`, "session *** expired"],
    ["Cookie: sid=abc; theme=dark", "Cookie: ***"],
    ["Set-Cookie: sid=abc; Path=/; HttpOnly\nnext line", "Set-Cookie: ***\nnext line"],
    ['{"access_token":"abc123","expires_in":3600}', '{"access_token":***,"expires_in":3600}'],
    ['{\\"refreshToken\\":\\"abc123\\"}', '{\\"refreshToken\\":***}'],
    ["{'password': 'hunter2'}", "{'password': ***}"],
    ['{"set-cookie":["a=1","b=2"],"status":200}', '{"set-cookie":***,"status":200}'],
    // A value holding the other quote, a bracket or an escaped quote is hidden whole.
    [`{"cookie":"sid=prefix'CANARY"}`, '{"cookie":***}'],
    ['{"set-cookie":["sid=before]CANARY; Path=/"]}', '{"set-cookie":***}'],
    ['{"token":"abc\\"CANARY"}', '{"token":***}'],
    ['{\\"token\\":\\"abc\\\\\\"CANARY\\"}', '{\\"token\\":***}'],
    ["{'password': 'it\\'s CANARY'}", "{'password': ***}"],
    ['password="two CANARY words" user=me', "password=*** user=me"],
    // Credential fields holding arrays, objects or bare values, and a JWT whose header has spaces.
    [
      '{"setCookie":["sid=CANARY; Path=/"],"cookie":["sid=CANARY", 7]}',
      '{"setCookie":***,"cookie":***}',
    ],
    ['{"cookie":{"sid":"CANARY"},"status":200}', '{"cookie":***,"status":200}'],
    ['{"password":123456,"ok":true}', '{"password":***,"ok":true}'],
    // An escaped spelling of a credential name, in JSON and in JSON inside a JSON string.
    ['{"to\\u006ben":"CANARY","ok":1}', '{"to\\u006ben":***,"ok":1}'],
    ['{\\"to\\\\u006ben\\":\\"CANARY\\"}', '{\\"to\\\\u006ben\\":***}'],
    [`requestid.${jwt} done`, "requestid.*** done"],
    // A whole assigned value: quoted segments joined to more text, or a JSON value with spaces.
    ["password='first'CANARY user=me", "password=*** user=me"],
    [`authorization=${"A".repeat(65)} CANARY next`, "authorization=*** next"],
    ["authorization=Bearer\nCANARY next", "authorization=*** next"],
    ['token={"a": "CANARY", "b": [1, 2]} next', "token=*** next"],
    // Pretty JSON escaped inside a JSON string: its whitespace is escaped too.
    [
      JSON.stringify('{"token" :\n\t"CANARY",\n"cookie":\n[\n"CANARY"\n],"ok":1}'),
      JSON.stringify('{"token" :\n\t***,\n"cookie":\n***,"ok":1}')
        .replaceAll('"***', "***")
        .replaceAll('***"', "***"),
    ],
    // Text joined to a token without a dot, however it is joined.
    [`jwt-${jwt} done`, "jwt-*** done"],
    [`jwt_${jwt} done`, "jwt_*** done"],
    [`bearer${jwt} done`, "bearer*** done"],
    // An escaped line break inside a quoted value, and short scheme credentials.
    ['password="two \\\nCANARY words" user=me', "password=*** user=me"],
    ["Authorization: Basic dTpw", "Authorization: ***"],
    ["Authorization: Negotiate CANARY\nnext", "Authorization: ***\nnext"],
    ['Authorization: Digest username="u", nonce="CANARY", response="CANARY"', "Authorization: ***"],
    // A folded header continues on lines that start with a space or tab.
    ['Authorization: Digest username="u",\r\n nonce="CANARY"\nnext', "Authorization: ***\nnext"],
    ["Cookie: sid=one;\n\ttheme=CANARY\r\nnext", "Cookie: ***\r\nnext"],
    ["csrfToken=CANARY authToken=CANARY", "csrfToken=*** authToken=***"],
    [
      "bearerToken: CANARY xsrf_token=CANARY cookie=CANARY",
      "bearerToken: *** xsrf_token=*** cookie=***",
    ],
    [`${"x".repeat(257)}${jwt} done`, `${"x".repeat(257)}*** done`],
    ["authorization=Bearer abc", "authorization=***"],
    ["https://user:p@CANARY@example.com/x?q=1", "https://***@example.com/x?q=1"],
    [
      `clone https://bot:${"x".repeat(600)}@example.com/r.git`,
      "clone https://***@example.com/r.git",
    ],
    [
      `${"y".repeat(40)}://bot:pw@example.com`,
      `${"y".repeat(8)}${"y".repeat(32)}://***@example.com`,
    ],
    ['{"cookie":[["first"],"CANARY"],"status":200}', '{"cookie":***,"status":200}'],
    ['{"token":{"value":{"inner":"CANARY"},"next":"CANARY"},"ok":1}', '{"token":***,"ok":1}'],
    ['{"token":"never closed CANARY', '{"token":***'],
    [`whitespace ${leadingSpaceJwt} header`, "whitespace *** header"],
    [`id ${spacedJwt} expired`, "id *** expired"],
  ])("redacts %j", (text, expected) => {
    expect(redactLogText(text)).toBe(expected);
  });

  it.each([
    "Receiving objects: 100% (2000/2000), done.",
    "GET /api/threads/thread-1 took 12ms",
    "used 1200 tokens, maxTokens: 8000",
    "the cookie jar is empty",
    "https://github.com/goat-si/goat/pull/1388",
    '{"tokenCount":3,"secretName":"memory-hub-internal"}',
    "eyes.width.px and ewma.window.size=3",
    "Basic auth is enabled for the dev server",
    "apps/server/src/serverLogger.test.ts and collector.example.com.local",
  ])("leaves %j as it is", (text) => {
    expect(redactLogText(text)).toBe(text);
  });

  it("hides a token whose remaining dots fall past the scanned part of a huge text", () => {
    const header = Buffer.from('{"alg":"HS256"}').toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ privateClaim: "canary-claim", pad: "p".repeat(220_000) }),
    ).toString("base64url");
    const text = redactLogText(`start ${header}.${payload}.c2ln end`);
    expect(text).not.toContain(header);
    expect(text).not.toContain(payload.slice(0, 40));
  });

  it.each([0, 60])(
    "hides a header that the scanned part of a huge text cuts open (%i leading spaces)",
    (spaces) => {
      const header = Buffer.from(
        " ".repeat(spaces) +
          JSON.stringify({ alg: "HS256", marker: "canary-header", pad: "x".repeat(220_000) }),
      ).toString("base64url");
      const text = redactLogText(`start ${header}.e30.c2ln`);
      expect(text).not.toContain(header.slice(0, 40));
    },
  );

  it("finds a token joined to a long prefix whatever the length of its header", () => {
    const longHeader = Buffer.from(
      JSON.stringify({ alg: "HS256", kid: "k".repeat(5_000) }),
    ).toString("base64url");
    const payload = Buffer.from('{"sub":"canary-joined"}').toString("base64url");
    const jws = redactLogText(`${"x".repeat(300)}${longHeader}.${payload}.c2ln done`);
    expect(jws).toBe(`${"x".repeat(300)}*** done`);
    // A JWE has no JSON payload; its five parts are found by the header alone.
    const jweHeader = Buffer.from(
      JSON.stringify({ alg: "dir", enc: "A256GCM", kid: "k".repeat(5_000) }),
    ).toString("base64url");
    const jwe = redactLogText(`${"x".repeat(300)}${jweHeader}..aXY.Y2FuYXJ5LWNpcGhlcg.dGFn done`);
    expect(jwe).toBe(`${"x".repeat(300)}*** done`);
  });

  it("renders span frames by name without running a frame's code", () => {
    let reads = 0;
    let calls = 0;
    const frame = {
      get name() {
        reads += 1;
        return "frame";
      },
      stack() {
        calls += 1;
        return undefined;
      },
      parent: { name: "spanName", stack: () => undefined, parent: undefined },
    };
    const reason = Cause.makeDieReason(new Error("original failure")).annotate(
      Context.make(Cause.StackTrace, frame),
    );
    const printed = Cause.pretty(redactCause(Cause.fromReasons([reason])));
    expect(printed).toContain("original failure");
    expect(printed).toContain("at spanName");
    expect([reads, calls]).toEqual([0, 0]);
  });

  it("redacts a long text before cutting it, so a credential across the cut is still hidden", () => {
    const text = redactLogText(`${"x".repeat(31_990)} ${jwt} ${"y".repeat(100)}`);
    expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(text).toMatch(/cut from \d+ characters\]$/);
  });
});

describe("defectSummary", () => {
  it("names what died without the defect's fields or credentials", () => {
    const defect = new Error("handler died with Bearer abcdefghijklmnopqrstuvwxyz0123", {
      cause: {
        authorization: "Bearer canary-cause-token-0123456789",
        accessToken: "canary-access",
      },
    });
    const summary = defectSummary(defect);
    expect(summary).toContain("Error: handler died with Bearer ***");
    expect(summary).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(summary).not.toContain("canary");
    const revoked = Proxy.revocable(new Error("canary-revoked"), {});
    revoked.revoke();
    expect(defectSummary(revoked.proxy)).toBe("non-Error defect (object)");
    // A Proxy whose prototype lookup throws on a second try is classified once.
    let lookups = 0;
    const flaky = new Proxy(new Error("original failure"), {
      getPrototypeOf: (target) => {
        lookups += 1;
        if (lookups > 1) throw new Error("second prototype lookup");
        return Reflect.getPrototypeOf(target);
      },
    });
    expect(defectSummary(flaky)).toContain("original failure");
    // A thrown value that is not an Error is named by its type only.
    expect(defectSummary({ token: "canary-object-token" })).toBe("non-Error defect (object)");
  });
});

describe("errors from another realm", () => {
  // vm contexts and workers build Errors whose prototype is not this realm's Error.prototype.
  const foreign = () =>
    NodeVm.runInNewContext(
      'Object.assign(new TypeError("cross-realm failure"), { requestBody: "canary-realm-extra" })',
    ) as unknown;

  it("keeps a foreign error's name and message and drops its fields, as a field, defect or cause", () => {
    const printed = [
      JSON.stringify(redactLogMessage({ error: foreign() })),
      defectSummary(foreign()),
      Cause.pretty(redactCause(Cause.die(foreign()))),
      Cause.pretty(redactCause(Cause.die(new Error("outer", { cause: foreign() })))),
      ...redactedDefects(Cause.die(foreign())).map((cause) => Cause.pretty(cause)),
    ];
    for (const text of printed) {
      expect(text).toContain("TypeError: cross-realm failure");
      expect(text).not.toContain("canary-realm-extra");
    }
  });
});

describe("redactCause", () => {
  it("keeps an error's name, message and cause chain, but none of its fields or credentials", () => {
    const error = Object.assign(
      new TypeError("bad header Cookie: sid=canary-cookie", {
        cause: new Error('upstream said {"token":"canary-json"}'),
      }),
      { headers: { authorization: "Bearer canary-field-0123456789" } },
    );
    const redacted = redactCause(
      Cause.fromReasons([Cause.makeFailReason(error), Cause.makeDieReason(error)]),
    );

    const printed = Cause.pretty(redacted);
    expect(printed).toContain("TypeError: bad header Cookie: ***");
    expect(printed).toContain('upstream said {"token":***}');
    expect(printed).not.toContain("canary");
    expect(Cause.squash(redacted)).not.toHaveProperty("headers");
    const exported = Cause.prettyErrors(redacted, { includeCauseInStack: true });
    expect(exported.map((e) => [e.name, e.message, e.stack]).join("\n")).not.toContain("canary");
  });

  it("reads a cause's reasons once, without running the list's methods", () => {
    const leaky = () => [Cause.makeDieReason(new Error("Cookie: sid=canary-forged-reason"))];
    const forgedList = leaky();
    Object.assign(forgedList, { slice: () => forgedList, map: () => forgedList });
    const lyingCause = Cause.fromReasons(leaky());
    let reads = 0;
    Object.defineProperty(lyingCause, "reasons", {
      get: () => (reads++ === 0 ? [] : leaky()),
    });
    for (const cause of [Cause.fromReasons(forgedList), lyingCause]) {
      expect(Cause.pretty(redactCause(cause))).not.toContain("canary-forged-reason");
    }
  });

  it("keeps an error whose reason metadata or reason list cannot be inspected", () => {
    const { proxy, revoke } = Proxy.revocable(new Map(), {});
    revoke();
    const reason = Cause.makeDieReason(new Error("original failure"));
    Object.defineProperty(reason, "annotations", { value: proxy });
    expect(Cause.pretty(redactCause(Cause.fromReasons([reason])))).toContain("original failure");

    const revokedList = Proxy.revocable([], {});
    revokedList.revoke();
    const cause = Cause.fromReasons([Cause.makeDieReason(new Error("listed"))]);
    Object.defineProperty(cause, "reasons", { value: revokedList.proxy });
    expect(() => redactCause(cause)).not.toThrow();
  });

  it("renders span frames without running an annotation map's own iterator", () => {
    let iterated = false;
    class Annotations extends Map<string, unknown> {
      override *[Symbol.iterator](): MapIterator<[string, unknown]> {
        iterated = true;
        yield* super[Symbol.iterator]();
      }
    }
    const reason = Cause.makeDieReason(new Error("original failure"));
    Object.defineProperty(reason, "annotations", { value: new Annotations([["k", "v"]]) });
    expect(Cause.pretty(redactCause(Cause.fromReasons([reason])))).toContain("original failure");
    expect(iterated).toBe(false);
  });

  it("ends on a cyclic chain of unnamed span frames", () => {
    const frame: Record<string, unknown> = {};
    frame.parent = frame;
    const reason = Cause.makeDieReason(new Error("original failure"));
    Object.defineProperty(reason, "annotations", {
      value: new Map([[Cause.StackTrace.key, frame]]),
    });
    expect(Cause.pretty(redactCause(Cause.fromReasons([reason])))).toContain("original failure");
  });

  it("keeps a deep cause chain's root, and marks a chain deeper than it shows", () => {
    const chain = (depth: number) =>
      Array.from({ length: depth - 1 }, (_, index) => `wrapper${index}`).reduceRight(
        (cause: Error, message) => new Error(message, { cause }),
        new Error("ROOT"),
      );
    expect(Cause.pretty(redactCause(Cause.die(chain(5))))).toContain("ROOT");
    expect(Cause.pretty(redactCause(Cause.die(chain(40))))).toContain("[deeper causes omitted]");
  });

  it("keeps stack frames whatever the engine's stack format", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\nfunction@file:///synthetic.ts:1:2";
    expect(Cause.pretty(redactCause(Cause.die(error)))).toContain(
      "function@file:///synthetic.ts:1:2",
    );
    // A stack without its own header is frames from its first line on.
    const headerless = new Error("boom");
    headerless.stack = "first@file:///a.js:1:1\nsecond@file:///b.js:2:2";
    const printed = Cause.pretty(redactCause(Cause.die(headerless)));
    expect(printed).toContain("first@file:///a.js:1:1");
    expect(printed).toContain("second@file:///b.js:2:2");
  });

  it("keeps an error whose cause cannot be inspected", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const printed = Cause.pretty(
      redactCause(Cause.die(new Error("original failure", { cause: proxy }))),
    );
    expect(printed).toContain("original failure");
  });

  it("keeps a getter-defined message and survives a getter that throws", () => {
    class Computed extends Error {
      override get message() {
        return "computed with Bearer canary-computed-0123456789";
      }
    }
    class Broken extends Error {
      override get message(): string {
        throw new Error("getter failed");
      }
    }
    const printed = Cause.pretty(
      redactCause(
        Cause.fromReasons([Cause.makeDieReason(new Computed()), Cause.makeDieReason(new Broken())]),
      ),
    );
    expect(printed).toContain("computed with Bearer ***");
    expect(printed).not.toContain("canary");
  });

  it.effect("hides credentials in span names, including on an interruption", () =>
    Effect.gen(function* () {
      const dies = Effect.fn("call with token=canary-span-0123456789")(function* () {
        return yield* Effect.die(new Error("boom"));
      });
      const interrupted = Effect.fn("call with token=canary-interrupt-0123456789")(function* () {
        return yield* Effect.interrupt;
      });
      for (const program of [dies(), interrupted()]) {
        const exit = yield* Effect.exit(program);
        assert.isTrue(Exit.isFailure(exit));
        if (!Exit.isFailure(exit)) continue;
        // The span name reaches the rendering before redaction, so the test sees a real leak.
        expect(Cause.pretty(exit.cause)).toContain("canary");
        const redacted = redactCause(exit.cause);
        expect(Cause.pretty(redacted)).not.toContain("canary");
        const exported = Cause.prettyErrors(redacted, { includeCauseInStack: true });
        expect(exported.map((e) => e.stack).join("\n")).not.toContain("canary");
      }
    }),
  );
});

describe("redactedDefects", () => {
  it("ends on a prototype chain a Proxy reports as cyclic or endless, and reports the defect", () => {
    let cyclic: object = {};
    cyclic = new Proxy({}, { getPrototypeOf: () => cyclic });
    const endless: ProxyHandler<object> = { getPrototypeOf: () => new Proxy({}, endless) };
    expect(redactedDefects(Cause.die(cyclic))).toHaveLength(1);
    expect(redactedDefects(Cause.die(new Proxy({}, endless)))).toHaveLength(1);
  });

  it("walks a prototype chain shared by many defects once", () => {
    let reads = 0;
    const counting: ProxyHandler<object> = {
      getOwnPropertyDescriptor: (target, key) => {
        reads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    };
    let leaf: object = new Proxy({}, counting);
    for (let index = 0; index < 200; index++) leaf = new Proxy(Object.create(leaf), counting);
    const defects = Array.from({ length: 100 }, () => Cause.makeDieReason(leaf));
    expect(redactedDefects(Cause.fromReasons(defects)).length).toBeGreaterThan(0);
    // One walk of the shared chain plus a constant per defect, not one walk per defect.
    expect(reads).toBeLessThan(450);
  });
});

describe("forged list lengths", () => {
  const forgedLength = (length: unknown, onValueOf: () => void) =>
    new Proxy([], {
      getOwnPropertyDescriptor: (target, key) =>
        key === "length"
          ? { value: length, writable: true, enumerable: false, configurable: false }
          : Reflect.getOwnPropertyDescriptor(target, key),
    });

  it("reads a list's length without coercing it", () => {
    let calls = 0;
    const valueOf = {
      valueOf: () => {
        calls += 1;
        return 1;
      },
    };
    redactLogMessage({ list: forgedLength(valueOf, () => {}) });
    const cause = Cause.fromReasons([]);
    Object.defineProperty(cause, "reasons", { value: forgedLength(valueOf, () => {}) });
    expect(redactedDefects(cause)).toEqual([]);
    expect(calls).toBe(0);
  });

  it("ends on a reason list that claims an endless length", () => {
    const cause = Cause.fromReasons([]);
    Object.defineProperty(cause, "reasons", { value: forgedLength(Infinity, () => {}) });
    expect(redactedDefects(cause)).toEqual([]);
  });
});

describe("redactLogMessage", () => {
  it("copies a log field as inert data without calling its getters or hooks", () => {
    class Request {
      readonly url = "https://bot:canary-userinfo@example.com/x";
      readonly headers = { cookie: "sid=canary-cookie" };
      toJSON() {
        return "canary-to-json";
      }
      [NodeUtil.inspect.custom]() {
        return "canary-inspect";
      }
    }
    const at = Object.assign(DateTime.toDate(DateTime.makeUnsafe(0)), {
      token: "canary-date-field",
    });
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    const shared = { kind: "shared" };
    const message = redactLogMessage({
      request: new Request(),
      at,
      accessToken: ["canary-array-token"],
      "Bearer canary-key-token-0123": "keyed",
      get lazy(): string {
        throw new Error("getter must not run");
      },
      loop,
      first: shared,
      second: shared,
      onDone: function onDone() {},
      tags: new Set(["Cookie: sid=canary-set"]),
    });

    expect(NodeUtil.inspect(message, { depth: 10 })).not.toContain("canary");
    expect(message).toMatchObject({
      request: { url: "https://***@example.com/x", headers: { cookie: "***" } },
      at: "1970-01-01T00:00:00.000Z",
      accessToken: "***",
      "Bearer ***": "keyed",
      lazy: "[Getter]",
      loop: { name: "loop", self: "[Circular]" },
      first: { kind: "shared" },
      second: { kind: "shared" },
      onDone: "[Function onDone]",
      tags: ["Cookie: ***"],
    });
  });

  it("lets a Redactable hook decide what shows, then redacts what it returns", () => {
    const value = {
      secret: "canary-hook-secret",
      [Redactable.symbolRedactable]() {
        return { note: "Cookie: sid=canary-hook-cookie", kept: "yes" };
      },
    };
    expect(redactLogMessage(value)).toEqual({ note: "Cookie: ***", kept: "yes" });
  });

  it("masks a credential-named Map entry like an object field", () => {
    const headers = new Map<unknown, unknown>([
      ["access_token", "canary-map-token"],
      ["cookie", "sid=canary-map-cookie"],
      ["accept", "application/json"],
    ]);
    expect(redactLogMessage(headers)).toEqual([
      ["access_token", "***"],
      ["cookie", "***"],
      ["accept", "application/json"],
    ]);
  });

  it("copies an array without reading its elements through getters", () => {
    const items: Array<unknown> = ["first"];
    Object.defineProperty(items, 1, {
      enumerable: true,
      get: () => {
        throw new Error("getter must not run");
      },
    });
    expect(redactLogMessage(items)).toEqual(["first", "[Getter]"]);
  });

  it("bounds a wide collection of large strings", () => {
    const wide = redactLogMessage(Array.from({ length: 5_000 }, () => "a".repeat(4_096)));
    assert.isArray(wide);
    expect(JSON.stringify(wide).length).toBeLessThan(70_000);
    expect((wide as Array<unknown>).at(-1)).toBe("[Truncated]");
  });

  it("summarizes binary data without reading it", () => {
    const bytes = Object.defineProperty(new Uint8Array(1), "byteLength", {
      get() {
        return "Cookie: sid=canary-binary";
      },
    });
    const buffer = new ArrayBuffer(8);
    const detached = new DataView(buffer);
    structuredClone(buffer, { transfer: [buffer] });
    expect(redactLogMessage({ bytes, detached })).toEqual({
      bytes: "[binary data]",
      detached: "[binary data]",
    });
  });

  it("bounds a sparse array, getter-only slots and a huge bigint", () => {
    const sparse = redactLogMessage(Array.from({ length: 1 }).concat(new Array(100_000)));
    assert.isArray(sparse);
    expect((sparse as Array<unknown>).length).toBeLessThan(2_100);
    expect((sparse as Array<unknown>).at(-1)).toBe("[Truncated]");

    const getters: Array<unknown> = [];
    for (let index = 0; index < 3_000; index++)
      Object.defineProperty(getters, index, {
        enumerable: true,
        get: () => {
          throw new Error("getter must not run");
        },
      });
    expect((redactLogMessage(getters) as Array<unknown>).at(-1)).toBe("[Truncated]");

    // A huge bigint is told by its size; converting it to decimal would not be linear.
    expect(redactLogMessage(10n ** 100_000n)).toMatch(/^\[bigint of \d+ bits\]$/);
    expect(redactLogMessage(42n)).toBe(42n);
  });

  it("logs a value that throws on inspection as a placeholder", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(redactLogMessage({ revoked: proxy, forged: Object.create(Map.prototype) })).toEqual({
      revoked: "[Uninspectable]",
      forged: "[Uninspectable]",
    });
  });

  it("shows an Error field's cause chain", () => {
    const printed = redactLogMessage({ error: new Error("outer", { cause: new Error("inner") }) });
    expect(JSON.stringify(printed)).toContain("outer");
    expect(JSON.stringify(printed)).toContain("inner");
  });

  it("names a function without running a name getter", () => {
    const fn = Object.defineProperty(function () {}, "name", {
      get() {
        throw new Error("getter must not run");
      },
    });
    expect(redactLogMessage({ fn })).toEqual({ fn: "[Function anonymous]" });
  });

  it("bounds a deep or wide message", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 20; depth++) deep = { deep };
    expect(JSON.stringify(redactLogMessage(deep))).toContain("[Truncated]");
    const wide = redactLogMessage(Array.from({ length: 5_000 }, (_, index) => ({ index })));
    assert.isArray(wide);
    expect((wide as Array<unknown>).at(-1)).toBe("[Truncated]");
  });
});
