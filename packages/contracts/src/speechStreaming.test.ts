import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { SpeechStreamFeed } from "./voice.ts";

const accepts = Schema.is(SpeechStreamFeed);

it("bounds and validates encoded streaming audio at the wire boundary", () => {
  const valid = { streamId: "stream-fixture", sequence: 0, audioBase64: "AAA=" };
  expect(accepts(valid)).toBe(true);
  expect(accepts({ ...valid, sequence: -1 })).toBe(false);
  expect(accepts({ ...valid, audioBase64: "!" })).toBe(false);
  expect(accepts({ ...valid, audioBase64: "A".repeat(43_696) })).toBe(false);
});
