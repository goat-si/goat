// @effect-diagnostics nodeBuiltinImport:off globalDate:off - recording artifacts are saved through the host filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@goat/contracts";
import type { Page } from "playwright-core";
import { PENDING_ATTACHMENT_THREAD_SEGMENT } from "../attachmentStore.ts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";

type EncoderWindow = {
  __goatRecorder: { chunk(index: number): Promise<string>; download(): void };
};
export const saveRecording = async (
  encoder: Page,
  stopped: { mimeType: string | null; count: number; bytes: number },
  directory: string,
  tabId: string,
) => {
  if (stopped.bytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES)
    throw new ServerBrowserOperationError(
      "PreviewAutomationRecordingTooLargeError",
      "The recording is larger than the attachment limit.",
    );
  if (!stopped.mimeType || stopped.bytes === 0)
    throw new ServerBrowserOperationError(
      "PreviewAutomationExecutionError",
      "The recording captured no frames.",
    );
  const extension = stopped.mimeType.startsWith("video/mp4") ? "mp4" : "webm";
  const id = `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${NodeCrypto.randomUUID()}-${extension}`;
  const path = NodePath.join(directory, `${id}.${extension}`);
  await NodeFSP.mkdir(directory, { recursive: true });
  if (stopped.bytes >= 8 * 1024 * 1024) {
    const stagedPath = `${path}.partial`;
    try {
      const [download] = await Promise.all([
        encoder.waitForEvent("download", { timeout: 5_000 }),
        encoder.evaluate(() => (globalThis as unknown as EncoderWindow).__goatRecorder.download()),
      ]);
      await download.saveAs(stagedPath);
      if ((await NodeFSP.stat(stagedPath)).size !== stopped.bytes)
        throw new Error("The recording download is incomplete.");
      await NodeFSP.rename(stagedPath, path);
    } finally {
      await NodeFSP.rm(stagedPath, { force: true });
    }
  } else {
    const chunks: Buffer[] = [];
    for (let index = 0; index < stopped.count; index++) {
      const chunk = await encoder.evaluate(
        (i) => (globalThis as unknown as EncoderWindow).__goatRecorder.chunk(i),
        index,
      );
      chunks.push(Buffer.from(chunk, "base64"));
    }
    const data = Buffer.concat(chunks);
    if (data.byteLength !== stopped.bytes) throw new Error("The recording transfer is incomplete.");
    await NodeFSP.writeFile(path, data);
  }
  return {
    id,
    tabId,
    path,
    mimeType: stopped.mimeType.split(";")[0] ?? stopped.mimeType,
    sizeBytes: stopped.bytes,
    createdAt: new Date().toISOString(),
    uploadedAttachmentId: id,
  };
};
