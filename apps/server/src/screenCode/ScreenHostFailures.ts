import type { ScreenImage } from "@goat/contracts";

export const imageSize = (image: ScreenImage) => Buffer.from(image.bytes, "base64").byteLength;
export const key = (runId: string, turnId: string, cellId: string) =>
  `${runId}\u0000${turnId}\u0000${cellId}`;
