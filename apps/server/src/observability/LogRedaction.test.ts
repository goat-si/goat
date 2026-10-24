import * as NodeUtil from "node:util";

import { assert, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redactable from "effect/Redactable";

import { defectSummary, redactCause, redactLogMessage, redactLogText } from "./LogRedaction.ts";

// Synthetic canaries throughout; none of them is a real credential.
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.Y2FuYXJ5LXNpZ25hdHVyZQ";

describe("redactLogText", () => {
  it.each([
    [
      "fatal: unable to access 'https://bot:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git/'",
      "fatal: unable to access 'https://***@github.com/o/r.git/'",
    ],
    ["token github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "token ***"],
    ["Authorization: Bearer abcdefghijklmnop.qrstuv", "Authorization: Bearer ***"],
    ["Authorization: abcdef0123456789", "Authorization: ***"],
    ["export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv", "export OPENAI_API_KEY=***"],
    ["password=hunter2hunter2 user=me", "password=*** user=me"],
    ["GET /cb?refresh_token=abc123&state=1", "GET /cb?refresh_token=***"],
    ["GOAT_MCP_BEARER_TOKEN=abc123 goat call", "GOAT_MCP_BEARER_TOKEN=[redacted] goat call"],
    [`session ${jwt} expired`, "session *** expired"],
    ["Cookie: sid=abc; theme=dark", "Cookie: ***"],
    ["Set-Cookie: sid=abc; Path=/; HttpOnly\nnext line", "Set-Cookie: ***\nnext line"],
    ['{"access_token":"abc123","expires_in":3600}', '{"access_token":"***","expires_in":3600}'],
    ['{\\"refreshToken\\":\\"abc123\\"}', '{\\"refreshToken\\":\\"***\\"}'],
    ["{'password': 'hunter2'}", "{'password': '***'}"],
    ['{"set-cookie":["a=1","b=2"],"status":200}', '{"set-cookie":[***],"status":200}'],
    // A value holding the other quote, a bracket or an escaped quote is hidden whole.
    [`{"cookie":"sid=prefix'CANARY"}`, '{"cookie":"***"}'],
    ['{"set-cookie":["sid=before]CANARY; Path=/"]}', '{"set-cookie":[***]}'],
    ['{"token":"abc\\"CANARY"}', '{"token":"***"}'],
    ['{\\"token\\":\\"abc\\\\\\"CANARY\\"}', '{\\"token\\":\\"***\\"}'],
    ["{'password': 'it\\'s CANARY'}", "{'password': '***'}"],
    ['password="two CANARY words" user=me', "password=*** user=me"],
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
  ])("leaves %j as it is", (text) => {
    expect(redactLogText(text)).toBe(text);
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
    // A thrown value that is not an Error is named by its type only.
    expect(defectSummary({ token: "canary-object-token" })).toBe("non-Error defect (object)");
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
    expect(printed).toContain('upstream said {"token":"***"}');
    expect(printed).not.toContain("canary");
    expect(Cause.squash(redacted)).not.toHaveProperty("headers");
    const exported = Cause.prettyErrors(redacted, { includeCauseInStack: true });
    expect(exported.map((e) => [e.name, e.message, e.stack]).join("\n")).not.toContain("canary");
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

  it("bounds a deep or wide message", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 20; depth++) deep = { deep };
    expect(JSON.stringify(redactLogMessage(deep))).toContain("[Truncated]");
    const wide = redactLogMessage(Array.from({ length: 5_000 }, (_, index) => ({ index })));
    assert.isArray(wide);
    expect((wide as Array<unknown>).at(-1)).toBe("[Truncated]");
  });
});
