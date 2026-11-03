import type { CDPSession } from "playwright-core";

const SHRINK_PNG = `async function (png, width, height) {
  const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
}`;

const SHRINK_JPEG = `async function (jpeg, maxWidth, maxHeight, quality) {
  const bytes = Uint8Array.from(atob(jpeg), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  try {
    const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
    if (scale === 1) return null;
    const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
    canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality / 100).slice("data:image/jpeg;base64,".length);
  } finally {
    bitmap.close();
  }
}`;

const callInScreenshotWorld = async (
  cdp: CDPSession,
  functionDeclaration: string,
  args: ReadonlyArray<string | number>,
  errorMessage: string,
) => {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "goat-preview-screenshot",
  });
  const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
    functionDeclaration,
    executionContextId,
    arguments: args.map((value) => ({ value })),
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails || (result.value !== null && typeof result.value !== "string")) {
    throw new Error(errorMessage);
  }
  return result.value as string | null;
};

export const shrinkPng = async (cdp: CDPSession, png: string, scale: number) => {
  const header = Buffer.from(png.slice(0, 32), "base64");
  const result = await callInScreenshotWorld(
    cdp,
    SHRINK_PNG,
    [png, Math.round(header.readUInt32BE(16) * scale), Math.round(header.readUInt32BE(20) * scale)],
    "The snapshot could not shrink its screenshot.",
  );
  if (result === null) throw new Error("The snapshot could not shrink its screenshot.");
  return result;
};

export const shrinkJpegWithin = (
  cdp: CDPSession,
  jpeg: string,
  quality: number,
  bounds: { readonly maxWidth: number; readonly maxHeight: number },
) =>
  callInScreenshotWorld(
    cdp,
    SHRINK_JPEG,
    [jpeg, bounds.maxWidth, bounds.maxHeight, quality],
    "The preview still could not be resized.",
  );
