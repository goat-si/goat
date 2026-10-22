import { describe, expect, it } from "vite-plus/test";

import {
  filePreviewKind,
  decodeFilePreviewText,
  FILE_TEXT_PREVIEW_MAX_BYTES,
  isWorkspacePreviewEntryPath,
  isWorkspaceImagePreviewPath,
  mediaKindFromPath,
  hostPreviewMimeTypeFromExtension,
} from "./filePreview.ts";

describe("workspace file previews", () => {
  // regression: #10311 previews classify by the literal filename, not URL-like suffixes
  it.each(["image.png.ts", "image.png#notes.txt", "image%2Epng"])(
    "rejects non-preview path %s",
    (path) => {
      expect(isWorkspacePreviewEntryPath(path)).toBe(false);
    },
  );

  it.each(["photo.HEIC", "photo.heif"])("recognizes image preview path %s", (path) => {
    expect(isWorkspaceImagePreviewPath(path)).toBe(true);
    expect(isWorkspacePreviewEntryPath(path)).toBe(true);
  });

  it.each(["image.heic.txt", "image.heif?download=1"])("rejects non-preview path %s", (path) => {
    expect(isWorkspacePreviewEntryPath(path)).toBe(false);
  });

  it.each([
    [".HEIC", "image/heic"],
    [".heif", "image/heif"],
  ])("serves %s with its native image MIME type", (extension, mimeType) => {
    expect(hostPreviewMimeTypeFromExtension(extension)).toBe(mimeType);
    expect(hostPreviewMimeTypeFromExtension(`${extension}.txt`)).toBeNull();
  });
});

describe("media path parsing", () => {
  // regression: #9023 media kind comes from the decoded pathname, ignoring query and hash
  it.each([
    ["https://cdn.example/clip.webm?download=1#t=2", "video"],
    ["https://example.com/download?name=recording.mp4", null],
    ["images%2Fresult%2Epng", "image"],
    ["images/result.png%23secret.txt", null],
    ["images/result.png%3Fsecret.txt", null],
    ["/tmp/100%.png", "image"],
    ["https://cdn.example/photo.HEIC?download=1", "image"],
    ["images/photo%2Eheif", "image"],
  ])("classifies the decoded pathname of %s", (source, kind) => {
    expect(mediaKindFromPath(source)).toBe(kind);
  });
});

describe("attachment preview classification", () => {
  it.each([
    ["example.json", "application/octet-stream", "text"],
    ["README.md", "text/plain", "markdown"],
    ["component.tsx", "", "text"],
    ["report.pdf", "application/pdf", "pdf"],
    ["page.HTML", "", "html"],
    ["recording.mp3", "", "audio"],
    ["photo.HEIC", "", "image"],
    ["photo.heif", "application/octet-stream", "image"],
    ["photo.heic", "text/plain", "image"],
    ["photo", "image/heic", "image"],
    ["photo", "image/heif", "image"],
    ["payload", "application/problem+json", "text"],
    ["misleading.json", "application/pdf", "pdf"],
    ["misleading.pdf", "application/zip", "unsupported"],
  ])("classifies %s (%s) as %s", (name, mimeType, expected) => {
    expect(filePreviewKind({ name, mimeType })).toBe(expected);
  });
  it("rejects binary and invalid UTF-8 data", () => {
    expect(() => decodeFilePreviewText(new Uint8Array([65, 0, 66]))).toThrow("binary");
    expect(() => decodeFilePreviewText(new Uint8Array([255]))).toThrow("UTF-8");
  });
  it("does not corrupt a multi-byte character at the preview boundary", () => {
    const bytes = new Uint8Array(FILE_TEXT_PREVIEW_MAX_BYTES + 1).fill(97);
    bytes[FILE_TEXT_PREVIEW_MAX_BYTES - 1] = 0xe2;
    bytes[FILE_TEXT_PREVIEW_MAX_BYTES] = 0x82;
    const preview = decodeFilePreviewText(bytes);
    expect(preview.truncated).toBe(true);
    expect(preview.text.endsWith("�")).toBe(false);
    expect(preview.text.length).toBe(FILE_TEXT_PREVIEW_MAX_BYTES - 1);
  });
});
