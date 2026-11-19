import { AssetCreateUrlResult, AttachmentCreateUploadUrlResult } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import { issueAssetUrl } from "./AssetAccess.ts";
import { issueNoteFileUrl } from "./noteFileAsset.ts";
import { issueAttachmentUploadUrl } from "./AttachmentUpload.ts";
import * as PendingAttachmentSweep from "./PendingAttachmentSweep.ts";
import { layerTest, screenshotItem } from "./AssetAccess.testkit.ts";

const decodeAsset = Schema.decodeUnknownSync(AssetCreateUrlResult);
const decodeUpload = Schema.decodeUnknownSync(AttachmentCreateUploadUrlResult);
it.effect("accepts signed URLs from asset, note-file, and attachment-upload producers", () =>
  Effect.gen(function* () {
    const image = yield* issueAssetUrl({
      resource: {
        _tag: "tool-output-image",
        threadId: screenshotItem.threadId,
        itemId: screenshotItem.id,
        index: 0,
      },
    });
    expect(decodeAsset(image).relativeUrl).toBe(image.relativeUrl);
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(`${notesDir}/.attachments`, { recursive: true });
    yield* fs.writeFileString(`${notesDir}/.attachments/0123456789abcdef.png`, "image");
    const note = yield* issueNoteFileUrl({
      _tag: "note-file",
      path: ".attachments/0123456789abcdef.png",
    });
    expect(decodeAsset(note).relativeUrl).toBe(note.relativeUrl);
    const upload = yield* issueAttachmentUploadUrl({
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 5,
    });
    expect(decodeUpload(upload).relativeUrl).toBe(upload.relativeUrl);
  }).pipe(
    Effect.provideService(PendingAttachmentSweep.PendingAttachmentSweep, { request: Effect.void }),
    Effect.provide(layerTest),
  ),
);
