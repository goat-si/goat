import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { deduplicateComposerAttachments } from "./composerAttachmentDedup";

it("keeps same-metadata files with different content and deduplicates the same source", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-dedup-"));
  try {
    const firstPath = NodePath.join(root, "first", "report.txt");
    const secondPath = NodePath.join(root, "second", "report.txt");
    NodeFS.mkdirSync(NodePath.join(root, "first"));
    NodeFS.mkdirSync(NodePath.join(root, "second"));
    NodeFS.writeFileSync(firstPath, "abc");
    NodeFS.writeFileSync(secondPath, "xyz");
    const first = {
      id: "first",
      type: "file" as const,
      name: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      fileUri: NodeURL.pathToFileURL(firstPath).href,
    };
    const different = {
      ...first,
      id: "different",
      fileUri: NodeURL.pathToFileURL(secondPath).href,
    };
    const same = { ...first, id: "same" };
    expect(deduplicateComposerAttachments([first], [different, same])).toEqual({
      attachments: [different],
      duplicates: [same],
    });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps same-metadata images when their content identity is unknown", () => {
  const first = {
    id: "one",
    type: "image" as const,
    name: "same.png",
    mimeType: "image/png",
    sizeBytes: 3,
    previewUri: "preview:one",
  };
  const other = { ...first, id: "two", previewUri: "preview:two" };
  expect(deduplicateComposerAttachments([first], [other]).attachments).toEqual([other]);
});
