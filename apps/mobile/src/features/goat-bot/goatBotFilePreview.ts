import { botArtifactPreview } from "@goat/client-runtime/goatBot";
import type { ChannelReadBotArtifactResult } from "@goat/contracts";
import { readImageDimensions } from "@goat/shared/imageDimensions";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/** One run of preview words and how it is drawn. */
export interface GoatBotPreviewInline {
  readonly text: string;
  readonly strong?: boolean;
  readonly emphasis?: boolean;
  readonly code?: boolean;
}

export interface GoatBotPreviewBlock {
  readonly kind: "heading" | "paragraph" | "item" | "quote" | "code";
  readonly inlines: ReadonlyArray<GoatBotPreviewInline>;
}

export type GoatBotFilePreview =
  | { readonly kind: "markdown"; readonly blocks: ReadonlyArray<GoatBotPreviewBlock> }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly uri: string };

type Node = {
  readonly type: string;
  readonly value?: string;
  readonly alt?: string | null;
  readonly children?: ReadonlyArray<Node>;
};

const parser = unified().use(remarkParse).use(remarkGfm);

function inlinesOf(
  nodes: ReadonlyArray<Node>,
  style: Omit<GoatBotPreviewInline, "text"> = {},
): GoatBotPreviewInline[] {
  return nodes.flatMap((node): GoatBotPreviewInline[] => {
    switch (node.type) {
      case "text":
        return [{ ...style, text: node.value ?? "" }];
      case "inlineCode":
        return [{ ...style, code: true, text: node.value ?? "" }];
      case "break":
        return [{ ...style, text: "\n" }];
      case "strong":
        return inlinesOf(node.children ?? [], { ...style, strong: true });
      case "emphasis":
        return inlinesOf(node.children ?? [], { ...style, emphasis: true });
      // The file's media and markup never load: an image is its alt text, raw HTML goes.
      case "image":
      case "imageReference":
        return node.alt ? [{ ...style, text: node.alt }] : [];
      case "html":
        return [];
      // A link is only its words: nothing in a preview opens.
      default:
        return inlinesOf(node.children ?? [], style);
    }
  });
}

function blocksOf(nodes: ReadonlyArray<Node>, inQuote = false): GoatBotPreviewBlock[] {
  return nodes.flatMap((node): GoatBotPreviewBlock[] => {
    switch (node.type) {
      case "heading":
        return [{ kind: "heading", inlines: inlinesOf(node.children ?? []) }];
      case "paragraph":
        return [{ kind: inQuote ? "quote" : "paragraph", inlines: inlinesOf(node.children ?? []) }];
      case "code":
        return [{ kind: "code", inlines: [{ text: node.value ?? "", code: true }] }];
      case "list":
        return (node.children ?? []).flatMap((item) =>
          blocksOf(item.children ?? [], inQuote).map((block, index) =>
            index === 0 && block.kind !== "code" ? { ...block, kind: "item" as const } : block,
          ),
        );
      case "blockquote":
        return blocksOf(node.children ?? [], true);
      case "table":
        return (node.children ?? []).map((row) => ({
          kind: "paragraph" as const,
          inlines: (row.children ?? []).flatMap((cell, index) => [
            ...(index === 0 ? [] : [{ text: " · " }]),
            ...inlinesOf(cell.children ?? []),
          ]),
        }));
      default:
        return [];
    }
  });
}

/** A Markdown file's start as plain blocks: no images, no links, no HTML. */
export function goatBotPreviewBlocks(markdown: string): ReadonlyArray<GoatBotPreviewBlock> {
  return blocksOf((parser.parse(markdown) as Node).children ?? []).filter((block) =>
    block.inlines.some((inline) => inline.text.trim() !== ""),
  );
}

const MAX_SIDE = 2048;

function pngIsAnimated(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === "acTL") return true;
    if (type === "IDAT") return false;
    at += 12 + length;
  }
  // No image data in the chunk read: an animation control could still follow.
  return true;
}

const startsWith = (bytes: Uint8Array, at: number, expected: ReadonlyArray<number>) =>
  expected.every((byte, index) => bytes[at + index] === byte);

/** The still-image format the bytes themselves are, whatever the file is called. */
function stillFormatOf(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  )
    return "image/webp";
  return null;
}

/**
 * Whether an image's first chunk is one still picture small enough to decode in a card: PNG,
 * JPEG or WebP up to 2048 pixels a side, by its bytes, and the format its name says. GIF,
 * animated PNG and animated WebP never preview.
 */
export function goatBotStillImage(bytes: Uint8Array, mimeType: string): boolean {
  const named = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const format = stillFormatOf(bytes);
  if (format === null || format !== named) return false;
  const size = readImageDimensions(bytes);
  if (size === null || size.width > MAX_SIDE || size.height > MAX_SIDE) return false;
  if (format === "image/png") return !pngIsAnimated(bytes);
  // WebP VP8X: the animation flag is bit 1 of the flags byte.
  if (format === "image/webp" && startsWith(bytes, 12, [0x56, 0x50, 0x38, 0x58]))
    return ((bytes[20] ?? 0) & 0x02) === 0;
  return true;
}

/**
 * What a card shows from a file's first chunk, decided by the shared preview: the start of a
 * text or Markdown file, or a still image drawn from the chunk's own data. Null shows the icon.
 */
export function goatBotFilePreviewOf(
  answer: ChannelReadBotArtifactResult,
): GoatBotFilePreview | null {
  const preview = botArtifactPreview(answer);
  if (preview === null || answer.status !== "chunk") return null;
  if (preview.kind === "image")
    return goatBotStillImage(preview.bytes, preview.mimeType)
      ? { kind: "image", uri: `data:${preview.mimeType};base64,${answer.bytesBase64}` }
      : null;
  if (preview.kind === "markdown")
    return { kind: "markdown", blocks: goatBotPreviewBlocks(preview.text) };
  return { kind: "text", text: preview.text };
}

// Never reset, so a remounted chat can never meet an earlier listing's number.
let generations = 0;
const generationOf = new WeakMap<object, number>();

/** A number for one listing answer, higher for every newer answer. */
export function listingGeneration(listing: object): number {
  const known = generationOf.get(listing);
  if (known !== undefined) return known;
  generations += 1;
  generationOf.set(listing, generations);
  return generations;
}

const MAX_ENTRIES = 12;
const MAX_BYTES = 4 * 1024 * 1024;
const cache = new Map<
  string,
  { readonly chatKey: string; readonly preview: GoatBotFilePreview | null; readonly bytes: number }
>();
let cachedBytes = 0;
const keyOf = (chatKey: string, path: string, generation: number) =>
  JSON.stringify([chatKey, path, generation]);
const weight = (preview: GoatBotFilePreview | null) =>
  preview === null
    ? 0
    : preview.kind === "image"
      ? preview.uri.length
      : preview.kind === "text"
        ? preview.text.length * 2
        : preview.blocks.reduce(
            (total, block) =>
              total + block.inlines.reduce((sum, inline) => sum + inline.text.length * 2, 0),
            0,
          );

/**
 * A preview read in this chat under this listing, so scrolling a card back does not read it again:
 * the preview, null for a file with nothing to show in that version, undefined when not read.
 */
export function cachedGoatBotFilePreview(
  chatKey: string,
  path: string,
  generation: number,
): GoatBotFilePreview | null | undefined {
  const key = keyOf(chatKey, path, generation);
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  cache.delete(key);
  cache.set(key, entry);
  return entry.preview;
}

export function storeGoatBotFilePreview(
  chatKey: string,
  path: string,
  generation: number,
  preview: GoatBotFilePreview | null,
): void {
  const key = keyOf(chatKey, path, generation);
  const old = cache.get(key);
  if (old !== undefined) {
    cachedBytes -= old.bytes;
    cache.delete(key);
  }
  const bytes = weight(preview);
  cache.set(key, { chatKey, preview, bytes });
  cachedBytes += bytes;
  for (const [oldest, entry] of cache) {
    if (cache.size <= MAX_ENTRIES && cachedBytes <= MAX_BYTES) break;
    if (oldest === key) continue;
    cache.delete(oldest);
    cachedBytes -= entry.bytes;
  }
}

/** The person left chat `chatKey`: its previews go. */
export function forgetChatFilePreviews(chatKey: string): void {
  for (const [key, entry] of cache) {
    if (entry.chatKey !== chatKey) continue;
    cache.delete(key);
    cachedBytes -= entry.bytes;
  }
}
