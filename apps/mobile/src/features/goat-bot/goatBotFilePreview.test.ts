import { expect, it } from "vite-plus/test";

import {
  cachedGoatBotFilePreview,
  forgetChatFilePreviews,
  goatBotFilePreviewOf,
  goatBotPreviewBlocks,
  goatBotStillImage,
  listingGeneration,
  storeGoatBotFilePreview,
} from "./goatBotFilePreview";

const flat = (blocks: ReturnType<typeof goatBotPreviewBlocks>) =>
  blocks.map((block) => block.inlines.map((inline) => inline.text).join("")).join("\n");

it("reads a file's Markdown without anything that loads or opens: images become alt text, links words, HTML goes", () => {
  const blocks = goatBotPreviewBlocks(
    [
      "# Weekly report",
      "",
      'See ![the chart](https://example.com/chart.png) and [our site](https://example.com "t").',
      "",
      '<img src="https://example.com/x.png"> <script>steal()</script> <a href="https://example.com">a</a>',
      "",
      "- first **bold** `code`",
      "- second",
      "",
      "```",
      "npm test",
      "```",
    ].join("\n"),
  );
  const text = flat(blocks);
  expect(blocks[0]).toMatchObject({ kind: "heading" });
  expect(text).toContain("Weekly report");
  expect(text).toContain("See the chart and our site.");
  expect(text).not.toContain("example.com");
  // Tags go; words between them stay words, which load nothing.
  expect(text).not.toMatch(/<\/?(?:img|script|a)\b/);
  expect(text).toContain("first bold code");
  expect(blocks.filter((block) => block.kind === "item")).toHaveLength(2);
  expect(blocks.at(-1)).toMatchObject({ kind: "code", inlines: [{ text: "npm test" }] });
});

const chunk = (bytes: Uint8Array, length: number, type: string) => {
  const size = 8 + length + 4;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, length);
  out.set(
    [...type].map((char) => char.charCodeAt(0)),
    4,
  );
  out.set(bytes.subarray(0, length), 8);
  return out;
};
function png(width: number, height: number, animated = false): Uint8Array {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk(ihdr, 13, "IHDR"),
    ...(animated ? [chunk(new Uint8Array(8), 8, "acTL")] : []),
    chunk(new Uint8Array(4), 4, "IDAT"),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 10, 0, 0, 0, 0]);
function webp(animated: boolean): Uint8Array {
  const out = new Uint8Array(30);
  out.set(
    [..."RIFF"].map((char) => char.charCodeAt(0)),
    0,
  );
  out.set(
    [..."WEBPVP8X"].map((char) => char.charCodeAt(0)),
    8,
  );
  out[20] = animated ? 0x02 : 0;
  out.set([9, 0, 0, 9, 0, 0], 24);
  return out;
}

it("draws only still images up to 2048 pixels a side", () => {
  expect(goatBotStillImage(png(2048, 2048), "image/png")).toBe(true);
  expect(goatBotStillImage(png(2049, 100), "image/png")).toBe(false);
  expect(goatBotStillImage(png(10, 10, true), "image/png")).toBe(false);
  expect(goatBotStillImage(gif, "image/gif")).toBe(false);
  expect(goatBotStillImage(webp(true), "image/webp")).toBe(false);
  expect(goatBotStillImage(webp(false), "image/webp")).toBe(true);
  expect(goatBotStillImage(new Uint8Array([1, 2, 3]), "image/png")).toBe(false);
  expect(goatBotStillImage(png(10, 10), "image/svg+xml")).toBe(false);
});

it("decides an image's format from its bytes, and previews it only when the name says the same format", () => {
  // GIF bytes saved as chart.png, and a PNG saved as photo.jpg, show the icon.
  expect(goatBotStillImage(gif, "image/png")).toBe(false);
  expect(goatBotStillImage(png(10, 10), "image/jpeg")).toBe(false);
  expect(goatBotStillImage(webp(false), "image/png")).toBe(false);
  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 10, 0, 10, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ]);
  expect(goatBotStillImage(jpeg, "image/jpeg")).toBe(true);
  expect(goatBotStillImage(jpeg, "image/png")).toBe(false);
});

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const answer = (bytes: Uint8Array, mimeType: string, relativePath: string) => ({
  status: "chunk" as const,
  relativePath,
  mimeType,
  size: bytes.length,
  offset: 0,
  bytesBase64: base64(bytes),
  version: "v1",
  done: true,
});

it("previews a still image from its first chunk's own data, and nothing for an animated one", () => {
  const still = png(10, 10);
  expect(goatBotFilePreviewOf(answer(still, "image/png", "chart.png"))).toEqual({
    kind: "image",
    uri: `data:image/png;base64,${base64(still)}`,
  });
  expect(goatBotFilePreviewOf(answer(png(10, 10, true), "image/png", "spin.png"))).toBeNull();
  const markdown = new TextEncoder().encode("# 보고서 🐐\n\n![x](https://example.com/a.png)");
  const preview = goatBotFilePreviewOf(answer(markdown, "text/markdown", "report.md"));
  expect(preview?.kind).toBe("markdown");
  expect(preview?.kind === "markdown" ? flat(preview.blocks) : "").toBe("보고서 🐐\nx");
});

it("keeps previews per listing generation, and forgets the oldest past 12 or 4 MiB", () => {
  const first = listingGeneration({});
  const later = listingGeneration({});
  expect(later).toBeGreaterThan(first);
  const listing = {};
  expect(listingGeneration(listing)).toBe(listingGeneration(listing));
  const text = { kind: "text" as const, text: "hello" };
  storeGoatBotFilePreview("env", "a.txt", first, text);
  expect(cachedGoatBotFilePreview("env", "a.txt", first)).toEqual(text);
  // A newer listing reads the file again, even when its modified time did not change.
  expect(cachedGoatBotFilePreview("env", "a.txt", later)).toBeUndefined();
  for (let index = 0; index < 12; index += 1)
    storeGoatBotFilePreview("env", `f${index}.txt`, first, text);
  expect(cachedGoatBotFilePreview("env", "a.txt", first)).toBeUndefined();
  const big = {
    kind: "image" as const,
    uri: `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`,
  };
  storeGoatBotFilePreview("env", "big1.png", first, big);
  storeGoatBotFilePreview("env", "big2.png", first, big);
  expect(cachedGoatBotFilePreview("env", "big1.png", first)).toBeUndefined();
  expect(cachedGoatBotFilePreview("env", "big2.png", first)).toEqual(big);
});

it("remembers a file with nothing to show for its generation, counted against the same 12 entries", () => {
  const first = listingGeneration({});
  const later = listingGeneration({});
  storeGoatBotFilePreview("env-empty", "big.txt", first, null);
  expect(cachedGoatBotFilePreview("env-empty", "big.txt", first)).toBeNull();
  expect(cachedGoatBotFilePreview("env-empty", "big.txt", later)).toBeUndefined();
  for (let index = 0; index < 12; index += 1)
    storeGoatBotFilePreview("env-empty", `empty${index}.txt`, first, null);
  expect(cachedGoatBotFilePreview("env-empty", "big.txt", first)).toBeUndefined();
});

it("forgets a chat's previews when the person leaves it, and keeps another chat's", () => {
  const generation = listingGeneration({});
  const text = { kind: "text" as const, text: "hello" };
  storeGoatBotFilePreview("chat-left", "a.txt", generation, text);
  storeGoatBotFilePreview("chat-stays", "a.txt", generation, text);
  forgetChatFilePreviews("chat-left");
  expect(cachedGoatBotFilePreview("chat-left", "a.txt", generation)).toBeUndefined();
  expect(cachedGoatBotFilePreview("chat-stays", "a.txt", generation)).toEqual(text);
});
