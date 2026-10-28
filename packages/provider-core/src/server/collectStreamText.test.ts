import { it } from "@effect/vitest";
import { assert, describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { collectUint8StreamText } from "./collectStreamText.ts";

const encoder = new TextEncoder();

describe("collectUint8StreamText", () => {
  it.effect("truncates by bytes and appends an optional marker once", () =>
    Effect.gen(function* () {
      const result = yield* collectUint8StreamText({
        stream: Stream.make(encoder.encode("abcdef"), encoder.encode("ghij")),
        maxBytes: 5,
        truncatedMarker: "[truncated]",
      });

      assert.deepStrictEqual(result, {
        text: "abcde[truncated]",
        bytes: 5,
        truncated: true,
        invalidUtf8: false,
      });
    }),
  );

  it.effect("reports invalid UTF-8 separately from a literal replacement character", () =>
    Effect.gen(function* () {
      const invalid = yield* collectUint8StreamText({
        stream: Stream.make(new Uint8Array([0x66, 0x80, 0x6f])),
      });
      const literal = yield* collectUint8StreamText({
        stream: Stream.make(encoder.encode("before\uFFFDafter")),
      });

      assert.strictEqual(invalid.invalidUtf8, true);
      assert.strictEqual(invalid.text, "f\uFFFDo");
      assert.strictEqual(literal.invalidUtf8, false);
      assert.strictEqual(literal.text, "before\uFFFDafter");
    }),
  );
});

it.effect("bounds default retention and drains the remaining finite stream", () =>
  Effect.gen(function* () {
    let drained = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    const result = yield* collectUint8StreamText({
      stream: Stream.fromIterable(Array.from({ length: 16 }, () => chunk)).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            drained++;
          }),
        ),
      ),
    });
    assert.equal(result.bytes, 8 * 1024 * 1024);
    assert.equal(result.truncated, true);
    assert.equal(result.text.length, 8 * 1024 * 1024);
    assert.equal(drained, 16);
  }),
);
