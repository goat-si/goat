import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { SpeechStreamEvent, SpeechStreamFeed } from "./voice.ts";
import { WsSpeechStreamRpcGroup } from "./rpc.ts";

const accepts = Schema.is(SpeechStreamFeed);
const acceptsEvent = Schema.is(SpeechStreamEvent);
const decodeFeed = Schema.decodeUnknownSync(SpeechStreamFeed);
const encodeEvent = Schema.encodeUnknownSync(SpeechStreamEvent);

it("bounds and validates encoded streaming audio at the wire boundary", () => {
  const valid = { streamId: "stream-fixture", sequence: 0, audioBase64: "AAA=" };
  expect(accepts(valid)).toBe(true);
  expect(accepts({ ...valid, sequence: -1 })).toBe(false);
  expect(accepts({ ...valid, audioBase64: "!" })).toBe(false);
  expect(accepts({ ...valid, audioBase64: "A".repeat(43_696) })).toBe(false);
});

it("does not include audio or transcript content in schema error messages", () => {
  const marker = "SYNTHETIC_PRIVATE_AUDIO_OR_TRANSCRIPT";
  const errors: string[] = [];
  for (const input of [
    () => decodeFeed({ streamId: "fixture", sequence: 0, audioBase64: `${marker}!` }),
    () => encodeEvent({ type: "partial", revision: -1, committed: marker, tentative: "" }),
  ]) {
    try {
      input();
    } catch (error) {
      errors.push(String(error));
    }
  }
  expect(errors).toHaveLength(2);
  expect(errors.every((message) => !message.includes(marker))).toBe(true);
});

it("exposes each streaming operation on the authenticated RPC group", () => {
  for (const method of [
    "speech.stream.start",
    "speech.stream.feed",
    "speech.stream.finish",
    "speech.stream.cancel",
    "speech.stream.events",
  ]) {
    expect(WsSpeechStreamRpcGroup.requests.has(method)).toBe(true);
  }
});

it("decodes revisioned previews and terminal speech events", () => {
  expect(
    acceptsEvent({ type: "partial", revision: 1, committed: "hello", tentative: " world" }),
  ).toBe(true);
  expect(acceptsEvent({ type: "final", text: "hello world" })).toBe(true);
  expect(acceptsEvent({ type: "error", code: "failed" })).toBe(true);
  expect(acceptsEvent({ type: "partial", revision: -1, committed: "x", tentative: "" })).toBe(
    false,
  );
});
