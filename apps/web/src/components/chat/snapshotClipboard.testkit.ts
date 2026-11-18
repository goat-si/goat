import { ComposerContextId, EnvironmentId } from "@goat/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@goat/shared/composerContextClipboard";
import { formatComposerContextReference } from "@goat/shared/composerContextReferences";
import { vi } from "vite-plus/test";
import { copySnapshot } from "./copySnapshot";

function pngUrl(color: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Test canvas is unavailable.");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

export async function snapshotClipboardFixture({
  unrelatedPng = false,
  plainImage = false,
  rejectCustom = false,
}: { unrelatedPng?: boolean; plainImage?: boolean; rejectCustom?: boolean } = {}) {
  const src = pngUrl("#ef0000");
  const originalPng = await (await fetch(src)).blob();
  const record = {
    version: 1 as const,
    kind: "image" as const,
    contextId: ComposerContextId.make("image_snapshot"),
    label: "shot.png",
    attachmentId: "snapshot",
    name: "shot.png",
    mimeType: "image/png",
    sizeBytes: originalPng.size,
    source: {
      kind: "snap-shot" as const,
      capturedAt: "2026-01-01T00:00:00.000Z",
      appName: "Finder",
      windowTitle: "Downloads",
    },
  };
  const fragment = encodeComposerContextFragment({
    version: 1,
    source: { environmentId: EnvironmentId.make("local") },
    records: [record],
  });
  if (!fragment) throw new Error("Could not make snapshot clipboard fixture.");
  const clipboard = new DataTransfer();
  if (!plainImage) {
    using _write = vi.spyOn(navigator.clipboard, "write").mockImplementation(async ([item]) => {
      if (!item) throw new Error("No snapshot clipboard item written.");
      if (rejectCustom && item.types.includes(COMPOSER_CONTEXT_CLIPBOARD_MIME))
        throw new Error("Custom clipboard formats are unavailable.");
      for (const format of item.types.filter((type) => type.startsWith("text/"))) {
        clipboard.setData(format, await (await item.getType(format)).text());
      }
    });
    await copySnapshot(src, formatComposerContextReference(record), fragment);
  }
  const png = unrelatedPng ? await (await fetch(pngUrl("#0000ef"))).blob() : originalPng;
  clipboard.items.add(new File([png], record.name, { type: png.type }));
  return { clipboard, record };
}
