import { assert, describe, it } from "@effect/vitest";

import {
  admitDriverReplyScreenshots,
  COMPUTER_USE_SCREENSHOT_MAX_BYTES,
} from "./ComputerUseDriverReply.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString(
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49]).toString("base64");
const reply = (...content: ReadonlyArray<unknown>) =>
  JSON.stringify({ jsonrpc: "2.0", id: 4, result: { content } });
const text = { type: "text", text: "Captured window 12" };
const withheld = (reason: string) => ({
  type: "text",
  text: `GOAT withheld a screenshot from this result: ${reason}.`,
});
const contentOf = (line: string) =>
  (JSON.parse(line) as { result: { content: ReadonlyArray<unknown> } }).result.content;

describe("admitDriverReplyScreenshots", () => {
  it("passes a PNG or JPEG screenshot through as the driver wrote it", () => {
    for (const [mimeType, data] of [
      ["image/png", PNG],
      ["image/jpeg", JPEG],
    ] as const) {
      const line = reply(text, { type: "image", mimeType, data });
      assert.equal(admitDriverReplyScreenshots(line), line);
    }
  });

  it("withholds images that are not PNG or JPEG, are not base64 bytes, or lie about their type", () => {
    const line = reply(
      text,
      { type: "image", mimeType: "image/svg+xml", data: PNG },
      { type: "image", mimeType: "image/gif", data: "R0lGODlhAQABAAAAACw=" },
      { type: "image", mimeType: "image/png", data: "file:///etc/passwd" },
      { type: "image", mimeType: "image/png", data: "../../secrets.png" },
      { type: "image", mimeType: "image/png", data: JPEG },
      { type: "image", mimeType: "image/jpeg", data: Buffer.from("plain text").toString("base64") },
      { type: "image", mimeType: "image/png", data: PNG },
    );
    assert.deepEqual(contentOf(admitDriverReplyScreenshots(line)), [
      text,
      withheld("it is not a PNG or JPEG image"),
      withheld("it is not a PNG or JPEG image"),
      withheld("its data is not base64"),
      withheld("its data is not base64"),
      withheld("its bytes are not image/png"),
      withheld("its bytes are not image/jpeg"),
      { type: "image", mimeType: "image/png", data: PNG },
    ]);
  });

  it("checks an image block whatever the JSON spells, and never throws on an odd mimeType", () => {
    const escaped = reply(text).replace(
      '"content":[',
      `"content":[{"type":"im\\u0061ge","mimeType":"image/svg+xml","data":"${PNG}"},`,
    );
    assert.deepEqual(contentOf(admitDriverReplyScreenshots(escaped)), [
      withheld("it is not a PNG or JPEG image"),
      text,
    ]);
    for (const mimeType of ["constructor", "__proto__", "toString"])
      assert.deepEqual(
        contentOf(admitDriverReplyScreenshots(reply({ type: "image", mimeType, data: PNG }))),
        [withheld("it is not a PNG or JPEG image")],
      );
  });

  it("withholds a screenshot over 25 MiB", () => {
    const length = Math.ceil(COMPUTER_USE_SCREENSHOT_MAX_BYTES / 3) * 4 + 4;
    const oversize = PNG + "A".repeat(length - PNG.length);
    const line = reply({ type: "image", mimeType: "image/png", data: oversize });
    assert.deepEqual(contentOf(admitDriverReplyScreenshots(line)), [
      withheld("it is larger than 25 MiB"),
    ]);
  });
});
